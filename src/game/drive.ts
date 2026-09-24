import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";

/**
 * An angular PD that cannot blow up.
 *
 * Every drive here is an explicit torque, worked out from this step's state
 * and applied across the next. That is stable only while the gains are small
 * against the inertia they push: damping under 1.5·I/dt, stiffness under
 * 0.7·I/dt². Past that the correction overshoots by more than the error it
 * corrected, and the body flips back and forth every step, harder each time,
 * until it sits at the torque clamp -- which is what the off arm did about its
 * own length for as long as it existed, and what an empty sword hand did the
 * moment it let go of its sword.
 *
 * So the drive is worked out in the body's principal frame, and each axis gets
 * no more stiffness and damping than its own inertia can take. Across a bone,
 * or with something heavy in the hand, that is usually the whole drive; about
 * a bone's own length it is very little. `out` is the torque, world space;
 * `err` and `spin` are world vectors the caller may not need afterwards --
 * they are turned into the principal frame in place.
 */
export function stablePD(
  body: RAPIER.RigidBody, err: THREE.Vector3, spin: THREE.Vector3,
  kp: number, kd: number, dt: number, out: THREE.Vector3,
): THREE.Vector3 {
  const r = body.rotation();
  const lf = body.principalInertiaLocalFrame();
  const frame = _frame.set(lf.x, lf.y, lf.z, lf.w).premultiply(_q.set(r.x, r.y, r.z, r.w));
  const into = _into.copy(frame).invert();
  err.applyQuaternion(into);
  spin.applyQuaternion(into);
  const inertia = body.principalInertia();
  return out.set(
    axis(kp, kd, inertia.x, err.x, spin.x, dt),
    axis(kp, kd, inertia.y, err.y, spin.y, dt),
    axis(kp, kd, inertia.z, err.z, spin.z, dt),
  ).applyQuaternion(frame);
}

/** The stability bound on an explicit step, as fractions of I/dt² and I/dt. */
export const STIFFNESS_LIMIT = 0.7;
export const DAMPING_LIMIT = 1.5;

function axis(kp: number, kd: number, inertia: number, e: number, w: number, dt: number): number {
  const kpAxis = Math.min(kp, (STIFFNESS_LIMIT * inertia) / (dt * dt));
  const kdAxis = Math.min(kd, (DAMPING_LIMIT * inertia) / dt);
  return kpAxis * e - kdAxis * w;
}

const _q = new THREE.Quaternion();
const _frame = new THREE.Quaternion();
const _into = new THREE.Quaternion();
