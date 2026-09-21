import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "../core/physics";
import type { Arm } from "./arm";

/**
 * Swept-segment hit detection for soft targets.
 *
 * A sword does not bounce off a person. It goes through them. Modelling flesh
 * as a rigid collider and letting the blade bump into it looks reasonable right
 * up until you watch the numbers: a 1.4kg blade meeting a 20kg torso stops
 * dead, so the swing that should have arrived at 12 m/s instead registers two
 * dozen grazing contacts at 3 m/s while the blade wipes across the target like
 * a windscreen wiper, braked from the first touch onward.
 *
 * So the blade no longer collides with anything soft. It still collides with
 * the world and with the other blade — stone stops a sword and a parry is still
 * two swords meeting — but against a body it passes through, and the hit is
 * found by casting the blade's own line from where it was last step to where it
 * is now. That reports the speed the blade was ACTUALLY travelling at the
 * moment it arrived, which is the number the whole damage model is built on.
 *
 * This is the standard trick for dismemberment. The alternative, real mesh
 * cutting, is an order of magnitude more work and reads the same at speed.
 */

/** Samples along the blade. Each traces its own path between steps. */
const SAMPLES = 7;

export interface SweptHit {
  collider: RAPIER.Collider;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** 0 at the guard, 1 at the tip. */
  alongBlade: number;
}

export class Cutter {
  /** Last step's sample positions, in world space. */
  private previous: THREE.Vector3[] = [];
  private primed = false;

  private readonly _p = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly ray: RAPIER.Ray;

  constructor(
    private phys: PhysicsWorld,
    private arm: Arm,
    /** Which groups count as cuttable, as a Rapier interaction-groups filter. */
    private softFilter: number,
  ) {
    for (let i = 0; i < SAMPLES; i++) this.previous.push(new THREE.Vector3());
    this.ray = new phys.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  }

  /**
   * Trace the blade from its last position to its current one.
   *
   * Call after `world.step()`. Returns at most one hit per sample, nearest
   * first along the blade, so a cut is attributed to the part of the edge that
   * actually reached the target.
   */
  sweep(out: SweptHit[]): void {
    out.length = 0;
    const current = this.samplePoints();

    if (!this.primed) {
      for (let i = 0; i < SAMPLES; i++) this.previous[i].copy(current[i]);
      this.primed = true;
      return;
    }

    for (let i = 0; i < SAMPLES; i++) {
      const from = this.previous[i];
      const to = current[i];
      this._d.copy(to).sub(from);
      const distance = this._d.length();

      // A blade that has barely moved is resting, not cutting. Below about a
      // millimetre a step (6cm/s) there is nothing here worth reporting.
      if (distance > 1e-3) {
        this.ray.origin = { x: from.x, y: from.y, z: from.z };
        this.ray.dir = { x: this._d.x, y: this._d.y, z: this._d.z };

        const hit = this.phys.world.castRayAndGetNormal(
          this.ray, 1.0, true,
          undefined, this.softFilter, undefined,
          // Never cut the hand that holds the sword.
          this.arm.blade,
        );
        if (hit) {
          const t = hit.timeOfImpact;
          out.push({
            collider: hit.collider,
            point: this._p.copy(from).addScaledVector(this._d, t).clone(),
            normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
            alongBlade: i / (SAMPLES - 1),
          });
        }
      }
      this.previous[i].copy(to);
    }
  }

  /** Points spread from the guard to the tip, in world space. */
  private samplePoints(): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      points.push(this.arm.pointAlongBlade(i / (SAMPLES - 1), new THREE.Vector3()));
    }
    return points;
  }

  /** After a teleport, forget where the blade was or it cuts the whole room. */
  reset(): void {
    this.primed = false;
  }
}
