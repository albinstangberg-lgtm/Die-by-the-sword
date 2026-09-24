import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import type { Tuning } from "../tuning";
import type { Build } from "./anatomy";
import type { Fighter } from "./fighter";
import { clamp, Tracker } from "./motion";
import { pushOut, repulsion } from "./clearance";
import { buildShieldMesh, SHIELD } from "./shield";
import { stablePD } from "./drive";

/**
 * The off arm, driven.
 *
 * It used to be held in a pose by a weak orientation spring on each bone, and
 * that spring was unstable: its damping, applied explicitly, was several times
 * what a bone's inertia about its own length can take in one step. So each
 * bone spun about its length, flipping direction every step at the torque
 * clamp -- a steady 37 rad/s at rest, standing still -- and the first shove
 * from a sidestep threw the whole limb over to the wrong side of the body. It
 * was the sword arm's roll singularity all over again, on an arm nobody had
 * gone back to.
 *
 * Now it is the sword arm's mechanic on a smaller budget: a ghost hand, solved
 * from the off shoulder with the same two-bone elbow, and a clamped PD drive
 * pulling the real hand after it, with the limb's weight fed forward. Nothing
 * about it is placed. And every gain is held inside what an explicit step on
 * that body's inertia stays stable under, about each of its principal axes on
 * its own -- which is the one rule the old spring broke.
 *
 * With nothing in it the hand rests in front of the belly and the arm is held
 * loosely, on a third of the sword arm's budget, so it still swings a little
 * when the body turns and settles back. With a shield it takes the whole
 * budget, holds a guard across the chest, and a player can steer it with the
 * mouse while the left button is held, as the right button rolls the sword.
 */

/**
 * Where the elbow hangs off the shoulder-to-hand line. Empty-handed it is
 * the sword arm's, mirrored: down, back, a little out.
 */
const POLE = { back: 1.0, down: 0.45, out: 0.35 };
/**
 * Behind a shield the elbow goes out and a little forward instead, so the
 * forearm -- and the shield on it -- runs ACROSS the chest. Hung back as the
 * empty arm's is, the forearm pointed forward and the shield faced sideways.
 */
const SHIELD_POLE = { back: -0.25, down: 0.55, out: 1.0 };

/** The same reach limits as the sword arm, as fractions of the arm's own length. */
const MIN_REACH_FRACTION = 0.517;
const REACH_MARGIN = 0.08;
/** And a hand being taken to a hold may straighten nearer to full, as the sword hand's may. */
const GUIDE_MARGIN = 0.02;
/**
 * How much of the trunk's push an arm holding its own body still gets: enough
 * that the forearm rests on the belly rather than sinking into it, not so much
 * that it is shoved off what the hand is holding.
 */
const ON_BODY_GIVE = 0.15;

/**
 * Aims, chest-relative: yaw about the chest's own facing (positive is out to
 * the left, negative across the body), pitch above level, reach 0..1 of the
 * arm's range.
 */
export interface OffAim {
  yaw: number;
  pitch: number;
  reach: number;
}

/** Empty-handed: the forearm across the belly, the way a free hand hangs. */
export const OFF_REST: Readonly<OffAim> = { yaw: -0.25, pitch: -1.05, reach: 0.9 };
/** With a shield: the forearm across the chest and the face forward. */
export const OFF_GUARD: Readonly<OffAim> = { yaw: -0.8, pitch: -0.45, reach: 0.8 };

/** How far the off arm may be steered, radians. Across the body is negative. */
const YAW_MIN = -1.5, YAW_MAX = 2.2;
const PITCH_MIN = -1.35, PITCH_MAX = 1.5;

/** Share of the sword arm's drive the off arm gets: loose empty, full with a shield. */
const REST_SHARE = 0.35;
const SHIELD_SHARE = 1;
/** As the sword arm: the shoulder's drive runs softer than the forearm's. */
const UPPER_SCALE = 0.7;

/** What the off arm reads from its input, once a step. */
export interface OffArmInput {
  /**
   * Mouse travel meant for the off arm since last asked, and whether it is
   * being steered at all -- the left button held.
   */
  consumeOff(): { dx: number; dy: number; wheel: number; active: boolean };
}

export class OffArm {
  /** Force budget as a multiple of the tuning's clamp, as the sword arm's. */
  power = 1;
  /** Set while the owner is down or dead: nothing drives the limb. */
  limp = false;

  /** The shield on the forearm, if one is strapped there. */
  private shieldPart: { collider: RAPIER.Collider; mesh: THREE.Object3D } | null = null;

  private readonly build: Build;
  private readonly upperLen: number;
  private readonly foreLen: number;
  private readonly foreHalf: number;
  private readonly upperHalf: number;
  private readonly minReach: number;
  private readonly maxReach: number;
  private readonly handRadius: number;
  private readonly radii: { elbow: number; fore: number; hand: number };

  /** What the hand asked for, exact; the ghost follows it through `track`. */
  private readonly aim: OffAim = { ...OFF_REST };
  private readonly track = new Tracker([OFF_REST.yaw, OFF_REST.pitch]);
  private readonly _want = [OFF_REST.yaw, OFF_REST.pitch];
  /** Being steered this step. */
  steered = false;
  /**
   * A world point the hand is being taken to instead of its aim, and how far
   * over to it, 0..1: a hold on a ledge. See `guide`.
   */
  private readonly guideAt = new THREE.Vector3();
  private guideWeight = 0;

  /** Last step's targets, for the speed they are moving at. */
  private primed = false;
  private readonly _prevGhost = new THREE.Vector3();
  private readonly _prevUpperQ = new THREE.Quaternion();
  private readonly _prevForeQ = new THREE.Quaternion();

  /** Distance between ghost hand and real hand, metres. */
  trackingError = 0;

  private readonly _shoulder = new THREE.Vector3();
  private readonly _ghost = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _elbow = new THREE.Vector3();
  private readonly _elbowDir = new THREE.Vector3();
  private readonly _foreDir = new THREE.Vector3();
  private readonly _upperQ = new THREE.Quaternion();
  private readonly _foreQ = new THREE.Quaternion();
  private readonly _hand = new THREE.Vector3();
  private readonly _handVel = new THREE.Vector3();
  private readonly _ghostVel = new THREE.Vector3();
  private readonly _force = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _c = new THREE.Vector3();
  private readonly _e = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _t = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q1 = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _q3 = new THREE.Quaternion();
  private readonly _m = new THREE.Matrix4();

  constructor(
    private readonly phys: PhysicsWorld,
    private readonly fighter: Fighter,
    private readonly side: Side,
    t: Tuning,
  ) {
    const build = this.build = fighter.build;
    this.upperLen = build.segment.upperArm.length;
    this.foreLen = build.segment.foreArm.length;
    this.upperHalf = this.upperLen / 2;
    this.foreHalf = this.foreLen / 2;
    this.minReach = build.armLength * MIN_REACH_FRACTION;
    this.maxReach = build.armLength - REACH_MARGIN * build.scale;
    const fore = build.segment.foreArm.radius;
    this.handRadius = fore * 1.22;
    this.radii = { elbow: fore * 1.15, fore, hand: this.handRadius };
    this.settle(t);
  }

  // ---------------------------------------------------------------------------
  // Intent
  // ---------------------------------------------------------------------------

  /**
   * Fold a step's mouse travel into the off arm's aim, while it is being
   * steered. Let go, a shield stays where it was put, as a sword does; an
   * empty hand goes back to hanging in front of the belly.
   */
  steer(input: { dx: number; dy: number; wheel: number; active: boolean }, t: Tuning): void {
    this.steered = input.active && this.attached;
    if (this.steered) {
      this.aim.yaw = clamp(this.aim.yaw - input.dx * t.sensitivity, YAW_MIN, YAW_MAX);
      this.aim.pitch = clamp(
        this.aim.pitch + input.dy * t.sensitivity * (t.invertY ? 1 : -1), PITCH_MIN, PITCH_MAX);
      const range = this.maxReach - this.minReach;
      this.aim.reach = clamp(this.aim.reach + (input.wheel * t.reachRate) / range, 0, 1);
    } else if (!this.shieldPart) {
      Object.assign(this.aim, OFF_REST);
    }
  }

  /**
   * Take the hand to a world point instead of its aim, `weight` of the way,
   * or back to the aim with null -- under the same drive, so it gets there
   * if the arm can. How a climb puts the hand on the ledge.
   *
   * `onBody` is a hand going to its own body -- holding a wound -- where the
   * forearm is meant to lie across the belly. The trunk pushing it off, as it
   * does any other time, fought the drive, and a goblin's hand swung a third
   * of a metre either side of the wound it was holding. It gives, then: see
   * `ON_BODY_GIVE`.
   */
  guide(at: THREE.Vector3 | null, weight = 1, onBody = false): void {
    if (!at) {
      this.guideWeight = 0;
      this.onBody = false;
      return;
    }
    this.guideAt.copy(at);
    this.guideWeight = clamp(weight, 0, 1);
    this.onBody = onBody;
  }

  /** The hand is being taken to its own body. See `guide`. */
  private onBody = false;

  /** The aim as it stands, chest-relative. For the harness. */
  get aimNow(): Readonly<OffAim> {
    return this.aim;
  }

  /** Both bones on and jointed: something to drive. */
  private get attached(): boolean {
    const l = this.fighter.offLimb;
    return l.shoulderOn && l.elbowOn;
  }

  // ---------------------------------------------------------------------------
  // The pose
  // ---------------------------------------------------------------------------

  /**
   * The target pose for an aim: the ghost hand, and each bone's orientation,
   * by the same two-bone solve and the same hinge convention as the sword
   * arm. Hung from where the posture has put the off shoulder this step.
   */
  private solve(
    yaw: number, pitch: number, reachFraction: number, t: Tuning,
    shielded = this.shieldPart !== null, guided = false,
  ): void {
    const f = this.fighter;
    f.offShoulderWorld(this._shoulder);
    // The chest's own facing: the off arm is carried by the chest, and turns
    // with it when a swing of the sword turns it.
    const frame = f.yaw + f.posture.pose.chestYaw;
    const a = frame + yaw;
    const cp = Math.cos(pitch);
    const dir = this._dir.set(-Math.sin(a) * cp, Math.sin(pitch), -Math.cos(a) * cp);
    let reach = this.minReach + (this.maxReach - this.minReach) * clamp(reachFraction, 0, 1);
    this._ghost.copy(this._shoulder).addScaledVector(dir, reach);

    // A hand going to a hold goes there instead, as far as the arm reaches.
    const w = guided ? this.guideWeight : 0;
    const hi = this.maxReach
      + (this.build.armLength - GUIDE_MARGIN * this.build.scale - this.maxReach) * w;
    if (w > 0) {
      this._ghost.lerp(this.guideAt, w);
      dir.copy(this._ghost).sub(this._shoulder);
      reach = clamp(dir.length(), this.minReach, hi);
      dir.normalize();
      this._ghost.copy(this._shoulder).addScaledVector(dir, reach);
    }

    // A hand steered into the body goes on its surface instead.
    const margin = t.clearance * this.build.scale;
    if (margin > 0
      && pushOut(this._ghost, this.handRadius, f.trunkCapsules(f.posture.pose), margin)) {
      dir.copy(this._ghost).sub(this._shoulder);
      reach = clamp(dir.length(), this.minReach, hi);
      dir.normalize();
      this._ghost.copy(this._shoulder).addScaledVector(dir, reach);
    }

    const l1 = this.upperLen;
    const l2 = this.foreLen;
    const d = clamp(reach, Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.01);
    const angle = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));

    // Out is to the LEFT: the sword arm's convention, mirrored.
    const hang = shielded ? SHIELD_POLE : POLE;
    const right = this._a.set(Math.cos(frame), 0, -Math.sin(frame));
    const back = this._b.set(Math.sin(frame), 0, Math.cos(frame));
    const pole = this._c.set(0, -hang.down, 0)
      .addScaledVector(right, -hang.out)
      .addScaledVector(back, hang.back)
      .normalize();
    const axis = this._a.crossVectors(dir, pole);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();
    const elbowDir = this._elbowDir.copy(dir).applyQuaternion(this._q.setFromAxisAngle(axis, angle));
    this._elbow.copy(this._shoulder).addScaledVector(elbowDir, l1);
    const foreDir = this._foreDir.copy(this._ghost).sub(this._elbow).normalize();

    // Both bones share the elbow's hinge as their local X, and the cross in
    // this order bends it the way the joint's limits allow.
    const hinge = this._b.crossVectors(foreDir, elbowDir);
    if (hinge.lengthSq() < 1e-8) hinge.set(1, 0, 0); else hinge.normalize();
    this._m.makeBasis(hinge, elbowDir, this._c.crossVectors(hinge, elbowDir));
    this._upperQ.setFromRotationMatrix(this._m);
    this._m.makeBasis(hinge, foreDir, this._c.crossVectors(hinge, foreDir));
    this._foreQ.setFromRotationMatrix(this._m);
  }

  /**
   * Lay the limb out in the pose its aim asks for, at rest, joints satisfied.
   * For spawns and resets: a limb that starts where it is going has nothing
   * to snap into.
   */
  settle(t: Tuning): void {
    const l = this.fighter.offLimb;
    this.track.snap([this.aim.yaw, this.aim.pitch]);
    this.solve(this.aim.yaw, this.aim.pitch, this.aim.reach, t);
    const put = (body: RAPIER.RigidBody, at: THREE.Vector3, q: THREE.Quaternion) => {
      body.setTranslation({ x: at.x, y: at.y, z: at.z }, true);
      body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.resetForces(true);
      body.resetTorques(true);
    };
    put(l.upper, this._a.copy(this._shoulder).addScaledVector(this._elbowDir, this.upperHalf),
      this._upperQ);
    put(l.fore, this._b.copy(this._elbow).addScaledVector(this._foreDir, this.foreHalf),
      this._foreQ);
    this.primed = false;
  }

  // ---------------------------------------------------------------------------
  // The drive
  // ---------------------------------------------------------------------------

  /** Once per fixed step, after the body has been placed and before the world steps. */
  drive(t: Tuning, dt: number): void {
    const l = this.fighter.offLimb;
    // Nothing must drive a limb that is off, or a body that is down -- and
    // Rapier keeps a force until it is cleared, so not driving it is not
    // enough: the last push would go on forever.
    if (this.limp || !l.shoulderOn || !l.elbowOn) {
      for (const b of [l.upper, l.fore]) {
        b.resetForces(false);
        b.resetTorques(false);
      }
      this.primed = false;
      this.trackingError = 0;
      return;
    }

    this._want[0] = this.aim.yaw;
    this._want[1] = this.aim.pitch;
    this.track.step(this._want, t.flickSpeed, t.flickAccel, dt);
    this.solve(this.track.pos[0], this.track.pos[1], this.aim.reach, t, this.shieldPart !== null, true);

    for (const b of [l.upper, l.fore]) {
      b.resetForces(false);
      b.resetTorques(false);
    }
    const power = this.power * (this.shieldPart ? SHIELD_SHARE : REST_SHARE);

    // The limb's weight, and the shield's, held up at each centre of mass.
    if (t.gravityComp > 0) {
      const up = -t.gravity * t.gravityComp;
      for (const b of [l.upper, l.fore]) b.addForce({ x: 0, y: b.mass() * up, z: 0 }, false);
    }

    // --- linear: the hand toward the ghost, damped against the ghost's own
    // motion, so a body that walks does not leave its hand behind it ---
    const fq = l.fore.rotation();
    const qf = this._q1.set(fq.x, fq.y, fq.z, fq.w);
    const r = this._a.set(0, this.foreHalf, 0).applyQuaternion(qf);
    const fp = l.fore.translation();
    this._hand.set(fp.x + r.x, fp.y + r.y, fp.z + r.z);
    const lv = l.fore.linvel();
    const av = l.fore.angvel();
    this._handVel.set(
      lv.x + (av.y * r.z - av.z * r.y),
      lv.y + (av.z * r.x - av.x * r.z),
      lv.z + (av.x * r.y - av.y * r.x),
    );
    if (this.primed) this._ghostVel.copy(this._ghost).sub(this._prevGhost).multiplyScalar(1 / dt);
    else this._ghostVel.set(0, 0, 0);
    this._prevGhost.copy(this._ghost);

    const err = this._force.copy(this._ghost).sub(this._hand);
    this.trackingError = err.length();
    const force = err.multiplyScalar(t.armKp * power)
      .addScaledVector(this._handVel.sub(this._ghostVel), -t.armKd * power);
    const maxForce = t.maxForce * power;
    if (force.length() > maxForce) force.setLength(maxForce);
    l.fore.addForceAtPoint(
      { x: force.x, y: force.y, z: force.z },
      { x: this._hand.x, y: this._hand.y, z: this._hand.z }, true);

    // --- angular: each bone toward its own target ---
    this.turn(l.fore, this._foreQ, this._prevForeQ,
      t.armKpRot * power, t.armKdRot * power, t.maxTorque * power, dt);
    this.turn(l.upper, this._upperQ, this._prevUpperQ,
      t.armKpRot * power * UPPER_SCALE, t.armKdRot * power * UPPER_SCALE,
      t.maxTorque * power * UPPER_SCALE, dt);
    this.primed = true;

    this.keepClear(t, l);
  }

  /**
   * Turn a body toward a world orientation: a clamped PD, damped against the
   * target's own spin, with the gains about each principal axis held inside
   * what an explicit step on that axis's inertia can take. About a bone's own
   * length that is very little -- that axis is where the old spring blew up --
   * and across it, or with a shield strapped on, there is room for the whole
   * drive.
   */
  private turn(
    body: RAPIER.RigidBody, target: THREE.Quaternion, prev: THREE.Quaternion,
    kp: number, kd: number, maxTorque: number, dt: number,
  ): void {
    const r = body.rotation();
    const q = this._q1.set(r.x, r.y, r.z, r.w);
    const e = this._q2.copy(q).invert().premultiply(target);
    if (e.w < 0) e.set(-e.x, -e.y, -e.z, -e.w);
    const err = axisAngle(e, this._e);

    // How far the target itself turned since last step: the chest's turn,
    // the aim's sweep. Damping only what the bone does beyond that is what
    // stops a turning body leaving its arm behind.
    const w = body.angvel();
    const spin = this._w.set(w.x, w.y, w.z);
    if (this.primed) {
      const d = this._q3.copy(prev).invert().premultiply(target);
      if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
      spin.addScaledVector(axisAngle(d, this._t), -1 / dt);
    }
    prev.copy(target);

    // Each principal axis gets only what its own inertia can take.
    const torque = stablePD(body, err, spin, kp, kd, dt, this._t);
    if (torque.length() > maxTorque) torque.setLength(maxTorque);
    body.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
  }

  /**
   * The trunk pushing back on the real limb, as it does on the sword arm: the
   * elbow, the middle of the forearm, and the hand. Not the root of the upper
   * arm, which hangs against the ribs by construction.
   */
  private keepClear(t: Tuning, l: Fighter["offLimb"]): void {
    if (t.clearance <= 0) return;
    const caps = this.fighter.trunkCapsules(this.fighter.posture.pose);
    const points: [RAPIER.RigidBody, number, number][] = [
      [l.upper, this.upperHalf, this.radii.elbow],
      [l.fore, 0, this.radii.fore],
      [l.fore, this.foreHalf, this.radii.hand],
    ];
    for (const [body, along, radius] of points) {
      const bq = body.rotation();
      const r = this._a.set(0, along, 0).applyQuaternion(this._q1.set(bq.x, bq.y, bq.z, bq.w));
      const c = body.translation();
      const p = this._b.set(c.x + r.x, c.y + r.y, c.z + r.z);
      const lv = body.linvel();
      const av = body.angvel();
      const vel = this._c.set(
        lv.x + (av.y * r.z - av.z * r.y),
        lv.y + (av.z * r.x - av.x * r.z),
        lv.z + (av.x * r.y - av.y * r.x),
      );
      const give = this.onBody ? ON_BODY_GIVE : 1;
      if (repulsion(p, radius, vel, caps, this.power * give, this._t) <= 0) continue;
      body.addForceAtPoint(
        { x: this._t.x, y: this._t.y, z: this._t.z }, { x: p.x, y: p.y, z: p.z }, true);
    }
  }

  // ---------------------------------------------------------------------------
  // The shield
  // ---------------------------------------------------------------------------

  get hasShield(): boolean {
    return this.shieldPart !== null;
  }

  /** The shield's collider, for telling a blocked blow from a landed one. */
  get shieldCollider(): RAPIER.Collider | null {
    return this.shieldPart?.collider ?? null;
  }

  /**
   * Strap a shield to the forearm. False if there is no forearm to strap it
   * to, or one is already there.
   *
   * It is a collider on the forearm's own body, so it goes wherever the
   * forearm goes -- including onto the floor, if the forearm is cut off. It is
   * laid so its face points forward with the arm at its guard, worked out from
   * the guard's own solved pose rather than declared, so it stays true for a
   * body of any size.
   */
  equipShield(t: Tuning): boolean {
    if (this.shieldPart || !this.attached) return false;
    const { rapier, world } = this.phys;
    const l = this.fighter.offLimb;
    const s = this.build.scale;

    this.solve(OFF_GUARD.yaw, OFF_GUARD.pitch, OFF_GUARD.reach, t, true);
    const frame = this.fighter.yaw + this.fighter.posture.pose.chestYaw;
    const face = this._a.set(-Math.sin(frame), 0, -Math.cos(frame))
      .applyQuaternion(this._q.copy(this._foreQ).invert());
    face.y = 0;
    if (face.lengthSq() < 1e-8) face.set(0, 0, -1);
    face.normalize();

    const turn = this._q.setFromUnitVectors(this._b.set(0, 1, 0), face);
    const at = this._c.set(0, SHIELD.along * s, 0)
      .addScaledVector(face, this.radii.fore + (SHIELD.thick * s) / 2 + 0.01 * s);

    const collider = world.createCollider(
      rapier.ColliderDesc.cylinder((SHIELD.thick * s) / 2, SHIELD.radius * s)
        .setTranslation(at.x, at.y, at.z)
        .setRotation({ x: turn.x, y: turn.y, z: turn.z, w: turn.w })
        .setMass(SHIELD.mass * s * s)
        .setFriction(0.4)
        .setRestitution(0.1)
        // A blade's membership, but not a blade's filter: it meets the world
        // and other blades, and nothing that bleeds. So an enemy's cut that
        // finds it is stopped like a parry, and is never taken for flesh.
        .setCollisionGroups(this.side.shieldFilter),
      l.fore,
    );
    // A shield swung fast into a thin blade should not tunnel through it.
    l.fore.enableCcd(true);

    const mesh = buildShieldMesh(s);
    mesh.position.copy(at);
    mesh.quaternion.copy(turn);
    this.fighter.offForeMesh.add(mesh);

    this.shieldPart = { collider, mesh };
    Object.assign(this.aim, OFF_GUARD);
    this.primed = false;
    return true;
  }

  /** Take the shield off the arm, wherever the arm is. */
  dropShield(): void {
    const part = this.shieldPart;
    if (!part) return;
    this.phys.world.removeCollider(part.collider, true);
    part.mesh.removeFromParent();
    part.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    this.shieldPart = null;
    Object.assign(this.aim, OFF_REST);
    this.primed = false;
  }

  /** After the body has been on the floor: take the arm back up from where it hangs. */
  regain(): void {
    this.limp = false;
    this.guideWeight = 0;
    this.onBody = false;
    this.primed = false;
    this.track.snap([this.aim.yaw, this.aim.pitch]);
  }

  /** Back to an empty hand at rest, laid out in place. Call after the fighter's reset. */
  reset(t: Tuning): void {
    this.dropShield();
    this.limp = false;
    this.steered = false;
    this.guideWeight = 0;
    this.onBody = false;
    Object.assign(this.aim, OFF_REST);
    this.settle(t);
  }
}

/** A unit quaternion's rotation as a vector: its axis times its angle. */
function axisAngle(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.hypot(q.x, q.y, q.z);
  if (s < 1e-9) return out.set(0, 0, 0);
  return out.set(q.x, q.y, q.z).multiplyScalar((2 * Math.atan2(s, q.w)) / s);
}
