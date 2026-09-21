import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";

import type { Tuning } from "../tuning";
import { SHOULDER_LOCAL, type Fighter } from "./fighter";

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

// --- segment geometry, metres ---
const UPPER_LEN = 0.30;
const UPPER_RADIUS = 0.052;
const FORE_LEN = 0.28;
const FORE_RADIUS = 0.046;

const UPPER_HALF = UPPER_LEN / 2;
const FORE_HALF = FORE_LEN / 2;
/** Capsule half-height excludes the two hemispherical caps. */
const UPPER_CAP_HH = UPPER_HALF - UPPER_RADIUS;
const FORE_CAP_HH = FORE_HALF - FORE_RADIUS;

// --- blade geometry ---
const GRIP_LEN = 0.11;        // hand to guard
const BLADE_LEN = 0.86;
const BLADE_HALF_WIDTH = 0.019;   // along local Z — the EDGE axis
const BLADE_HALF_THICK = 0.0048;  // along local X — the flat
const BLADE_MID_Y = GRIP_LEN + BLADE_LEN / 2;
const TIP_Y = GRIP_LEN + BLADE_LEN;

// --- reach limits, from the shoulder ---
/**
 * Folding tighter than this turns the arm into a knot that points the blade at
 * the floor, where the tip grounds out and props the whole limb up. The sword
 * genuinely CAN be planted and stuck -- that is good, and worth keeping -- but
 * it should take a deliberate downward swing, not simply pulling the hand in.
 */
const MIN_REACH = 0.30;
/**
 * Deliberately well short of UPPER_LEN+FORE_LEN (0.58). Near full extension the
 * elbow's moment arm collapses: the force pulling the hand back in acts almost
 * along the arm and has nothing to bend against, so the limb locks straight and
 * stops tracking. Keeping the reach 8cm inside anatomical maximum holds the
 * elbow at 60 degrees or more of flexion, where it always has leverage.
 */
const MAX_REACH = 0.50;

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
  readonly blade: RAPIER.RigidBody;
  readonly bladeCollider: RAPIER.Collider;

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

  constructor(
    private phys: PhysicsWorld,
    scene: THREE.Scene,
    private fighter: Fighter,
    tuning: Tuning,
    readonly side: Side = fighter.side,
  ) {
    const { rapier, world } = phys;

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

    this.upper = world.createRigidBody(dyn(at(UPPER_HALF)));
    this.fore = world.createRigidBody(dyn(at(UPPER_LEN + FORE_HALF)));
    this.blade = world.createRigidBody(dyn(at(UPPER_LEN + FORE_LEN)));

    // A fast tip crosses several centimetres per step. Without CCD it tunnels
    // straight through the thin post and you cut air where you clearly connected.
    this.blade.enableCcd(true);
    this.fore.enableCcd(true);

    // The limb is transparent to its own blade but solid to the other one.
    const limbGroups = this.side.bodyFilter;
    const armMassEach = tuning.armMass / 2;

    world.createCollider(
      rapier.ColliderDesc.capsule(UPPER_CAP_HH, UPPER_RADIUS)
        .setMass(armMassEach).setFriction(0.5).setCollisionGroups(limbGroups),
      this.upper,
    );
    world.createCollider(
      rapier.ColliderDesc.capsule(FORE_CAP_HH, FORE_RADIUS)
        .setMass(armMassEach).setFriction(0.5).setCollisionGroups(limbGroups),
      this.fore,
    );

    // The blade: thin in X (the flats), wide in Z (edge to edge), long in Y.
    // Z rather than X because the forearm's X is spoken for by the elbow hinge;
    // putting the edge on Z lands it in the plane of the arm.
    this.bladeCollider = world.createCollider(
      rapier.ColliderDesc.cuboid(BLADE_HALF_THICK, BLADE_LEN / 2, BLADE_HALF_WIDTH)
        .setTranslation(0, BLADE_MID_Y, 0)
        .setMass(tuning.bladeMass)
        .setFriction(0.25)      // low: steel skids off stone rather than gripping
        .setRestitution(0.12)   // a little — a hard parry should kick back
        .setCollisionGroups(this.side.bladeFilter)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(2.0),
      this.blade,
    );

    // --- joints ---
    // Shoulder: spherical, 3 DOF, anchored at the torso's shoulder point.
    this.shoulderJoint = world.createImpulseJoint(
      rapier.JointData.spherical(
        // Must match Fighter.shoulderWorld, or the ghost hand is computed from
        // one shoulder while the arm hangs off another.
        { x: SHOULDER_LOCAL.x, y: SHOULDER_LOCAL.y, z: SHOULDER_LOCAL.z },
        { x: 0, y: -UPPER_HALF, z: 0 },      // top of the upper arm
      ),
      this.fighter.body, this.upper, true,
    );

    // Elbow: revolute, 1 DOF, hinging about the arm's local X. Limited so it
    // bends one way only — an elbow that inverts instantly looks like a bug.
    const elbow = this.elbowJoint = world.createImpulseJoint(
      rapier.JointData.revolute(
        { x: 0, y: UPPER_HALF, z: 0 },
        { x: 0, y: -FORE_HALF, z: 0 },
        { x: 1, y: 0, z: 0 },
      ),
      this.upper, this.fore, true,
    ) as RAPIER.RevoluteImpulseJoint;
    // A real elbow does not hyperextend, and allowing even a few degrees of it
    // here lets the joint cross to the far side of straight, where the sign of
    // the bend is undefined and the arm can jam. The upper bound keeps it
    // permanently on one side of the singularity.
    elbow.setLimits(-2.45, -0.06);

    // Hand: the blade is welded rigidly. Identity frames mean the blade's +Y
    // (its length) continues the forearm's +Y, and its +X is the cutting edge.
    world.createImpulseJoint(
      rapier.JointData.fixed(
        { x: 0, y: FORE_HALF, z: 0 }, { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 },
      ),
      this.fore, this.blade, true,
    );

    this.buildMeshes();
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
    this.reach = clamp(this.reach + wheel * t.reachRate, MIN_REACH, MAX_REACH);

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
    const d = clamp(this.reach, Math.abs(UPPER_LEN - FORE_LEN) + 0.01, UPPER_LEN + FORE_LEN - 0.01);
    const cosA = (UPPER_LEN * UPPER_LEN + d * d - FORE_LEN * FORE_LEN) / (2 * UPPER_LEN * d);
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

    this._elbowTarget.copy(this._shoulder).addScaledVector(elbowDir, UPPER_LEN);
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
    const offset = this._v.set(0, FORE_HALF, 0).applyQuaternion(this._q);
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

    const force = err.multiplyScalar(t.armKp).addScaledVector(this._handVel, -t.armKd);
    const mag = force.length();
    this.state.saturation = t.maxForce > 0 ? Math.min(1, mag / t.maxForce) : 1;
    if (mag > t.maxForce) force.multiplyScalar(t.maxForce / mag);

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
        .multiplyScalar((angle / sinHalf) * t.armKpRot);
    }
    this.state.roll = angle;

    torque.x -= av.x * t.armKdRot;
    torque.y -= av.y * t.armKdRot;
    torque.z -= av.z * t.armKdRot;

    const tmag = torque.length();
    this.state.torqueSaturation = t.maxTorque > 0 ? Math.min(1, tmag / t.maxTorque) : 1;
    if (tmag > t.maxTorque) torque.multiplyScalar(t.maxTorque / tmag);
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
        .multiplyScalar((angle / sinHalf) * t.armKpRot * UPPER_TORQUE_SCALE);
    }
    const av = this.upper.angvel();
    torque.x -= av.x * t.armKdRot * UPPER_TORQUE_SCALE;
    torque.y -= av.y * t.armKdRot * UPPER_TORQUE_SCALE;
    torque.z -= av.z * t.armKdRot * UPPER_TORQUE_SCALE;

    const cap = t.maxTorque * UPPER_TORQUE_SCALE;
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
    const r = this._v.set(0, TIP_Y, 0).applyQuaternion(this._q);
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
   * The blade's cutting-edge direction (local +Z) as of the pre-step snapshot.
   * Taken from the same instant as `velocityAt`, so edge alignment and closing
   * speed describe one moment rather than two.
   */
  edgeDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this._preQuat);
  }

  /** A point on the blade, 0 at the guard and 1 at the tip, in world space. */
  pointAlongBlade(t: number, out: THREE.Vector3): THREE.Vector3 {
    const bq = this.blade.rotation();
    const bp = this.blade.translation();
    out.set(0, GRIP_LEN + BLADE_LEN * t, 0)
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

  private buildMeshes(): void {
    const skin = new THREE.MeshStandardMaterial({ color: 0xa8826a, roughness: 0.65 });

    this.upperMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(UPPER_RADIUS, UPPER_CAP_HH * 2, 6, 12), skin,
    );
    this.foreMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(FORE_RADIUS, FORE_CAP_HH * 2, 6, 12), skin,
    );
    this.upperMesh.castShadow = true;
    this.foreMesh.castShadow = true;
    this.group.add(this.upperMesh, this.foreMesh);

    this.bladeMesh = buildSwordMesh();
    this.group.add(this.bladeMesh);

    this.ghostMesh = buildGhostMesh();
    this.group.add(this.ghostMesh);
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

  static readonly LIMITS = {
    yaw: [YAW_MIN, YAW_MAX] as const,
    pitch: [PITCH_MIN, PITCH_MAX] as const,
    reach: [MIN_REACH, MAX_REACH] as const,
    roll: [ROLL_MIN, ROLL_MAX] as const,
  };

  /** Re-seat the arm after a reset, so it doesn't whip back across the room. */
  reset(t: Tuning): void {
    this.severedAt = null;
    this.limp = false;
    this.armYaw = 0.30;
    this.armPitch = -0.30;
    this.reach = 0.46;
    this.roll = 0;
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
    place(this.upper, UPPER_HALF);
    place(this.fore, UPPER_LEN + FORE_HALF);
    place(this.blade, UPPER_LEN + FORE_LEN);
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

  /** Masses are tunable at runtime, so they need re-applying on change. */
  applyMasses(t: Tuning): void {
    this.upper.collider(0)?.setMass(t.armMass / 2);
    this.fore.collider(0)?.setMass(t.armMass / 2);
    this.bladeCollider.setMass(t.bladeMass);
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

function buildSwordMesh(): THREE.Group {
  const g = new THREE.Group();

  const steel = new THREE.MeshStandardMaterial({
    color: 0xc3cad2, roughness: 0.28, metalness: 0.88,
  });
  const edge = new THREE.MeshStandardMaterial({
    color: 0xf2f6fa, roughness: 0.12, metalness: 0.95,
  });
  const leather = new THREE.MeshStandardMaterial({ color: 0x3a2b22, roughness: 0.9 });
  const brass = new THREE.MeshStandardMaterial({
    color: 0x9a7b3f, roughness: 0.4, metalness: 0.8,
  });

  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(BLADE_HALF_THICK * 2, BLADE_LEN, BLADE_HALF_WIDTH * 2), steel,
  );
  blade.position.y = BLADE_MID_Y;
  blade.castShadow = true;
  g.add(blade);

  // Bright slivers on the two cutting edges. Purely visual, but they let you
  // read the blade's roll at a glance — which matters, because roll decides
  // whether a hit cuts or slaps.
  for (const sz of [-1, 1]) {
    const e = new THREE.Mesh(
      new THREE.BoxGeometry(BLADE_HALF_THICK * 2.1, BLADE_LEN, 0.003), edge,
    );
    e.position.set(0, BLADE_MID_Y, sz * BLADE_HALF_WIDTH);
    g.add(e);
  }

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.19), brass);
  guard.position.y = GRIP_LEN;
  guard.castShadow = true;
  g.add(guard);

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, GRIP_LEN, 10), leather);
  grip.position.y = GRIP_LEN / 2;
  g.add(grip);

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), brass);
  g.add(pommel);

  return g;
}

function buildGhostMesh(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x5fd3ff, wireframe: true, transparent: true, opacity: 0.5,
  });
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), mat);
  g.add(hand);
  // The target blade axis, so the gap between where you asked the sword to be
  // and where it actually is reads as a shape, not just a number.
  const axis = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.5, 6), mat);
  axis.position.y = 0.25;
  g.add(axis);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.004, 0.004), mat);
  edge.position.y = 0.12;
  g.add(edge);
  return g;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
