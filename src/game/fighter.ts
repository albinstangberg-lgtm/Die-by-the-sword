import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";
import { HUMAN, type Build, type Segment } from "./anatomy";
import {
  disposeTree, footMesh, handMesh, headMesh as headShape, jointBall, shellMesh,
  stumpCap,
} from "./skin";
import type { WoundEnd } from "./blood";
import { CROUCH_DROP, Pose, Posture, type Gait, type PostureDrive } from "./posture";
import { wrap, type Capsule } from "./clearance";
import { clamp, smoothstep } from "./motion";
import { emptyBlow, judgeBlow, type Blow } from "./balance";
import type { Impact } from "./impacts";
import { Ragdoll } from "./ragdoll";

/**
 * A fighter: one locomotion hull carrying a human-shaped skeleton.
 *
 * The hull is an invisible capsule spanning feet to shoulders. It is the only
 * thing that walks, bumps into walls and holds the figure up, and blades pass
 * straight through it. Everything you can see or cut hangs off it:
 *
 *   torso, pelvis   colliders on the hull itself, posed by the posture layer:
 *                   the hips turn and the chest turns, leans and bends on top
 *   head            a real jointed body, held in place by a weak PD controller,
 *                   severable exactly as the practice dummy's limbs are
 *   off arm         real jointed bodies too, severable the same way, and
 *                   driven by a hand of their own (offarm.ts)
 *   legs            kinematic: posed by a walk cycle, hittable, never simulated
 *
 * That split is the whole trick. A skeleton made of jointed limbs that has to
 * hold itself upright is a research project; a skeleton hung off something that
 * cannot fall over is an afternoon. The sword arm is the exception and lives in
 * arm.ts, because it is the one limb a player actually drives.
 *
 * What you SEE is a second thing laid over that, and only that: skin.ts draws
 * each capsule as a tapered shell and fills the joints between them, so the
 * figure reads as a body rather than as the pile of parts it is underneath.
 * No collider, mass or joint changes for it, and every shell is a child of a
 * mesh the Interpolator already places.
 */

export interface Palette {
  cloth: number;
  skin: number;
  mark: number;
}

export const PLAYER_PALETTE: Palette = { cloth: 0x6b4a3a, skin: 0xa8826a, mark: 0xd8cbb4 };
export const FOE_PALETTE: Palette = { cloth: 0x3f4a5c, skin: 0x9c8570, mark: 0xc44a2f };

/**
 * How hard the head is held in its pose. The off arm is driven on its own now:
 * see offarm.ts.
 */
const HEAD_KP = 26, HEAD_KD = 3.2;
/** Clamped like the sword arm's drive: no controller here gets unbounded authority. */
const POSE_MAX_TORQUE = 40;
/**
 * And held inside what an explicit step on the body's inertia can take:
 * stiffness under 0.7·I/dt², damping under 1.5·I/dt, as the sword arm bounds
 * its roll. The head's damping was two thirds over that, and it buzzed about its
 * own vertical at 15 rad/s, flipping every step at the torque clamp.
 */
const STIFFNESS_LIMIT = 0.7;
const DAMPING_LIMIT = 1.5;

/**
 * The trunk as the sword arm keeps out of it: the body you can see, not the
 * rounder collider a blade hits.
 *
 * The drawn chest is an oval shell a little inside the collider -- its top
 * cap is 14cm where the collider's is 17 -- and shallower front to back than
 * it is wide. Fitted by eye against the shells in skin.ts, erring toward
 * letting an elbow brush the ribs rather than toward holding it off them.
 */
const TRUNK_FIT = 0.92;
const CHEST_FLAT = 1.2;
const HIPS_FLAT = 1.1 / 0.92;
const UP = new THREE.Vector3(0, 1, 0);

/** Stride timing: radians of hip swing per metre travelled. */
const STRIDE = 2.6;
const STRIDE_SWING = 0.55;
/**
 * How fast a stride comes in once the feet are moving, and goes once they
 * stop, per second.
 *
 * The stride is a phase that only advances with distance covered, so a body
 * that stopped used to stop wherever the phase had got to: one foot in the
 * air, one knee bent, held like that for as long as it stood there -- and
 * short steps with pauses between, which is how an opponent moves now, froze
 * a new pose at every pause. Easing the stride in and out puts the lifted foot
 * back down and both legs straight under the body within a fifth of a second
 * of stopping. It comes in faster than it goes: a step that starts with its
 * legs still standing slides the feet along the floor.
 */
const STRIDE_IN = 25;
const STRIDE_OUT = 10;

/**
 * How long after the feet leave the ground a jump still counts, seconds.
 *
 * Small, but not zero: the probe below is a single ray and it flickers off for
 * a step or two crossing anything uneven, and a jump that silently does
 * nothing reads as a broken key rather than a missed input.
 */
const COYOTE = 0.09;
/** After a take-off, how long before the feet can push again. */
const JUMP_LOCK = 0.14;
/** How far past the soles the ground probe looks, at human scale. */
const GROUND_PROBE = 0.1;
/**
 * How high off the floor the step probe looks, at human scale: knee height,
 * which is under the low beam a body walks beneath and level with the block
 * it would walk into.
 */
const STEP_PROBE = 0.45;
/** How fast the legs fold up once there is nothing to stand on. */
const TUCK_RATE = 9;

// --- crouching, climbing and vaulting -------------------------------------------
//
// A crouch is the posture's (see `Pose.sink`): the hips sink and everything
// above them goes with them, and the legs bend under them so the feet stay on
// the floor. The hull does not change -- it is invisible and no blade finds
// it -- so what a crouch takes out of the way of a swing is the body you can
// see and cut. A stoop is a crouch taken further, bowed over, for a hand that
// has to get to the floor: see `stoop`.
//
// A climb is a jump that has somewhere to go. At a ledge between a knee and
// as high as hands can reach, the jump key with the body moving at it takes
// it up the face and onto the top; the vault key takes a body over something
// between a knee and a chest instead, and down the far side. Both are driven
// the way a body is walked and got up off the floor -- by its velocity along
// a path, never placed -- so anything in the way still has its say, and both
// put the hands on the stone: see `handhold`.

/** How fast a crouched body walks, as a share of standing. */
const CROUCH_SPEED = 0.45;
/** How far ahead of the middle of the body something may start, to be vaulted: a running stride. */
const VAULT_REACH = 1.3;
/** How high it may stand, from the soles: over a knee and under a chest. */
const VAULT_LOW = 0.35;
const VAULT_HIGH = 1.15;
/** How deep it may be, front to back. */
const VAULT_DEPTH = 1.5;
/** How far over its top the soles clear it. */
const VAULT_CLEAR = 0.1;
/** How long a vault takes at human scale, seconds, and the fastest it may be driven, m/s. */
const VAULT_TIME = 0.62;
const VAULT_SPEED = 7;
/** Points along a vault's path: enough that following them reads as a curve. */
const VAULT_POINTS = 24;

/** How far ahead of the middle of the body a ledge may be, to be climbed: an arm's length. */
const CLIMB_REACH = 0.95;
/**
 * How high its top may be, from the soles: from a knee -- below that it is a
 * step -- to as high as hands that have jumped for it can get a grip.
 */
const CLIMB_LOW = 0.5;
const CLIMB_HIGH = 2.2;
/** How much of its top there must be to stand on, front to back. */
const CLIMB_DEPTH = 0.3;
/** How far past its edge the body goes to stand. */
const CLIMB_ON = 0.12;
/**
 * How long a climb takes, seconds at human scale: a moment to get the hands
 * on, and more for every metre of it.
 */
const CLIMB_TIME = 0.45;
const CLIMB_PER_METRE = 0.35;
/** Points up the face; half as many again over the edge. */
const CLIMB_POINTS = 16;
/** How far apart the hands take hold of a ledge, either side of the middle. */
const HOLD_SPREAD = 0.2;

/** A stoop's crouch, as a share of an ordinary one's depth. How far it bows over is the posture's. */
const STOOP_SINK = 1.4;

// --- planted feet -------------------------------------------------------------
//
// Standing still, the feet stay where they are while the hips turn over them
// -- the thighs rotating in their sockets, as they do -- and only when the
// hips have wound too far round does a foot pick up and step. Walking,
// turning on the spot or in the air, every stride replants them anyway and
// they simply follow the hips. None of this is physical and none of it is on
// the arm's side of anything: the feet can never hold the body back.

/** How far the hips may turn over a planted foot before it has to step. */
const PLANT_SLACK = 0.18;
/** Beyond this the foot slides rather than let the leg wind up any further. */
const PLANT_MAX = 0.7;
/** How long one step takes, seconds. */
const STEP_TIME = 0.22;
/** A stepping foot lands a little past square: the feet lead a turn. */
const STEP_LEAD = 0.25;
/** A step's knee lift and hip flex at its height, radians. */
const STEP_KNEE = 0.5;
const STEP_HIP = 0.28;
/** How fast feet that are being replanted anyway catch up with the hips. */
const FOLLOW_RATE = 12;

// --- being hit ----------------------------------------------------------------
//
// balance.ts says what a blow does; these are how the body carries it out. A
// shove is a velocity on top of the one the feet are asked for, spent at the
// rate a stumble can spend it. A stagger also takes the feet away from whoever
// is steering them. A knockdown takes everything: the locks come off, the
// body goes over, lies there, and is driven back up. Every duration goes with
// the square root of the body's size, like anything else that moves under
// gravity -- a goblin is back up sooner than an orc.

/**
 * How fast stumbling feet catch a knocked body, as a share of gravity. A
 * person caught by a shove does not skid to a halt, they step back out of it,
 * and a step or two takes the better part of half a second -- which is also
 * what makes a stagger something you can see rather than a twitch.
 */
const STUMBLE = 0.15;
/** However small the stagger, the feet are lost for at least this long, seconds. */
const REEL_MIN = 0.25;
/** A second part of one swing, going through the same body within this long, is the same blow. */
const SWING = 0.3;
/** How fast a blow can throw the chest, rad/s: a kick to the posture's springs. */
const RECOIL_MAX = 4;
/**
 * On the floor, before it starts to get up, seconds -- counted from when it
 * is lying there, not from the blow, since a fall takes as long as it takes.
 */
const LIE_TIME = 0.8;
/** Lying is the hull's long axis within this cosine of flat: fifty degrees over. */
const FLOORED = 0.64;
/** Propped against a wall, it counts as lying after this long anyway. */
const FALL_MAX = 1.2;
/** Getting up, seconds. */
const RISE_TIME = 0.65;
/** How freely a body on the floor turns: enough that a capsule does not roll about like a log. */
const DOWN_DAMPING = 1.5;
/** A rise cannot be dragged anywhere faster than this, m/s and rad/s, whatever it has hit. */
const RISE_SPEED = 6;
const RISE_SPIN = 12;
/** On the floor the legs go slack, one more folded than the other: hip, knee. */
const SPRAWL_NEAR = [0.35, 0.6] as const;
const SPRAWL_FAR = [0.12, 0.2] as const;
const SPRAWL_RATE = 6;
/**
 * How fast a body that dies standing starts to go over some way of its own,
 * rad/s at human size, whatever else the blow did: see `fallFrom`.
 */
const TIP = [0.5, 1.1] as const;

type Stance = "up" | "down" | "rising";

export interface FighterPart {
  name: string;
  label: string;
  collider: RAPIER.Collider;
  /** Present only for the severable jointed parts. */
  body?: RAPIER.RigidBody;
  joint?: RAPIER.ImpulseJoint | null;
  severed?: boolean;
  mesh: THREE.Object3D;
}

export class Fighter {
  readonly body: RAPIER.RigidBody;
  /** The chest. Named `collider` still because it is the main hit target. */
  readonly collider: RAPIER.Collider;
  readonly mesh = new THREE.Group();

  /** Facing, radians. Driven by the turn keys, not the mouse — the mouse is the arm. */
  yaw = 0;

  readonly parts: FighterPart[] = [];

  /**
   * How the trunk is carried around the sword arm: see posture.ts.
   *
   * The hull stays the one thing that faces, walks and collides. The posture
   * turns what hangs on it -- hips, then chest -- and moves the anchors the
   * shoulder, the neck and the off arm are jointed to.
   */
  readonly posture: Posture;
  /** Everything that turns with the hips: pelvis, belt, legs. */
  readonly pelvis = new THREE.Object3D();
  /** Everything above the waist: chest, shoulders, neck. A child of the hips. */
  readonly chest = new THREE.Object3D();
  /**
   * The sword shoulder this step, hull-local. The sword arm's joint anchor
   * and the root its ghost hand is solved from -- the two must be one point.
   */
  readonly shoulderAnchor = new THREE.Vector3();
  /**
   * A world point to look at instead of the blade, or null. An opponent
   * watches the one it is fighting; the player watches their own sword.
   */
  focus: THREE.Vector3 | null = null;
  /** The ball the sword arm hangs from, carried by the shoulder girdle. */
  shoulderBall!: THREE.Object3D;
  private readonly swordShoulderRest = new THREE.Vector3();
  private offShoulderBall!: THREE.Object3D;
  /** The torso collider's centre at rest, hull-local height. */
  private torsoY = 0;
  private pelvisY = 0;
  private readonly renderPose = new Pose();
  /** Chest and hips as capsules, world space, rebuilt on request. */
  private readonly trunk: Capsule[] = [
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0, forward: new THREE.Vector3(), flat: 1 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0, forward: new THREE.Vector3(), flat: 1 },
  ];

  private head!: RAPIER.RigidBody;
  private offUpper!: RAPIER.RigidBody;
  private offFore!: RAPIER.RigidBody;

  /**
   * Kinematic lower body, posed rather than simulated.
   *
   * The swing angles are kept for two steps so render can interpolate them.
   * Every other mesh in the fight is placed by the Interpolator from a rigid
   * body's transform; these are the one thing with no body to read, so they
   * would otherwise step at 60Hz inside a body that does not.
   */
  private legs: {
    thigh: RAPIER.RigidBody; shin: RAPIER.RigidBody;
    hipPivot: THREE.Object3D; kneePivot: THREE.Object3D;
    thighMesh: THREE.Object3D; shinMesh: THREE.Object3D;
    sign: number;
    hip: number; knee: number;
    prevHip: number; prevKnee: number;
    /** Which way the foot points, WORLD yaw: planted means this holds still. */
    foot: number;
    /** The leg's turn in the hip socket, relative to the pelvis, and last step's. */
    turn: number; prevTurn: number;
    /** Progress through a step, 0..1, or -1 when the foot is planted. */
    step: number;
    stepFrom: number; stepTo: number;
  }[] = [];
  /** Commanded ground speed and turn rate, for whether the feet are planted. */
  private gait = 0;
  private turning = 0;

  private stridePhase = 0;
  /** How much of the stride the legs are showing: 0 standing, 1 walking. */
  private striding = 0;
  /** Which way the feet are asked to go: 1 forward, -1 back, 0 sideways. */
  private heading = 0;
  /** The legs' going, as the posture wants it. */
  private readonly gaitNow: Gait = { phase: 0, amount: 0, forward: 0 };
  private headMesh!: THREE.Object3D;

  /** One set of materials for the whole figure, from its palette. */
  private clothMat!: THREE.MeshStandardMaterial;
  private skinMat!: THREE.MeshStandardMaterial;
  private markMat!: THREE.MeshStandardMaterial;
  private beltMat!: THREE.MeshStandardMaterial;

  /** Dark caps added to cut faces, cleared when a reset puts the limb back. */
  private readonly caps: THREE.Object3D[] = [];

  /** Whether the ground probe found anything to push off. */
  grounded = true;
  private coyote = COYOTE;
  private jumpLock = 0;
  /** 0 standing, 1 fully folded up. Blended so the legs do not pop. */
  private tuck = 0;
  private readonly groundRay: RAPIER.Ray;
  private readonly groundReach: number;
  private readonly sightRay: RAPIER.Ray;
  private readonly stepRay: RAPIER.Ray;
  private readonly _eye = new THREE.Vector3();

  private readonly tmpVec = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();

  /** The hips' collider, which a crouch carries down with them. */
  private pelvisCollider!: RAPIER.Collider;
  /** The walking capsule: what stands, and what a corpse no longer has. */
  private readonly hullCollider: RAPIER.Collider;
  /** Dead: the body gone limp, and everything it simulates. See ragdoll.ts. */
  private ragdoll: Ragdoll | null = null;
  /**
   * A vault or a climb under way: where it goes, as a path of hull centres
   * with the distance along it to each, how far through it the body is,
   * seconds, and where on the stone the hands go, left then right.
   */
  private traverse: {
    kind: "vault" | "climb";
    path: THREE.Vector3[]; along: number[]; time: number; duration: number;
    hold: [THREE.Vector3, THREE.Vector3];
  } | null = null;
  private readonly _hold = { left: new THREE.Vector3(), right: new THREE.Vector3(), weight: 0 };

  /**
   * How far down to reach, 0 standing to 1 all the way: past a crouch, and
   * bowed over, for a hand that has to get to the floor. Set by whatever is
   * doing the reaching -- a pick-up -- and not by any key.
   */
  stoop = 0;
  /**
   * How far the body is curled round a lost sword arm, 0..1. Set by whatever
   * knows the arm is gone -- the Combatant -- each step.
   */
  hurt = 0;
  private readonly downRay: RAPIER.Ray;

  /** On its feet, on the floor, or getting up off it. */
  private stance: Stance = "up";
  /** Seconds since the stance last changed. */
  private stanceTime = 0;
  /** Seconds it has been lying on the floor, once it gets there. */
  private lying = 0;
  /**
   * What blows have added to the velocity the feet are asked for, world,
   * m/s: horizontal, and spent at the rate stumbling feet can spend it.
   */
  readonly knock = new THREE.Vector3();
  /** Seconds of lost footing left. The feet go nowhere they are asked meanwhile. */
  private reel = 0;
  /**
   * The swing that last landed here: which weapon, when, and the most it has
   * done so far. A blade that goes through an arm and then a chest is one
   * blow, not two, and its momentum only arrives once.
   */
  private readonly swing = { blade: -1, time: -Infinity, knock: new THREE.Vector3(), severity: 0 };
  private readonly _blow = emptyBlow();
  /** The way up: from where it lay, pivoting about its feet, to standing. */
  private readonly riseFrom = new THREE.Quaternion();
  private readonly riseTo = new THREE.Quaternion();
  private readonly risePivot = new THREE.Vector3();
  /** 0 on its feet, 1 slack on the floor. Blended, so the legs do not pop. */
  private sprawl = 0;

  constructor(
    private phys: PhysicsWorld,
    private scene: THREE.Scene,
    spawn: THREE.Vector3,
    readonly side: Side,
    readonly palette: Palette = PLAYER_PALETTE,
    /** Proportions. A goblin and an orc are this same class at other sizes. */
    readonly build: Build = HUMAN,
  ) {
    const { rapier, world } = phys;
    // Local aliases so every measurement below reads as anatomy rather than
    // as a chain of property lookups.
    const { segment: SEGMENT, standing: STANDING, hull: HULL } = build;
    const local = build.local;

    this.groundRay = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.groundReach = HULL.height / 2 + GROUND_PROBE * build.scale;
    this.sightRay = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    this.stepRay = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    this.downRay = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

    this.posture = new Posture(build);
    this.mesh.add(this.pelvis);
    this.pelvis.add(this.chest);
    this.chest.position.y = this.posture.waistY;

    this.clothMat = new THREE.MeshStandardMaterial({ color: palette.cloth, roughness: 0.85 });
    this.skinMat = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.68 });
    this.markMat = new THREE.MeshStandardMaterial({ color: palette.mark, roughness: 0.6 });
    this.beltMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.cloth).multiplyScalar(0.55), roughness: 0.7,
    });

    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setLinearDamping(0.2)
        .setAngularDamping(6)
        .setCanSleep(false),
    );
    // Only yaw. Letting the hull pitch or roll turns every wall hit into a
    // pratfall, and the sword arm's reaction torque would topple it constantly.
    this.body.setEnabledRotations(false, true, false, true);

    // The hull: what stands and walks. Blades ignore it, so a hit always lands
    // on a named body part instead of a nondescript capsule.
    this.hullCollider = world.createCollider(
      rapier.ColliderDesc.capsule(HULL.height / 2 - HULL.radius, HULL.radius)
        .setMass(HULL.mass)
        .setFriction(0.4)
        .setCollisionGroups(side.hullFilter),
      this.body,
    );

    // The trunk. A chest that tapers to a waist and hips that flare out of it,
    // drawn a little wider than they are deep, because a body is.
    const chest = shellMesh(this.clothMat, {
      from: SEGMENT.torso.radius * 0.82,
      to: SEGMENT.torso.radius * 0.84,
      length: SEGMENT.torso.length,
      belly: 1.12,
    });
    chest.scale.set(1.16, 1, 0.86);
    this.torsoY = local((STANDING.waist + STANDING.neck) / 2);
    this.collider = this.rigidPart("torso", "body", SEGMENT.torso,
      this.torsoY, 0, chest, this.chest, this.posture.waistY);

    const hips = shellMesh(this.clothMat, {
      from: SEGMENT.pelvis.radius * 0.98,
      to: SEGMENT.pelvis.radius * 0.86,
      length: SEGMENT.pelvis.length,
      belly: 1.06,
    });
    hips.scale.set(1.1, 1, 0.92);
    this.pelvisY = local((STANDING.hip + STANDING.waist) / 2);
    this.pelvisCollider = this.rigidPart("pelvis", "hips", SEGMENT.pelvis,
      this.pelvisY, 0, hips, this.pelvis, 0);

    this.buildTrunkFill();
    this.buildHead();
    this.buildOffArm();
    this.buildLegs();

    this.scene.add(this.mesh);
    // The anchors the arm is about to be jointed to have to exist first.
    this.applyPosture();
    // Kinematic bodies are born at the origin. Reaching their real position
    // through setNextKinematicTranslation would imply crossing the room in one
    // step, at a couple of hundred metres per second.
    this.poseLegs(true);
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /**
   * A collider mounted straight onto the hull — moves with it, cannot come off.
   *
   * `y` is hull-local, where the collider goes. The mesh goes on `parent`,
   * which sits `parentY` up the hull, so it rides whatever that part of the
   * body is doing.
   */
  private rigidPart(
    name: string, label: string, seg: { radius: number; length: number; mass: number },
    y: number, x: number, mesh: THREE.Object3D,
    parent: THREE.Object3D, parentY: number,
  ): RAPIER.Collider {
    const { rapier, world } = this.phys;
    const half = Math.max(0.01, seg.length / 2 - seg.radius);
    const collider = world.createCollider(
      rapier.ColliderDesc.capsule(half, seg.radius)
        .setTranslation(x, y, 0)
        .setMass(seg.mass)
        .setCollisionGroups(this.side.bodyFilter)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1.0),
      this.body,
    );

    mesh.position.set(x, y - parentY, 0);
    parent.add(mesh);

    this.parts.push({ name, label, collider, mesh });
    return collider;
  }

  /**
   * The lumps that make a trunk continuous: shoulders, hips, a neck, a belt.
   *
   * They hang off the chest and hip groups rather than off the torso mesh,
   * because that mesh is scaled to an oval cross-section and a ball inherited
   * into that scale comes out an egg.
   */
  private buildTrunkFill(): void {
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
    const waist = this.posture.waistY;

    for (const sx of [-1, 1]) {
      const shoulder = jointBall(SEGMENT.upperArm.radius * 1.5, this.clothMat, 0.8);
      shoulder.position.set(sx * STANDING.shoulderX, local(STANDING.shoulder) - waist, 0);
      this.chest.add(shoulder);
      // The sword side is +X: it is the one the shoulder girdle carries about.
      if (sx > 0) {
        this.shoulderBall = shoulder;
        this.swordShoulderRest.copy(shoulder.position);
      } else {
        this.offShoulderBall = shoulder;
      }

      const hip = jointBall(SEGMENT.thigh.radius * 1.08, this.clothMat, 0.92);
      hip.position.set(sx * STANDING.hipX, local(STANDING.hip), 0);
      this.pelvis.add(hip);
    }

    // A neck, and it has to be long enough to see: shoulders sit a hand's
    // width below the skull, and without a column between them the head reads
    // as sitting straight on the chest.
    const neck = shellMesh(this.skinMat, {
      from: SEGMENT.head.radius * 0.66,
      to: SEGMENT.head.radius * 0.56,
      length: SEGMENT.head.radius * 2.0,
    });
    neck.position.y = local(STANDING.neck) - SEGMENT.head.radius * 0.35 - waist;
    this.chest.add(neck);

    const belt = new THREE.Mesh(
      new THREE.CylinderGeometry(
        SEGMENT.pelvis.radius * 1.03, SEGMENT.pelvis.radius * 1.03,
        0.055 * this.build.scale, 20),
      this.beltMat,
    );
    belt.scale.set(1.1, 1, 0.92);
    belt.position.y = local(STANDING.waist);
    belt.castShadow = true;
    this.pelvis.add(belt);
  }

  private buildHead(): void {
    const { rapier, world } = this.phys;
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
    const p = this.body.translation();
    const seg = SEGMENT.head;
    const y = local(STANDING.neck + seg.length / 2);

    this.head = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y + y, p.z)
        .setLinearDamping(0.5).setAngularDamping(2).setCanSleep(false),
    );
    const collider = world.createCollider(
      rapier.ColliderDesc.ball(seg.radius)
        .setMass(seg.mass)
        .setCollisionGroups(this.side.bodyFilter)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1.0),
      this.head,
    );

    this.headMesh = headShape(seg.radius, this.skinMat, this.markMat);
    this.scene.add(this.headMesh);
    this.parts.push({
      name: "head", label: "head", collider, body: this.head,
      joint: this.jointFor("head"), severed: false, mesh: this.headMesh,
    });
  }

  /**
   * Build one of the severable joints from scratch.
   *
   * A factory rather than three inline calls in the constructor, because a
   * reset has to be able to put a limb back ON. Severing removes the joint
   * from the world outright — there is no "disabled" state to flip back — so
   * the only way to reattach anything is to make the joint again, and the only
   * way to be sure the new one matches the old is for both to come from here.
   */
  private jointFor(name: string): RAPIER.ImpulseJoint {
    const { rapier, world } = this.phys;
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;

    // Both of these ride on the chest, so they are built where the posture
    // has the chest right now; `applyPosture` keeps them there after.
    if (name === "head") {
      const a = this.onChest(0, local(STANDING.neck), _anchor);
      return world.createImpulseJoint(
        rapier.JointData.spherical(
          { x: a.x, y: a.y, z: a.z },
          { x: 0, y: -SEGMENT.head.length / 2, z: 0 },
        ),
        this.body, this.head, true,
      );
    }
    if (name === "offShoulder") {
      const a = this.onChest(-STANDING.shoulderX, local(STANDING.shoulder), _anchor);
      return world.createImpulseJoint(
        rapier.JointData.spherical(
          { x: a.x, y: a.y, z: a.z },
          { x: 0, y: -SEGMENT.upperArm.length / 2, z: 0 },
        ),
        this.body, this.offUpper, true,
      );
    }
    if (name !== "offElbow") {
      // Only three parts have a joint to rebuild. Anything else reaching here
      // means a new severable part was added without teaching this about it,
      // and silently handing back an elbow would be far harder to spot.
      throw new Error(`no joint recipe for "${name}"`);
    }
    const elbow = world.createImpulseJoint(
      rapier.JointData.revolute(
        { x: 0, y: SEGMENT.upperArm.length / 2, z: 0 },
        { x: 0, y: -SEGMENT.foreArm.length / 2, z: 0 },
        { x: 1, y: 0, z: 0 },
      ),
      this.offUpper, this.offFore, true,
    );
    (elbow as RAPIER.RevoluteImpulseJoint).setLimits(-2.3, -0.05);
    return elbow;
  }

  /** The left arm: present, jointed, severable — but never driven by anyone. */
  private buildOffArm(): void {
    const { rapier, world } = this.phys;
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
    const p = this.body.translation();
    const sx = -STANDING.shoulderX;

    const make = (seg: Segment, topY: number, wide: number, narrow: number) => {
      const centre = topY - seg.length / 2;
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(p.x + sx, p.y + local(centre), p.z)
          // Rotated so local +Y runs from the joint down the limb, matching
          // the sword arm's convention.
          .setRotation({ x: 1, y: 0, z: 0, w: 0 })
          .setLinearDamping(0.7).setAngularDamping(1.6).setCanSleep(false),
      );
      const half = Math.max(0.01, seg.length / 2 - seg.radius);
      const collider = world.createCollider(
        rapier.ColliderDesc.capsule(half, seg.radius)
          .setMass(seg.mass)
          .setCollisionGroups(this.side.bodyFilter)
          .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(1.0),
        body,
      );
      // Local +Y runs from the joint DOWN the limb, so -Y is the shoulder end
      // and the taper runs thick to thin in that order.
      const mesh = shellMesh(this.skinMat, {
        from: seg.radius * wide,
        to: seg.radius * narrow,
        length: seg.length,
        belly: 1.05,
      });
      return { body, collider, mesh, seg };
    };

    const upper = make(SEGMENT.upperArm, STANDING.shoulder, 1.06, 0.84);
    const elbowY = STANDING.shoulder - SEGMENT.upperArm.length;
    const fore = make(SEGMENT.foreArm, elbowY, 1.0, 0.68);

    // The elbow belongs to the upper arm and the hand to the forearm, so a cut
    // at either joint leaves a rounded joint on the body and a flat cut face
    // on the piece that fell.
    const elbow = jointBall(SEGMENT.foreArm.radius * 1.15, this.skinMat);
    elbow.position.y = SEGMENT.upperArm.length / 2;
    upper.mesh.add(elbow);

    const hand = handMesh(SEGMENT.foreArm.radius * 1.22, this.skinMat);
    hand.position.y = SEGMENT.foreArm.length / 2;
    fore.mesh.add(hand);

    this.offUpper = upper.body;
    this.offFore = fore.body;

    this.scene.add(upper.mesh, fore.mesh);

    this.parts.push({
      name: "offShoulder", label: "off arm", collider: upper.collider,
      body: upper.body, joint: this.jointFor("offShoulder"),
      severed: false, mesh: upper.mesh,
    });
    this.parts.push({
      name: "offElbow", label: "off forearm", collider: fore.collider,
      body: fore.body, joint: this.jointFor("offElbow"),
      severed: false, mesh: fore.mesh,
    });
  }

  /**
   * Legs: kinematic bodies that follow a posed hierarchy.
   *
   * They collide with blades so you can cut at someone's legs and have it
   * register, but they are never simulated — a kinematic body is unmoved by
   * anything it hits, so no amount of flailing can trip the figure up.
   */
  private buildLegs(): void {
    const { rapier, world } = this.phys;
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;

    for (const sign of [-1, 1]) {
      const hipPivot = new THREE.Object3D();
      hipPivot.position.set(sign * STANDING.hipX, local(STANDING.hip), 0);
      this.pelvis.add(hipPivot);

      // A leg hangs off its pivot, so here +Y is the joint end and -Y the far
      // one -- the opposite way round from an arm, and worth stating twice.
      const thighMesh = shellMesh(this.clothMat, {
        from: SEGMENT.thigh.radius * 0.8,
        to: SEGMENT.thigh.radius * 1.02,
        length: SEGMENT.thigh.length,
        belly: 1.06,
      });
      thighMesh.position.y = -SEGMENT.thigh.length / 2;
      hipPivot.add(thighMesh);

      const knee = jointBall(SEGMENT.shin.radius * 1.12, this.clothMat);
      knee.position.y = -SEGMENT.thigh.length / 2;
      thighMesh.add(knee);

      const kneePivot = new THREE.Object3D();
      kneePivot.position.y = -SEGMENT.thigh.length;
      hipPivot.add(kneePivot);

      const shinMesh = shellMesh(this.clothMat, {
        from: SEGMENT.shin.radius * 0.62,
        to: SEGMENT.shin.radius * 1.0,
        length: SEGMENT.shin.length,
        belly: 1.04,
      });
      shinMesh.position.y = -SEGMENT.shin.length / 2;
      kneePivot.add(shinMesh);

      // Forward is -Z, so the foot lies out ahead of the ankle rather than
      // down from it. Scenery: the collider is the shin and stops at the sole.
      const foot = footMesh(SEGMENT.shin.radius * 0.72,
        SEGMENT.shin.length * 0.52, this.beltMat);
      foot.position.set(0, -SEGMENT.shin.length / 2 + SEGMENT.shin.radius * 0.3,
        -SEGMENT.shin.length * 0.12);
      shinMesh.add(foot);

      const kinematic = (seg: Segment, label: string, mesh: THREE.Object3D) => {
        const bodyR = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased());
        const half = Math.max(0.01, seg.length / 2 - seg.radius);
        const collider = world.createCollider(
          rapier.ColliderDesc.capsule(half, seg.radius)
            .setCollisionGroups(this.side.hitOnlyFilter)
            .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
            .setContactForceEventThreshold(1.0),
          bodyR,
        );
        this.parts.push({ name: label, label, collider, mesh });
        return bodyR;
      };

      const side = sign < 0 ? "left" : "right";
      // Turn in the socket first, then swing: the leg bends along the way
      // its foot points, not the way the hips do.
      hipPivot.rotation.order = "YXZ";

      this.legs.push({
        thigh: kinematic(SEGMENT.thigh, `${side} thigh`, thighMesh),
        shin: kinematic(SEGMENT.shin, `${side} shin`, shinMesh),
        hipPivot, kneePivot, thighMesh, shinMesh, sign,
        hip: 0, knee: 0, prevHip: 0, prevKnee: 0,
        foot: this.yaw, turn: 0, prevTurn: 0,
        step: -1, stepFrom: 0, stepTo: 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Per-step
  // ---------------------------------------------------------------------------

  /**
   * Called once per fixed step, before the physics step.
   *
   * `drive` is what the sword arm wants of the body this step -- null when
   * there is no arm to carry, and the trunk relaxes back to square.
   */
  update(keys: Keys, t: Tuning, dt: number, drive: PostureDrive | null = null): void {
    // On the floor, or on the way up off it: nothing anyone asks reaches it.
    if (this.stance !== "up") {
      this.updateDown(t, dt);
      return;
    }

    let turn = 0;
    if (keys.turnLeft) turn += 1;
    if (keys.turnRight) turn -= 1;
    this.yaw += turn * t.turnSpeed * dt;
    this.turning = Math.abs(turn) * t.turnSpeed;
    this.body.setRotation(
      { x: 0, y: Math.sin(this.yaw / 2), z: 0, w: Math.cos(this.yaw / 2) }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);

    this.grounded = this.probeGround();
    this.coyote = this.grounded ? COYOTE : Math.max(0, this.coyote - dt);
    this.jumpLock = Math.max(0, this.jumpLock - dt);
    const crouch = Math.max(keys.crouch ? 1 : 0, STOOP_SINK * clamp(this.stoop, 0, 1));

    // Going over something, or up it: the feet are off the floor and nothing
    // anyone asks of them reaches them until the far side, or the top.
    if (this.traverse) {
      this.stepTraverse(dt);
      this.finishStep(drive, t, dt, 0);
      return;
    }

    // Staggering, the feet are busy keeping the body up and go nowhere they
    // are asked. Turning is the upper body's, and survives it.
    const footed = this.reel <= 0;
    let ix = 0;
    let iz = 0;
    if (footed) {
      if (keys.forward) iz -= 1;
      if (keys.back) iz += 1;
      if (keys.left) ix -= 1;
      if (keys.right) ix += 1;
    }

    const len = Math.hypot(ix, iz);
    this.heading = len > 0 ? -iz / len : 0;
    const v = this.tmpVec.set(0, 0, 0);
    if (len > 0) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Crouched, the steps are short.
      const low = Math.min(1, this.posture.pose.sink / (CROUCH_DROP * this.build.scale));
      v.set((ix * cos + iz * sin) / len, 0, (-ix * sin + iz * cos) / len)
        .multiplyScalar(t.moveSpeed * this.build.scale * (1 - (1 - CROUCH_SPEED) * low));
    }

    const current = this.body.linvel();
    let vy = current.y;

    // The take-off speed that clears `jumpHeight` under the world's gravity,
    // rather than a hand-picked impulse: turning gravity down then floats the
    // same jump instead of firing you into the ceiling.
    // Going over something is its own key, and only ever goes over: with
    // nothing in front to vault, it does nothing.
    const takeOff = footed && this.coyote > 0 && this.jumpLock <= 0;
    if (keys.vault && takeOff && this.beginVault()) {
      this.leaveGround();
      this.stepTraverse(dt);
      this.finishStep(drive, t, dt, 0);
      return;
    }
    if (keys.jump && takeOff) {
      this.leaveGround();
      // Moving at a ledge, the same key climbs it.
      if (keys.forward && this.beginClimb()) {
        this.stepTraverse(dt);
        this.finishStep(drive, t, dt, 0);
        return;
      }
      vy = Math.sqrt(2 * Math.abs(t.gravity) * t.jumpHeight * this.build.scale);
    }

    const knock = this.knock;
    if (this.grounded) {
      // On the ground the fighter simply IS its input velocity, which is what
      // lets it shove lighter things aside rather than be stopped by them --
      // plus whatever it has been knocked, which the feet have yet to catch.
      this.body.setLinvel({ x: v.x + knock.x, y: vy, z: v.z + knock.z }, true);
    } else {
      // In the air there is nothing to push against, so intent only nudges the
      // line you left the ground on. This is also why a hard swing in mid-air
      // visibly shoves you sideways: the arm's reaction has nowhere to go.
      const a = Math.min(1, t.airControl);
      this.body.setLinvel({
        x: current.x + (v.x - current.x) * a,
        y: vy,
        z: current.z + (v.z - current.z) * a,
      }, true);
      // A knock taken off the ground is already in the body's momentum, and
      // there are no feet up here to catch it.
      knock.set(0, 0, 0);
    }

    // Stride advances with distance covered, so the legs never skate -- a
    // knock included, so a stagger is feet scrambling rather than a slide.
    // Airborne there is no ground to measure against, so it holds and the
    // legs fold up.
    const target = this.grounded ? 0 : 1;
    this.tuck += (target - this.tuck) * Math.min(1, TUCK_RATE * dt);
    const covered = Math.hypot(v.x + knock.x, v.z + knock.z);
    if (this.grounded) this.stridePhase += covered * dt * STRIDE;
    this.gait = covered;
    const walking = this.grounded && covered > 0.05;
    this.striding += ((walking ? 1 : 0) - this.striding)
      * Math.min(1, (walking ? STRIDE_IN : STRIDE_OUT) * dt);

    // Stumbling feet catch the body at the rate stepping can, and find their
    // footing again once they have.
    const k = knock.length();
    if (k > 0) knock.multiplyScalar(Math.max(0, k - STUMBLE * Math.abs(t.gravity) * dt) / k);
    this.reel = Math.max(0, this.reel - dt);

    this.finishStep(drive, t, dt, crouch);
  }

  private leaveGround(): void {
    this.coyote = 0;
    this.jumpLock = JUMP_LOCK;
    this.grounded = false;
  }

  /** What every step on its feet ends with: the posture, and the legs under it. */
  private finishStep(drive: PostureDrive | null, t: Tuning, dt: number, crouch: number): void {
    const gait = this.gaitNow;
    gait.phase = this.stridePhase;
    // Going over or up something is not walking, whatever the legs show.
    gait.amount = this.traverse ? 0 : this.striding * (1 - this.tuck);
    gait.forward = this.heading;
    this.posture.update(drive, this.focus, this.yaw, this.body.translation(), t, dt, crouch,
      this.traverse ? 0 : clamp(this.stoop, 0, 1), clamp(this.hurt, 0, 1), gait);
    this.applyPosture();
    this.poseLegs(false, dt);
    this.holdPose(dt);
  }

  // ---------------------------------------------------------------------------
  // Vaulting and climbing
  // ---------------------------------------------------------------------------

  /** Crouching: the hips more than halfway down. */
  get crouching(): boolean {
    return this.posture.pose.sink > 0.5 * CROUCH_DROP * this.build.scale;
  }

  /** Going over something. */
  get vaulting(): boolean {
    return this.traverse?.kind === "vault";
  }

  /** Going up onto something. */
  get climbing(): boolean {
    return this.traverse?.kind === "climb";
  }

  /** How far a crouch has lowered everything above the hips, metres. */
  get sink(): number {
    return this.posture.pose.sink;
  }

  /**
   * Where the hands go on the stone while going over or up something, left
   * then right, world, and how far they have been handed over to it, 0..1;
   * null when there is nothing to hold. The arms take it as a guide (see
   * Combatant.act): a hand with nothing in it goes and takes hold, and lets
   * go again as the body comes over the top. Reused: read it straight away.
   */
  get handhold(): { left: THREE.Vector3; right: THREE.Vector3; weight: number } | null {
    const tr = this.traverse;
    if (!tr) return null;
    const f = Math.min(1, tr.time / tr.duration);
    const h = this._hold;
    h.weight = tr.kind === "climb"
      ? smoothstep(0, 0.2, f) * (1 - smoothstep(0.62, 0.92, f))
      : smoothstep(0, 0.12, f) * (1 - smoothstep(0.4, 0.62, f));
    h.left.copy(tr.hold[0]);
    h.right.copy(tr.hold[1]);
    return h;
  }

  /**
   * Is there something to vault straight ahead, and if so, start going over it.
   *
   * Asked of the stone, the same stone that stops sight and footwork: knee
   * high within a stride, a top between a knee and a chest when looked down
   * on, a far side within a pace and a half, and floor to land on past it
   * with nothing overhead on the way. A wall fails the top -- looked down on
   * from chest height, the ray starts inside it -- and a gap between two
   * things fails the far side.
   */
  private beginVault(): boolean {
    const s = this.build.scale;
    const p = this.body.translation();
    const soles = p.y - this.build.hullCentreY;
    const r = this.build.hull.radius;
    const dx = -Math.sin(this.yaw);
    const dz = -Math.cos(this.yaw);

    const near = this.clearAlong(dx, dz, VAULT_REACH * s);
    if (near >= VAULT_REACH * s) return false;

    const top = this.surfaceAt(p.x + dx * (near + 0.06 * s), p.z + dz * (near + 0.06 * s),
      soles + VAULT_HIGH * s + 0.05 * s);
    if (top === null) return false;
    const height = top - soles;
    if (height < VAULT_LOW * s || height > VAULT_HIGH * s) return false;

    // Walk along its top until it falls away: that is the far side.
    const step = 0.08 * s;
    let far = -1;
    for (let d = near + 0.06 * s; d <= near + VAULT_DEPTH * s; d += step) {
      const y = this.surfaceAt(p.x + dx * d, p.z + dz * d, top + 0.3 * s);
      if (y === null || y < soles + 0.15 * s) { far = d; break; }
      if (y > top + 0.2 * s) return false;       // it gets taller: a wall behind it
    }
    if (far < 0) return false;

    // Somewhere to land, level with where it started, and nothing overhead.
    const land = far + r + 0.3 * s;
    const floor = this.surfaceAt(p.x + dx * land, p.z + dz * land, soles + 0.4 * s);
    if (floor === null || Math.abs(floor - soles) > 0.15 * s) return false;
    const over = top + VAULT_CLEAR * s;
    if (this.blocked(p.x, over + this.build.hull.height * 0.75, p.z, dx, 0, dz, land)) return false;

    // The path, as hull centres: up off the floor while closing on it, over
    // its top with the soles clear of it the whole way from its near edge to
    // its far one, and down the other side.
    const rise = Math.max(0.05 * s, near - r);
    const clearFrom = far + r * 0.6;
    const lift = over - soles;
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= VAULT_POINTS; i++) {
      const x = (land * i) / VAULT_POINTS;
      const h = x < rise ? lift * smoothstep(0, rise, x)
        : x <= clearFrom ? lift
          : lift * (1 - smoothstep(clearFrom, land, x));
      path.push(new THREE.Vector3(p.x + dx * x, p.y + h, p.z + dz * x));
    }
    // A hand planted on its top as the body goes over.
    this.begin("vault", path, VAULT_TIME * Math.sqrt(s), near + 0.12 * s, top);
    return true;
  }

  /**
   * Is there a ledge to climb straight ahead, and if so, start up it.
   *
   * Asked of the stone as a vault is: a face within an arm's length, a top
   * between a knee and as high as a jump gets the hands, enough of it past
   * the edge to stand on, and nothing in the way going up or overhead once
   * there. A wall is no ledge -- looked down on from over its top, the ray
   * starts inside it -- and neither is a pillar, which has no top to stand on
   * within reach.
   */
  private beginClimb(): boolean {
    const s = this.build.scale;
    const p = this.body.translation();
    const soles = p.y - this.build.hullCentreY;
    const r = this.build.hull.radius;
    const dx = -Math.sin(this.yaw);
    const dz = -Math.cos(this.yaw);

    const near = this.clearAlong(dx, dz, CLIMB_REACH * s);
    if (near >= CLIMB_REACH * s) return false;
    const edge = near + 0.06 * s;
    const top = this.surfaceAt(p.x + dx * edge, p.z + dz * edge, soles + (CLIMB_HIGH + 0.25) * s);
    if (top === null) return false;
    const height = top - soles;
    if (height < CLIMB_LOW * s || height > CLIMB_HIGH * s) return false;

    // Flat past the edge for a body's width, or at least enough to balance on.
    const step = 0.06 * s;
    let flat = 0;
    for (let d = edge + step; d <= edge + 2 * (r + CLIMB_ON * s); d += step) {
      const y = this.surfaceAt(p.x + dx * d, p.z + dz * d, top + 0.3 * s);
      if (y === null || Math.abs(y - top) > 0.12 * s) break;
      flat = d - edge;
    }
    if (flat + 0.06 * s < CLIMB_DEPTH * s) return false;
    const on = edge + Math.min(flat / 2, r + CLIMB_ON * s);

    // Up the face, close in against it, and nothing overhead all the way up;
    // then over the edge, with room on top for a whole body.
    const rise = Math.max(0, near - r - 0.03 * s);
    const hull = this.build.hull.height;
    const up = top + this.build.hullCentreY + 0.05 * s;
    const fromX = p.x + dx * rise;
    const fromZ = p.z + dz * rise;
    if (this.blocked(fromX, p.y, fromZ, 0, 1, 0, up + hull / 2 - p.y)) return false;
    for (const y of [top + 0.25 * s, top + hull * 0.9]) {
      if (this.blocked(fromX, y, fromZ, dx, 0, dz, on - rise + r)) return false;
    }

    const path: THREE.Vector3[] = [];
    const climb = up - p.y;
    for (let i = 0; i <= CLIMB_POINTS; i++) {
      const f = i / CLIMB_POINTS;
      path.push(new THREE.Vector3(
        p.x + dx * rise * smoothstep(0, 0.5, f), p.y + climb * smoothstep(0, 1, f),
        p.z + dz * rise * smoothstep(0, 0.5, f)));
    }
    const stand = top + this.build.hullCentreY + 0.01 * s;
    for (let i = 1; i <= CLIMB_POINTS / 2; i++) {
      const f = smoothstep(0, 1, i / (CLIMB_POINTS / 2));
      const x = rise + (on - rise) * f;
      path.push(new THREE.Vector3(p.x + dx * x, up + (stand - up) * f, p.z + dz * x));
    }
    const human = height / s;
    this.begin("climb", path, (CLIMB_TIME + CLIMB_PER_METRE * human) * Math.sqrt(s),
      near + 0.08 * s, top);
    return true;
  }

  /**
   * Set a traverse going along a path of hull centres, at no less than
   * `minTime` seconds and no faster than a body can be driven, with the hands
   * to hold on at the edge `edge` metres ahead, on a top at `top`.
   */
  private begin(
    kind: "vault" | "climb", path: THREE.Vector3[], minTime: number, edge: number, top: number,
  ): void {
    const along = [0];
    for (let i = 1; i < path.length; i++) along.push(along[i - 1] + path[i].distanceTo(path[i - 1]));
    const duration = Math.max(minTime, along[along.length - 1] / VAULT_SPEED);
    const s = this.build.scale;
    const p = this.body.translation();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const at = new THREE.Vector3(p.x - sin * edge, top + 0.03 * s, p.z - cos * edge);
    const spread = HOLD_SPREAD * s;
    const hold: [THREE.Vector3, THREE.Vector3] = [
      at.clone().add(new THREE.Vector3(-cos * spread, 0, sin * spread)),
      at.clone().add(new THREE.Vector3(cos * spread, 0, -sin * spread)),
    ];
    this.traverse = { kind, path, along, time: 0, duration, hold };
    this.knock.set(0, 0, 0);
  }

  /** Is there stone along a ray, within `reach`? */
  private blocked(
    x: number, y: number, z: number, dx: number, dy: number, dz: number, reach: number,
  ): boolean {
    this.stepRay.origin = { x, y, z };
    this.stepRay.dir = { x: dx, y: dy, z: dz };
    return this.phys.world.castRay(this.stepRay, reach, true,
      undefined, this.side.sightFilter, undefined, this.body) !== null;
  }

  /**
   * A step of a vault or a climb: the body's velocity set to carry it to
   * where the path has it next step. The pace eases in and out along the
   * path, and the speed is capped, so whatever it runs into gets its say.
   */
  private stepTraverse(dt: number): void {
    const v = this.traverse!;
    v.time += dt;
    const done = v.time >= v.duration;
    const u = smoothstep(0, 1, Math.min(1, v.time / v.duration));
    const want = u * v.along[v.along.length - 1];
    let i = 1;
    while (i < v.along.length - 1 && v.along[i] < want) i++;
    const a = v.along[i - 1];
    const b = v.along[i];
    const target = _pVault.lerpVectors(v.path[i - 1], v.path[i], b > a ? (want - a) / (b - a) : 1);

    const p = this.body.translation();
    const vel = target.set(target.x - p.x, target.y - p.y, target.z - p.z).multiplyScalar(1 / dt);
    if (vel.length() > VAULT_SPEED * 1.5) vel.setLength(VAULT_SPEED * 1.5);
    this.body.setLinvel({ x: vel.x, y: done ? Math.min(0, vel.y) : vel.y, z: vel.z }, true);

    this.grounded = false;
    this.coyote = 0;
    this.gait = 0;
    this.tuck += (1 - this.tuck) * Math.min(1, TUCK_RATE * 1.5 * dt);
    this.striding += (0 - this.striding) * Math.min(1, STRIDE_OUT * dt);
    if (done) {
      this.traverse = null;
      this.jumpLock = JUMP_LOCK;
    }
  }

  /** The height of whatever stone lies under a point, looking down from `fromY`; null if nothing within 3m. */
  private surfaceAt(x: number, z: number, fromY: number): number | null {
    this.downRay.origin = { x, y: fromY, z };
    const hit = this.phys.world.castRay(
      this.downRay, 3, true, undefined, this.side.sightFilter, undefined, this.body);
    return hit === null ? null : fromY - hit.timeOfImpact;
  }

  // ---------------------------------------------------------------------------
  // Being hit
  // ---------------------------------------------------------------------------

  /** On the floor or getting up: not on its feet. */
  get down(): boolean {
    return this.stance !== "up";
  }

  /** On its feet, but they are busy keeping it there. */
  get reeling(): boolean {
    return this.stance === "up" && this.reel > 0;
  }

  /** Seconds of lost footing left. */
  get reelLeft(): number {
    return this.stance === "up" ? this.reel : 0;
  }

  /**
   * A blow has landed somewhere on this body. `mass` is everything still
   * attached to it; `t` supplies gravity and balance.
   *
   * Returns what it did, in an object this fighter reuses -- read it before
   * the next blow lands. A second part of one swing going through the same
   * body only counts for what it adds to the first: a blade that crosses an
   * arm and then a chest carries one swing's momentum, not two.
   */
  takeBlow(impact: Impact, mass: number, t: Tuning): Blow {
    const blow = judgeBlow(impact, {
      mass,
      build: this.build,
      soles: this.body.translation().y - this.build.hullCentreY,
      grounded: this.grounded,
    }, t.gravity, t.balance, this._blow);

    const swing = this.swing;
    const since = impact.time - swing.time;
    const same = impact.blade === swing.blade && since >= 0 && since < SWING * 1000;
    const worse = !same || blow.severity > swing.severity;
    const extra = _extra.copy(blow.knock);
    if (same) {
      if (blow.knock.lengthSq() > swing.knock.lengthSq()) extra.sub(swing.knock);
      else extra.set(0, 0, 0);
    } else {
      swing.blade = impact.blade;
      swing.time = impact.time;
      swing.knock.set(0, 0, 0);
      swing.severity = 0;
    }
    if (blow.knock.lengthSq() > swing.knock.lengthSq()) swing.knock.copy(blow.knock);
    swing.severity = Math.max(swing.severity, blow.severity);

    if (this.stance === "down") {
      // Loose on the floor, it is shoved like anything else lying there.
      if (worse) {
        const j = blow.speed * this.body.mass();
        this.body.applyImpulseAtPoint(
          { x: impact.into.x * j, y: impact.into.y * j, z: impact.into.z * j },
          { x: impact.at.x, y: impact.at.y, z: impact.at.z }, true);
      }
      return blow;
    }
    if (this.stance === "rising") {
      // Halfway up, only something that would floor it anyway puts it back.
      if (worse && blow.effect === "down") this.knockDown(blow);
      return blow;
    }

    if (worse) this.flinch(blow);
    if (extra.lengthSq() > 0) {
      if (this.grounded) {
        this.knock.add(extra);
      } else {
        const lv = this.body.linvel();
        this.body.setLinvel({ x: lv.x + extra.x, y: lv.y, z: lv.z + extra.z }, true);
      }
    }
    if (worse && blow.effect === "down") {
      this.knockDown(blow);
    } else if (worse && blow.effect === "stagger") {
      const catchUp = this.knock.length() / (STUMBLE * Math.abs(t.gravity));
      this.reel = Math.max(this.reel, REEL_MIN * Math.sqrt(this.build.scale), catchUp);
    }
    return blow;
  }

  /**
   * The chest thrown away from a blow. It is what the blade meets, and it
   * moves before the hips it stands on have caught up -- at about twice the
   * speed the blow gives the body as a whole, turned over the length of the
   * trunk. A heavy body barely flinches; a light one is jerked round.
   */
  private flinch(blow: Blow): void {
    const rate = Math.min(RECOIL_MAX, (2 * blow.speed) / this.build.segment.torso.length);
    if (rate <= 0) return;
    // Into the chest's own frame, which the lean and bend are measured in.
    const a = this.yaw + this.posture.pose.chestYaw;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const d = blow.dir;
    this.posture.recoil(d.x * c - d.z * s, d.x * s + d.z * c, rate);
  }

  /**
   * Over it goes. The rotation locks come off and nothing drives the body:
   * it carries on the way the blow sent it, and it topples -- its top along
   * the blow if it was hit high, its feet along it if it was hit low.
   */
  private knockDown(blow: Blow): void {
    this.traverse = null;
    this.stance = "down";
    this.stanceTime = 0;
    this.lying = 0;
    this.reel = 0;
    this.knock.set(0, 0, 0);
    this.body.setEnabledRotations(true, true, true, true);
    this.body.setAngularDamping(DOWN_DAMPING);

    const lv = this.body.linvel();
    this.body.setLinvel({ x: lv.x + blow.knock.x, y: lv.y, z: lv.z + blow.knock.z }, true);
    // Turning about up x dir carries the top of the body along dir.
    const axis = _spin.crossVectors(UP, blow.dir);
    const rate = (blow.over * blow.topple) / this.build.hullCentreY;
    const av = this.body.angvel();
    this.body.setAngvel(
      { x: av.x + axis.x * rate, y: av.y, z: av.z + axis.z * rate }, true);
  }

  /**
   * Down for good, and limp: see ragdoll.ts. No getting up -- nothing will
   * call `update` on this body again.
   *
   * Which is also why the head and the off arm have to let go here. The head
   * is held by a torque that `holdPose` clears and reapplies every step, the
   * off arm by its own drive, and Rapier keeps a force until it is cleared:
   * with nothing calling them any more, the last push would go on twisting a
   * dead head forever.
   */
  collapse(): void {
    // Died on its feet: the blow that did it goes on, because nothing is left
    // to step out of it. A blow that put the body over already has.
    if (this.stance === "up" && !this.ragdoll) this.fallFrom(this._blow);
    this.traverse = null;
    this.stance = "down";
    this.stanceTime = 0;
    this.lying = 0;
    this.reel = 0;
    this.knock.set(0, 0, 0);
    for (const part of this.parts) {
      part.body?.resetTorques(true);
      part.body?.resetForces(true);
    }
    if (this.ragdoll) return;
    const head = this.parts.find((p) => p.name === "head");
    const pose = this.posture.pose;
    this.ragdoll = new Ragdoll({
      phys: this.phys, side: this.side, build: this.build,
      hull: this.body, hullCollider: this.hullCollider, pelvisCollider: this.pelvisCollider,
      mesh: this.mesh, pelvis: this.pelvis, chest: this.chest, legs: this.legs,
      neck: head && !head.severed ? head.joint ?? null : null,
      waist: new THREE.Vector3(0, this.posture.waistY - pose.drop, 0),
      chestQuat: this.posture.chestQuat(pose, new THREE.Quaternion()),
      hipsAt: new THREE.Vector3(0, -pose.drop, 0),
      hipsQuat: pose.hipsQuat(new THREE.Quaternion()),
    });
  }

  /**
   * Which way a body that dies standing goes down.
   *
   * Along the blow that killed it, with what its feet had yet to take of the
   * shove, and over it the way a blow high or low puts a body over -- and a
   * little way off true whatever hit it, because nothing falls straight down
   * its own middle. Without that last, every body folded straight down onto
   * its heels into the same kneeling heap.
   */
  private fallFrom(blow: Blow): void {
    const lv = this.body.linvel();
    this.body.setLinvel({ x: lv.x + this.knock.x, y: lv.y, z: lv.z + this.knock.z }, true);
    const axis = _spin.crossVectors(UP, blow.dir);
    const rate = (blow.over * blow.topple) / this.build.hullCentreY;
    const off = Math.random() * Math.PI * 2;
    const tip = (TIP[0] + Math.random() * (TIP[1] - TIP[0])) / Math.sqrt(this.build.scale);
    const av = this.body.angvel();
    this.body.setAngvel({
      x: av.x + axis.x * rate + Math.cos(off) * tip,
      y: av.y,
      z: av.z + axis.z * rate + Math.sin(off) * tip,
    }, true);
  }

  /** A step of lying dead: once per step, before the physics step. */
  lie(): void {
    this.ragdoll?.capture();
  }

  /** Whether this body has gone limp for good. */
  get limp(): boolean {
    return this.ragdoll !== null;
  }

  /**
   * A step on the floor, or on the way up off it.
   *
   * The body is not driven at all while it lies there: it is a dynamic body
   * with its locks off, and wherever the blow and the floor put it is where it
   * is. The legs, the posture and the held head carry on, so what lies there
   * is still a body -- and the legs, being kinematic, have to be told where it
   * has fallen or they would stay standing without it. The arms hang limp.
   */
  private updateDown(t: Tuning, dt: number): void {
    this.stanceTime += dt;
    this.grounded = this.probeGround();
    this.coyote = 0;
    this.gait = 0;
    this.turning = 0;
    this.tuck += (0 - this.tuck) * Math.min(1, TUCK_RATE * dt);
    this.striding += (0 - this.striding) * Math.min(1, STRIDE_OUT * dt);

    const pace = Math.sqrt(this.build.scale);
    if (this.stance === "down") {
      // How upright the hull still is: the height of its long axis.
      const r = this.body.rotation();
      const upright = 1 - 2 * (r.x * r.x + r.z * r.z);
      if (upright < FLOORED || this.stanceTime > FALL_MAX * pace) this.lying += dt;
      if (this.lying >= LIE_TIME * pace) this.beginRise();
    } else {
      this.rise(dt, RISE_TIME * pace);
    }

    this.posture.update(null, null, this.yaw, this.body.translation(), t, dt);
    this.applyPosture();
    this.poseLegs(false, dt);
    this.holdPose(dt);
  }

  /**
   * Start getting up: from however it lies, round its feet, to standing and
   * facing the way it faced before it went over.
   */
  private beginRise(): void {
    this.stance = "rising";
    this.stanceTime = 0;
    const r = this.body.rotation();
    this.riseFrom.set(r.x, r.y, r.z, r.w);
    this.riseTo.setFromAxisAngle(UP, this.yaw);
    const p = this.body.translation();
    this.risePivot.set(0, -this.build.hull.height / 2, 0)
      .applyQuaternion(this.riseFrom).add(_extra.set(p.x, p.y, p.z));
  }

  /**
   * Drive the body back up, a step at a time.
   *
   * Driven as it is walked: by setting its velocity every step, never its
   * position, so the solver still has the last word on anything in the way
   * and the head and arms are carried up by their joints rather than
   * teleported with it. It pivots about its feet, which sink from where the
   * lying hull holds them -- a hull's radius off the floor -- to the floor.
   */
  private rise(dt: number, duration: number): void {
    const s = smoothstep(0, 1, Math.min(1, this.stanceTime / duration));
    const q = _qRise.slerpQuaternions(this.riseFrom, this.riseTo, s);
    const target = _pRise.set(0, this.build.hull.height / 2, 0).applyQuaternion(q)
      .add(this.risePivot);
    target.y -= this.build.hull.radius * s;

    const p = this.body.translation();
    const lin = target.set(target.x - p.x, target.y - p.y, target.z - p.z)
      .multiplyScalar(1 / dt);
    if (lin.length() > RISE_SPEED) lin.setLength(RISE_SPEED);
    this.body.setLinvel({ x: lin.x, y: lin.y, z: lin.z }, true);

    const r = this.body.rotation();
    const turn = _qTurn.set(r.x, r.y, r.z, r.w).invert().premultiply(q);
    if (turn.w < 0) turn.set(-turn.x, -turn.y, -turn.z, -turn.w);
    const sinHalf = Math.hypot(turn.x, turn.y, turn.z);
    const spin = _spin.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      spin.set(turn.x, turn.y, turn.z)
        .multiplyScalar((2 * Math.atan2(sinHalf, turn.w)) / (sinHalf * dt));
      if (spin.length() > RISE_SPIN) spin.setLength(RISE_SPIN);
    }
    this.body.setAngvel({ x: spin.x, y: spin.y, z: spin.z }, true);

    if (this.stanceTime >= duration) this.stand();
  }

  /** On its feet: upright, locked, facing where it faced, and in charge of its legs again. */
  private stand(): void {
    this.stance = "up";
    this.stanceTime = 0;
    this.knock.set(0, 0, 0);
    this.reel = 0;
    this.body.setRotation(
      { x: 0, y: Math.sin(this.yaw / 2), z: 0, w: Math.cos(this.yaw / 2) }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setEnabledRotations(false, true, false, true);
    this.body.setAngularDamping(6);
    for (const leg of this.legs) {
      leg.foot = this.yaw;
      leg.step = -1;
    }
  }

  /**
   * A point on the chest, given where it would be on a square-standing body
   * (hull-local), placed where the posture has the chest now.
   */
  private onChest(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    return this.posture.chestPoint(this.posture.pose,
      out.set(x, y - this.posture.waistY, 0), out);
  }

  /**
   * Move everything physical that rides on the chest to where the posture
   * has put it: the torso's collider, and the anchors the neck, the off arm
   * and -- through `shoulderAnchor` -- the sword arm are jointed to.
   *
   * Moving a joint anchor is how a shoulder girdle moves here. The limb is
   * not placed; its joint is, and the solver carries the limb after it at
   * whatever the joint can do, the same as every other constraint in the
   * body. The posture's springs keep each step's move to a few millimetres.
   */
  private applyPosture(): void {
    const pose = this.posture.pose;
    const { standing: STANDING } = this.build;
    const local = this.build.local;

    this.posture.swordShoulder(pose, this.shoulderAnchor);

    const centre = this.onChest(0, this.torsoY, _anchor);
    this.collider.setTranslationWrtParent({ x: centre.x, y: centre.y, z: centre.z });
    const q = this.posture.chestQuat(pose, this._q);
    this.collider.setRotationWrtParent({ x: q.x, y: q.y, z: q.z, w: q.w });
    // The hips go down into a crouch with everything above them.
    this.pelvisCollider.setTranslationWrtParent({ x: 0, y: this.pelvisY - pose.drop, z: 0 });

    const head = this.parts.find((p) => p.name === "head");
    if (head?.joint) {
      head.joint.setAnchor1(this.onChest(0, local(STANDING.neck), _anchor));
    }
    const off = this.parts.find((p) => p.name === "offShoulder");
    if (off?.joint) {
      off.joint.setAnchor1(
        this.onChest(-STANDING.shoulderX, local(STANDING.shoulder), _anchor));
    }
  }

  /**
   * Is there anything under the feet?
   *
   * One ray straight down from the hull's centre, as long as the hull's own
   * half-height plus a little. It deliberately looks for the world and for
   * props only: a fighter should be able to jump onto the block or the
   * gallows, but not off another fighter's shoulders.
   */
  private probeGround(): boolean {
    const p = this.body.translation();
    this.groundRay.origin = { x: p.x, y: p.y, z: p.z };
    return this.phys.world.castRay(
      this.groundRay, this.groundReach, true,
      undefined, this.side.groundFilter, undefined, this.body,
    ) !== null;
  }

  /** Eye point in world space, near enough: the top of the head. */
  eyeWorld(out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    const { standing: STANDING, segment: SEGMENT } = this.build;
    return out.set(
      p.x, p.y + this.build.local(STANDING.crown) - SEGMENT.head.radius - this.posture.pose.drop,
      p.z);
  }

  /**
   * Is there a clear line from this fighter's eyes to that point?
   *
   * One ray against the architecture and nothing else. It is what an opponent
   * uses to decide whether you are its problem yet, and the whole reason the
   * orc waits in its hall instead of walking into the far side of a wall for
   * the length of the fight.
   *
   * The last few centimetres are not tested: a target standing with its back
   * to a wall is not hidden by that wall.
   */
  sees(point: THREE.Vector3): boolean {
    this.eyeWorld(this._eye);
    const dx = point.x - this._eye.x;
    const dy = point.y - this._eye.y;
    const dz = point.z - this._eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.2) return true;

    this.sightRay.origin = { x: this._eye.x, y: this._eye.y, z: this._eye.z };
    this.sightRay.dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    return this.phys.world.castRay(
      this.sightRay, dist - 0.15, true,
      undefined, this.side.sightFilter, undefined, this.body,
    ) === null;
  }

  /**
   * How much clear floor lies along a flat direction, metres, up to `reach`.
   *
   * Knee high, against the same stone that stops sight and nothing that walks.
   * It is how an opponent asks whether there is room to step somewhere before
   * it steps there: one that circled you into a pillar would stand against it
   * treading air until its feet gave up.
   *
   * Given a `halfWidth` it asks for a body's width of floor rather than a
   * line of it -- down the middle and down either flank -- because a single
   * ray passes a pillar that the shoulder beside it walks straight into. The
   * flanks sit a little inside that width, so a body already brushing a wall
   * still finds room to walk along it. `dirX, dirZ` must be a unit vector.
   */
  clearAlong(dirX: number, dirZ: number, reach: number, halfWidth = 0): number {
    const p = this.body.translation();
    const y = p.y - this.build.hullCentreY + STEP_PROBE * this.build.scale;
    this.stepRay.dir = { x: dirX, y: 0, z: dirZ };
    let clear = reach;
    for (let flank = halfWidth > 0 ? -1 : 0; flank <= (halfWidth > 0 ? 1 : 0); flank++) {
      const off = flank * halfWidth * 0.8;
      this.stepRay.origin = { x: p.x - dirZ * off, y, z: p.z + dirX * off };
      const hit = this.phys.world.castRay(
        this.stepRay, clear, true,
        undefined, this.side.sightFilter, undefined, this.body,
      );
      if (hit !== null) clear = hit.timeOfImpact;
    }
    return clear;
  }

  /**
   * Weak PD keeping the head in a living posture rather than limp.
   *
   * Held relative to the CHEST, not the hull, so it turns and leans with it,
   * and then turns on top of that toward whatever the posture's gaze has
   * found. Being a PD target rather than a placement, it arrives a little
   * late and a little past -- which is the secondary motion.
   *
   * The off arm used to be held here the same way, and was the thing that
   * flopped: see offarm.ts, which drives it now.
   */
  private holdPose(_dt: number): void {
    if (this.severed("head")) return;
    const hullRot = this.body.rotation();
    this._q2.set(hullRot.x, hullRot.y, hullRot.z, hullRot.w)
      .multiply(this.posture.chestQuat(this.posture.pose, this._q));
    const p = this.posture;
    this._q.copy(this._q2).multiply(
      this._qe.setFromEuler(this._euler.set(p.gazePitch, p.gazeYaw, p.gazeRoll, "YXZ")));
    this.alignTo(this.head, this._q, HEAD_KP, HEAD_KD);
  }

  private readonly _euler = new THREE.Euler();
  private readonly _qe = new THREE.Quaternion();

  /** Clamped angular PD pulling a body toward a world orientation. */
  private alignTo(body: RAPIER.RigidBody, target: THREE.Quaternion,
                  kp: number, kd: number): void {
    body.resetTorques(false);
    const i = body.principalInertia();
    const least = Math.min(i.x, i.y, i.z);
    const dt = this.phys.world.timestep;
    kp = Math.min(kp, (STIFFNESS_LIMIT * least) / (dt * dt));
    kd = Math.min(kd, (DAMPING_LIMIT * least) / dt);
    const r = body.rotation();
    const err = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert().premultiply(target);
    if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w);
    const sinHalf = Math.hypot(err.x, err.y, err.z);
    const torque = this._v.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      const angle = 2 * Math.atan2(sinHalf, err.w);
      torque.set(err.x, err.y, err.z).multiplyScalar((angle / sinHalf) * kp);
    }
    const av = body.angvel();
    torque.x -= av.x * kd;
    torque.y -= av.y * kd;
    torque.z -= av.z * kd;
    const mag = torque.length();
    if (mag > POSE_MAX_TORQUE) torque.multiplyScalar(POSE_MAX_TORQUE / mag);
    body.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
  }

  /**
   * Keep the feet where they are while the hips turn over them, and step
   * when they have turned too far.
   *
   * Each foot holds a WORLD heading. Standing, it holds still, and the leg
   * turns in its hip socket by however far the hips have come round. Past
   * `PLANT_SLACK` the more wound-up foot -- the one on the side of the turn,
   * if they are level -- picks up and steps to a little past square, then
   * the other; only one is ever off the floor. Walking, turning, or in the
   * air, the feet are being replanted every stride regardless and just
   * follow the hips.
   */
  private plantFeet(teleport: boolean, dt: number): void {
    const facing = this.yaw + this.posture.pose.pelvis;
    // A body on the floor has nothing to plant: its feet go where its hips do.
    const moving = this.gait > 0.05 || this.turning > 0.1 || this.tuck > 0.3
      || this.stance !== "up";
    let busy = false;

    for (const leg of this.legs) {
      leg.prevTurn = leg.turn;
      if (teleport) {
        leg.foot = facing;
        leg.step = -1;
      } else if (moving) {
        leg.step = -1;
        leg.foot += wrap(facing - leg.foot) * Math.min(1, FOLLOW_RATE * dt);
      } else if (leg.step >= 0) {
        leg.step = Math.min(1, leg.step + dt / STEP_TIME);
        leg.foot = leg.stepFrom
          + (leg.stepTo - leg.stepFrom) * smoothstep(0, 1, leg.step);
        if (leg.step >= 1) leg.step = -1; else busy = true;
      }
      // However it got here, a leg does not wind up past what a hip allows:
      // the foot slides instead.
      const off = wrap(facing - leg.foot);
      if (Math.abs(off) > PLANT_MAX) leg.foot = facing - Math.sign(off) * PLANT_MAX;
    }

    if (!teleport && !moving && !busy) {
      let pick: (typeof this.legs)[number] | null = null;
      let most = PLANT_SLACK;
      for (const leg of this.legs) {
        const off = wrap(facing - leg.foot);
        // A turn to the left is led by the left foot, which is sign -1.
        const leads = Math.sign(off) === -leg.sign ? 1e-3 : 0;
        if (Math.abs(off) + leads > most) {
          most = Math.abs(off) + leads;
          pick = leg;
        }
      }
      if (pick) {
        const off = wrap(facing - pick.foot);
        pick.step = 0;
        pick.stepFrom = pick.foot;
        pick.stepTo = pick.foot + off * (1 + STEP_LEAD);
      }
    }

    for (const leg of this.legs) leg.turn = wrap(leg.foot - facing);
  }

  /** Swing the legs and push the kinematic colliders to match. */
  private poseLegs(teleport = false, dt = 0): void {
    // The hull as it is, not as it faces: standing that is the same thing,
    // since `update` has just set it, but on the floor the legs have to lie
    // where the body has fallen or they would be left standing without it.
    const p = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    this.sprawl += ((this.stance === "down" ? 1 : 0) - this.sprawl)
      * Math.min(1, SPRAWL_RATE * dt);
    // This step's posture, not an interpolated one: the leg colliders are
    // pushed from these matrices, and the hips carry the legs.
    this.placeTrunk(this.posture.pose);
    this.mesh.updateMatrixWorld(true);

    this.plantFeet(teleport, dt);

    // A crouch bends both legs so the feet stay on the floor under the sunk
    // hips: the two-bone solve for a foot straight below the hip, the hip
    // flexing forward and the knee folding back.
    const { segment: SEGMENT } = this.build;
    const l1 = SEGMENT.thigh.length;
    const l2 = SEGMENT.shin.length;
    const reach = Math.max(0.35 * (l1 + l2), l1 + l2 - this.posture.pose.drop);
    const crouchHip = Math.acos(Math.min(1, (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach)));
    const crouchKnee = Math.PI
      - Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - reach * reach) / (2 * l1 * l2))));

    for (const leg of this.legs) {
      const phase = this.stridePhase + (leg.sign > 0 ? Math.PI : 0);
      const swing = Math.sin(phase) * STRIDE_SWING * this.striding;
      // A knee only bends one way, so the back half of the cycle is flattened.
      const bend = Math.max(0, -Math.sin(phase - 0.6)) * 0.9 * this.striding;

      // Airborne: one knee up, the other trailing. Purely cosmetic -- the legs
      // are kinematic and never carry the jump -- but a figure that keeps
      // walking in mid-air reads as a bug.
      const tuckHip = leg.sign > 0 ? 0.85 : -0.3;
      const tuckKnee = leg.sign > 0 ? 1.25 : 0.55;

      // A foot in the middle of a step comes up off the floor and goes down
      // again: the same bend the stride uses, on a half-sine.
      const lift = leg.step >= 0 ? Math.sin(Math.PI * leg.step) : 0;

      leg.prevHip = leg.hip;
      leg.prevKnee = leg.knee;
      const bent = 1 - this.tuck;
      leg.hip = swing + (tuckHip - swing) * this.tuck + STEP_HIP * lift + crouchHip * bent;
      leg.knee = bend + (tuckKnee - bend) * this.tuck + STEP_KNEE * lift + crouchKnee * bent;
      // Knocked down, the legs go slack -- and straighten again on the way up.
      if (this.sprawl > 1e-3) {
        const [hip, knee] = leg.sign > 0 ? SPRAWL_NEAR : SPRAWL_FAR;
        leg.hip += (hip - leg.hip) * this.sprawl;
        leg.knee += (knee - leg.knee) * this.sprawl;
      }
      // A teleport has no previous pose worth easing out of.
      if (teleport) {
        leg.prevHip = leg.hip;
        leg.prevKnee = leg.knee;
        leg.prevTurn = leg.turn;
      }

      // The colliders are pushed from these matrices below, so the pose used
      // here has to be this step's, not a fraction of the way into it. The
      // hips turn and tilt with the stride over legs that do not: see
      // `placeTrunk`.
      leg.hipPivot.rotation.x = leg.hip;
      leg.hipPivot.rotation.y = leg.turn - this.posture.pose.hipSwing;
      leg.hipPivot.rotation.z = -this.posture.pose.roll;
      // `knee` is flexion, positive when bent. The hip's +x swings the thigh
      // forward, and the knee folds the other way -- the foot goes back -- so
      // the same number turns the shin through minus it. Forward here would
      // bend the leg like a horse's hind leg.
      leg.kneePivot.rotation.x = -leg.knee;
    }
    this.mesh.updateMatrixWorld(true);

    for (const leg of this.legs) {
      pushKinematic(leg.thigh, leg.thighMesh, teleport);
      pushKinematic(leg.shin, leg.shinMesh, teleport);
    }
  }

  private severed(name: string): boolean {
    return this.parts.find((p) => p.name === name)?.severed === true;
  }

  /**
   * Fade the whole figure out, 1 solid and 0 gone.
   *
   * For the camera, which in three rooms with doorways is forever being backed
   * into a wall. Pulling it in to the stone is the only way to keep the room
   * in view, and pulling it in that far puts it inside the body -- so the body
   * gets out of the way. The sword arm has materials of its own and is
   * deliberately not touched: the one thing you must never lose sight of is
   * the thing you are swinging.
   */
  setFade(amount: number): void {
    const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    if (Math.abs(a - this.fade) < 0.01) return;
    this.fade = a;

    for (const m of [this.clothMat, this.skinMat, this.markMat, this.beltMat]) {
      m.transparent = a < 1;
      m.opacity = a;
      m.depthWrite = a > 0.6;
    }
    // A material at zero opacity still casts a shadow, so the figure has to
    // leave the scene rather than merely turn invisible.
    const shown = a > 0.02;
    this.mesh.visible = shown;
    for (const part of this.parts) {
      if (part.body !== undefined) part.mesh.visible = shown;
    }
  }

  private fade = 1;

  /**
   * Cut a jointed part free. Children go with it.
   *
   * Returns the two faces the cut left -- the piece and the stump -- or null
   * if there was nothing there to cut. They are local points on meshes the
   * Interpolator places, so blood drawn from them follows both ends about.
   */
  sever(name: string): WoundEnd[] | null {
    const part = this.parts.find((p) => p.name === name);
    if (!part || !part.joint || part.severed) return null;
    this.phys.world.removeImpulseJoint(part.joint, true);
    part.joint = null;
    part.severed = true;
    part.body?.resetTorques(true);
    part.body?.resetForces(true);
    // Cutting the shoulder takes the forearm with it — its elbow is intact, it
    // is just no longer attached to anything that is attached to anything.
    if (name === "offShoulder") {
      const fore = this.parts.find((p) => p.name === "offElbow");
      if (fore) fore.severed = true;
    }
    return this.capCut(part);
  }

  /**
   * A dark dome over the cut face, so a severed part reads as cut rather than
   * dropped. Every part here is built with its joint end at -Y.
   */
  private capCut(part: FighterPart): WoundEnd[] {
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;

    const shape = part.name === "head"
      ? { half: SEGMENT.head.radius * 1.04, end: SEGMENT.head.radius * 0.74 }
      : part.name === "offShoulder"
        ? { half: SEGMENT.upperArm.length / 2, end: SEGMENT.upperArm.radius * 1.06 }
        : { half: SEGMENT.foreArm.length / 2, end: SEGMENT.foreArm.radius };

    const cap = stumpCap(shape.end);
    cap.position.y = -(shape.half - shape.end * 0.5);
    cap.rotation.x = Math.PI;
    part.mesh.add(cap);
    this.caps.push(cap);

    // The other face: whatever the piece came off. A neck and a shoulder are
    // on the body group; an off forearm comes off the upper arm above it.
    const upper = this.parts.find((p) => p.name === "offShoulder");
    const socket: WoundEnd = part.name === "head"
      ? {
          object: this.chest,
          local: new THREE.Vector3(0, local(STANDING.neck) - this.posture.waistY, 0),
        }
      : part.name === "offShoulder"
        ? { object: this.offShoulderBall, local: new THREE.Vector3() }
        : {
            object: upper?.mesh ?? this.mesh,
            local: new THREE.Vector3(0, SEGMENT.upperArm.length / 2, 0),
          };

    return [{ object: part.mesh, local: cap.position.clone() }, socket];
  }

  position(out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    return out.set(p.x, p.y, p.z);
  }

  /**
   * Set the hips, the chest and the sword shoulder's ball to a posture.
   *
   * The hips group turns and tilts with the stride; the chest does not go
   * with it. The chest is placed where the posture puts it -- the same
   * turn and pivot the shoulder, the neck and the chest's collider are placed
   * from -- whatever the hips under it are doing, so what is drawn and what
   * the arm hangs from never part.
   */
  private placeTrunk(pose: Pose): void {
    this.pelvis.position.set(0, -pose.drop, 0);
    const hips = pose.hipsQuat(this.pelvis.quaternion);
    const into = _qInv.copy(hips).invert();
    this.chest.position.set(0, this.posture.waistY, 0).applyQuaternion(into);
    this.chest.quaternion.copy(into).multiply(this.posture.chestQuat(pose, _qChest));
    this.posture.clavicle(pose, this.shoulderBall.position).add(this.swordShoulderRest);
  }

  /**
   * Where a wounded sword side is held, world space: the socket, with the arm
   * gone at the shoulder, or `down` metres down the side from it, where the
   * stump of one cut at the elbow hangs. Measured on the body rather than off
   * the stump, which swings about as the body moves: a hand chasing it flailed.
   */
  woundWorld(down: number, out: THREE.Vector3): THREE.Vector3 {
    return this.hullToWorld(this.posture.swordSide(this.posture.pose, down, _wound), out);
  }

  /**
   * Sword shoulder in world space: the arm's joint anchor, where the posture
   * has put it this step.
   */
  shoulderWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.hullToWorld(this.shoulderAnchor, out);
  }

  /**
   * Where the sword shoulder would be for a given posture, in world space.
   * For the arm's probes, which ask about a held aim rather than this step.
   */
  shoulderWorldFor(pose: Pose, out: THREE.Vector3): THREE.Vector3 {
    return this.hullToWorld(this.posture.swordShoulder(pose, out), out);
  }

  /**
   * The off shoulder in world space: the joint the off arm hangs from, where
   * the posture has carried it this step.
   */
  offShoulderWorld(out: THREE.Vector3): THREE.Vector3 {
    const { standing: STANDING } = this.build;
    return this.hullToWorld(
      this.onChest(-STANDING.shoulderX, this.build.local(STANDING.shoulder), out), out);
  }

  /**
   * A point and an orientation given in the chest's own frame -- relative to
   * the waist pivot, as the posture places everything on the chest -- in
   * world space. Through the hull's whole rotation, not only its facing, so it
   * stays on the chest of a body lying on the floor.
   *
   * `lead` is how far ahead to look, seconds: where the chest will be once
   * the hull has carried it that far at the speed it is going. Something
   * placed on the chest before a step, for the step to move it to, has to be
   * sent to where the chest will be after it -- sent to where it is, it
   * arrives a step behind, and a sword on the back of a body at a run rode
   * five centimetres out of its scabbard.
   */
  chestFrameWorld(
    local: THREE.Vector3, localQ: THREE.Quaternion,
    outP: THREE.Vector3, outQ: THREE.Quaternion, lead = 0,
  ): void {
    const pose = this.posture.pose;
    const r = this.body.rotation();
    const hull = _qHull.set(r.x, r.y, r.z, r.w);
    const p = this.body.translation();
    const v = lead > 0 ? this.body.linvel() : ZERO;
    this.posture.chestPoint(pose, outP.copy(local), outP)
      .applyQuaternion(hull)
      .add(_pHull.set(p.x + v.x * lead, p.y + v.y * lead, p.z + v.z * lead));
    outQ.copy(hull).multiply(this.posture.chestQuat(pose, _qChest)).multiply(localQ);
  }

  /** The other way: a world point and orientation in the chest's own frame, as it is now. */
  chestFrameLocal(
    world: THREE.Vector3, worldQ: THREE.Quaternion,
    outP: THREE.Vector3, outQ: THREE.Quaternion,
  ): void {
    const pose = this.posture.pose;
    const r = this.body.rotation();
    const hull = _qHull.set(r.x, r.y, r.z, r.w);
    const p = this.body.translation();
    const chest = this.posture.chestQuat(pose, _qChest);
    const into = _qInto.copy(hull).multiply(chest).invert();
    outP.set(world.x - p.x, world.y - p.y, world.z - p.z)
      .applyQuaternion(_qInv.copy(hull).invert());
    outP.y -= this.posture.waistY - pose.drop;
    outP.applyQuaternion(_qInv.copy(chest).invert());
    outQ.copy(into).multiply(worldQ);
  }

  /** The off arm's two bodies, and whether each is still jointed on. */
  get offLimb(): {
    upper: RAPIER.RigidBody; fore: RAPIER.RigidBody; shoulderOn: boolean; elbowOn: boolean;
  } {
    return {
      upper: this.offUpper,
      fore: this.offFore,
      shoulderOn: !this.severed("offShoulder"),
      elbowOn: !this.severed("offElbow"),
    };
  }

  /** The off forearm's mesh, which anything strapped to the forearm hangs from. */
  get offForeMesh(): THREE.Object3D {
    return this.parts.find((p) => p.name === "offElbow")!.mesh;
  }

  /**
   * The trunk, as the sword arm has to keep out of it: the chest and the hips
   * as capsules in world space, for a given posture.
   *
   * The same capsules the torso and pelvis colliders are, placed the same
   * way -- the chest turned, leant and bent about the waist, the hips upright
   * -- so what the arm keeps clear of is exactly what a blade would hit.
   * Returns an array this fighter reuses; read it before asking again.
   */
  trunkCapsules(pose: Pose): readonly Capsule[] {
    const { segment: SEGMENT } = this.build;
    const [chest, hips] = this.trunk;

    const half = Math.max(0.01, SEGMENT.torso.length / 2 - SEGMENT.torso.radius);
    const centre = this.posture.chestPoint(pose,
      _anchor.set(0, this.torsoY - this.posture.waistY, 0), _anchor);
    const chestQ = this.posture.chestQuat(pose, _q);
    const axis = _axis.set(0, half, 0).applyQuaternion(chestQ);
    this.hullToWorld(_end.copy(centre).sub(axis), chest.a);
    this.hullToWorld(_end.copy(centre).add(axis), chest.b);
    chest.radius = SEGMENT.torso.radius * TRUNK_FIT;
    chest.flat = CHEST_FLAT;
    chest.forward.set(0, 0, -1).applyQuaternion(chestQ).applyAxisAngle(UP, this.yaw);

    const hipHalf = Math.max(0.01, SEGMENT.pelvis.length / 2 - SEGMENT.pelvis.radius);
    this.hullToWorld(_end.set(0, this.pelvisY - pose.drop - hipHalf, 0), hips.a);
    this.hullToWorld(_end.set(0, this.pelvisY - pose.drop + hipHalf, 0), hips.b);
    hips.radius = SEGMENT.pelvis.radius * TRUNK_FIT;
    hips.flat = HIPS_FLAT;
    hips.forward.set(0, 0, -1).applyAxisAngle(UP, this.yaw + pose.pelvis);
    return this.trunk;
  }

  /** A hull-local point in world space. Safe to alias. */
  private hullToWorld(l: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const x = l.x, y = l.y, z = l.z;
    return out.set(
      p.x + x * cos + z * sin,
      p.y + y,
      p.z + -x * sin + z * cos,
    );
  }

  /**
   * Per FRAME, not per step: ease the legs between the last two poses.
   *
   * Everything else the fighter shows -- the body group, the head, the off
   * arm -- is a rigid body, and the Interpolator places those from the physics
   * state either side of the frame. The legs are the exception: they are posed
   * by a walk cycle rather than simulated, so there is no pair of transforms
   * to read and they have to carry their own.
   *
   * This method used to place the body group and the jointed limbs as well,
   * straight from the live physics state. It ran AFTER the Interpolator in the
   * same frame, so it overwrote smoothed transforms with hard ones and threw
   * the interpolation away: on anything faster than 60Hz the torso stepped
   * while the sword it was holding did not. It also pinned the body mesh's
   * rotation to yaw, which meant a corpse tumbled in the physics world and
   * stayed bolt upright on screen.
   */
  applyPose(alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    // Dead, nothing is posed: hips, chest and legs lie as their bodies do.
    if (this.ragdoll) {
      this.ragdoll.pose(a);
      return;
    }
    const pose = this.renderPose.lerpPoses(this.posture.prev, this.posture.pose, a);
    this.placeTrunk(pose);
    for (const leg of this.legs) {
      leg.hipPivot.rotation.x = leg.prevHip + (leg.hip - leg.prevHip) * a;
      leg.hipPivot.rotation.y = leg.prevTurn + wrap(leg.turn - leg.prevTurn) * a - pose.hipSwing;
      leg.hipPivot.rotation.z = -pose.roll;
      leg.kneePivot.rotation.x = -(leg.prevKnee + (leg.knee - leg.prevKnee) * a);
    }
  }

  /**
   * Where each foot points (world yaw) and whether it is mid-step, left then
   * right. For the harness and the HUD: allocates, so not for the step loop.
   */
  get feet(): { yaw: number; stepping: boolean }[] {
    return this.legs.map((l) => ({ yaw: l.foot, stepping: l.step >= 0 }));
  }

  /**
   * Every part with a body of its own, for the render interpolator.
   *
   * The head and both off-arm segments are jointed rigid bodies; the torso and
   * pelvis are colliders on the hull and ride with the body group, and the
   * legs are posed rather than simulated.
   */
  get jointedParts(): [RAPIER.RigidBody, THREE.Object3D][] {
    return this.parts
      .filter((p) => p.body !== undefined)
      .map((p) => [p.body!, p.mesh] as [RAPIER.RigidBody, THREE.Object3D]);
  }

  reset(spawn: THREE.Vector3): void {
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
    // Alive again: the hips back on the hull, and the legs posed. The neck a
    // corpse was given a range for is rebuilt below, once the head is back.
    const wasLimp = this.ragdoll !== null;
    this.ragdoll?.dispose();
    this.ragdoll = null;
    this.yaw = 0;
    this.hurt = 0;
    this.stridePhase = 0;
    this.striding = 0;
    this.tuck = 0;
    this.coyote = COYOTE;
    this.jumpLock = 0;
    this.grounded = true;
    this.gait = 0;
    this.turning = 0;
    for (const leg of this.legs) {
      leg.foot = 0;
      leg.turn = leg.prevTurn = 0;
      leg.step = -1;
    }
    // On its feet, whatever it was doing on the floor.
    this.traverse = null;
    this.stance = "up";
    this.stanceTime = 0;
    this.lying = 0;
    this.knock.set(0, 0, 0);
    this.reel = 0;
    this.sprawl = 0;
    this.swing.blade = -1;
    this.swing.time = -Infinity;
    this.body.setEnabledRotations(false, true, false, true);
    this.body.setAngularDamping(6);
    this.body.setLinearDamping(0.2);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

    // Put the pieces back where they belong BEFORE reattaching them. A joint
    // created across a metre of gap is a metre of constraint violation, and
    // the solver resolves it by firing the limb at its anchor.
    //
    // The rotations matter as much as the positions. A severed forearm comes
    // to rest at whatever angle it fell at, and the elbow is a hinge: build it
    // around a forearm lying on its side and the joint has to unwind the whole
    // error on the first step.
    const place = (body: RAPIER.RigidBody, y: number, x: number, upright: boolean) => {
      body.setTranslation({ x: spawn.x + x, y: spawn.y + y, z: spawn.z }, true);
      // Limbs are built with local +Y running DOWN the limb, which is a half
      // turn about X from the identity the head sits at.
      body.setRotation(upright ? { x: 0, y: 0, z: 0, w: 1 } : { x: 1, y: 0, z: 0, w: 0 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.resetForces(true);
      body.resetTorques(true);
    };
    place(this.head, local(STANDING.neck + SEGMENT.head.length / 2), 0, true);
    place(this.offUpper, local(STANDING.shoulder - SEGMENT.upperArm.length / 2),
      -STANDING.shoulderX, false);
    place(this.offFore,
      local(STANDING.shoulder - SEGMENT.upperArm.length - SEGMENT.foreArm.length / 2),
      -STANDING.shoulderX, false);

    // Square again before anything is jointed back on to it: a rebuilt joint
    // takes its anchor from wherever the chest is.
    this.posture.reset();
    this.focus = null;
    this.applyPosture();
    this.placeTrunk(this.posture.pose);

    this.reattach();
    if (wasLimp) {
      const head = this.parts.find((p) => p.name === "head");
      if (head?.joint) {
        this.phys.world.removeImpulseJoint(head.joint, true);
        head.joint = this.jointFor("head");
      }
      // The hips and chest groups were turned to lie as the corpse did, and
      // the legs were lying wherever it fell: square the figure up, and put
      // the legs under it outright rather than dragging them across the room.
      this.pelvis.quaternion.identity();
      this.pelvis.position.set(0, 0, 0);
      this.chest.position.set(0, this.posture.waistY, 0);
      // Walking only ever sets a hip's swing and turn and a knee's bend: the
      // rest of a sprawl would stay in them.
      for (const leg of this.legs) {
        leg.hipPivot.rotation.set(0, 0, 0);
        leg.kneePivot.rotation.set(0, 0, 0);
      }
      this.placeTrunk(this.posture.pose);
      this.poseLegs(true);
    }
  }

  /**
   * Put every severed part back on.
   *
   * Severing removes the joint from the world, so a reset that only clears the
   * flags leaves a head lying where it fell and a fighter that believes it
   * still has one. The parts list owns the joint, so the rule is simply: if a
   * part has no joint, make it one.
   *
   * Cutting a shoulder marks the forearm severed without touching its elbow —
   * the elbow was fine, the thing it hung from was not — so that one only
   * needs its flag cleared, and asking for a second elbow joint would leave
   * two constraints fighting over the same pair of bodies.
   */
  private reattach(): void {
    for (const cap of this.caps) {
      cap.removeFromParent();
      disposeTree(cap);
    }
    this.caps.length = 0;

    for (const part of this.parts) {
      if (!part.severed) continue;
      if (part.joint === null || part.joint === undefined) {
        part.joint = this.jointFor(part.name);
      }
      part.severed = false;
    }
  }
}

// -----------------------------------------------------------------------------

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _wound = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _end = new THREE.Vector3();
const _extra = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _pRise = new THREE.Vector3();
const _qRise = new THREE.Quaternion();
const _qTurn = new THREE.Quaternion();
const _qInto = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const ZERO = { x: 0, y: 0, z: 0 } as const;
const _qHull = new THREE.Quaternion();
const _pVault = new THREE.Vector3();
const _qChest = new THREE.Quaternion();
const _pHull = new THREE.Vector3();

/** Drive a kinematic body from wherever its mesh has been posed to. */
function pushKinematic(body: RAPIER.RigidBody, mesh: THREE.Object3D, teleport = false): void {
  mesh.matrixWorld.decompose(_p, _q, _s);
  if (teleport) {
    body.setTranslation({ x: _p.x, y: _p.y, z: _p.z }, false);
    body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, false);
    return;
  }
  body.setNextKinematicTranslation({ x: _p.x, y: _p.y, z: _p.z });
  body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
}

