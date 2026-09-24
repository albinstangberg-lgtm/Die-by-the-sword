import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import { disposeTree, handMesh, jointBall, shellMesh, stumpCap } from "./skin";
import type { WoundEnd } from "./blood";

import type { Tuning } from "../tuning";
import type { Build } from "./anatomy";
import type { Fighter } from "./fighter";
import { SWORD, weaponMassProperties, type Weapon } from "./weapons";
import { stablePD } from "./drive";
import { smoothstep, Tracker } from "./motion";
import { GUARD, Pose, type PostureDrive } from "./posture";
import {
  pushOut, repulsion, SwivelSearch, wrap, type Capsule, type ChainRadii,
} from "./clearance";

/**
 * THE MECHANIC.
 *
 * Three ideas, in order of importance:
 *
 *  1. A kinematic GHOST HAND is driven directly by mouse deltas. It is not
 *     physical, it never collides, it goes exactly where you point. It is pure
 *     intent.
 *
 *  2. The REAL ARM is a chain of dynamic bodies — upper arm on a spherical
 *     shoulder, forearm on a hinged elbow, weapon in a hand that turns about
 *     the forearm's length and bends at the wrist. It is subject to gravity,
 *     collision and its own inertia.
 *
 *  3. A FORCE-LIMITED PD CONTROLLER drags the real hand toward the ghost hand.
 *     `maxForce` and `maxTorque` clamp what the arm is allowed to exert.
 *
 * The clamp in (3) is the entire game. With the blade free, the motor easily
 * wins and the arm tracks the mouse almost exactly — responsive. With the blade
 * buried in a pillar, the motor saturates, the real hand falls behind the ghost,
 * and you feel the sword's weight and the wall's refusal. Every bit of the
 * feel — the bounce, the trailing tip, the bad swings that skid off stone —
 * falls out of that one saturating controller. Nothing is animated.
 *
 * Why not IK? Because IK always succeeds. It would place the hand at the target
 * and the blade would pass through the wall, or pop out of it. The failure to
 * reach is the point.
 */

/**
 * Where the elbow hangs relative to the shoulder-to-hand line.
 *
 * This decides how steeply the sword sits in the hand, and it matters far more
 * than it looks. The blade is held pointing along the forearm, so wherever
 * the elbow sits, the blade points away from it: an elbow directly BELOW the
 * line throws the blade upward, an elbow BEHIND the hand lays it forward.
 *
 * It used to be straight down, which was fine when the shoulder sat at 0.90m
 * and an upward blade pointed into the target. At a human 1.51m shoulder the
 * same geometry parks the tip at 2.1m, over everything's head, and leaves only
 * the slow part of the blade near the hilt low enough to reach a chest — which
 * is why swings turned into 24 grazing contacts at 3.7 m/s instead of one at
 * twelve.
 */
export const POLE = { back: 1.0, down: 0.45, right: 0.25 };

/**
 * The shoulder drive runs softer than the wrist. It is steering a lighter
 * segment and mostly only needs to keep the elbow from wandering, and a
 * shoulder as stiff as the wrist makes the whole limb feel welded rather than
 * hung.
 */
const UPPER_TORQUE_SCALE = 0.7;

/**
 * Where along a weapon the part that does the work sits, 0 at the guard and 1
 * at the tip: wherever its own leverage curve peaks.
 *
 * Read off `sweetSpot` rather than declared, so it cannot drift away from the
 * curve the damage model uses. It matters more than it sounds: it is the
 * distance an opponent stands back to, and a spear told to stand at a sword's
 * percussion point plants itself close enough to lay two thirds of its shaft
 * across the target and thrust with the middle of it.
 */
function strikePointOf(weapon: Weapon): number {
  let best = 0;
  let bestAt = 0.7;
  for (let i = 0; i <= 40; i++) {
    const along = i / 40;
    const v = weapon.sweetSpot(along);
    if (v > best) { best = v; bestAt = along; }
  }
  return bestAt;
}

// --- reach limits, as fractions of the arm's own length ---
/**
 * Folding tighter than this turns the arm into a knot that points the weapon
 * at the floor, where the tip grounds out and props the whole limb up. The
 * sword genuinely CAN be planted and stuck -- that is good, and worth keeping
 * -- but it should take a deliberate downward swing, not simply pulling the
 * hand in.
 */
const MIN_REACH_FRACTION = 0.517;
/**
 * How far short of full extension the reach stops, at human scale. Near a
 * straight arm the elbow's moment arm collapses: the force pulling the hand
 * back in acts almost along the arm and has nothing to bend against, so the
 * limb locks straight and stops tracking. Keeping the reach 8cm inside
 * anatomical maximum holds the elbow at 60 degrees or more of flexion, where
 * it always has leverage.
 */
const REACH_MARGIN = 0.08;

// --- how far the edge may be rolled, radians ---
const ROLL_MIN = -1.8, ROLL_MAX = 1.8;

// --- how far the arm may sweep, radians, relative to torso forward ---
const YAW_MIN = -2.5, YAW_MAX = 1.9;
const PITCH_MIN = -1.35, PITCH_MAX = 1.5;

/** The same limits, for a driver that needs to know where its arm stops. */
export const ARM_RANGE = {
  yaw: [YAW_MIN, YAW_MAX],
  pitch: [PITCH_MIN, PITCH_MAX],
  roll: [ROLL_MIN, ROLL_MAX],
} as const;

/**
 * Where the arm is held at rest: see the note on `armYaw` below. The body's
 * posture is measured from the same guard, so at rest it stands square.
 */
const REST_YAW: number = GUARD.yaw, REST_PITCH: number = GUARD.pitch;

/** The hand's acceleration is smoothed over a few steps before the body sees it. */
const ACCEL_SMOOTHING = 0.3;
/** And capped: a blade stopping dead on stone is not a reason to fling the torso. */
const ACCEL_CAP = 150;

/**
 * How fast the clearance swivel may turn the elbow round the arm, rad/s and
 * rad/s^2. Quick enough to keep pace with a full-speed sweep of the aim --
 * slower, and the elbow's target spent the first few steps of every hard
 * cross-body swing inside the ribs, waiting for its correction to arrive.
 */
const SWIVEL_SPEED = 18;
const SWIVEL_ACCEL = 400;

/**
 * The leash on the followed intent, in metres of lag at human scale.
 *
 * Past `LEASH_FROM` of distance between hand and ghost the ghost slows, down
 * to `LEASH_MIN` of its speed by `LEASH_TO`, and waits for the arm. The
 * intent tracker keeps the TARGET on the arc round the shoulder, but an arm
 * that cannot keep up -- an orc hauling an axe through a flick trailed its
 * ghost by three quarters of a metre -- catches up along a straight line,
 * and that line runs through the chest. Held on a leash it catches up along
 * the arc. A free arm at a human pace never lags this far, so nothing about
 * ordinary play is slowed.
 */
const LEASH_FROM = 0.12;
const LEASH_TO = 0.4;
const LEASH_MIN = 0.25;

// --- the forearm twist -----------------------------------------------------
//
// Pronation and supination: the weapon turns in the grip, about the forearm's
// own length. Without it the edge could only be turned by swinging the whole
// elbow round the shoulder-to-hand line -- so an elbow the body had to move
// out of the ribs took the edge with it, and a roll toward the body stopped
// dead the moment the elbow met the ribs. The twist keeps the edge where the
// aim and the roll put it while the elbow goes wherever the body lets it.

/** How far the grip turns either way, radians. A symmetric edge needs 90°. */
const TWIST_LIMIT = 1.6;
/** The most the grip is ever asked for: inside the limit, so it never leans on it. */
const TWIST_REACH = 1.5;
/** Twist speed wanted per radian still to go: about 40ms to close most of a gap. */
const TWIST_RATE = 25;
/**
 * A quick forearm, not an instant one, rad/s. Also what caps the grip's
 * torque: the motor pushes in proportion to how far short of this speed the
 * weapon turns, so a weapon that cannot turn at all gets `twistTorque` and
 * no more.
 */
const TWIST_SPEED = 20;
/** A dead or severed hand holds the grip loosely: damping, no drive, N·m·s/rad. */
const SLACK_GRIP = 0.01;

// --- the wrist ----------------------------------------------------------------
//
// The twist keeps the EDGE where it was asked. Where the blade POINTS is the
// forearm's business, and when the clearance swivels the elbow out of the ribs
// the forearm points somewhere else: at the far end of a cross-body cut, back
// over the other shoulder, up to sixty degrees off the line the aim asked for.
// The wrist bends the weapon back toward that line, as far as a wrist goes.
//
// It is one ball joint in the hand, carrying both: the grip's turn about the
// weapon's length, and a bend of the weapon off the forearm's line.

/**
 * The most the wrist is ever asked to bend, radians off the forearm's line, in
 * any direction. A compromise over a real wrist's uneven range -- seventy-odd
 * degrees of flexion and extension, twenty to thirty of sideways deviation --
 * because which of those a given bend is depends on the grip's turn, which the
 * edge decides.
 */
const WRIST_REACH = 0.9;
/** The hard stop about each of the weapon's two cross axes: past the reach, so nothing ordinary leans on it. */
const WRIST_LIMIT = 1.05;
/** Bend speed wanted per radian still to go, as the twist's. */
const WRIST_RATE = 25;
/**
 * And the most it is wanted at, rad/s -- which, as with the twist, caps its
 * torque: a weapon the wrist cannot move at all gets `wristTorque` and no more.
 */
const WRIST_SPEED = 20;

/**
 * Over this range of wrist bend, radians, the forearm's own drive lets go of
 * its roll about its length, which the weapon's share of the drive has taken
 * over by then. See `drive`.
 */
const WRIST_ROLL_FROM = 0.1;
const WRIST_ROLL_TO = 0.5;

// --- the scabbard ----------------------------------------------------------------
//
// A sword goes on the back, hilt over the sword shoulder and point down toward
// the other hip, where a hand coming up over the shoulder finds it. Given in
// the chest's own frame, relative to the waist pivot as the posture places
// everything on the chest: +X the sword side, +Y up, +Z out of the back.

/** Where the pommel sits, metres at human scale. */
const SHEATH_AT = new THREE.Vector3(0.12, 0.58, 0.155);
/** Which way the blade runs from it: down, and across to the other hip. */
const SHEATH_DIR = new THREE.Vector3(-0.42, -0.9, 0).normalize();

/**
 * The linear drive's gains with nothing in the hand, as a share of its own.
 *
 * It was tuned pushing a hand with a sword in it, which carries a kilo and a
 * half of steel. An empty hand at the end of two bones can weigh less than
 * half a kilo to push, and the same damping on that is past what an explicit
 * step can take: the hand flipped back and forth every step at the force
 * clamp, a centimetre from where it was sent.
 */
const EMPTY_HAND = 0.5;

/**
 * How far out of the scabbard the grip stands with the point just in its
 * mouth, metres at human scale: where the hand takes a sword to put it up,
 * and how far it draws one before bringing it over the shoulder. Not the
 * blade's whole length -- nobody's arm reaches that far up behind their own
 * head -- so the last of the point goes in, and comes out, on the swing.
 */
const SHEATH_MOUTH = 0.32;

/**
 * Putting a sword up and drawing it, a phase at a time: seconds at human
 * scale, and longer for a bigger body, as anything that moves under gravity.
 *
 *   lift    the hand takes the sword up over its shoulder, still in its grip
 *   turn    the point goes back over the shoulder and down into the mouth
 *   seat    and the blade slides home
 *   settle  the empty hand goes back to wherever the mouse has it
 *
 *   reach   drawing: the hand goes up over the shoulder to the grip
 *   pull    draws the blade up out of the scabbard
 *   swing   and brings it over the shoulder into the hand's line
 */
const STOW_TIME = {
  lift: 0.3, turn: 0.28, seat: 0.18, settle: 0.3, reach: 0.3, pull: 0.2, swing: 0.36,
} as const;
type StowPhase = keyof typeof STOW_TIME;
/** How much longer than its time a phase waits for a hand still on its way. */
const STOW_GRACE = 2;

/**
 * A hand being taken somewhere -- to its own back, to the floor -- may fold
 * further than an aim is ever let go, and straighten nearer to full: the
 * fraction of the arm it may come in to, and how short of straight it stops,
 * metres at human scale. An aim is kept off both for the sake of a blade in
 * the hand, which is not what these reaches are for.
 */
const GUIDE_MIN_REACH = 0.36;
const GUIDE_MARGIN = 0.02;

/**
 * Where the elbow goes when the hand goes up behind the shoulder: up, out
 * and forward, as an arm reaching for something on its own back. Hung down
 * and back as it is for an aim, it would have to go through the shoulder.
 */
const OVER_POLE = { back: -0.5, down: -0.8, right: 0.7 };

/** The chest's own right, which the point swings about going over the shoulder. */
const CHEST_RIGHT = new THREE.Vector3(1, 0, 0);
const IDENTITY = new THREE.Quaternion();

/** Rapier's axes, by the numbers its raw joint calls take them as. */
const ANG_X = 3, ANG_Y = 4, ANG_Z = 5;

/**
 * An arm cut at the elbow is held in: which way what is left of it hangs, in
 * the chest's frame (down, a little toward the middle and a little forward),
 * and how hard it is held there. See `Arm.tuckStump`.
 */
const STUMP_HANG = new THREE.Vector3(-0.25, -1, -0.35);
const STUMP_KP = 60;
const STUMP_KD = 6;
const STUMP_TORQUE = 12;

/**
 * Below this bend of the elbow, radians, the arm's angular drives let go of
 * its roll about its own length, fading in fully by `ROLL_FADE_TO`.
 *
 * With the elbow straight, which way the elbow points means nothing -- any
 * swivel is the same pose -- and the arm's inertia about its own length is
 * almost nothing either: the upper arm and forearm roll together like one
 * thin rod. An explicit drive on a mode that light over-corrects every step
 * and spins it up; this is the singularity behind the original snap. It
 * used to be masked by the weapon welded on and by Rapier's phantom inertia
 * about the spear's and the axe's shafts. With the grip free to turn and the
 * inertia right, a freshly spawned -- straight -- goblin arm spun at 900
 * rad/s. The reach limits hold the elbow at sixty degrees or more in play,
 * so nothing ordinary is touched.
 */
const ROLL_FADE_FROM = 0.15;
const ROLL_FADE_TO = 0.6;

/**
 * And however bent the elbow, the drives' push about each bone's own length
 * is held inside what that roll can take: damping and stiffness no larger
 * than an explicit step on its inertia stays stable with. The inertia is a
 * lower bound -- both bones' own roll, plus as much of the other bone as the
 * elbow's bend swings round with it -- so the limit can only be cautious.
 * A human's or an orc's arm is heavy enough that nothing changes; a goblin's
 * is not, and with the spear's phantom inertia gone its drive had been
 * spinning it up against anything the spear touched.
 */
const ROLL_DAMPING_LIMIT = 1.5;
const ROLL_STIFFNESS_LIMIT = 0.7;

/**
 * The minimum the arm needs from an input source. Kept structural so the
 * headless harness can drive the real controller without a browser.
 */
export interface ArmInput {
  consumeMouse(): { dx: number; dy: number; wheel: number; rollDx: number };
}

export interface ArmState {
  /** Distance between ghost hand and real hand, metres. The key diagnostic. */
  trackingError: number;
  /** How saturated the linear drive is, 0..1. At 1 the wall is winning. */
  saturation: number;
  /** Blade tip speed, m/s. */
  tipSpeed: number;
  /** Elbow flexion, radians. */
  elbow: number;
  /**
   * How far the weapon is off the orientation it was asked for, radians:
   * where it points and which way its edge faces, together.
   */
  roll: number;
  /** How saturated the angular drive is, 0..1. */
  torqueSaturation: number;
  /** How far the weapon is turned in the grip, radians. */
  twist: number;
  /** How far the wrist is bent off the forearm's line, radians. */
  wrist: number;
  /** How far the real limb is into its own trunk, metres. 0 is clear. */
  clearance: number;
}

export class Arm {
  readonly upper: RAPIER.RigidBody;
  readonly fore: RAPIER.RigidBody;
  /** The weapon's body. Every part of the weapon is a collider on this one. */
  readonly blade: RAPIER.RigidBody;
  /** The business end -- what a solver contact is attributed to. */
  readonly bladeCollider: RAPIER.Collider;
  /** Every collider the weapon is made of, hilt to tip. */
  readonly weaponColliders: RAPIER.Collider[] = [];

  /** This fighter's proportions. Every length below is derived from them. */
  readonly build: Build;
  readonly weapon: Weapon;
  /**
   * What this fighter's arm is allowed to exert, as a multiple of the tuning's
   * clamp. An orc swinging four kilos of axe on a human's force budget could
   * not lift it; that is not a special case, it is a bigger animal.
   */
  power = 1;

  private readonly upperLen: number;
  private readonly foreLen: number;
  private readonly upperHalf: number;
  private readonly foreHalf: number;
  private readonly minReach: number;
  private readonly maxReach: number;
  /** Distance from the hand to the weapon's tip, along the forearm. */
  private readonly tipY: number;
  /** Where the weapon's leverage peaks, 0..1 from guard to tip. */
  private readonly strikePoint: number;
  /** Live total weapon mass, which the panel can change for the player. */
  private weaponMass: number;
  /** Dark caps on cut faces, cleared when a reset puts the arm back on. */
  private readonly caps: THREE.Object3D[] = [];

  private shoulderJoint: RAPIER.ImpulseJoint | null = null;
  private elbowJoint: RAPIER.ImpulseJoint | null = null;
  /**
   * The weapon in the hand: a ball joint, turning about its length (the grip's
   * twist) and bending off the forearm's line (the wrist), each on its own
   * motor. See `applyGrip`.
   */
  private wristJoint: RAPIER.ImpulseJoint | null = null;
  /**
   * What the arm's roll about each bone's length has to turn, kg·m²: each
   * bone's own inertia about its length, and each bone's mass at half its
   * length -- what the other one swings round when the elbow is bent.
   */
  private foreRoll = 0;
  private upperRoll = 0;
  private foreSwing = 0;
  private upperSwing = 0;
  /**
   * The weapon's part of the swing's inertia about the hand, 0..1: how the
   * angular drive shares its torque between the forearm and the weapon.
   */
  private weaponShare = 0.5;
  /** The weapon's inertia across its length about the hand, kg·m². */
  private weaponSwing = 0;
  /** The weapon's target: the forearm's, bent at the wrist and turned in the grip. */
  private readonly _bladeQuat = new THREE.Quaternion();
  /** The turn of the grip asked for this step, radians. */
  private twistTarget = 0;
  /** The edge the aim and the roll asked for, before any clearance moved the elbow. */
  private readonly _askedEdge = new THREE.Vector3();
  /** And the way they asked the weapon to point: the forearm's line in that pose. */
  private readonly _askedDir = new THREE.Vector3();
  /** The bend of the wrist asked for this step, forearm-local. */
  private readonly _wristTarget = new THREE.Quaternion();
  /** Scratch for the wrist's bend, forearm-local. */
  private readonly _bendQuat = new THREE.Quaternion();
  private readonly _bentQuat = new THREE.Quaternion();
  private readonly _bladeDir = new THREE.Vector3();
  private readonly _neutralEdge = new THREE.Vector3();

  /** Once the arm is cut, nothing drives it and the sword is gone for good. */
  severedAt: "shoulder" | "elbow" | null = null;

  /** Set when the owner is down: the limb hangs, but still reports its motion. */
  limp = false;

  /**
   * The weapon is on the back rather than in the hand. The hand is empty and
   * the arm still goes where the mouse sends it; nothing it does can cut.
   */
  private sheathedNow = false;
  /** The scabbard the weapon goes into, if this weapon has one: a sword does. */
  private scabbard: THREE.Object3D | null = null;
  /** The hand, which rides the weapon while it is held and the forearm while it is not. */
  private handMeshObj!: THREE.Mesh;
  /**
   * The inside of the hand, riding the forearm: where something the hand
   * picks up is held. A plain node, so what hangs from it keeps its shape.
   */
  readonly palm = new THREE.Object3D();
  /** Where the grip sits in the scabbard, chest frame, and the weapon's turn there. */
  private readonly sheathPoint = new THREE.Vector3();
  private readonly sheathQuat = new THREE.Quaternion();
  /** Where the grip is with the point just in the mouth: see SHEATH_MOUTH. */
  private readonly mouthPoint = new THREE.Vector3();
  private readonly _sheathP = new THREE.Vector3();
  private readonly _sheathQ = new THREE.Quaternion();

  /**
   * Putting the weapon up or taking it out, under way: which, what part of
   * it, how long into that part, and how far the point swings over the
   * shoulder on the way, radians about the chest's right.
   */
  private stow: { draw: boolean; phase: StowPhase; time: number; turn: number } | null = null;
  /**
   * The weapon is out of the hand's joint and carried by the stow instead:
   * kinematic, touching nothing, but not on the back yet either.
   */
  private loose = false;
  /** The weapon's pose where the part of the stow moving it began, chest frame. */
  private readonly stowP = new THREE.Vector3();
  private readonly stowQ = new THREE.Quaternion();
  private readonly _stowP = new THREE.Vector3();
  private readonly _stowQ = new THREE.Quaternion();
  private readonly _handP = new THREE.Vector3();
  private readonly _handV = new THREE.Vector3();
  private readonly _handQ = new THREE.Quaternion();

  /**
   * A world point the hand is being taken to rather than aimed, and how far
   * the ghost has been handed over to it: 0 is wholly the mouse's aim, 1
   * wholly the point. And where the elbow goes meanwhile, if not where the
   * aim hangs it. See `guide`.
   */
  private readonly guideAt = new THREE.Vector3();
  private guideWeight = 0;
  private guidePole: { back: number; down: number; right: number } | null = null;

  readonly group = new THREE.Group();
  /** Public so the Interpolator can drive them; physics never touches meshes. */
  upperMesh!: THREE.Mesh;
  foreMesh!: THREE.Mesh;
  bladeMesh!: THREE.Group;
  private ghostMesh!: THREE.Group;

  /**
   * Mouse-driven intent, in torso-local spherical coordinates.
   *
   * The rest pitch sits below the shoulder because the elbow hangs under the
   * shoulder-to-hand line, so the forearm — and the blade held along it —
   * angles UP out of the hand. Level with the shoulder the tip rides around
   * 2.1m, over the head of anything worth hitting; dropping the hand brings
   * the blade back toward the height a standing opponent occupies.
   */
  private armYaw = REST_YAW;
  private armPitch = REST_PITCH;
  private reach = 0.46;
  private roll = 0;

  /**
   * The same intent, as the ghost is actually allowed to follow it.
   *
   * `armYaw` and friends are what the hand ASKED for, and stay exact: the AI
   * steers by them, the limits clamp them, and the probes solve with them.
   * The ghost follows these trackers instead, which pass anything a hand does
   * at a human speed straight through and spread only a flick across the few
   * steps an arm would need -- see `Tracker` for why that matters.
   */
  private readonly aimTrack = new Tracker([REST_YAW, REST_PITCH]);
  private readonly rollTrack = new Tracker([0]);
  private readonly _aimWant = [REST_YAW, REST_PITCH];
  private readonly _rollWant = [0];

  /**
   * How far the elbow is swivelled off its designed pole to keep it out of
   * the trunk. Followed, like the aim, so a clearance that switches sides
   * swings the elbow round rather than teleporting its target.
   */
  private readonly swivelTrack = new Tracker([0]);
  private readonly _swivelWant = [0];
  private readonly swivelSearch = new SwivelSearch();
  private readonly radii: ChainRadii;
  private readonly handRadius: number;
  /** Where on the limb the trunk can push: a body, how far along it, how fat. */
  private readonly contactPoints: { body: RAPIER.RigidBody; along: number; radius: number }[];

  readonly state: ArmState = {
    trackingError: 0, saturation: 0, tipSpeed: 0, elbow: 0, roll: 0,
    torqueSaturation: 0, twist: 0, wrist: 0, clearance: 0,
  };

  // Scratch — this runs 60x/s, so nothing here allocates.
  private readonly _ghostPos = new THREE.Vector3();
  private readonly _shoulder = new THREE.Vector3();
  private readonly _handPos = new THREE.Vector3();
  private readonly _handVel = new THREE.Vector3();
  private readonly _armDir = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _elbowTarget = new THREE.Vector3();
  private readonly _foreTarget = new THREE.Vector3();
  private readonly _ghostQuat = new THREE.Quaternion();
  private readonly _upperQuat = new THREE.Quaternion();
  private readonly _q3 = new THREE.Quaternion();
  private readonly _q4 = new THREE.Quaternion();
  private readonly _m = new THREE.Matrix4();
  private readonly _refA = new THREE.Vector3();
  private readonly _refB = new THREE.Vector3();
  private readonly _refC = new THREE.Vector3();
  private readonly _refD = new THREE.Vector3();
  private readonly _prePos = new THREE.Vector3();
  private readonly _preLin = new THREE.Vector3();
  private readonly _preAng = new THREE.Vector3();
  private readonly _preQuat = new THREE.Quaternion();
  private readonly _tipPos = new THREE.Vector3();
  private readonly _tipVel = new THREE.Vector3();
  private readonly _probeHand = new THREE.Vector3();
  private readonly _probeDir = new THREE.Vector3();
  private readonly _steadyPose = new Pose();
  private readonly _ta = new THREE.Vector3();
  private readonly _tb = new THREE.Vector3();
  private readonly _tc = new THREE.Vector3();
  private readonly _qa = new THREE.Quaternion();
  private readonly _qb = new THREE.Quaternion();
  private readonly _qc = new THREE.Quaternion();
  /** `elbowBend`'s own, so it can be asked mid-drive without clobbering anything. */
  private readonly _bendA = new THREE.Vector3();
  private readonly _bendB = new THREE.Vector3();
  private readonly _bendQ = new THREE.Quaternion();

  /** The ghost's velocity, and where it was last step. See `measureGhost`. */
  private readonly _ghostVel = new THREE.Vector3();
  private readonly _prevGhost = new THREE.Vector3();
  private _ghostPrimed = false;
  private readonly _relVel = new THREE.Vector3();

  /** The hand's velocity last step and its smoothed acceleration, world. */
  private readonly _prevHandVel = new THREE.Vector3();
  private readonly _handAccel = new THREE.Vector3();
  private _accelPrimed = false;
  /** Where the ghost's percussion point is: what the body's eyes follow. */
  private readonly _look = new THREE.Vector3();
  private readonly _drive: PostureDrive = {
    yaw: REST_YAW, pitch: REST_PITCH, yawRate: 0, pitchRate: 0,
    accel: new THREE.Vector3(), strain: 0, look: null,
  };

  constructor(
    private phys: PhysicsWorld,
    scene: THREE.Scene,
    private fighter: Fighter,
    tuning: Tuning,
    weapon: Weapon = SWORD,
    readonly side: Side = fighter.side,
  ) {
    const { rapier, world } = phys;
    const build = this.build = fighter.build;
    this.weapon = weapon;

    // Every length the controller uses comes from the body it is attached to,
    // so a goblin's arm is a goblin's arm rather than a human's drawn small.
    const upperLen = this.upperLen = build.segment.upperArm.length;
    const foreLen = this.foreLen = build.segment.foreArm.length;
    const upperHalf = this.upperHalf = upperLen / 2;
    const foreHalf = this.foreHalf = foreLen / 2;
    const upperRadius = build.segment.upperArm.radius;
    const foreRadius = build.segment.foreArm.radius;

    this.radii = {
      upper: upperRadius,
      // The meshes a clearance is judged against: the elbow's ball is drawn
      // fatter than the forearm, the hand fatter still.
      elbow: foreRadius * 1.15,
      fore: foreRadius,
    };
    this.handRadius = foreRadius * 1.22;

    this.minReach = build.armLength * MIN_REACH_FRACTION;
    this.maxReach = build.armLength - REACH_MARGIN * build.scale;
    this.tipY = weapon.grip + weapon.span;
    this.strikePoint = strikePointOf(weapon);
    this.weaponMass = weapon.mass;

    // The rest pose, as a fraction of this arm's own reach rather than a
    // number of centimetres that only means anything on a human.
    this.reach = clamp(build.armLength * 0.793, this.minReach, this.maxReach);

    // Spawn the chain already straight along the initial arm direction, so the
    // joints are satisfied exactly at t=0 and nothing snaps on the first step.
    this.fighter.shoulderWorld(this._shoulder);
    this.computeGhost(tuning);
    const dir = this._armDir.copy(this._ghostPos).sub(this._shoulder).normalize();
    const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const rq = { x: rot.x, y: rot.y, z: rot.z, w: rot.w };

    const at = (d: number) => {
      const p = new THREE.Vector3().copy(this._shoulder).addScaledVector(dir, d);
      return { x: p.x, y: p.y, z: p.z };
    };

    const dyn = (pos: { x: number; y: number; z: number }) =>
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(rq)
        .setLinearDamping(0.6)
        .setAngularDamping(1.2)
        .setCanSleep(false);

    this.upper = world.createRigidBody(dyn(at(upperHalf)));
    this.fore = world.createRigidBody(dyn(at(upperLen + foreHalf)));
    this.blade = world.createRigidBody(dyn(at(upperLen + foreLen)));

    // A fast tip crosses several centimetres per step. Without CCD it tunnels
    // straight through the thin post and you cut air where you clearly connected.
    this.blade.enableCcd(true);
    this.fore.enableCcd(true);

    // The limb is transparent to its own weapon but solid to everyone else's.
    const limbGroups = this.side.bodyFilter;
    const armMassEach = (tuning.armMass / 2) * build.massScale;

    world.createCollider(
      rapier.ColliderDesc.capsule(Math.max(0.005, upperHalf - upperRadius), upperRadius)
        .setMass(armMassEach).setFriction(0.5).setCollisionGroups(limbGroups),
      this.upper,
    );
    world.createCollider(
      rapier.ColliderDesc.capsule(Math.max(0.005, foreHalf - foreRadius), foreRadius)
        .setMass(armMassEach).setFriction(0.5).setCollisionGroups(limbGroups),
      this.fore,
    );

    // --- the weapon ---
    //
    // One rigid body, one collider per part, so the solver sees the real mass
    // distribution. An axe with 2.7kg of iron a metre from the hand genuinely
    // has an axe's moment of inertia; nothing downstream needs to be told it is
    // an axe. Thin in X (the flats), wide in Z (spine to edge), long in Y --
    // Z rather than X because the forearm's X is spoken for by the elbow hinge,
    // so putting the edge on Z lands it in the plane of the arm.
    for (const part of weapon.parts) {
      const desc = part.shape === "capsule"
        ? rapier.ColliderDesc.capsule(
            Math.max(0.005, part.halfLen - part.halfThick), part.halfThick)
        : rapier.ColliderDesc.cuboid(part.halfThick, part.halfLen, part.halfWidth);
      const collider = world.createCollider(
        desc
          .setTranslation(0, part.at, part.atZ ?? 0)
          // No mass of its own: the weapon's is set on the body, whole -- see
          // `weaponMassProperties` for why Rapier cannot be left to add it up.
          .setDensity(0)
          .setFriction(0.25)      // low: steel skids off stone rather than gripping
          .setRestitution(0.12)   // a little — a hard parry should kick back
          .setCollisionGroups(this.side.bladeFilter)
          .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(2.0),
        this.blade,
      );
      this.weaponColliders.push(collider);
    }
    // The last part is the business end, and the one a solver contact is
    // reported against when the weapon meets stone.
    this.bladeCollider = this.weaponColliders[this.weaponColliders.length - 1];
    this.setWeaponMass(weapon.mass);
    this.measureLimbs();

    // Where the trunk can push the limb: the elbow end of the upper arm and
    // the elbow itself, the middle of the forearm and the hand. Not the upper
    // arm's root, which hangs against the ribs by construction -- the same
    // stretch the kinematic search leaves out, for the same reason: pushing
    // there would be a standing force on an arm at rest.
    this.contactPoints = [
      { body: this.upper, along: upperHalf * 0.6, radius: this.radii.upper },
      { body: this.upper, along: upperHalf, radius: this.radii.elbow },
      { body: this.fore, along: 0, radius: this.radii.fore },
      { body: this.fore, along: foreHalf, radius: this.handRadius },
    ];

    // --- joints ---
    this.shoulderJoint = this.makeShoulderJoint();
    this.elbowJoint = this.makeElbowJoint();

    this.wristJoint = this.makeWristJoint();

    this.buildMeshes(fighter.palette.skin);
    scene.add(this.group);
    if (weapon === SWORD) this.buildScabbard();
  }

  /**
   * The weapon in the hand: a ball joint, built so the weapon continues the
   * forearm. A factory because putting a sword away takes it out of the hand
   * and drawing it has to put it back exactly as it was.
   */
  private makeWristJoint(): RAPIER.ImpulseJoint {
    const { rapier, world } = this.phys;
    // Hand: at rest the weapon's +Y (its length) continues the forearm's +Y
    // and its +Z is the cutting edge, as when it was welded. A ball joint, so
    // it can turn about that length -- the forearm's twist -- and bend off it
    // at the wrist.
    //
    // Built from the WEAPON's side. A joint's motors push about its first
    // body's axes, and the grip's turn is about the weapon's own length: from
    // the forearm's side, a bent wrist's "twist" motor would turn the weapon
    // about the forearm instead, which swings the bend round as well, and the
    // wrist's motors and the grip's spent every step undoing each other.
    const joint = world.createImpulseJoint(
      rapier.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: this.foreHalf, z: 0 }),
      this.blade, this.fore, true,
    );
    // Rapier's typed wrapper gives a ball joint no limits or motors, but the
    // joint underneath has one of each per axis.
    const raw = (joint as unknown as { rawSet: GripRaw }).rawSet;
    const h = joint.handle;
    raw.jointSetLimits(h, ANG_Y, -TWIST_LIMIT, TWIST_LIMIT);
    raw.jointSetLimits(h, ANG_X, -WRIST_LIMIT, WRIST_LIMIT);
    raw.jointSetLimits(h, ANG_Z, -WRIST_LIMIT, WRIST_LIMIT);
    // Driven through the joint's own motors, as force-based velocity servos:
    // see `applyGrip` for why that and not a torque of our own.
    for (const axis of [ANG_X, ANG_Y, ANG_Z]) {
      raw.jointConfigureMotorModel(h, axis, rapier.MotorModel.ForceBased);
    }
    this.wristJoint = joint;
    this.slackenGrip();
    return joint;
  }

  /**
   * The two joints that can be cut, built from scratch.
   *
   * Factories rather than inline construction, because a reset has to be able
   * to put the arm back ON. Severing removes the joint from the world outright
   * — there is no "disabled" state to flip back — so reattaching means
   * building it again, and the only way to be sure the new one matches the old
   * is for both to come from here.
   */
  private makeShoulderJoint(): RAPIER.ImpulseJoint {
    const { rapier, world } = this.phys;
    const l = this.fighter.shoulderAnchor;
    // Spherical, 3 DOF, anchored at the torso's shoulder point. Must match
    // Fighter.shoulderWorld, or the ghost hand is computed from one shoulder
    // while the arm hangs off another -- which is why both read the same
    // anchor, and why `drive` moves this one every step the posture moves it.
    return world.createImpulseJoint(
      rapier.JointData.spherical(
        { x: l.x, y: l.y, z: l.z },
        { x: 0, y: -this.upperHalf, z: 0 },      // top of the upper arm
      ),
      this.fighter.body, this.upper, true,
    );
  }

  private makeElbowJoint(): RAPIER.RevoluteImpulseJoint {
    const { rapier, world } = this.phys;
    // Revolute, 1 DOF, hinging about the arm's local X.
    const elbow = world.createImpulseJoint(
      rapier.JointData.revolute(
        { x: 0, y: this.upperHalf, z: 0 },
        { x: 0, y: -this.foreHalf, z: 0 },
        { x: 1, y: 0, z: 0 },
      ),
      this.upper, this.fore, true,
    ) as RAPIER.RevoluteImpulseJoint;
    // A real elbow does not hyperextend, and allowing even a few degrees of it
    // here lets the joint cross to the far side of straight, where the sign of
    // the bend is undefined and the arm can jam. The upper bound keeps it
    // permanently on one side of the singularity.
    elbow.setLimits(-2.45, -0.06);
    return elbow;
  }

  // -------------------------------------------------------------------------
  // Input -> ghost hand
  // -------------------------------------------------------------------------

  /** Fold this step's mouse travel into the arm's intent. */
  readInput(input: ArmInput, t: Tuning, dt: number = this.phys.world.timestep): void {
    const { dx, dy, wheel, rollDx } = input.consumeMouse();

    this.armYaw = clamp(this.armYaw - dx * t.sensitivity, YAW_MIN, YAW_MAX);
    const pitchDelta = dy * t.sensitivity * (t.invertY ? 1 : -1);
    this.armPitch = clamp(this.armPitch + pitchDelta, PITCH_MIN, PITCH_MAX);
    this.reach = clamp(this.reach + wheel * t.reachRate, this.minReach, this.maxReach);

    // Roll is the elbow swivel, so it needs a human range: past about a
    // hundred degrees either way the arm would be winding itself up in a way
    // no shoulder does. The blade is symmetric anyway, so every distinct edge
    // orientation is already reachable well inside this.
    this.roll = clamp(this.roll + rollDx * t.rollSensitivity, ROLL_MIN, ROLL_MAX);

    this.shapeIntent(t, dt);
  }

  /**
   * Let the ghost follow the intent, at no more than an arm's speed.
   *
   * One tracker for yaw and pitch together, so a diagonal flick is limited by
   * the distance it covers rather than by each axis on its own, and one for
   * roll, which is the elbow swivel and can wrench the arm round just as hard.
   */
  private shapeIntent(t: Tuning, dt: number): void {
    const s = this.build.scale;
    const lag = smoothstep(LEASH_FROM * s, LEASH_TO * s, this.state.trackingError);
    const speed = t.flickSpeed * (1 - lag * (1 - LEASH_MIN));

    this._aimWant[0] = this.armYaw;
    this._aimWant[1] = this.armPitch;
    this.aimTrack.step(this._aimWant, speed, t.flickAccel, dt);
    this._rollWant[0] = this.roll;
    this.rollTrack.step(this._rollWant, speed, t.flickAccel, dt);

    // It cannot overshoot a still target, but a reversal carries some of the
    // old velocity for a step, and the limits are anatomy: pin it inside them.
    pin(this.aimTrack, 0, YAW_MIN, YAW_MAX);
    pin(this.aimTrack, 1, PITCH_MIN, PITCH_MAX);
    pin(this.rollTrack, 0, ROLL_MIN, ROLL_MAX);
  }

  /** Put the followed intent exactly on the commanded one, with no motion. */
  private snapIntent(): void {
    this.aimTrack.snap([this.armYaw, this.armPitch]);
    this.rollTrack.snap([this.roll]);
    this.swivelTrack.snap([0]);
    this._swivelWant[0] = 0;
  }

  /**
   * The target pose: where the hand should be, and how the blade should be held.
   *
   * These two must be KINEMATICALLY CONSISTENT or the linear and angular drives
   * deadlock. The first version of this commanded the blade to lie along the
   * shoulder->hand line, which is only true with the elbow straight; at any bent
   * reach the two controllers fought and left a permanent error.
   *
   * So the elbow is solved for first, with ordinary two-bone trigonometry, and
   * the blade's target direction is taken from elbow->hand. Now both drives
   * describe the same pose and agree everywhere.
   *
   * This is not "using IK to place the arm" -- the solve only produces a
   * TARGET. The physical arm still has to get there under a clamped force and
   * frequently cannot, which is the entire point. Nothing here ever moves a
   * body directly.
   */
  private computeGhost(t: Tuning, steady = false, advance = false): void {
    // `steady` solves for the commanded aim as it will be once arrived, body
    // and all -- what a probe asks about. Otherwise the ghost is wherever the
    // followed intent has got to this step, hung from wherever the posture
    // has carried the shoulder.
    const pose = steady
      ? this.fighter.posture.steady(this.armYaw, this.armPitch, t, this._steadyPose)
      : this.fighter.posture.pose;
    if (steady) this.fighter.shoulderWorldFor(pose, this._shoulder);
    else this.fighter.shoulderWorld(this._shoulder);

    const yaw = this.fighter.yaw + (steady ? this.armYaw : this.aimTrack.pos[0]);
    const pitch = steady ? this.armPitch : this.aimTrack.pos[1];
    const roll = steady ? this.roll : this.rollTrack.pos[0];

    // Torso-forward is -Z, so the arm sweeps around that.
    const cp = Math.cos(pitch);
    this._v.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    this._ghostPos.copy(this._shoulder).addScaledVector(this._v, this.reach);

    // A hand being taken somewhere goes there instead, as far as the arm
    // reaches -- which, for a grip on its own back or a potion on the floor,
    // is further in and further out than an aim is ever let go. A probe asks
    // about an aim, and never sees it.
    const w = steady ? 0 : this.guideWeight;
    let reach = this.reach;
    let lo = this.minReach;
    let hi = this.maxReach;
    if (w > 0) {
      lo += (GUIDE_MIN_REACH * this.build.armLength - lo) * w;
      hi += (this.build.armLength - GUIDE_MARGIN * this.build.scale - hi) * w;
      this._ghostPos.lerp(this.guideAt, w);
      this._v.copy(this._ghostPos).sub(this._shoulder);
      reach = clamp(this._v.length(), lo, hi);
      this._v.normalize();
      this._ghostPos.copy(this._shoulder).addScaledVector(this._v, reach);
    }

    // A hand asked to be inside the body goes on its surface instead. Rare --
    // the posture has usually carried the shoulder far enough round that the
    // hand clears -- but a low hand pulled in and across can still ask for it.
    const margin = t.clearance * this.build.scale;
    const caps = margin > 0 ? this.fighter.trunkCapsules(pose) : null;
    if (caps && pushOut(this._ghostPos, this.handRadius, caps, margin)) {
      this._v.copy(this._ghostPos).sub(this._shoulder);
      reach = clamp(this._v.length(), lo, hi);
      this._v.normalize();
      this._ghostPos.copy(this._shoulder).addScaledVector(this._v, reach);
    }
    this._armDir.copy(this._v).normalize();

    // --- solve the elbow ---
    const d = clamp(reach, Math.abs(this.upperLen - this.foreLen) + 0.01, this.upperLen + this.foreLen - 0.01);
    const cosA = (this.upperLen * this.upperLen + d * d - this.foreLen * this.foreLen) / (2 * this.upperLen * d);
    const shoulderAngle = Math.acos(clamp(cosA, -1, 1));

    // Pole vector: which way the elbow points off the shoulder->hand line,
    // then rotated by the roll command.
    //
    // This is the crux of the control scheme. With a hinge elbow and no forearm
    // twist, swivelling the elbow around the shoulder->hand line and rolling the
    // cutting edge are THE SAME degree of freedom: the hand stays put, the elbow
    // swings around it, and the blade turns with the plane of the arm. Treating
    // them as two separate controls (a fixed pole plus a roll torque) had them
    // fighting each other for the same joint, which is what left 45 degrees of
    // standing orientation error. Q/E turns the whole arm, and the edge follows.
    //
    // The pole stays on the HULL even when the chest has turned. Swivel and
    // edge roll are one degree of freedom here, so the pole is what decides
    // which way the edge faces through a swing, and it was tuned against the
    // hull: hung off a turning chest instead it presented the flat, and cut
    // quality in a real sweep fell by half. The posture moves the shoulder;
    // the clearance pass below keeps the elbow out of the ribs.
    const torsoYaw = this.fighter.yaw;
    const right = this._refA.set(Math.cos(torsoYaw), 0, -Math.sin(torsoYaw));
    const back = this._refC.set(Math.sin(torsoYaw), 0, Math.cos(torsoYaw));
    const pole = this._refB.set(0, -POLE.down, 0)
      .addScaledVector(right, POLE.right)
      .addScaledVector(back, POLE.back)
      .normalize();
    // A guided hand hangs its elbow its own way, and the roll -- the edge the
    // mouse asked for -- is not what it is doing.
    const hang = this.guidePole;
    if (w > 0 && hang) {
      const own = this._refD.set(0, -hang.down, 0)
        .addScaledVector(right, hang.right)
        .addScaledVector(back, hang.back)
        .normalize();
      pole.lerp(own, w).normalize();
    }
    pole.applyQuaternion(this._q2.setFromAxisAngle(this._armDir, roll * (1 - w)));

    // The edge this pose presents, and the way its weapon points, are what
    // the aim and the roll asked for. Remember them before the body gets a
    // say: the wrist and the twist will hold them there.
    this.designOf(pole, shoulderAngle, this._askedEdge, this._askedDir);

    // Then swivel the elbow out of the ribs, if the pose put it there. The
    // roll is inside this now -- roll the elbow toward your own chest and it
    // stops at the ribs, and the forearm twist turns the rest of the way, as
    // a real one does when the shoulder has run out of room.
    const swivel = caps
      ? this.clearanceSwivel(pole, shoulderAngle, caps, margin, steady, advance)
      : this.relaxSwivel(steady, advance);
    if (swivel !== 0) pole.applyQuaternion(this._q2.setFromAxisAngle(this._armDir, swivel));

    // Swing the arm direction toward the pole by the shoulder angle.
    const axis = this._refC.crossVectors(this._armDir, pole);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();
    const elbowDir = this._refD.copy(this._armDir)
      .applyQuaternion(this._q2.setFromAxisAngle(axis, shoulderAngle));

    this._elbowTarget.copy(this._shoulder).addScaledVector(elbowDir, this.upperLen);
    const foreDir = this._foreTarget.copy(this._ghostPos).sub(this._elbowTarget).normalize();

    // --- hinge axis: normal of the shoulder/elbow/hand plane ---
    // The elbow hinges about this axis, so both segments must adopt it as
    // their local X or the joint fights the pose. Taking cross(fore, elbow)
    // rather than the reverse puts the bend on the negative side, which is the
    // side the joint limits allow.
    const hinge = this._refA.crossVectors(foreDir, elbowDir);
    if (hinge.lengthSq() < 1e-8) hinge.set(1, 0, 0); else hinge.normalize();
    this._m.makeBasis(hinge, elbowDir, this._refB.crossVectors(hinge, elbowDir));
    this._upperQuat.setFromRotationMatrix(this._m);

    // --- forearm target: +Y along the forearm, +X the shared hinge axis ---
    // The elbow physically forces the forearm's X to match the upper arm's, so
    // asking for anything else here would be a target the joint cannot honour.
    // The blade's cutting edge is its local Z, which lands in the plane of the
    // arm -- where an edge has to be to lead a cut rather than slap with the flat.
    this._m.makeBasis(hinge, foreDir, this._refC.crossVectors(hinge, foreDir));
    this._ghostQuat.setFromRotationMatrix(this._m);

    // --- the weapon: the forearm's orientation, bent at the wrist toward the
    // line that was asked for, then turned in the grip toward the edge ---
    this.wristBend();
    const bent = this._bentQuat.copy(this._ghostQuat).multiply(this._bendQuat);
    const bladeDir = this._bladeDir.set(0, 1, 0).applyQuaternion(bent);
    const neutral = this._neutralEdge.set(0, 0, 1).applyQuaternion(bent);
    const twist = this.twistFor(bladeDir, neutral, steady, advance);
    const turn = this._qa.setFromAxisAngle(this._ta.set(0, 1, 0), twist);
    this._bladeQuat.copy(bent).multiply(turn);
    if (!steady) {
      this.twistTarget = twist;
      this._wristTarget.copy(this._bendQuat);
    }

    // The percussion point of the pose asked for, which is what a fighter
    // watching its own blade watches. Not for probes: they are hypothetical.
    if (!steady) {
      this._look.copy(bladeDir)
        .multiplyScalar(this.gripping ? this.weapon.grip + this.weapon.span * this.strikePoint : 0)
        .add(this._ghostPos);
    }
  }

  /**
   * The wrist's bend, forearm-local, into `_bendQuat`: the least turn that
   * lays the forearm's line onto the line that was asked for, as far as the
   * wrist reaches.
   *
   * None at all unless the clearance has swivelled the elbow off its design,
   * since the asked-for line IS the design's forearm -- so everywhere the body
   * is not in the way, the weapon still continues the forearm exactly.
   */
  private wristBend(): void {
    const local = this._ta.copy(this._askedDir)
      .applyQuaternion(this._qc.copy(this._ghostQuat).invert());
    const angle = Math.acos(clamp(local.y, -1, 1));
    // The forearm's +Y crossed with the asked line: the axis to bend about.
    const axis = this._tb.set(local.z, 0, -local.x);
    if (angle < 1e-6 || axis.lengthSq() < 1e-12) {
      this._bendQuat.identity();
      return;
    }
    this._bendQuat.setFromAxisAngle(axis.normalize(), Math.min(angle, WRIST_REACH));
  }

  /**
   * What a pole would present with the hand unturned: the elbow solved from
   * it, and read off the result the cutting edge -- which lies in the plane
   * of the arm, square to the forearm -- into `edge`, and the forearm's line,
   * which the weapon continues, into `dir`.
   */
  private designOf(
    pole: THREE.Vector3, shoulderAngle: number, edge: THREE.Vector3, dir: THREE.Vector3,
  ): void {
    const axis = this._ta.crossVectors(this._armDir, pole);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();
    const elbowDir = this._tb.copy(this._armDir)
      .applyQuaternion(this._qa.setFromAxisAngle(axis, shoulderAngle));
    const fore = this._tc.copy(this._shoulder).addScaledVector(elbowDir, this.upperLen)
      .negate().add(this._ghostPos).normalize();
    const hinge = axis.crossVectors(fore, elbowDir);
    if (hinge.lengthSq() < 1e-8) hinge.set(1, 0, 0); else hinge.normalize();
    dir.copy(fore);
    edge.crossVectors(hinge, fore);
  }

  /**
   * How far to turn the grip so the edge faces where it was asked, as nearly
   * as the weapon's actual direction allows: the asked-for edge laid square
   * to the weapon, measured round it from `neutral`, the edge an untwisted
   * grip gives on the forearm as the wrist has bent it.
   *
   * Zero whenever the clearance has not moved the elbow, which is nearly
   * always -- the weapon is then exactly where it was welded.
   *
   * The edge is symmetric, so an edge half a turn round is the same edge;
   * of the three ways to present it, the one nearest the last is kept, so the
   * grip does not flick between them. Only when that one would run past what
   * a forearm can turn is it given up for the nearest to square -- a regrip,
   * swung through at the twist's own speed. A point has no edge to present,
   * and is held square.
   */
  private twistFor(
    bladeDir: THREE.Vector3, neutral: THREE.Vector3, steady: boolean, advance: boolean,
  ): number {
    const last = steady ? 0 : this.twistTarget;
    if (this.weapon.bite === "point") return 0;

    const asked = this._tb.copy(this._askedEdge)
      .addScaledVector(bladeDir, -this._askedEdge.dot(bladeDir));
    if (asked.lengthSq() < 1e-6) return last;
    asked.normalize();
    const raw = Math.atan2(this._tc.crossVectors(neutral, asked).dot(bladeDir), neutral.dot(asked));

    let pick = raw;
    for (const c of [raw - Math.PI, raw + Math.PI]) {
      if (Math.abs(c - last) < Math.abs(pick - last)) pick = c;
    }
    if (Math.abs(pick) > TWIST_REACH) {
      for (const c of [raw, raw - Math.PI, raw + Math.PI]) {
        if (Math.abs(c) < Math.abs(pick)) pick = c;
      }
      // Both faces of the edge can lie past the reach once the wrist has
      // bent; the grip then turns as far as it goes and no further, rather
      // than leaning on its stop.
      pick = clamp(pick, -TWIST_REACH, TWIST_REACH);
    }
    // A probe restoring the ghost must not move the grip's memory on.
    return steady || advance ? pick : this.twistTarget;
  }

  /**
   * The swivel that keeps the elbow and both bones clear of the trunk: the
   * least departure from the designed pole that does it, since the pole is
   * also the edge.
   *
   * A probe takes the answer as it stands. The live ghost follows it through
   * a tracker, and only `drive` advances that -- a probe restoring the ghost
   * afterwards must not also move it on.
   */
  private clearanceSwivel(
    pole: THREE.Vector3, shoulderAngle: number, caps: readonly Capsule[],
    margin: number, steady: boolean, advance: boolean,
  ): number {
    // A probe asks where a held aim would settle. The live arm asks where the
    // elbow can get to from where it is, and the answer comes back already
    // unwrapped for the way round it chose.
    const want = this.swivelSearch.solve(
      this._shoulder, this._armDir, pole, shoulderAngle, this.upperLen,
      this._ghostPos, this.radii, caps, margin,
      steady ? null : this.swivelTrack.pos[0]);
    if (steady) return want;
    this._swivelWant[0] = want;
    return this.followSwivel(advance);
  }

  /** With clearance off, any swivel still in hand unwinds back to the design. */
  private relaxSwivel(steady: boolean, advance: boolean): number {
    if (steady) return 0;
    const at = this.swivelTrack.pos[0];
    this._swivelWant[0] = at - wrap(at);
    return this.followSwivel(advance);
  }

  private followSwivel(advance: boolean): number {
    if (advance) {
      this.swivelTrack.step(this._swivelWant, SWIVEL_SPEED, SWIVEL_ACCEL,
        this.phys.world.timestep);
    }
    return this.swivelTrack.pos[0];
  }

  // -------------------------------------------------------------------------
  // The PD drive
  // -------------------------------------------------------------------------

  /** Call once per fixed step, immediately before `world.step()`. */
  drive(t: Tuning): void {
    // The posture has moved the shoulder since last step: take the joint with
    // it before anything is solved from it, so the arm hangs from the point
    // its ghost is measured from. Before the early return below, too -- a
    // forearm cut off at the elbow still leaves an upper arm on this joint,
    // and it has to hang from where the shoulder is drawn.
    this.shoulderJoint?.setAnchor1(this.fighter.shoulderAnchor);

    // A sword going up or coming out is finished where it is, or dropped
    // home, by anything that takes the arm away from it; otherwise it goes
    // on a step. Before the ghost, which it may be guiding.
    if (this.stow && (this.severedAt !== null || this.limp)) this.abortStow();
    if (this.stow) this.stepStow(this.phys.world.timestep);

    // A sword on the back rides the back, whatever the arm is doing -- a body
    // on the floor, a limb cut off -- so this goes before anything returns.
    if (this.sheathedNow) this.holdSheathed(false);

    // A detached arm is meat. Continuing to run the PD on it would have the
    // controller flying a severed limb around the room by itself -- and the
    // grip's motor, left running, would go on turning the weapon in its hand.
    //
    // Not running it is not enough, either: Rapier keeps a user force until
    // it is cleared, so the last step's drive -- a few hundred newtons at the
    // hand, and the gravity feed-forward -- went on pushing forever. A dead
    // goblin's arm dragged its own corpse six metres across the floor in ten
    // seconds and threw it into the air. Limp has to mean nothing at all.
    if (this.severedAt !== null || this.limp) {
      for (const b of [this.upper, this.fore, this.blade]) {
        b.resetForces(false);
        b.resetTorques(false);
      }
      if (this.severedAt === "elbow" && !this.limp) this.tuckStump();
      this.slackenGrip();
      this.updateDerived();
      this.snapshotBlade();
      this.sampleTip();
      return;
    }

    this.computeGhost(t, false, true);
    this.measureGhost(this.phys.world.timestep);

    // Rapier keeps user forces until they're cleared, so a missed reset would
    // make the arm accelerate without bound.
    this.fore.resetForces(false);
    this.fore.resetTorques(false);
    this.upper.resetForces(false);
    this.upper.resetTorques(false);
    this.blade.resetForces(false);
    this.blade.resetTorques(false);
    const holding = this.gripping;

    // Gravity feed-forward. Without it the PD has to spend a standing 45N just
    // holding the sword up, and since a proportional controller only produces
    // force from error, that shows up as a permanent ~5cm sag below wherever
    // you point. Cancelling it per-body at the centre of mass needs no
    // compensating torque and leaves every gram of inertia intact -- the swing
    // is exactly as heavy as before, it just no longer droops at rest.
    this.applyGravityFeedForward(t);

    const fq = this.fore.rotation();
    this._q.set(fq.x, fq.y, fq.z, fq.w);

    // Hand = the far end of the forearm, in world space.
    const offset = this._v.set(0, this.foreHalf, 0).applyQuaternion(this._q);
    const fp = this.fore.translation();
    this._handPos.set(fp.x + offset.x, fp.y + offset.y, fp.z + offset.z);

    // v_point = v_com + omega x r
    const lv = this.fore.linvel();
    const av = this.fore.angvel();
    this._handVel.set(
      lv.x + (av.y * offset.z - av.z * offset.y),
      lv.y + (av.z * offset.x - av.x * offset.z),
      lv.z + (av.x * offset.y - av.y * offset.x),
    );
    this.measureAccel(this.phys.world.timestep);

    // --- linear: F = kp*e - kd*v, clamped ---
    const err = this._v2.copy(this._ghostPos).sub(this._handPos);
    this.state.trackingError = err.length();

    const maxForce = t.maxForce * this.power;
    // An empty hand is a fraction of the mass the linear drive was tuned to
    // push: see EMPTY_HAND.
    const lin = holding ? 1 : EMPTY_HAND;
    // Damped against the hand's own motion -- except for as much of it as is
    // following a guide. The lag that leaves behind a moving ghost is what an
    // aim is meant to feel, but a hand taking a grip off its own back that
    // trailed it by a hand's breadth would be holding air.
    const moving = this._relVel.copy(this._handVel)
      .addScaledVector(this._ghostVel, -this.guideWeight);
    const force = err.multiplyScalar(t.armKp * this.power * lin)
      .addScaledVector(moving, -t.armKd * this.power * lin);
    const mag = force.length();
    this.state.saturation = maxForce > 0 ? Math.min(1, mag / maxForce) : 1;
    if (mag > maxForce) force.multiplyScalar(maxForce / mag);

    this.fore.addForceAtPoint(
      { x: force.x, y: force.y, z: force.z },
      { x: this._handPos.x, y: this._handPos.y, z: this._handPos.z },
      true,
    );

    // --- angular: bring the blade onto the target orientation ---
    //
    // The error is NOT folded into the nearer half-turn, although the blade is
    // symmetric and either edge would cut. It used to be, and that was the
    // snap. Turning the forearm half a turn about its own length negates the
    // elbow's hinge axis, and with the hand and the forearm's direction fixed
    // the elbow point is fixed too -- so the only arm that matches the folded
    // target is one bent backwards, which the joint limit forbids. Whenever a
    // swing left the swivel more than a quarter turn behind, the fold picked
    // that impossible target; at exactly a quarter turn the two tied and the
    // torque reversed from step to step, pinning the arm there, saturated,
    // while the elbow drifted straight. At straight the arm's inertia about
    // its own length is nearly nothing, the chain flipped over, and the forearm
    // spun at 150-170 rad/s. Without the fold the arm swivels round the way a
    // shoulder actually can, and arrives.
    this._q2.copy(this._q).invert().premultiply(this._ghostQuat);
    if (this._q2.w < 0) this._q2.set(-this._q2.x, -this._q2.y, -this._q2.z, -this._q2.w);

    const sinHalf = Math.sqrt(this._q2.x ** 2 + this._q2.y ** 2 + this._q2.z ** 2);
    const error = this._tb.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      const angle = 2 * Math.atan2(sinHalf, this._q2.w);
      error.set(this._q2.x, this._q2.y, this._q2.z).multiplyScalar(angle / sinHalf);
    }

    const kpRot = t.armKpRot * this.power;
    const kdRot = t.armKdRot * this.power;

    if (!holding) {
      // The hand is empty. The drive was tuned on a forearm with a weapon in
      // it, and without one the forearm's swing and the upper arm's roll --
      // one motion, when the elbow is bent -- weigh a fraction of what the
      // drive assumed: both drives damping it at once flipped it back and
      // forth every step. So each bone gets only what its own inertia can
      // take about each of its axes, as the off arm does.
      this.applyEmptyHanded(t, error, av);
      this.state.roll = this.state.twist = this.state.wrist = 0;
      this.applyClearance(t);
      this.snapshotBlade();
      this.sampleTip();
      return;
    }
    const torque = this._v.copy(error).multiplyScalar(kpRot);
    torque.x -= av.x * kdRot;
    torque.y -= av.y * kdRot;
    torque.z -= av.z * kdRot;

    // The roll about the forearm's own length: let go of it near a straight
    // elbow, and keep it inside what its inertia can take everywhere else.
    const bend = this.elbowBend();
    const rollGain = smoothstep(ROLL_FADE_FROM, ROLL_FADE_TO, bend);
    const sin2 = Math.sin(bend) ** 2;
    // And step back as the wrist bends: a bent weapon's share of the drive,
    // below, turns the forearm about its length as well -- by as much as the
    // sine of the bend -- and the two together over-drove a roll that is no
    // heavier than either assumed, flipping it back and forth every step.
    const wristGain = 1 - smoothstep(WRIST_ROLL_FROM, WRIST_ROLL_TO,
      2 * Math.acos(Math.min(1, Math.abs(this._wristTarget.w))));
    this.boundRoll(
      torque, this._ta.set(0, 1, 0).applyQuaternion(this._q), error, av,
      kpRot, kdRot, this.foreRoll + this.upperRoll + this.upperSwing * sin2,
      rollGain * wristGain);

    // The weapon's share of the swing. The drive was tuned on a forearm and a
    // weapon welded into one body, and it only works on a body that heavy:
    // behind a wrist the forearm alone is a fraction of it, and the same
    // damping over-corrected it every step. So the swing is shared out the way
    // the weld shared it, by how much of the turning each carries, each part
    // toward its own target -- and the wrist is left holding only what they
    // disagree about. Each part's own roll stays with it: the forearm's with
    // its drive above, the weapon's with the grip.
    const foreAxis = this._ta.set(0, 1, 0).applyQuaternion(this._q);
    const along = torque.dot(foreAxis);
    torque.addScaledVector(foreAxis, -along).multiplyScalar(1 - this.weaponShare)
      .addScaledVector(foreAxis, along);
    const bladeTorque = this.weaponTorque(kpRot, kdRot);

    const maxTorque = t.maxTorque * this.power;
    const tmag = torque.length() + bladeTorque.length();
    this.state.torqueSaturation = maxTorque > 0 ? Math.min(1, tmag / maxTorque) : 1;
    if (tmag > maxTorque) {
      torque.multiplyScalar(maxTorque / tmag);
      bladeTorque.multiplyScalar(maxTorque / tmag);
    }
    this.fore.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
    this.blade.addTorque({ x: bladeTorque.x, y: bladeTorque.y, z: bladeTorque.z }, true);

    // The upper arm gets the same treatment from the same solve. Without it
    // the elbow swivel is left to gravity, the physical forearm ends up pointing
    // somewhere the target never predicted, and the angular drive spends itself
    // fighting the hand instead of aiming the blade.
    this.applyUpperArmTorque(t, rollGain * wristGain, sin2);

    // The weapon bent at the wrist and turned in the grip, toward the line
    // and the edge that were asked for.
    this.applyGrip(t);

    // And the body pushing back, for whatever the target could not prevent.
    this.applyClearance(t);

    this.snapshotBlade();
    this.sampleTip();
  }

  /**
   * What is left of an arm cut at the elbow, held in against the ribs.
   *
   * Left to hang, a stump swings from its shoulder like anything else on a
   * ball joint, and every step back its owner took flung it out in front and
   * up past its head. Somebody holding a wound keeps it still: a gentle hold,
   * down the side and a little in front, inside what the bone's own inertia
   * can take and never more than a hand's strength.
   */
  private tuckStump(): void {
    const dt = this.phys.world.timestep;
    const f = this.fighter;
    const want = this._refA.copy(STUMP_HANG)
      .applyQuaternion(f.posture.chestQuat(f.posture.pose, this._q2))
      .applyAxisAngle(this._v.set(0, 1, 0), f.yaw)
      .normalize();
    const r = this.upper.rotation();
    const along = this._refB.set(0, 1, 0).applyQuaternion(this._q.set(r.x, r.y, r.z, r.w));
    const angle = Math.acos(clamp(along.dot(want), -1, 1));
    const err = this._refC.crossVectors(along, want);
    if (err.lengthSq() > 1e-12) err.setLength(angle); else err.set(0, 0, 0);
    const w = this.upper.angvel();
    const torque = stablePD(this.upper, err, this._v.set(w.x, w.y, w.z),
      STUMP_KP * this.power, STUMP_KD * this.power, dt, this._tb);
    const cap = STUMP_TORQUE * this.power;
    if (torque.length() > cap) torque.setLength(cap);
    this.upper.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
  }

  /**
   * The angular drive with nothing in the hand: each bone toward its own
   * target, every axis held inside what its inertia can take. `error` and
   * `av` are the forearm's, as `drive` measured them.
   */
  private applyEmptyHanded(
    t: Tuning, error: THREE.Vector3, av: { x: number; y: number; z: number },
  ): void {
    const dt = this.phys.world.timestep;
    const kp = t.armKpRot * this.power;
    const kd = t.armKdRot * this.power;
    const maxTorque = t.maxTorque * this.power;

    const fore = stablePD(this.fore, this._refA.copy(error),
      this._refB.set(av.x, av.y, av.z), kp, kd, dt, this._refC);
    let tmag = fore.length();
    this.state.torqueSaturation = maxTorque > 0 ? Math.min(1, tmag / maxTorque) : 1;
    if (tmag > maxTorque) fore.multiplyScalar(maxTorque / tmag);
    this.fore.addTorque({ x: fore.x, y: fore.y, z: fore.z }, true);

    const uq = this.upper.rotation();
    const e = this._q4.copy(this._q3.set(uq.x, uq.y, uq.z, uq.w)).invert()
      .premultiply(this._upperQuat);
    if (e.w < 0) e.set(-e.x, -e.y, -e.z, -e.w);
    const sinHalf = Math.hypot(e.x, e.y, e.z);
    const upperErr = this._refA.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      upperErr.set(e.x, e.y, e.z).multiplyScalar((2 * Math.atan2(sinHalf, e.w)) / sinHalf);
    }
    const w = this.upper.angvel();
    const upper = stablePD(this.upper, upperErr, this._refB.set(w.x, w.y, w.z),
      kp * UPPER_TORQUE_SCALE, kd * UPPER_TORQUE_SCALE, dt, this._refD);
    tmag = upper.length();
    const cap = maxTorque * UPPER_TORQUE_SCALE;
    if (tmag > cap) upper.multiplyScalar(cap / tmag);
    this.upper.addTorque({ x: upper.x, y: upper.y, z: upper.z }, true);
  }

  /**
   * The weapon's share of the angular drive, toward its own target, into
   * `_refD`: the same law as the forearm's, scaled by `weaponShare`, with
   * nothing about the weapon's own length -- that is the grip's to turn.
   */
  private weaponTorque(kp: number, kd: number): THREE.Vector3 {
    const bq = this.blade.rotation();
    const qb = this._q3.set(bq.x, bq.y, bq.z, bq.w);
    const e = this._q4.copy(qb).invert().premultiply(this._bladeQuat);
    if (e.w < 0) e.set(-e.x, -e.y, -e.z, -e.w);
    const sinHalf = Math.hypot(e.x, e.y, e.z);
    const out = this._refD.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      out.set(e.x, e.y, e.z).multiplyScalar((2 * Math.atan2(sinHalf, e.w)) / sinHalf);
    }
    const w = this.blade.angvel();
    out.multiplyScalar(kp).sub(this._refC.set(w.x, w.y, w.z).multiplyScalar(kd));
    const axis = this._refC.set(0, 1, 0).applyQuaternion(qb);
    return out.addScaledVector(axis, -out.dot(axis)).multiplyScalar(this.weaponShare);
  }

  /**
   * The hand: bend the wrist toward `_wristTarget` and turn the grip toward
   * `twistTarget`.
   *
   * Through the joint's own motors, as velocity servos: each is asked to turn
   * the weapon at a speed that closes the gap, and pushes in proportion to
   * how far short of that it is. Two reasons it is the motors and not a
   * torque of our own, as every other drive here is.
   *
   * A weapon's inertia about its own length is tiny -- 0.0002 kg·m² for the
   * sword -- and an explicit servo on something that light can only be
   * stable by being soft. Soft, the grip could not hold against a shaft
   * dragged along the floor: friction at a 1.7cm radius rolled the goblin's
   * spear up to 880 rad/s. The motors are solved implicitly, stiff and stable
   * at any inertia.
   *
   * And their authority is still bounded, which Rapier's motors otherwise do
   * not offer: with the wanted speed capped, a weapon that cannot move at all
   * -- wedged in stone -- gets `twistTorque` about its own length and
   * `wristTorque` about each of the wrist's two axes, and no more.
   */
  private applyGrip(t: Tuning): void {
    const fq = this.fore.rotation();
    const bq = this.blade.rotation();
    const qf = this._qa.set(fq.x, fq.y, fq.z, fq.w);
    const qb = this._qb.set(bq.x, bq.y, bq.z, bq.w);

    // How far off the whole weapon is, edge included: the HUD's roll readout.
    this.state.roll = 2 * Math.acos(Math.min(1, Math.abs(qb.dot(this._bladeQuat))));

    // The hand as it is, seen from the forearm: a bend, then a turn about the
    // weapon's own length. The turn is the grip's twist, the rest the wrist.
    const rel = this._qc.copy(qf).invert().multiply(qb);
    const turn = wrapPi(2 * Math.atan2(rel.y, rel.w));
    this.state.twist = turn;
    this.state.wrist = 2 * Math.acos(Math.min(1, Math.hypot(rel.y, rel.w)));

    // The joint is built from the weapon's side, so it measures the forearm
    // as seen from the weapon: every angle and speed below is the negative of
    // the hand's own.

    // The twist, as before: a capped velocity servo on the grip's own turn.
    if (!this.wristJoint) return;
    const raw = this.gripRaw;
    const h = this.wristJoint.handle;
    const want = clamp(TWIST_RATE * wrapPi(this.twistTarget - turn), -TWIST_SPEED, TWIST_SPEED);
    raw.jointConfigureMotorVelocity(h, ANG_Y, -want, (t.twistTorque * this.power) / TWIST_SPEED);

    // The bend: the same kind of servo on the weapon's two cross axes, toward
    // the line the wrist was asked to bend it onto. The error is the least
    // turn from the weapon's line as it is to that one, seen from the weapon,
    // so it has nothing about the weapon's own length in it -- that is the
    // twist's. (Not springs on the joint's own angles: Rapier reads a ball
    // joint's angles off its quaternion, where each cross axis's reading
    // moves with the other's once the grip is turned, and two springs that
    // push each other sideways circulate. With the grip at its stop the
    // forearm settled into a steady 12 rad/s roll.)
    const now = this._ta.set(0, 1, 0).applyQuaternion(rel);
    const line = this._tb.set(0, 1, 0).applyQuaternion(this._wristTarget);
    const axis = this._tc.crossVectors(now, line);
    const sin = axis.length();
    const bend = Math.atan2(sin, now.dot(line));
    if (sin > 1e-9) axis.multiplyScalar(bend / sin); else axis.set(0, 0, 0);
    // Into the weapon's frame, which the joint's motors push in.
    axis.applyQuaternion(this._q4.copy(rel).invert());
    const factor = (t.wristTorque * this.power) / WRIST_SPEED;
    raw.jointConfigureMotorVelocity(h, ANG_X,
      -clamp(WRIST_RATE * axis.x, -WRIST_SPEED, WRIST_SPEED), factor);
    raw.jointConfigureMotorVelocity(h, ANG_Z,
      -clamp(WRIST_RATE * axis.z, -WRIST_SPEED, WRIST_SPEED), factor);
  }

  /** Let go of the grip: a hand nothing is driving holds its weapon loosely. */
  private slackenGrip(): void {
    if (!this.wristJoint) return;
    const raw = this.gripRaw;
    const h = this.wristJoint.handle;
    for (const axis of [ANG_X, ANG_Y, ANG_Z]) {
      raw.jointConfigureMotorVelocity(h, axis, 0, SLACK_GRIP);
    }
  }

  /**
   * The hand joint's raw handle set, for the per-axis limits and motors a
   * ball joint has underneath but Rapier's typed wrapper does not expose.
   */
  private get gripRaw(): GripRaw {
    return (this.wristJoint as unknown as { rawSet: GripRaw }).rawSet;
  }

  /**
   * The trunk's repulsion on the real limb: the elbow and the stretch of
   * upper arm above it push the upper arm out, the middle of the forearm and
   * the hand push the forearm out.
   *
   * Applied at the point itself, so a push on the elbow turns the upper arm
   * about the shoulder rather than shoving it bodily. Scaled by the fighter's
   * power: a bigger animal's arm is heavier and its body pushes harder.
   */
  private applyClearance(t: Tuning): void {
    this.state.clearance = 0;
    if (t.clearance <= 0) return;
    const caps = this.fighter.trunkCapsules(this.fighter.posture.pose);

    let deepest = 0;
    for (const { body, along, radius } of this.contactPoints) {
      const bq = body.rotation();
      const r = this._refA.set(0, along, 0).applyQuaternion(this._q3.set(bq.x, bq.y, bq.z, bq.w));
      const c = body.translation();
      const point = this._refB.set(c.x + r.x, c.y + r.y, c.z + r.z);
      const lv = body.linvel();
      const av = body.angvel();
      const vel = this._refC.set(
        lv.x + (av.y * r.z - av.z * r.y),
        lv.y + (av.z * r.x - av.x * r.z),
        lv.z + (av.x * r.y - av.y * r.x),
      );
      const depth = repulsion(point, radius, vel, caps, this.power, this._refD);
      if (depth <= 0) continue;
      deepest = Math.max(deepest, depth);
      body.addForceAtPoint(
        { x: this._refD.x, y: this._refD.y, z: this._refD.z },
        { x: point.x, y: point.y, z: point.z },
        true,
      );
    }
    this.state.clearance = deepest;
  }

  /**
   * The hand's acceleration, smoothed and capped, for the body to react to.
   *
   * Differenced from the hand's velocity rather than read off the drive
   * force, so it is the acceleration the arm actually managed -- including
   * the lurch of a blade that has just been stopped, which the cap keeps
   * from turning into a full-body spasm.
   */
  private measureAccel(dt: number): void {
    if (this._accelPrimed) {
      const raw = this._v2.copy(this._handVel).sub(this._prevHandVel).multiplyScalar(1 / dt);
      const len = raw.length();
      if (len > ACCEL_CAP) raw.multiplyScalar(ACCEL_CAP / len);
      this._handAccel.lerp(raw, ACCEL_SMOOTHING);
    }
    this._prevHandVel.copy(this._handVel);
    this._accelPrimed = true;
  }

  /**
   * What this arm asks of the body this step: the followed intent and how
   * fast it is moving, how hard the hand is accelerating, how hard the drive
   * is straining, and where the blade is meant to be.
   *
   * Null once there is no arm to carry. Read BEFORE `drive`, so the body is
   * placed for this step before the ghost is solved from its shoulder.
   */
  postureDrive(): PostureDrive | null {
    if (this.severedAt !== null || this.limp) return null;
    const d = this._drive;
    d.yaw = this.aimTrack.pos[0];
    d.pitch = this.aimTrack.pos[1];
    d.yawRate = this.aimTrack.vel[0];
    d.pitchRate = this.aimTrack.vel[1];
    // The body wants it in its own frame: +X is the sword side, -Z forward.
    d.accel.copy(this._handAccel).applyAxisAngle(this._v.set(0, 1, 0), -this.fighter.yaw);
    d.strain = this.state.saturation;
    d.look = this._look;
    return d;
  }

  /** How fast the ghost is going, from where it was last step. */
  private measureGhost(dt: number): void {
    if (this._ghostPrimed) this._ghostVel.copy(this._ghostPos).sub(this._prevGhost).divideScalar(dt);
    else this._ghostVel.set(0, 0, 0);
    this._prevGhost.copy(this._ghostPos);
    this._ghostPrimed = true;
  }

  /** Cancels `gravityComp` of each limb segment's weight at its own centre of mass. */
  private applyGravityFeedForward(t: Tuning): void {
    if (t.gravityComp <= 0) return;
    const up = -t.gravity * t.gravityComp;
    for (const body of [this.upper, this.fore, this.blade]) {
      // A weapon out of the hand is carried by the back, or by the stow, and
      // not held up by the arm.
      if (body === this.blade && !this.gripping) continue;
      body.addForce({ x: 0, y: body.mass() * up, z: 0 }, false);
    }
  }

  /**
   * Angular PD holding the upper arm on the solved shoulder->elbow direction.
   * `rollGain` and `sin2` (the squared sine of the elbow's bend) bound its
   * roll about its own length, as for the forearm.
   */
  private applyUpperArmTorque(t: Tuning, rollGain: number, sin2: number): void {
    const uq = this.upper.rotation();
    this._q3.set(uq.x, uq.y, uq.z, uq.w);
    this._q4.copy(this._q3).invert().premultiply(this._upperQuat);
    if (this._q4.w < 0) {
      this._q4.set(-this._q4.x, -this._q4.y, -this._q4.z, -this._q4.w);
    }

    const sinHalf = Math.sqrt(this._q4.x ** 2 + this._q4.y ** 2 + this._q4.z ** 2);
    const error = this._tb.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      const angle = 2 * Math.atan2(sinHalf, this._q4.w);
      error.set(this._q4.x, this._q4.y, this._q4.z).multiplyScalar(angle / sinHalf);
    }
    const kp = t.armKpRot * UPPER_TORQUE_SCALE * this.power;
    const kd = t.armKdRot * UPPER_TORQUE_SCALE * this.power;
    const av = this.upper.angvel();
    const torque = this._v.copy(error).multiplyScalar(kp);
    torque.x -= av.x * kd;
    torque.y -= av.y * kd;
    torque.z -= av.z * kd;

    this.boundRoll(
      torque, this._ta.set(0, 1, 0).applyQuaternion(this._q3), error, av,
      kp, kd, this.upperRoll + this.foreRoll + this.foreSwing * sin2, rollGain);

    const cap = t.maxTorque * UPPER_TORQUE_SCALE * this.power;
    const tmag = torque.length();
    if (tmag > cap) torque.multiplyScalar(cap / tmag);
    this.upper.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
  }

  /**
   * Freeze the blade's motion as of THIS step, before the solver runs.
   *
   * Contact events are drained after `world.step()`, by which point the solver
   * has already stopped the blade dead against whatever it hit. Reading the
   * blade's live velocity there reports the speed it ended at -- near zero --
   * so a 24 m/s cut scored as a 0.1 m/s nudge and did no damage at all. Damage
   * has to be computed from how fast the blade was travelling as it ARRIVED,
   * which is the state captured here.
   */
  private snapshotBlade(): void {
    const p = this.blade.translation();
    const r = this.blade.rotation();
    const lv = this.blade.linvel();
    const av = this.blade.angvel();
    this._prePos.set(p.x, p.y, p.z);
    this._preQuat.set(r.x, r.y, r.z, r.w);
    this._preLin.set(lv.x, lv.y, lv.z);
    this._preAng.set(av.x, av.y, av.z);
  }

  /**
   * Blade tip position and velocity — used for impact quality. With the
   * weapon on the back there is no blade to speak of: this is the empty hand,
   * which is what the camera frames and what anyone watching your arm sees.
   */
  private sampleTip(): void {
    if (this.sheathedNow) {
      this.handSample(this._tipPos, this._tipVel);
      this.state.tipSpeed = this._tipVel.length();
      return;
    }
    const bq = this.blade.rotation();
    this._q.set(bq.x, bq.y, bq.z, bq.w);
    const r = this._v.set(0, this.tipY, 0).applyQuaternion(this._q);
    const bp = this.blade.translation();
    this._tipPos.set(bp.x + r.x, bp.y + r.y, bp.z + r.z);

    const lv = this.blade.linvel();
    const av = this.blade.angvel();
    this._tipVel.set(
      lv.x + (av.y * r.z - av.z * r.y),
      lv.y + (av.z * r.x - av.x * r.z),
      lv.z + (av.x * r.y - av.y * r.x),
    );
    this.state.tipSpeed = this._tipVel.length();
  }

  get tipPosition(): THREE.Vector3 { return this._tipPos; }
  get tipVelocity(): THREE.Vector3 { return this._tipVel; }

  /**
   * The axis of the weapon that does the damage, as of the pre-step snapshot.
   *
   * A blade cuts with its edge, which is its local +Z; a spear stabs with its
   * point, which is its length, local +Y. Taken from the same instant as
   * `velocityAt`, so alignment and closing speed describe one moment rather
   * than two.
   */
  biteDirection(out: THREE.Vector3): THREE.Vector3 {
    if (this.weapon.bite === "point") out.set(0, 1, 0);
    else out.set(0, 0, 1);
    return out.applyQuaternion(this._preQuat);
  }

  /**
   * A point on the weapon, 0 at the guard and 1 at the tip, in world space.
   *
   * The line it traces is the weapon's own -- straight up the middle for a
   * sword or a spear, out along the leading edge for an axe head that stands
   * proud of its haft.
   */
  pointAlongBlade(t: number, out: THREE.Vector3): THREE.Vector3 {
    const bq = this.blade.rotation();
    const bp = this.blade.translation();
    this.weapon.samplePoint(t, out)
      .applyQuaternion(this._q2.set(bq.x, bq.y, bq.z, bq.w));
    return out.set(bp.x + out.x, bp.y + out.y, bp.z + out.z);
  }

  /** Blade velocity at a world point, from the pre-step snapshot. */
  velocityAt(point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const rx = point.x - this._prePos.x;
    const ry = point.y - this._prePos.y;
    const rz = point.z - this._prePos.z;
    const lv = this._preLin;
    const av = this._preAng;
    return out.set(
      lv.x + (av.y * rz - av.z * ry),
      lv.y + (av.z * rx - av.x * rz),
      lv.z + (av.x * ry - av.y * rx),
    );
  }

  /** Blade orientation as of the pre-step snapshot, for blade-local maths. */
  get snapshotQuat(): THREE.Quaternion { return this._preQuat; }
  get snapshotPos(): THREE.Vector3 { return this._prePos; }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  private buildMeshes(skinColour: number): void {
    const skin = new THREE.MeshStandardMaterial({ color: skinColour, roughness: 0.65 });
    const upper = this.build.segment.upperArm;
    const fore = this.build.segment.foreArm;

    // Both bodies are built with local +Y running from the shoulder out toward
    // the hand, so the limb tapers from -Y to +Y and the hand goes at +foreHalf.
    this.upperMesh = shellMesh(skin, {
      from: upper.radius * 1.06, to: upper.radius * 0.84,
      length: upper.length, belly: 1.05,
    });
    this.foreMesh = shellMesh(skin, {
      from: fore.radius, to: fore.radius * 0.68,
      length: fore.length, belly: 1.05,
    });

    const elbow = jointBall(fore.radius * 1.15, skin);
    elbow.position.y = this.upperHalf;
    this.upperMesh.add(elbow);

    this.group.add(this.upperMesh, this.foreMesh);

    this.bladeMesh = this.weapon.build();
    this.group.add(this.bladeMesh);

    // A hand around the grip, or the weapon grows out of a tapered stump. It
    // rides the weapon rather than the forearm, so a turn of the grip turns
    // the hand with it: the forearm is drawn round, and its own twist along
    // its length would not show anyway.
    const hand = this.handMeshObj = handMesh(fore.radius * 1.22, skin);
    this.bladeMesh.add(hand);
    // And the inside of the hand, on the forearm, for anything held in it
    // that is not the weapon.
    this.palm.position.y = this.foreHalf + fore.radius;
    this.foreMesh.add(this.palm);

    this.ghostMesh = buildGhostMesh(this.build.scale);
    this.group.add(this.ghostMesh);
  }

  /**
   * Fade the limb and its weapon out, 1 solid and 0 gone.
   *
   * Only ever the player's, and only when the camera has been pulled in so
   * close by a wall that the arm is what you are looking at instead of the
   * room. It goes later and faster than the body does -- it is the last thing
   * to disappear, because it is the thing you are steering.
   */
  setFade(amount: number): void {
    const a = clamp(amount, 0, 1);
    if (Math.abs(a - this.fadeAmount) < 0.01) return;
    this.fadeAmount = a;

    this.group.visible = a > 0.02;
    for (const root of [this.upperMesh, this.foreMesh, this.bladeMesh]) {
      root.traverse((o) => {
        const mat = (o as THREE.Mesh).material;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          m.transparent = a < 1;
          m.opacity = a;
          m.depthWrite = a > 0.6;
        }
      });
    }
  }

  private fadeAmount = 1;

  /**
   * The limb meshes are placed by the Interpolator. Only the ghost is snapped —
   * it is pure input with no physics state, and showing it a step in the past
   * would understate the very lag it exists to reveal.
   *
   * Whether to draw it at all is the caller's: it is a readout of the arm you
   * are steering, and an opponent's is nobody's business but its own.
   */
  syncMeshes(showGhost: boolean): void {
    this.ghostMesh.visible = showGhost;
    if (showGhost) {
      this.ghostMesh.position.copy(this._ghostPos);
      this.ghostMesh.quaternion.copy(this._bladeQuat);
    }
  }

  // -------------------------------------------------------------------------
  // Kinematic probes
  //
  // Both of these run the SAME solve `computeGhost` uses and touch nothing
  // physical. They exist so a driver can ask "where would my weapon be if I
  // aimed there?" without swinging first -- which is not cheating, it is a
  // creature knowing the length of its own arm. The physical limb still has to
  // get to the pose under a clamped force, and still frequently cannot.
  // -------------------------------------------------------------------------

  /** Turn a 0..1 fraction into a reach in metres for this particular arm. */
  reachAt(fraction: number): number {
    return this.minReach + (this.maxReach - this.minReach) * clamp(fraction, 0, 1);
  }

  /**
   * Run the pose solve for a hypothetical aim and leave the result in
   * `_probeHand` (the hand) and `_probeDir` (the weapon's direction).
   *
   * Does NOT put the real intent back -- `withProbe` does that once, around
   * however many probes a solve needs.
   */
  private probePose(
    yaw: number, pitch: number, reachFraction: number, roll: number, t: Tuning,
  ): void {
    this.armYaw = clamp(yaw, YAW_MIN, YAW_MAX);
    this.armPitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
    this.reach = this.reachAt(reachFraction);
    this.roll = clamp(roll, ROLL_MIN, ROLL_MAX);
    this.computeGhost(t, true);

    this._probeHand.copy(this._ghostPos);
    // The weapon's own target, wrist bend and all: it continues the forearm
    // only where the body has not moved the elbow.
    this._probeDir.set(0, 1, 0).applyQuaternion(this._bladeQuat);
  }

  /** Run `body` on hypothetical aims, then put the real one back. */
  private withProbe<T>(t: Tuning, body: () => T): T {
    const keepYaw = this.armYaw, keepPitch = this.armPitch;
    const keepReach = this.reach, keepRoll = this.roll;
    try {
      return body();
    } finally {
      this.armYaw = keepYaw;
      this.armPitch = keepPitch;
      this.reach = keepReach;
      this.roll = keepRoll;
      this.computeGhost(t);
    }
  }

  /**
   * Where this arm's percussion point -- the part of the weapon that does the
   * work -- would end up for a given aim.
   */
  probeStrike(
    yaw: number, pitch: number, reachFraction: number, roll: number,
    t: Tuning, out: THREE.Vector3,
  ): THREE.Vector3 {
    return this.withProbe(t, () => {
      this.probePose(yaw, pitch, reachFraction, roll, t);
      return out.copy(this._probeDir)
        .multiplyScalar(this.weapon.grip + this.weapon.span * this.strikePoint)
        .add(this._probeHand);
    });
  }

  /**
   * The arm pitch that would put the percussion point at a given world height.
   *
   * Bisection over the pitch range, because the relation runs through an elbow
   * solve and a pole rotation and has no closed form worth writing down. This
   * is what lets one shape of swing describe the same swing for a 1.37m goblin
   * and a 2.11m orc: the shape says "a hand's width above level", and level is
   * solved here from whatever body and weapon is actually throwing it.
   */
  solvePitchForHeight(
    targetY: number, yaw: number, reachFraction: number, roll: number, t: Tuning,
  ): number {
    return this.withProbe(t, () => this.bisect(PITCH_MIN, PITCH_MAX, (pitch) => {
      this.probePose(yaw, pitch, reachFraction, roll, t);
      const strike = this._probeDir.y
        * (this.weapon.grip + this.weapon.span * this.strikePoint) + this._probeHand.y;
      return strike - targetY;
    }));
  }

  /**
   * Bring the percussion point round onto a target: the yaw that puts it on
   * the target's bearing from the shoulder, and the pitch that puts it at the
   * target's height, at a given reach and roll.
   *
   * Not the same as aiming the arm at it. The weapon leaves the hand at an
   * angle and the elbow's pole throws the forearm across, so an axe whose arm
   * points straight at you comes down a third of a metre to one side of you.
   * Where every other swing sweeps across and does not mind, a chop with
   * nothing to bring it round onto you does. The same two bisections
   * `aimPointAt` alternates, asking where the part that does the work arrives
   * rather than which way the weapon points.
   */
  aimCutAt(
    target: THREE.Vector3, reachFraction: number,
    roll: number, t: Tuning, out: { yaw: number; pitch: number },
  ): { yaw: number; pitch: number } {
    const strikeAt = this.weapon.grip + this.weapon.span * this.strikePoint;
    return this.withProbe(t, () => {
      let yaw = 0;
      let pitch = 0;
      for (let round = 0; round < 3; round++) {
        pitch = this.bisect(PITCH_MIN, PITCH_MAX, (p) => {
          this.probePose(yaw, p, reachFraction, roll, t);
          return this._probeDir.y * strikeAt + this._probeHand.y - target.y;
        });
        yaw = this.bisect(YAW_MIN, YAW_MAX, (y) => {
          this.probePose(y, pitch, reachFraction, roll, t);
          const px = this._probeHand.x + this._probeDir.x * strikeAt - this._shoulder.x;
          const pz = this._probeHand.z + this._probeDir.z * strikeAt - this._shoulder.z;
          const wanted = Math.atan2(
            -(target.x - this._shoulder.x), -(target.z - this._shoulder.z));
          return wrapPi(Math.atan2(-px, -pz) - wanted);
        });
      }
      out.yaw = yaw;
      out.pitch = pitch;
      return out;
    });
  }

  /**
   * Point this weapon AT something, rather than across it.
   *
   * For an edge weapon the question is where its arc crosses, which is what
   * `solvePitchForHeight` answers. For a POINT weapon that question is wrong:
   * a spear whose tip passes through a chest sideways has still only brushed
   * it, because the alignment term measures the shaft against the surface and
   * a shaft travelling broadside scores nothing.
   *
   * What a thrust needs is for the shaft to lie along the line to the target,
   * and that takes BOTH angles. The shoulder is a hand's width off centre and
   * the elbow's pole throws the forearm across the body, so a goblin holding
   * its spear at arm yaw zero is pointing it twenty degrees to its own left;
   * solving only the pitch left every thrust sailing past. The two bisections
   * interact through the pole rotation, so they are run alternately until they
   * settle, which takes about three rounds.
   */
  aimPointAt(
    target: THREE.Vector3, reachFraction: number,
    roll: number, t: Tuning, out: { yaw: number; pitch: number },
  ): { yaw: number; pitch: number } {
    return this.withProbe(t, () => {
      let yaw = 0;
      let pitch = 0;
      for (let round = 0; round < 3; round++) {
        // Both errors are measured from the HAND, not from the body. Aiming
        // the direction parallel to the line from the fighter's centre gets a
        // weapon that travels alongside the target and misses it by however
        // far the shoulder is off centre -- a third of a metre, which on a
        // torso is everything.
        pitch = this.bisect(PITCH_MIN, PITCH_MAX, (p) => {
          this.probePose(yaw, p, reachFraction, roll, t);
          const flat = Math.hypot(
            target.x - this._probeHand.x, target.z - this._probeHand.z);
          const wanted = Math.atan2(target.y - this._probeHand.y, Math.max(0.05, flat));
          return Math.asin(clamp(this._probeDir.y, -1, 1)) - wanted;
        });
        yaw = this.bisect(YAW_MIN, YAW_MAX, (y) => {
          this.probePose(y, pitch, reachFraction, roll, t);
          const wanted = Math.atan2(
            target.x - this._probeHand.x, -(target.z - this._probeHand.z));
          return -wrapPi(
            Math.atan2(this._probeDir.x, -this._probeDir.z) - wanted);
        });
      }
      out.yaw = yaw;
      out.pitch = pitch;
      return out;
    });
  }

  /**
   * Bisection over an angle range on any error that grows with the angle.
   *
   * Bisection because every one of these relations runs through an elbow solve
   * and a pole rotation and has no closed form worth writing down. This is
   * what lets one shape of swing describe the same swing for a 1.37m goblin and
   * a 2.11m orc: the shape says "a hand's width above level", and level is
   * solved here from whatever body and weapon is actually throwing it.
   */
  private bisect(min: number, max: number, error: (angle: number) => number): number {
    let lo = min;
    let hi = max;
    const eLo = error(lo);
    const eHi = error(hi);
    // Out of range either way: give the end that gets closest rather than a
    // meaningless midpoint.
    if (eLo >= 0 === eHi >= 0) return Math.abs(eLo) <= Math.abs(eHi) ? lo : hi;

    const rising = eHi > eLo;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if ((error(mid) < 0) === rising) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  get ghostPosition(): THREE.Vector3 { return this._ghostPos; }
  get handPosition(): THREE.Vector3 { return this._handPos; }

  /**
   * The current aim, so a driver can work out how far it still has to move.
   *
   * Read-only on purpose. An AI steers this exactly the way a hand does, by
   * emitting mouse deltas through `readInput`, which keeps it bound by the same
   * arm physics and the same reach limits as the player.
   */
  get aim(): { yaw: number; pitch: number; reach: number; roll: number } {
    return { yaw: this.armYaw, pitch: this.armPitch, reach: this.reach, roll: this.roll };
  }

  /** The angular limits, which are anatomy and so the same at any size. */
  static readonly LIMITS = {
    yaw: [YAW_MIN, YAW_MAX] as const,
    pitch: [PITCH_MIN, PITCH_MAX] as const,
    roll: [ROLL_MIN, ROLL_MAX] as const,
  };

  /** How far in and out this particular arm can go, metres from the shoulder. */
  get reachLimits(): readonly [number, number] {
    return [this.minReach, this.maxReach];
  }

  /** Re-seat the arm after a reset, so it doesn't whip back across the room. */
  reset(t: Tuning): void {
    const wasSevered = this.severedAt;
    // Back in the hand before anything is laid out: it is jointed on again
    // below, once the arm is where the joint expects it.
    this.endStow();
    if (this.sheathedNow || this.loose) {
      this.blade.setBodyType(this.phys.rapier.RigidBodyType.Dynamic, true);
      for (const c of this.weaponColliders) c.setEnabled(true);
      this.setWeaponMass(this.weaponMass);
      this.sheathedNow = false;
      this.loose = false;
      this.moveHand(this.bladeMesh, 0);
    }
    this.severedAt = null;
    for (const cap of this.caps) {
      cap.removeFromParent();
      disposeTree(cap);
    }
    this.caps.length = 0;
    this.limp = false;
    this.armYaw = REST_YAW;
    this.armPitch = REST_PITCH;
    this.reach = clamp(this.build.armLength * 0.793, this.minReach, this.maxReach);
    this.roll = 0;
    this.snapIntent();
    this.twistTarget = 0;
    this._wristTarget.identity();
    this.slackenGrip();
    this._handAccel.set(0, 0, 0);
    this._accelPrimed = false;
    this._ghostPrimed = false;
    this.computeGhost(t);

    const dir = this._armDir.copy(this._ghostPos).sub(this._shoulder).normalize();
    const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const rq = { x: rot.x, y: rot.y, z: rot.z, w: rot.w };
    const place = (b: RAPIER.RigidBody, d: number) => {
      const p = new THREE.Vector3().copy(this._shoulder).addScaledVector(dir, d);
      b.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      b.setRotation(rq, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.resetForces(true);
      b.resetTorques(true);
    };
    place(this.upper, this.upperHalf);
    place(this.fore, this.upperLen + this.foreHalf);
    place(this.blade, this.upperLen + this.foreLen);

    // Put the limb back on, AFTER it has been laid out straight along the arm
    // direction: a joint built across the gap to wherever the severed arm came
    // to rest is that much constraint violation, and the solver answers it by
    // firing the limb at its anchor.
    //
    // Clearing `severedAt` alone was worse than leaving it cut. The arm read as
    // attached, the drive started flying it again, and it was held in roughly
    // the right place only because the hand's target happens to be anchored to
    // the shoulder — a limb kept on by a controller rather than by a joint.
    if (wasSevered === "shoulder") this.shoulderJoint = this.makeShoulderJoint();
    if (wasSevered === "elbow") this.elbowJoint = this.makeElbowJoint();
    if (!this.wristJoint) this.makeWristJoint();
  }

  /**
   * Take the weapon back up after the body has been on the floor.
   *
   * The limb has hung wherever it fell, and putting the ghost straight back
   * at the guard would have the drive haul it there along the chord -- the
   * snap all over again. So the followed intent is re-seated where the hand
   * actually is, and carried back to the guard from there at an arm's speed,
   * exactly as a flick is.
   */
  regain(t: Tuning): void {
    this.limp = false;
    this.guide(null);
    if (this.severedAt !== null) return;

    this.fighter.shoulderWorld(this._shoulder);
    const fq = this.fore.rotation();
    const fp = this.fore.translation();
    const d = this._v.set(0, this.foreHalf, 0)
      .applyQuaternion(this._q.set(fq.x, fq.y, fq.z, fq.w))
      .add(this._v2.set(fp.x, fp.y, fp.z))
      .sub(this._shoulder);
    const len = d.length();
    if (len > 1e-6) {
      const pitch = Math.asin(clamp(d.y / len, -1, 1));
      const yaw = wrapPi(Math.atan2(-d.x, -d.z) - this.fighter.yaw);
      this.aimTrack.snap([clamp(yaw, YAW_MIN, YAW_MAX), clamp(pitch, PITCH_MIN, PITCH_MAX)]);
    }
    this.rollTrack.snap([0]);
    this.swivelTrack.snap([0]);
    this._swivelWant[0] = 0;

    this.armYaw = REST_YAW;
    this.armPitch = REST_PITCH;
    this.roll = 0;
    this.reach = clamp(this.build.armLength * 0.793, this.minReach, this.maxReach);
    this.twistTarget = 0;
    this._wristTarget.identity();
    this._handAccel.set(0, 0, 0);
    this._accelPrimed = false;
    this._ghostPrimed = false;
    // Stale from before it went down: it would hold the ghost on its leash.
    this.state.trackingError = 0;
    this.computeGhost(t);
  }

  /**
   * Cut the arm off. `shoulder` takes the whole limb, `elbow` takes the
   * forearm and the sword with it; either way the fighter is disarmed, because
   * the blade is held in the hand and the hand is no longer attached to
   * anything that can be driven.
   */
  sever(where: "shoulder" | "elbow"): WoundEnd[] {
    if (this.severedAt !== null) return [];
    const joint = where === "shoulder" ? this.shoulderJoint : this.elbowJoint;
    if (!joint) return [];

    this.phys.world.removeImpulseJoint(joint, true);
    if (where === "shoulder") this.shoulderJoint = null; else this.elbowJoint = null;
    this.severedAt = where;

    // The cut face. The limb's joint end is -Y, as everywhere else.
    const seg = where === "shoulder"
      ? { mesh: this.upperMesh, half: this.upperHalf, r: this.build.segment.upperArm.radius * 1.06 }
      : { mesh: this.foreMesh, half: this.foreHalf, r: this.build.segment.foreArm.radius };
    const cap = stumpCap(seg.r);
    cap.position.y = -(seg.half - seg.r * 0.5);
    cap.rotation.x = Math.PI;
    seg.mesh.add(cap);
    this.caps.push(cap);

    // The face it came off: the shoulder on the body, or the elbow on what is
    // left of the arm.
    const socket: WoundEnd = where === "shoulder"
      ? { object: this.fighter.shoulderBall, local: new THREE.Vector3() }
      : { object: this.upperMesh, local: new THREE.Vector3(0, this.upperHalf, 0) };

    // Clear the accumulated drive forces, or they keep pushing after the cut.
    for (const b of [this.upper, this.fore, this.blade]) {
      b.resetForces(true);
      b.resetTorques(true);
    }

    return [{ object: seg.mesh, local: cap.position.clone() }, socket];
  }

  get disarmed(): boolean {
    return this.severedAt !== null;
  }

  // -------------------------------------------------------------------------
  // The scabbard
  // -------------------------------------------------------------------------

  /** The weapon is on the back, and the hand is empty. */
  get sheathed(): boolean {
    return this.sheathedNow;
  }

  /** A weapon in a hand on an arm that is on: something that can cut. */
  get wielding(): boolean {
    return this.gripping && this.severedAt === null;
  }

  /**
   * The weapon is out of the world: on the back, or being carried between
   * the back and the hand, where it touches nothing and cuts nothing.
   */
  get stowed(): boolean {
    return this.sheathedNow || this.loose;
  }

  /** The weapon is being put up or taken out: the hand is busy with it. */
  get stowing(): boolean {
    return this.stow !== null;
  }

  /** And it is being taken out. */
  get drawing(): boolean {
    return this.stow?.draw === true;
  }

  /** The hand's joint has the weapon: not on the back, and not on its way there. */
  private get gripping(): boolean {
    return !this.sheathedNow && !this.loose;
  }

  /**
   * Start putting the weapon up, on the back. False if there is nothing to do
   * it with -- no scabbard, no arm, a body on the floor -- or it is already
   * there or on its way.
   *
   * It is not put there: the hand takes it. Up over the shoulder in the
   * hand's grip, under the arm's own drive, so a sword being put away is
   * still a sword until the point is in the mouth; then back over the
   * shoulder and down into the scabbard, carried along the chest -- the one
   * part of this that is placed, since the grip in this game runs along the
   * forearm and no wrist turns a blade point-down behind its own head -- and
   * the hand going with it all the way. See STOW_TIME.
   */
  sheathe(): boolean {
    if (!this.scabbard || this.sheathedNow || this.stow
      || this.severedAt !== null || this.limp) return false;
    this.stow = { draw: false, phase: "lift", time: 0, turn: 0 };
    return true;
  }

  /**
   * Start drawing it: the hand goes over the shoulder to the grip, pulls the
   * blade up out of the scabbard, and brings it over into its own line, where
   * it is jointed back on across no gap at all. False if it is not on the
   * back, or cannot be taken.
   */
  draw(): boolean {
    if (!this.sheathedNow || this.stow || this.severedAt !== null || this.limp) return false;
    this.stow = { draw: true, phase: "reach", time: 0, turn: 0 };
    return true;
  }

  /**
   * Take the hand to a world point instead of where the mouse aims it --
   * `weight` of the way, 0 the aim and 1 the point -- or back to the aim with
   * null. Nothing is placed: the ghost goes there and the hand has to follow
   * it under the same clamped drive as ever, which is how a pick-up reaches
   * for what it picks up. Ignored while a sword is going up or coming out:
   * that has the hand.
   */
  guide(at: THREE.Vector3 | null, weight = 1): void {
    if (this.stow) return;
    this.guidePole = null;
    if (!at) {
      this.guideWeight = 0;
      return;
    }
    this.guideAt.copy(at);
    this.guideWeight = clamp(weight, 0, 1);
  }

  /** A step of putting the weapon up or taking it out. */
  private stepStow(dt: number): void {
    const st = this.stow!;
    st.time += dt;
    const span = STOW_TIME[st.phase] * Math.sqrt(this.build.scale);
    const u = Math.min(1, st.time / span);
    const s = smoothstep(0, 1, u);
    // A hand that is still on its way when its time is up gets a little
    // longer to arrive -- not forever: a hand that cannot get there, can't.
    const late = (near: number) =>
      this.state.trackingError > near * this.build.scale && st.time < span * STOW_GRACE;
    const next = (phase: StowPhase) => {
      st.phase = phase;
      st.time = 0;
    };

    switch (st.phase) {
      case "lift":
        // Up over the shoulder to where the grip will be with the point in
        // the mouth, the weapon still in the hand's grip.
        this.guideOnChest(this.mouthPoint, s);
        if (u < 1 || late(0.1)) break;
        this.loosen();
        this.fighter.chestFrameLocal(this.bladePosition(this._sheathP), this.bladeQuat(this._sheathQ),
          this.stowP, this.stowQ);
        // Back over the shoulder, whichever way the point was: up, back, down.
        st.turn = wrapTwoPi(pitchOf(this.sheathQuat) - pitchOf(this.stowQ));
        this.carry(this.stowP, this.stowQ);
        next("turn");
        break;
      case "turn": {
        const p = this._stowP.lerpVectors(this.stowP, this.mouthPoint, s);
        const q = this._stowQ.setFromAxisAngle(CHEST_RIGHT, st.turn * s).multiply(this.stowQ)
          .slerp(this.sheathQuat, smoothstep(0.55, 1, u));
        this.carry(p, q);
        if (u >= 1) next("seat");
        break;
      }
      case "seat":
        this.carry(this._stowP.lerpVectors(this.mouthPoint, this.sheathPoint, s), this.sheathQuat);
        if (u < 1) break;
        this.loose = false;
        this.sheathedNow = true;
        this.moveHand(this.foreMesh, this.foreHalf);
        next("settle");
        break;
      case "settle":
        // The hand lets go of it and goes back to where the mouse has it.
        this.guideOnChest(this.sheathPoint, 1 - s);
        if (u >= 1) this.endStow();
        break;

      case "reach":
        this.guideOnChest(this.sheathPoint, s);
        if (u < 1 || late(0.04)) break;
        this.sheathedNow = false;
        this.loose = true;
        this.moveHand(this.bladeMesh, 0);
        this.carry(this.sheathPoint, this.sheathQuat);
        next("pull");
        break;
      case "pull":
        this.carry(this._stowP.lerpVectors(this.sheathPoint, this.mouthPoint, s), this.sheathQuat);
        if (u < 1) break;
        this.stowP.copy(this.mouthPoint);
        this.stowQ.copy(this.sheathQuat);
        // Forward over the shoulder, into the line the forearm has: down,
        // back, up and over.
        this.fighter.chestFrameLocal(this.handSample(this._handP, this._handV),
          this.foreQuat(this._sheathQ), this._stowP, this._stowQ);
        st.turn = wrapTwoPi(pitchOf(this._stowQ) - pitchOf(this.stowQ));
        if (st.turn > 0) st.turn -= 2 * Math.PI;
        next("swing");
        break;
      case "swing": {
        this.guideOnChest(this.mouthPoint, 1 - s);
        // Along the arc over the shoulder, and onto the hand, which is
        // already on its way back to the aim: its place first, so the fist
        // stays on the grip, and its line by the end.
        const q = this._stowQ.setFromAxisAngle(CHEST_RIGHT, st.turn * s).multiply(this.stowQ);
        const lead = this.phys.world.timestep;
        this.fighter.chestFrameWorld(this.stowP, q, this._sheathP, this._sheathQ, lead);
        this.handSample(this._handP, this._handV).addScaledVector(this._handV, lead);
        this._sheathP.lerp(this._handP, smoothstep(0, 0.35, u));
        this._sheathQ.slerp(this.foreQuat(this._handQ), smoothstep(0.3, 1, u));
        this.placeBlade(this._sheathP, this._sheathQ);
        if (u < 1) break;
        this.unsheathe();
        this.endStow();
        break;
      }
    }
  }

  /** The hand toward a point on the chest, `weight` of the way, elbow up and over. */
  private guideOnChest(local: THREE.Vector3, weight: number): void {
    this.fighter.chestFrameWorld(local, IDENTITY, this.guideAt, this._qb);
    this.guideWeight = weight;
    this.guidePole = OVER_POLE;
  }

  /**
   * The weapon to a pose on the chest, for this step to take it to, and the
   * hand guided onto its grip. Placed where the chest will be after the step
   * rather than where it is, or it rides a step behind a body on the move.
   */
  private carry(local: THREE.Vector3, localQ: THREE.Quaternion): void {
    this.fighter.chestFrameWorld(local, localQ, this._sheathP, this._sheathQ,
      this.phys.world.timestep);
    this.placeBlade(this._sheathP, this._sheathQ);
    this.fighter.chestFrameWorld(local, localQ, this.guideAt, this._qb);
    this.guideWeight = 1;
    this.guidePole = OVER_POLE;
  }

  private placeBlade(p: THREE.Vector3, q: THREE.Quaternion): void {
    this.blade.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
    this.blade.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  }

  /** Out of the hand's joint and out of the world: carried, from here, by the stow. */
  private loosen(): void {
    if (this.wristJoint) {
      this.phys.world.removeImpulseJoint(this.wristJoint, true);
      this.wristJoint = null;
    }
    this.blade.setBodyType(this.phys.rapier.RigidBodyType.KinematicPositionBased, true);
    for (const c of this.weaponColliders) c.setEnabled(false);
    this.loose = true;
    this.twistTarget = 0;
    this._wristTarget.identity();
  }

  private endStow(): void {
    this.stow = null;
    this.guideWeight = 0;
    this.guidePole = null;
  }

  /**
   * The arm has been taken away from a stow half done -- cut off, or the body
   * knocked down. A weapon still in the hand stays there and one still on
   * the back stays there; one between the two goes home, onto the back.
   */
  private abortStow(): void {
    if (this.loose) {
      this.loose = false;
      this.sheathedNow = true;
      this.moveHand(this.foreMesh, this.foreHalf);
      this.holdSheathed(true);
    }
    this.endStow();
  }

  /** Where the sheath has the weapon after this step, and send it there. */
  private holdSheathed(teleport: boolean): void {
    this.fighter.chestFrameWorld(this.sheathPoint, this.sheathQuat, this._sheathP, this._sheathQ,
      teleport ? 0 : this.phys.world.timestep);
    const p = this._sheathP;
    const q = this._sheathQ;
    if (teleport) {
      this.blade.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      this.blade.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    } else {
      this.placeBlade(p, q);
    }
  }

  /** The weapon back in the hand, whatever the arm is doing. */
  private unsheathe(): void {
    const fq = this.fore.rotation();
    const q = this._q.set(fq.x, fq.y, fq.z, fq.w);
    const hand = this._v.set(0, this.foreHalf, 0).applyQuaternion(q);
    const fp = this.fore.translation();
    const lv = this.fore.linvel();
    const av = this.fore.angvel();

    this.blade.setBodyType(this.phys.rapier.RigidBodyType.Dynamic, true);
    this.blade.setTranslation({ x: fp.x + hand.x, y: fp.y + hand.y, z: fp.z + hand.z }, true);
    this.blade.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.blade.setLinvel({
      x: lv.x + (av.y * hand.z - av.z * hand.y),
      y: lv.y + (av.z * hand.x - av.x * hand.z),
      z: lv.z + (av.x * hand.y - av.y * hand.x),
    }, true);
    this.blade.setAngvel({ x: av.x, y: av.y, z: av.z }, true);
    this.blade.resetForces(true);
    this.blade.resetTorques(true);
    for (const c of this.weaponColliders) c.setEnabled(true);
    // A body's type change is no time to trust its mass to have come through.
    this.setWeaponMass(this.weaponMass);

    this.sheathedNow = false;
    this.loose = false;
    this.twistTarget = 0;
    this._wristTarget.identity();
    if (!this.wristJoint) this.makeWristJoint();
    this.moveHand(this.bladeMesh, 0);
  }

  private bladePosition(out: THREE.Vector3): THREE.Vector3 {
    const p = this.blade.translation();
    return out.set(p.x, p.y, p.z);
  }

  private bladeQuat(out: THREE.Quaternion): THREE.Quaternion {
    const r = this.blade.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  private foreQuat(out: THREE.Quaternion): THREE.Quaternion {
    const r = this.fore.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  /** The hand mesh onto the weapon or the forearm, at the wrist. */
  private moveHand(parent: THREE.Object3D, y: number): void {
    parent.add(this.handMeshObj);
    this.handMeshObj.position.set(0, y, 0);
  }

  /** The hand -- the end of the forearm -- and its velocity, now. Returns `pos`. */
  private handSample(pos: THREE.Vector3, vel: THREE.Vector3): THREE.Vector3 {
    const fq = this.fore.rotation();
    const r = this._v.set(0, this.foreHalf, 0).applyQuaternion(this._q.set(fq.x, fq.y, fq.z, fq.w));
    const fp = this.fore.translation();
    pos.set(fp.x + r.x, fp.y + r.y, fp.z + r.z);
    const lv = this.fore.linvel();
    const av = this.fore.angvel();
    vel.set(
      lv.x + (av.y * r.z - av.z * r.y),
      lv.y + (av.z * r.x - av.x * r.z),
      lv.z + (av.x * r.y - av.y * r.x),
    );
    return pos;
  }

  /**
   * A scabbard on the back, on the chest so it turns and leans with it, and
   * the pose the weapon takes in it: pommel at the top, flat against the
   * back, edges out to either side.
   */
  private buildScabbard(): void {
    const s = this.build.scale;
    this.sheathPoint.copy(SHEATH_AT).multiplyScalar(s);
    // The weapon's +Y runs down the scabbard, its +X -- the flat -- out of the
    // back, and its edge, +Z, follows.
    const flat = this._ta.set(0, 0, 1);
    const along = this._tb.copy(SHEATH_DIR);
    const edge = this._tc.crossVectors(flat, along);
    this.sheathQuat.setFromRotationMatrix(this._m.makeBasis(flat, along, edge));
    this.mouthPoint.copy(this.sheathPoint).addScaledVector(SHEATH_DIR, -SHEATH_MOUTH * s);

    const len = this.weapon.span + 0.04;
    const leather = new THREE.MeshStandardMaterial({ color: 0x3a2b22, roughness: 0.88 });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.024, len, 0.058), leather);
    body.position.y = this.weapon.grip + len / 2 - 0.02;
    body.castShadow = true;
    g.add(body);
    const chape = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.06, 0.062),
      new THREE.MeshStandardMaterial({ color: 0x9a7b3f, roughness: 0.4, metalness: 0.8 }));
    chape.position.y = this.weapon.grip + len - 0.04;
    g.add(chape);
    g.scale.setScalar(s);
    // The chest group's origin is the waist pivot, and the posture places
    // everything on the chest relative to it: the same frame as the sheath.
    g.position.copy(this.sheathPoint);
    g.quaternion.copy(this.sheathQuat);
    this.fighter.chest.add(g);
    this.scabbard = g;
  }

  /**
   * Masses are tunable at runtime, so they need re-applying on change.
   *
   * `bladeMass` is a TOTAL, not a per-part figure: the weapon's own
   * distribution is preserved and rescaled to it, so dialling a sword up to
   * three kilos makes a heavy sword rather than turning it into an axe.
   */
  applyMasses(t: Tuning): void {
    const limb = (t.armMass / 2) * this.build.massScale;
    this.upper.collider(0)?.setMass(limb);
    this.fore.collider(0)?.setMass(limb);
    this.measureLimbs();
    this.setWeaponMass(t.bladeMass);
  }

  /**
   * Give the weapon body its mass, whole: every part's, distributed as the
   * weapon declares, rescaled to `total`. See `weaponMassProperties`.
   */
  private setWeaponMass(total: number): void {
    const mp = weaponMassProperties(this.weapon, total);
    // Across its length: the two larger of its principal moments, averaged.
    const p = mp.principal;
    const across = (p.x + p.y + p.z - Math.min(p.x, p.y, p.z)) / 2;
    this.weaponSwing = across + total * mp.com.lengthSq();
    this.blade.setAdditionalMassProperties(
      total,
      { x: mp.com.x, y: mp.com.y, z: mp.com.z },
      { x: mp.principal.x, y: mp.principal.y, z: mp.principal.z },
      { x: mp.frame.x, y: mp.frame.y, z: mp.frame.z, w: mp.frame.w },
      true,
    );
    this.weaponMass = total;
    this.shareSwing();
  }

  /**
   * What the weapon actually weighs right now, for the damage model's heft
   * term. Usually the weapon's declared mass; different if the panel has been
   * played with.
   */
  get liveWeaponMass(): number {
    return this.weaponMass;
  }

  /**
   * What the arm itself puts behind its weapon, kg: both segments while it is
   * driving the weapon, nothing once it hangs limp or has been cut off. A
   * loose weapon arrives on its own.
   */
  get armBehind(): number {
    if (this.limp || this.severedAt !== null) return 0;
    return this.upper.mass() + this.fore.mass();
  }

  /**
   * Rewrite a drive's push about one bone's own length.
   *
   * `torque` is the drive as computed, `kp·error − kd·ω`. Its component along
   * `axis` is replaced by the same law with gains no larger than an explicit
   * step on `inertia` stays stable under, scaled by `gain`.
   */
  private boundRoll(
    torque: THREE.Vector3, axis: THREE.Vector3, error: THREE.Vector3,
    spin: { x: number; y: number; z: number },
    kp: number, kd: number, inertia: number, gain: number,
  ): void {
    const dt = this.phys.world.timestep;
    const kpRoll = gain * Math.min(kp, (ROLL_STIFFNESS_LIMIT * inertia) / (dt * dt));
    const kdRoll = gain * Math.min(kd, (ROLL_DAMPING_LIMIT * inertia) / dt);
    const e = error.dot(axis);
    const w = spin.x * axis.x + spin.y * axis.y + spin.z * axis.z;
    torque.addScaledVector(axis, (kpRoll - kp) * e - (kdRoll - kd) * w);
  }

  /** The limb's own roll inertias and swings, which `boundRoll` sizes itself from. */
  private measureLimbs(): void {
    this.fore.recomputeMassPropertiesFromColliders();
    this.upper.recomputeMassPropertiesFromColliders();
    // A single capsule each, which Rapier gets right.
    this.foreRoll = this.fore.principalInertia().y;
    this.upperRoll = this.upper.principalInertia().y;
    this.foreSwing = this.fore.mass() * (this.foreLen / 2) ** 2;
    this.upperSwing = this.upper.mass() * (this.upperLen / 2) ** 2;
    this.shareSwing();
  }

  /**
   * Split the swing between forearm and weapon by their inertia about the
   * hand: a rod's third of mass times length squared for the forearm, and
   * the weapon's own across its length plus its mass at its centre.
   */
  private shareSwing(): void {
    const fore = this.fore.mass() * this.foreLen ** 2 / 3;
    this.weaponShare = this.weaponSwing / (this.weaponSwing + fore);
  }

  /** The angle between the upper arm and the forearm, radians: 0 is straight. */
  private elbowBend(): number {
    const uq = this.upper.rotation();
    const fq = this.fore.rotation();
    const a = this._bendA.set(0, 1, 0).applyQuaternion(this._bendQ.set(uq.x, uq.y, uq.z, uq.w));
    const b = this._bendB.set(0, 1, 0).applyQuaternion(this._bendQ.set(fq.x, fq.y, fq.z, fq.w));
    return a.angleTo(b);
  }

  /** Elbow flexion, for the HUD. */
  updateDerived(): void {
    const uq = this.upper.rotation();
    const fq = this.fore.rotation();
    const a = this._v.set(0, 1, 0).applyQuaternion(this._q.set(uq.x, uq.y, uq.z, uq.w));
    const b = this._v2.set(0, 1, 0).applyQuaternion(this._q2.set(fq.x, fq.y, fq.z, fq.w));
    this.state.elbow = a.angleTo(b);
  }

  dispose(): void {
    const { world } = this.phys;
    world.removeRigidBody(this.blade);
    world.removeRigidBody(this.fore);
    world.removeRigidBody(this.upper);
  }
}

// -----------------------------------------------------------------------------

function buildGhostMesh(scale: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x5fd3ff, wireframe: true, transparent: true, opacity: 0.5,
  });
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05 * scale, 8, 6), mat);
  g.add(hand);
  // The target weapon axis, so the gap between where you asked the sword to be
  // and where it actually is reads as a shape, not just a number.
  const axis = new THREE.Mesh(
    new THREE.CylinderGeometry(0.004, 0.004, 0.5 * scale, 6), mat);
  axis.position.y = 0.25 * scale;
  g.add(axis);
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(0.11 * scale, 0.004, 0.004), mat);
  edge.position.y = 0.12 * scale;
  g.add(edge);
  return g;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Hold one axis of a tracker inside a range, killing any motion out of it. */
function pin(track: Tracker, i: number, lo: number, hi: number): void {
  const v = track.pos[i];
  if (v < lo || v > hi) {
    track.pos[i] = clamp(v, lo, hi);
    track.vel[i] = 0;
  }
}

/** The slice of Rapier's raw joint set the hand's ball joint is driven through. */
interface GripRaw {
  jointSetLimits(handle: number, axis: number, min: number, max: number): void;
  jointConfigureMotorModel(handle: number, axis: number, model: number): void;
  jointConfigureMotorVelocity(handle: number, axis: number, vel: number, factor: number): void;
}

/** Fold an angle into (-pi, pi]. */
function wrapPi(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/** Fold an angle into [0, 2pi). */
function wrapTwoPi(a: number): number {
  const v = a % (Math.PI * 2);
  return v < 0 ? v + Math.PI * 2 : v;
}

/**
 * Which way a weapon at this turn points, as an angle about the chest's right
 * from straight up: a quarter turn is straight back, a half straight down.
 */
function pitchOf(q: THREE.Quaternion): number {
  const d = _pitchDir.set(0, 1, 0).applyQuaternion(q);
  return Math.atan2(d.z, d.y);
}

const _pitchDir = new THREE.Vector3();
