import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";

import type { Tuning } from "../tuning";
import type { Build } from "./anatomy";
import type { Fighter } from "./fighter";
import { SWORD, type Weapon } from "./weapons";

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
 *     shoulder, forearm on a hinged elbow, blade welded to the hand. It is
 *     subject to gravity, collision and its own inertia.
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

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Where the elbow hangs relative to the shoulder-to-hand line.
 *
 * This decides how steeply the sword sits in the hand, and it matters far more
 * than it looks. The blade is welded pointing along the forearm, so wherever
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
  /** Outstanding blade orientation error, radians. */
  roll: number;
  /** How saturated the angular drive is, 0..1. */
  torqueSaturation: number;
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
  private glow: THREE.MeshStandardMaterial[] = [];
  private tell = 0;

  private shoulderJoint: RAPIER.ImpulseJoint | null = null;
  private elbowJoint: RAPIER.ImpulseJoint | null = null;

  /** Once the arm is cut, nothing drives it and the sword is gone for good. */
  severedAt: "shoulder" | "elbow" | null = null;

  /** Set when the owner is down: the limb hangs, but still reports its motion. */
  limp = false;

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
   * shoulder-to-hand line, so the forearm — and the blade welded to it —
   * angles UP out of the hand. Level with the shoulder the tip rides around
   * 2.1m, over the head of anything worth hitting; dropping the hand brings
   * the blade back toward the height a standing opponent occupies.
   */
  private armYaw = 0.30;
  private armPitch = -0.30;
  private reach = 0.46;
  private roll = 0;

  readonly state: ArmState = { trackingError: 0, saturation: 0, tipSpeed: 0, elbow: 0, roll: 0, torqueSaturation: 0 };

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
          .setMass(part.mass)
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

    // --- joints ---
    // Shoulder: spherical, 3 DOF, anchored at the torso's shoulder point.
    this.shoulderJoint = world.createImpulseJoint(
      rapier.JointData.spherical(
        // Must match Fighter.shoulderWorld, or the ghost hand is computed from
        // one shoulder while the arm hangs off another.
        { x: build.shoulderLocal.x, y: build.shoulderLocal.y, z: build.shoulderLocal.z },
        { x: 0, y: -upperHalf, z: 0 },      // top of the upper arm
      ),
      this.fighter.body, this.upper, true,
    );

    // Elbow: revolute, 1 DOF, hinging about the arm's local X. Limited so it
    // bends one way only — an elbow that inverts instantly looks like a bug.
    const elbow = this.elbowJoint = world.createImpulseJoint(
      rapier.JointData.revolute(
        { x: 0, y: upperHalf, z: 0 },
        { x: 0, y: -foreHalf, z: 0 },
        { x: 1, y: 0, z: 0 },
      ),
      this.upper, this.fore, true,
    ) as RAPIER.RevoluteImpulseJoint;
    // A real elbow does not hyperextend, and allowing even a few degrees of it
    // here lets the joint cross to the far side of straight, where the sign of
    // the bend is undefined and the arm can jam. The upper bound keeps it
    // permanently on one side of the singularity.
    elbow.setLimits(-2.45, -0.06);

    // Hand: the weapon is welded rigidly. Identity frames mean the weapon's +Y
    // (its length) continues the forearm's +Y, and its +Z is the cutting edge.
    world.createImpulseJoint(
      rapier.JointData.fixed(
        { x: 0, y: foreHalf, z: 0 }, { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 },
      ),
      this.fore, this.blade, true,
    );

    this.buildMeshes(fighter.palette.skin);
    scene.add(this.group);
  }

  // -------------------------------------------------------------------------
  // Input -> ghost hand
  // -------------------------------------------------------------------------

  /** Fold this step's mouse travel into the arm's intent. */
  readInput(input: ArmInput, t: Tuning): void {
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
  private computeGhost(_t: Tuning): void {
    this.fighter.shoulderWorld(this._shoulder);
    const yaw = this.fighter.yaw + this.armYaw;
    const pitch = this.armPitch;

    // Torso-forward is -Z, so the arm sweeps around that.
    const cp = Math.cos(pitch);
    this._v.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    this._ghostPos.copy(this._shoulder).addScaledVector(this._v, this.reach);
    this._armDir.copy(this._v).normalize();

    // --- solve the elbow ---
    const d = clamp(this.reach, Math.abs(this.upperLen - this.foreLen) + 0.01, this.upperLen + this.foreLen - 0.01);
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
    const torsoYaw = this.fighter.yaw;
    const right = this._refA.set(Math.cos(torsoYaw), 0, -Math.sin(torsoYaw));
    const back = this._refC.set(Math.sin(torsoYaw), 0, Math.cos(torsoYaw));
    const pole = this._refB.set(0, -POLE.down, 0)
      .addScaledVector(right, POLE.right)
      .addScaledVector(back, POLE.back)
      .normalize()
      .applyQuaternion(this._q2.setFromAxisAngle(this._armDir, this.roll));

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
  }

  // -------------------------------------------------------------------------
  // The PD drive
  // -------------------------------------------------------------------------

  /** Call once per fixed step, immediately before `world.step()`. */
  drive(t: Tuning): void {
    // A detached arm is meat. Continuing to run the PD on it would have the
    // controller flying a severed limb around the room by itself.
    if (this.severedAt !== null || this.limp) {
      this.updateDerived();
      this.snapshotBlade();
      this.sampleTip();
      return;
    }

    this.computeGhost(t);

    // Rapier keeps user forces until they're cleared, so a missed reset would
    // make the arm accelerate without bound.
    this.fore.resetForces(false);
    this.fore.resetTorques(false);
    this.upper.resetForces(false);
    this.upper.resetTorques(false);
    this.blade.resetForces(false);
    this.blade.resetTorques(false);

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

    // --- linear: F = kp*e - kd*v, clamped ---
    const err = this._v2.copy(this._ghostPos).sub(this._handPos);
    this.state.trackingError = err.length();

    const maxForce = t.maxForce * this.power;
    const force = err.multiplyScalar(t.armKp * this.power)
      .addScaledVector(this._handVel, -t.armKd * this.power);
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
    // A blade is symmetric: presenting either edge cuts equally well, so the
    // error is folded into the nearer half-turn. Without that the sword rolls
    // the long way round on a reversal, which looks absurd and wastes the whole
    // torque budget doing it.
    this._q2.copy(this._q).invert().premultiply(this._ghostQuat);
    const flip = this._q3.setFromAxisAngle(UP, Math.PI).premultiply(this._ghostQuat)
      .multiply(this._q4.copy(this._q).invert());
    if (Math.abs(flip.w) > Math.abs(this._q2.w)) this._q2.copy(flip);
    if (this._q2.w < 0) this._q2.set(-this._q2.x, -this._q2.y, -this._q2.z, -this._q2.w);

    const sinHalf = Math.sqrt(this._q2.x ** 2 + this._q2.y ** 2 + this._q2.z ** 2);
    const torque = this._v.set(0, 0, 0);
    let angle = 0;
    if (sinHalf > 1e-6) {
      angle = 2 * Math.atan2(sinHalf, this._q2.w);
      torque.set(this._q2.x, this._q2.y, this._q2.z)
        .multiplyScalar((angle / sinHalf) * t.armKpRot * this.power);
    }
    this.state.roll = angle;

    const kdRot = t.armKdRot * this.power;
    torque.x -= av.x * kdRot;
    torque.y -= av.y * kdRot;
    torque.z -= av.z * kdRot;

    const maxTorque = t.maxTorque * this.power;
    const tmag = torque.length();
    this.state.torqueSaturation = maxTorque > 0 ? Math.min(1, tmag / maxTorque) : 1;
    if (tmag > maxTorque) torque.multiplyScalar(maxTorque / tmag);
    this.fore.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);

    // The upper arm gets the same treatment from the same solve. Without it
    // the elbow swivel is left to gravity, the physical forearm ends up pointing
    // somewhere the target never predicted, and the angular drive spends itself
    // fighting the hand instead of aiming the blade.
    this.applyUpperArmTorque(t);

    this.snapshotBlade();
    this.sampleTip();
  }

  /** Cancels `gravityComp` of each limb segment's weight at its own centre of mass. */
  private applyGravityFeedForward(t: Tuning): void {
    if (t.gravityComp <= 0) return;
    const up = -t.gravity * t.gravityComp;
    for (const body of [this.upper, this.fore, this.blade]) {
      body.addForce({ x: 0, y: body.mass() * up, z: 0 }, false);
    }
  }

  /** Angular PD holding the upper arm on the solved shoulder->elbow direction. */
  private applyUpperArmTorque(t: Tuning): void {
    const uq = this.upper.rotation();
    this._q3.set(uq.x, uq.y, uq.z, uq.w);
    this._q4.copy(this._q3).invert().premultiply(this._upperQuat);
    if (this._q4.w < 0) {
      this._q4.set(-this._q4.x, -this._q4.y, -this._q4.z, -this._q4.w);
    }

    const sinHalf = Math.sqrt(this._q4.x ** 2 + this._q4.y ** 2 + this._q4.z ** 2);
    const torque = this._v.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      const angle = 2 * Math.atan2(sinHalf, this._q4.w);
      torque.set(this._q4.x, this._q4.y, this._q4.z)
        .multiplyScalar((angle / sinHalf) * t.armKpRot * UPPER_TORQUE_SCALE * this.power);
    }
    const av = this.upper.angvel();
    const kd = t.armKdRot * UPPER_TORQUE_SCALE * this.power;
    torque.x -= av.x * kd;
    torque.y -= av.y * kd;
    torque.z -= av.z * kd;

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

  /** Blade tip position and velocity — used for impact quality. */
  private sampleTip(): void {
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

    this.upperMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(
        upper.radius, Math.max(0.01, upper.length - upper.radius * 2), 6, 12), skin,
    );
    this.foreMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(
        fore.radius, Math.max(0.01, fore.length - fore.radius * 2), 6, 12), skin,
    );
    this.upperMesh.castShadow = true;
    this.foreMesh.castShadow = true;
    this.group.add(this.upperMesh, this.foreMesh);

    const built = this.weapon.build();
    this.bladeMesh = built.group;
    this.glow = built.glow;
    this.group.add(this.bladeMesh);

    this.ghostMesh = buildGhostMesh(this.build.scale);
    this.group.add(this.ghostMesh);
  }

  /**
   * Light the weapon up while an attack is winding.
   *
   * The whole point of a telegraphed attack is that it can be read, and a
   * figure at four metres is a silhouette -- you can see the arm go back, but
   * not how far. A weapon that brightens as the windup completes says "now"
   * from any distance, and says it through the thing that is about to hit you.
   */
  setTell(amount: number): void {
    const a = clamp(amount, 0, 1);
    if (Math.abs(a - this.tell) < 0.01) return;
    this.tell = a;
    for (const m of this.glow) {
      m.emissive.setHex(0xd8562f);
      m.emissiveIntensity = a * 0.6;
    }
  }

  /**
   * The limb meshes are placed by the Interpolator. Only the ghost is snapped —
   * it is pure input with no physics state, and showing it a step in the past
   * would understate the very lag it exists to reveal.
   */
  syncMeshes(t: Tuning): void {
    this.ghostMesh.visible = t.showGhost;
    if (t.showGhost) {
      this.ghostMesh.position.copy(this._ghostPos);
      this.ghostMesh.quaternion.copy(this._ghostQuat);
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
    this.computeGhost(t);

    this._probeHand.copy(this._ghostPos);
    // The weapon continues the forearm's +Y, so the target forearm orientation
    // is the target weapon direction.
    this._probeDir.set(0, 1, 0).applyQuaternion(this._ghostQuat);
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
   * is what lets one attack table describe the same swing for a 1.37m goblin
   * and a 2.11m orc: the table says "a hand's width above level", and level is
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
   * what lets one attack table describe the same swing for a 1.37m goblin and
   * a 2.11m orc: the table says "a hand's width above level", and level is
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
    this.severedAt = null;
    this.limp = false;
    this.armYaw = 0.30;
    this.armPitch = -0.30;
    this.reach = clamp(this.build.armLength * 0.793, this.minReach, this.maxReach);
    this.roll = 0;
    this.setTell(0);
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
  }

  /**
   * Cut the arm off. `shoulder` takes the whole limb, `elbow` takes the
   * forearm and the sword with it; either way the fighter is disarmed, because
   * the blade is welded to the hand and the hand is no longer attached to
   * anything that can be driven.
   */
  sever(where: "shoulder" | "elbow"): void {
    if (this.severedAt !== null) return;
    const joint = where === "shoulder" ? this.shoulderJoint : this.elbowJoint;
    if (!joint) return;

    this.phys.world.removeImpulseJoint(joint, true);
    if (where === "shoulder") this.shoulderJoint = null; else this.elbowJoint = null;
    this.severedAt = where;

    // Clear the accumulated drive forces, or they keep pushing after the cut.
    for (const b of [this.upper, this.fore, this.blade]) {
      b.resetForces(true);
      b.resetTorques(true);
    }
  }

  get disarmed(): boolean {
    return this.severedAt !== null;
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

    const ratio = t.bladeMass / this.weapon.mass;
    this.weaponColliders.forEach((c, i) => c.setMass(this.weapon.parts[i].mass * ratio));
    this.weaponMass = t.bladeMass;
  }

  /**
   * What the weapon actually weighs right now, for the damage model's heft
   * term. Usually the weapon's declared mass; different if the panel has been
   * played with.
   */
  get liveWeaponMass(): number {
    return this.weaponMass;
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

/** Fold an angle into (-pi, pi]. */
function wrapPi(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}
