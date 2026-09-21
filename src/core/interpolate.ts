import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";

/**
 * Render interpolation between physics states.
 *
 * Physics runs at a fixed 60Hz but frames don't line up with it — on a 144Hz
 * display most frames fall between two steps. Snapping meshes to the latest
 * physics transform makes the blade judder; lerping between the previous and
 * current state by the loop's leftover `alpha` makes it smooth. The cost is
 * rendering up to one step in the past, which nobody can perceive.
 */

interface Entry {
  body: RAPIER.RigidBody;
  obj: THREE.Object3D;
  prevP: THREE.Vector3;
  prevQ: THREE.Quaternion;
  currP: THREE.Vector3;
  currQ: THREE.Quaternion;
}

export class Interpolator {
  private entries: Entry[] = [];

  add(body: RAPIER.RigidBody, obj: THREE.Object3D): void {
    const p = body.translation();
    const r = body.rotation();
    this.entries.push({
      body,
      obj,
      prevP: new THREE.Vector3(p.x, p.y, p.z),
      prevQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      currP: new THREE.Vector3(p.x, p.y, p.z),
      currQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    });
  }

  /** Before `world.step()`: this step's "current" becomes the next "previous". */
  capture(): void {
    for (const e of this.entries) {
      e.prevP.copy(e.currP);
      e.prevQ.copy(e.currQ);
    }
  }

  /** After `world.step()`: read the new state. */
  commit(): void {
    for (const e of this.entries) {
      const p = e.body.translation();
      const r = e.body.rotation();
      e.currP.set(p.x, p.y, p.z);
      e.currQ.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Each frame: place the meshes `alpha` of the way through the last step. */
  apply(alpha: number): void {
    for (const e of this.entries) {
      e.obj.position.lerpVectors(e.prevP, e.currP, alpha);
      e.obj.quaternion.copy(e.prevQ).slerp(e.currQ, alpha);
    }
  }

  /**
   * Drop every entry. Required before rebuilding anything whose rigid bodies
   * were removed from the world -- a stale entry would read a freed handle.
   */
  clear(): void {
    this.entries.length = 0;
  }

  /** After teleporting bodies, drop the stale history so nothing streaks. */
  snap(): void {
    this.commit();
    for (const e of this.entries) {
      e.prevP.copy(e.currP);
      e.prevQ.copy(e.currQ);
    }
  }
}
