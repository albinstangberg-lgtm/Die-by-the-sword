import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import type { Build } from "./anatomy";

/**
 * A body with nobody in it.
 *
 * Alive, a fighter is a hull that walks: one rigid body that faces, carries
 * the chest and the hips as colliders, and has legs that are posed rather
 * than simulated. Killed, that used to be what fell -- the hull balanced on
 * its end for a second and a half, then went over stiff as a plank with its
 * legs straight out, because nothing in it could bend.
 *
 * This is what it turns into instead. The hull stops holding the body up:
 * its capsule is switched off, and what is left of it is the chest. The hips
 * come away as a body of their own, on a waist that bends, and the thighs and
 * shins stop being posed and are simulated, on hips and knees that only go
 * the way a person's do. The head, both arms and the weapon were jointed
 * rigid bodies already, and are left to hang as they are, the neck given a
 * range so a dead head cannot turn right round.
 *
 * Nothing is placed and nothing is driven. Wherever the blow and the floor
 * put it is where it lies.
 *
 * A body knocked down is one of these too, for as long as it is down, with
 * some life in it: motors in the same joints brace it on the way over, and
 * gather it before it gets up -- the waist straightens and the legs draw in.
 * It is then taken apart again, so that what stands up is a hull whose hips
 * and legs are already more or less where the living figure keeps them: see
 * `Fighter.beginRise`.
 *
 * The meshes are the living figure's, and stay where they are in its
 * hierarchy -- hips, belt, the balls at the hip and knee, the feet -- and are
 * turned each frame to match the bodies, so nothing comes adrift from what it
 * was attached to.
 */

/** The living figure's legs, as the ragdoll needs them. */
export interface RagdollLeg {
  thigh: RAPIER.RigidBody;
  shin: RAPIER.RigidBody;
  hipPivot: THREE.Object3D;
  kneePivot: THREE.Object3D;
}

/** Everything of a fighter that dying changes. */
export interface RagdollRig {
  phys: PhysicsWorld;
  side: Side;
  build: Build;
  /** The hull: from here on, the chest. */
  hull: RAPIER.RigidBody;
  /** Its walking capsule, switched off. */
  hullCollider: RAPIER.Collider;
  /** The hips' collider on the hull, handed over to the hips' own body. */
  pelvisCollider: RAPIER.Collider;
  /** The body group, the hips group and the chest group, in that order of parenthood. */
  mesh: THREE.Object3D;
  pelvis: THREE.Object3D;
  chest: THREE.Object3D;
  legs: readonly RagdollLeg[];
  /** The neck, if the head is still on. */
  neck: RAPIER.ImpulseJoint | null;
  /** Where the posture last had things, hull-local: the waist the chest bends about, and the chest's turn. */
  waist: THREE.Vector3;
  chestQuat: THREE.Quaternion;
  /** And the hips group: where it hung, and how it was turned and tilted. */
  hipsAt: THREE.Vector3;
  hipsQuat: THREE.Quaternion;
}

// Rapier's typed wrapper gives a ball joint no limits, but the joint underneath
// has one per axis: see `Arm.makeWristJoint`.
const ANG_X = 3, ANG_Y = 4, ANG_Z = 5;
interface JointRaw {
  jointSetLimits(handle: number, axis: number, min: number, max: number): void;
  jointConfigureMotorModel(handle: number, axis: number, model: number): void;
  jointConfigureMotorPosition(
    handle: number, axis: number, target: number, stiffness: number, damping: number): void;
}
/** Rapier's MotorModel.ForceBased: the gains are a torque per radian and per rad/s, as given. */
const MOTOR_BY_FORCE = 1;

/**
 * How far each joint goes, radians, about its own X (forward and back), Y
 * (twist) and Z (side to side). Limits are what make a heap of limbs a body:
 * a spine that folds forward further than back, hips that swing a thigh up
 * in front but hardly behind, and knees that only bend one way.
 */
const WAIST = { x: [-0.35, 0.85], y: [-0.6, 0.6], z: [-0.4, 0.4] } as const;
const HIP = { x: [-0.45, 1.7], y: [-0.75, 0.75], z: [-0.7, 0.35] } as const;
const NECK = { x: [-0.8, 0.6], y: [-1.1, 1.1], z: [-0.5, 0.5] } as const;
/** A knee straight is 0, and it bends the foot back: negative about its hinge. */
const KNEE: readonly [number, number] = [-2.4, 0];

/**
 * Limp, not loose. Some damping in every piece, so a body that has come down
 * settles where it landed instead of trembling on its joints for ever.
 */
const LINEAR_DAMPING = 0.3;
const ANGULAR_DAMPING = 1.4;
const FRICTION = 0.7;

interface Tracked {
  body: RAPIER.RigidBody;
  prevP: THREE.Vector3;
  prevQ: THREE.Quaternion;
}

export class Ragdoll {
  /** The hips, come away from the chest. */
  readonly hips: RAPIER.RigidBody;
  private readonly joints: RAPIER.ImpulseJoint[] = [];
  /** The hips group's pose on the hips body, and the chest group's on the hull. */
  private readonly pelvisOnHips = new THREE.Matrix4();
  private readonly chestOnHull = new THREE.Matrix4();
  /** Last step's transform of every body this simulates, for render to ease from. */
  private readonly tracked: Tracked[] = [];
  /** The joints by what they are, for `drive`: the waist, then each leg's hip and knee. */
  private waistJoint!: RAPIER.ImpulseJoint;
  private readonly hipJoints: RAPIER.ImpulseJoint[] = [];
  private readonly kneeJoints: RAPIER.RevoluteImpulseJoint[] = [];
  /** The hips' own collider: a stand-in for the hull's, which is switched off. */
  readonly hipsCollider: RAPIER.Collider;

  constructor(private readonly rig: RagdollRig) {
    const { rapier, world } = rig.phys;
    const { hull, build } = rig;
    const seg = build.segment;

    const hp = hull.translation();
    const hr = hull.rotation();
    const hullPos = new THREE.Vector3(hp.x, hp.y, hp.z);
    const hullQuat = new THREE.Quaternion(hr.x, hr.y, hr.z, hr.w);
    const lv = hull.linvel();
    const av = hull.angvel();

    // The chest group, where the posture last had it, fixed to the hull.
    this.chestOnHull.compose(rig.waist, rig.chestQuat, ONE);

    // --- the hips, as a body of their own -----------------------------------
    //
    // Where the hips' collider was, turned with the hips rather than the hull
    // -- the legs are measured from the way the hips face.
    const pc = rig.pelvisCollider.translation();
    const hipsQuat = hullQuat.clone().multiply(rig.hipsQuat);
    this.hips = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(pc.x, pc.y, pc.z)
        .setRotation({ x: hipsQuat.x, y: hipsQuat.y, z: hipsQuat.z, w: hipsQuat.w })
        .setLinvel(lv.x, lv.y, lv.z)
        .setAngvel({ x: av.x, y: av.y, z: av.z })
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
        .setCanSleep(false),
    );
    this.hipsCollider = world.createCollider(
      rapier.ColliderDesc.capsule(
        Math.max(0.01, seg.pelvis.length / 2 - seg.pelvis.radius), seg.pelvis.radius)
        .setMass(seg.pelvis.mass)
        .setFriction(FRICTION)
        .setCollisionGroups(rig.side.bodyFilter),
      this.hips,
    );
    this.pelvisOnHips.copy(this.hipsGroupOffset(hullPos, hullQuat, hipsQuat, pc));

    // And the hull lets go of it: no capsule to stand on, no hips.
    rig.hullCollider.setEnabled(false);
    rig.pelvisCollider.setEnabled(false);
    hull.setEnabledRotations(true, true, true, true);
    hull.setLinearDamping(LINEAR_DAMPING);
    hull.setAngularDamping(ANGULAR_DAMPING);

    // --- the waist -----------------------------------------------------------
    const waist = rig.waist.clone().applyQuaternion(hullQuat).add(hullPos);
    this.waistJoint = this.ball(hull, this.hips, waist, WAIST);

    // --- the legs --------------------------------------------------------------
    for (const leg of rig.legs) {
      this.free(leg.thigh, seg.thigh.mass, lv);
      this.free(leg.shin, seg.shin.mass, lv);
      // A leg's own +Y runs up it: the hip is half a thigh up the thigh, the
      // knee half a thigh down it and half a shin up the shin.
      const hip = pointOn(leg.thigh, 0, seg.thigh.length / 2);
      this.hipJoints.push(this.ball(this.hips, leg.thigh, hip, HIP));
      const knee = world.createImpulseJoint(
        rapier.JointData.revolute(
          { x: 0, y: -seg.thigh.length / 2, z: 0 },
          { x: 0, y: seg.shin.length / 2, z: 0 },
          { x: 1, y: 0, z: 0 },
        ),
        leg.thigh, leg.shin, true,
      ) as RAPIER.RevoluteImpulseJoint;
      knee.setLimits(KNEE[0], KNEE[1]);
      this.joints.push(knee);
      this.kneeJoints.push(knee);
    }

    // --- the neck ----------------------------------------------------------------
    if (rig.neck) limit(rig.neck, NECK);

    for (const body of [this.hips, ...rig.legs.flatMap((l) => [l.thigh, l.shin])]) {
      this.tracked.push({ body, prevP: new THREE.Vector3(), prevQ: new THREE.Quaternion() });
    }
    this.capture();
  }

  /**
   * The hips group's pose on the hips' body.
   *
   * The group hangs from the hull where the posture had it, turned and tilted
   * as it had them; the body is where the hips' collider was, turned the same
   * way. Worked out from the two poses rather than by hand, so it holds
   * however the hull stood when it died.
   */
  private hipsGroupOffset(
    hullPos: THREE.Vector3, hullQuat: THREE.Quaternion, hipsQuat: THREE.Quaternion,
    pc: { x: number; y: number; z: number },
  ): THREE.Matrix4 {
    const hull = new THREE.Matrix4().compose(hullPos, hullQuat, ONE);
    const group = new THREE.Matrix4().compose(this.rig.hipsAt, this.rig.hipsQuat, ONE);
    const groupWorld = hull.clone().multiply(group);
    const hips = new THREE.Matrix4().compose(new THREE.Vector3(pc.x, pc.y, pc.z), hipsQuat, ONE);
    return hips.invert().multiply(groupWorld);
  }

  /** A posed leg bone let loose: a body with a weight, that meets the floor. */
  private free(body: RAPIER.RigidBody, mass: number, lv: { x: number; y: number; z: number }): void {
    const { rapier } = this.rig.phys;
    body.setBodyType(rapier.RigidBodyType.Dynamic, true);
    const c = body.collider(0)!;
    c.setMass(mass);
    c.setFriction(FRICTION);
    c.setCollisionGroups(this.rig.side.bodyFilter);
    body.setLinearDamping(LINEAR_DAMPING);
    body.setAngularDamping(ANGULAR_DAMPING);
    body.setLinvel({ x: lv.x, y: lv.y, z: lv.z }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** A ball joint between two bodies at a world point, with a range on each axis. */
  private ball(
    a: RAPIER.RigidBody, b: RAPIER.RigidBody, at: THREE.Vector3, range: Range,
  ): RAPIER.ImpulseJoint {
    const { rapier, world } = this.rig.phys;
    const joint = world.createImpulseJoint(
      rapier.JointData.spherical(toLocal(a, at), toLocal(b, at)), a, b, true);
    limit(joint, range);
    this.joints.push(joint);
    return joint;
  }

  /**
   * Some life in it: the hips square under the chest, and each leg to the
   * hip and knee `legs` gives it, flexion positive.
   *
   * A body knocked over is not a dead one. It goes over braced, held more or
   * less straight on its way to the floor, rather than folding in a heap
   * where it stood; and before it gets up it pulls itself together into the
   * sprawl a living figure on the floor has its legs in, so there is little
   * left to hide when the legs go back to being posed.
   *
   * Motors in the joints the body already has: a spring and damper to a
   * target angle, closing at `rate`, 1/s, on what each joint has to move.
   * That is worked out from the anatomy -- the upper body about the waist, a
   * whole leg about the hip, a shin about the knee -- and not left to Rapier,
   * whose own scaling goes by the two bodies a joint joins and nothing hung
   * off them: at the waist, that is a pair of hips and a chest without its
   * head and arms, and the motor could not lift the one off the floor. The
   * floor, and anything on it, still has its say.
   */
  drive(legs: readonly { hip: number; knee: number }[], rate: number): void {
    const seg = this.rig.build.segment;
    const upper = seg.torso.mass + seg.head.mass + 2 * (seg.upperArm.mass + seg.foreArm.mass);
    const leg = seg.thigh.mass + seg.shin.mass;
    const waist = upper * seg.torso.length * seg.torso.length;
    const hip = leg * seg.thigh.length * seg.thigh.length;
    const knee = seg.shin.mass * seg.shin.length * seg.shin.length;
    motor(this.waistJoint, [0, 0, 0], waist * rate * rate, 2 * waist * rate);
    for (let i = 0; i < this.hipJoints.length; i++) {
      motor(this.hipJoints[i], [legs[i].hip, 0, 0], hip * rate * rate, 2 * hip * rate);
      const joint = this.kneeJoints[i];
      joint.configureMotorModel(MOTOR_BY_FORCE);
      // A knee's bend is negative about its hinge: see KNEE.
      joint.configureMotorPosition(-legs[i].knee, knee * rate * rate, 2 * knee * rate);
    }
  }

  /** Nothing in it: limp. */
  relax(): void {
    motor(this.waistJoint, [0, 0, 0], 0, 0);
    for (const hip of this.hipJoints) motor(hip, [0, 0, 0], 0, 0);
    for (const knee of this.kneeJoints) knee.configureMotorPosition(0, 0, 0);
  }

  /** Call once per step, before the physics step: what render eases from. */
  capture(): void {
    for (const t of this.tracked) {
      const p = t.body.translation();
      const q = t.body.rotation();
      t.prevP.set(p.x, p.y, p.z);
      t.prevQ.set(q.x, q.y, q.z, q.w);
    }
  }

  /**
   * Per frame: turn the living figure's hips, chest and legs to lie as the
   * bodies do. The body group itself is the hull's, and the Interpolator has
   * already placed it.
   */
  pose(alpha: number): void {
    const { mesh, pelvis, chest, legs } = this.rig;
    mesh.updateMatrixWorld(true);

    // The hips group: the hips' body, eased, carrying its offset.
    const hips = this.eased(this.tracked[0], alpha, _m);
    _world.multiplyMatrices(hips, this.pelvisOnHips);
    setLocal(pelvis, mesh.matrixWorld, _world);

    // The chest group rides the hull, which is the body group's own pose.
    pelvis.updateMatrixWorld(true);
    _world.multiplyMatrices(mesh.matrixWorld, this.chestOnHull);
    setLocal(chest, pelvis.matrixWorld, _world);

    // Each leg bone's turn relative to what it hangs from. Positions stay
    // where the figure has them, so a joint that gives a little under a heap
    // of limbs shows nothing coming apart.
    pelvis.getWorldQuaternion(_parent);
    for (let i = 0; i < legs.length; i++) {
      const thigh = this.easedQuat(this.tracked[1 + 2 * i], alpha, _qa);
      const shin = this.easedQuat(this.tracked[2 + 2 * i], alpha, _qb);
      legs[i].hipPivot.quaternion.copy(_parent).invert().multiply(thigh);
      legs[i].kneePivot.quaternion.copy(thigh).invert().multiply(shin);
    }
  }

  private eased(t: Tracked, alpha: number, out: THREE.Matrix4): THREE.Matrix4 {
    const p = t.body.translation();
    _p.set(p.x, p.y, p.z);
    _p.lerpVectors(t.prevP, _p, alpha);
    return out.compose(_p, this.easedQuat(t, alpha, _q), ONE);
  }

  private easedQuat(t: Tracked, alpha: number, out: THREE.Quaternion): THREE.Quaternion {
    const q = t.body.rotation();
    return out.set(q.x, q.y, q.z, q.w).slerp(t.prevQ, 1 - alpha);
  }

  /**
   * Put the fighter back as a living one could stand: the hips back on the
   * hull, the legs posed again, the hull's capsule back under it. What is
   * left to the fighter is placing everything, which a reset does anyway,
   * and a neck with no range, which it rebuilds.
   */
  dispose(): void {
    const { rapier, world } = this.rig.phys;
    for (const joint of this.joints) {
      if (world.getImpulseJoint(joint.handle)) world.removeImpulseJoint(joint, true);
    }
    this.joints.length = 0;
    world.removeRigidBody(this.hips);
    for (const leg of this.rig.legs) {
      for (const body of [leg.thigh, leg.shin]) {
        body.setBodyType(rapier.RigidBodyType.KinematicPositionBased, true);
        body.collider(0)!.setCollisionGroups(this.rig.side.hitOnlyFilter);
      }
    }
    this.rig.hullCollider.setEnabled(true);
    this.rig.pelvisCollider.setEnabled(true);
  }
}

type Range = { readonly x: readonly number[]; readonly y: readonly number[]; readonly z: readonly number[] };

function limit(joint: RAPIER.ImpulseJoint, r: Range): void {
  const raw = (joint as unknown as { rawSet: JointRaw }).rawSet;
  raw.jointSetLimits(joint.handle, ANG_X, r.x[0], r.x[1]);
  raw.jointSetLimits(joint.handle, ANG_Y, r.y[0], r.y[1]);
  raw.jointSetLimits(joint.handle, ANG_Z, r.z[0], r.z[1]);
}

/** A ball joint's motors, X, Y and Z, toward `target`: a stiffness of 0 and a damping of 0 is off. */
function motor(joint: RAPIER.ImpulseJoint, target: readonly number[], k: number, d: number): void {
  const raw = (joint as unknown as { rawSet: JointRaw }).rawSet;
  const axes = [ANG_X, ANG_Y, ANG_Z];
  for (let i = 0; i < 3; i++) {
    raw.jointConfigureMotorModel(joint.handle, axes[i], MOTOR_BY_FORCE);
    raw.jointConfigureMotorPosition(joint.handle, axes[i], target[i], k, d);
  }
}

/** A point on a body, given in its own frame, in world space. */
function pointOn(body: RAPIER.RigidBody, x: number, y: number): THREE.Vector3 {
  const p = body.translation();
  const q = body.rotation();
  return new THREE.Vector3(x, y, 0)
    .applyQuaternion(_q.set(q.x, q.y, q.z, q.w)).add(_p.set(p.x, p.y, p.z));
}

/** A world point in a body's own frame. */
function toLocal(body: RAPIER.RigidBody, at: THREE.Vector3): { x: number; y: number; z: number } {
  const p = body.translation();
  const q = body.rotation();
  const v = at.clone().sub(_p.set(p.x, p.y, p.z))
    .applyQuaternion(_q.set(q.x, q.y, q.z, q.w).invert());
  return { x: v.x, y: v.y, z: v.z };
}

/** Give `obj` the local transform that puts it at `world` under a parent at `parentWorld`. */
function setLocal(obj: THREE.Object3D, parentWorld: THREE.Matrix4, world: THREE.Matrix4): void {
  _local.copy(parentWorld).invert().multiply(world);
  _local.decompose(obj.position, obj.quaternion, _s);
}

const ONE = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _local = new THREE.Matrix4();
