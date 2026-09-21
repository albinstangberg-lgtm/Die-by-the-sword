import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "../core/physics";
import type { Arm } from "./arm";
import type { Arena } from "./arena";

/**
 * Impact quality.
 *
 * Stage 2 has nothing to wound, but the numbers that stage 3 will turn into
 * damage are all readable now, and reading them is how you tell a good swing
 * from a bad one. A hit is described by three quantities:
 *
 *   closing speed  — how fast the blade was going INTO the surface
 *   edge alignment — |dot(edge direction, contact normal)|; 1 = edge-on, 0 = flat
 *   contact point  — where along the blade it landed; the hilt is a bad place
 *
 * The damage formula this feeds is just:
 *
 *   damage = closingSpeed x edgeAlignment x sweetSpot
 *
 * which is what makes a lazy swing bounce and a committed, edge-aligned one
 * bite. Nothing about it is a hitbox check.
 */

const GRIP_LEN = 0.11;
const BLADE_LEN = 0.86;

/** Ignore repeat events from a sustained contact for this long. */
const COOLDOWN_MS = 180;

export type Quality = "touch" | "flat" | "glance" | "bite" | "clean";

export interface Impact {
  quality: Quality;
  what: string;
  closingSpeed: number;   // m/s into the surface
  tangentSpeed: number;   // m/s along it — a draw cut
  edgeAlign: number;      // 0..1
  alongBlade: number;     // 0 at the guard, 1 at the tip
  force: number;          // N, from the solver
  at: THREE.Vector3;
}

export class Impacts {
  latest: Impact | null = null;
  onImpact?: (i: Impact) => void;

  private lastAt = 0;
  private sparks: Sparks;

  private readonly _n = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _edge = new THREE.Vector3();
  private readonly _local = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();

  constructor(
    private phys: PhysicsWorld,
    scene: THREE.Scene,
    private arm: Arm,
    private arena: Arena,
  ) {
    this.sparks = new Sparks(scene);
  }

  /** Drain this step's contact events. Call right after `world.step()`. */
  update(now: number): void {
    const bladeHandle = this.arm.bladeCollider.handle;

    this.phys.events.drainContactForceEvents((e) => {
      const h1 = e.collider1();
      const h2 = e.collider2();
      if (h1 !== bladeHandle && h2 !== bladeHandle) return;
      if (now - this.lastAt < COOLDOWN_MS) return;

      const otherHandle = h1 === bladeHandle ? h2 : h1;
      const other = this.phys.world.getCollider(otherHandle);
      if (!other) return;

      const force = e.totalForceMagnitude();
      const impact = this.describe(other, force);
      if (!impact) return;

      this.lastAt = now;
      this.latest = impact;
      this.onImpact?.(impact);
      this.sparks.burst(impact);
    });

    this.sparks.update();
  }

  private describe(other: RAPIER.Collider, force: number): Impact | null {
    const blade = this.arm.bladeCollider;

    let got = false;
    this._n.set(0, 1, 0);
    this._p.set(0, 0, 0);

    this.phys.world.contactPair(blade, other, (manifold, flipped) => {
      if (manifold.numSolverContacts() === 0) return;
      const n = manifold.normal();
      // `flipped` means the manifold is stored with the colliders swapped, so
      // the normal points the other way. We take |dot| below either way, but
      // keeping the sign right makes `closingSpeed` mean what it says.
      const s = flipped ? -1 : 1;
      this._n.set(n.x * s, n.y * s, n.z * s).normalize();

      const p = manifold.solverContactPoint(0);
      this._p.set(p.x, p.y, p.z);
      got = true;
    });

    if (!got) return null;

    // Blade velocity at the actual contact point, split into normal and tangent.
    this.arm.velocityAt(this._p, this._v);
    const normalComponent = this._v.dot(this._n);
    const closingSpeed = Math.abs(normalComponent);
    const tangentSpeed = Math.sqrt(Math.max(0, this._v.lengthSq() - normalComponent ** 2));

    // Edge alignment: the blade's local +X is the cutting edge.
    this.arm.edgeDirection(this._edge);
    const edgeAlign = Math.abs(this._edge.dot(this._n));

    // Where along the blade — project the contact into blade-local space.
    const bq = this.arm.blade.rotation();
    const bp = this.arm.blade.translation();
    this._local.set(this._p.x - bp.x, this._p.y - bp.y, this._p.z - bp.z)
      .applyQuaternion(this._q.set(bq.x, bq.y, bq.z, bq.w).invert());
    const alongBlade = clamp01((this._local.y - GRIP_LEN) / BLADE_LEN);

    return {
      quality: classify(closingSpeed, edgeAlign, alongBlade),
      what: this.arena.labelFor(other.handle),
      closingSpeed,
      tangentSpeed,
      edgeAlign,
      alongBlade,
      force,
      at: this._p.clone(),
    };
  }
}

function classify(speed: number, edgeAlign: number, alongBlade: number): Quality {
  if (speed < 1.2) return "touch";
  if (edgeAlign < 0.35) return "flat";
  if (alongBlade < 0.15) return "glance";   // caught it on the guard
  if (edgeAlign > 0.72 && speed > 4.5) return "clean";
  if (edgeAlign > 0.5 && speed > 2.5) return "bite";
  return "glance";
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A pool of short line bursts at the contact point. Cheap, and it makes the
 * difference between an edge-on hit and a flat slap legible at a glance.
 */
const SPARK_COUNT = 64;

class Sparks {
  private geom = new THREE.BufferGeometry();
  private positions = new Float32Array(SPARK_COUNT * 6);
  private life = new Float32Array(SPARK_COUNT);
  private vel = new Float32Array(SPARK_COUNT * 3);
  private origin = new Float32Array(SPARK_COUNT * 3);
  private next = 0;
  private lines: THREE.LineSegments;

  constructor(scene: THREE.Scene) {
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.lines = new THREE.LineSegments(
      this.geom,
      new THREE.LineBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.9 }),
    );
    this.lines.frustumCulled = false;
    scene.add(this.lines);
  }

  burst(impact: Impact): void {
    // Edge-on hits at speed throw a lot of sparks; a flat slap throws none.
    const n = Math.round(
      THREE.MathUtils.clamp(impact.closingSpeed * impact.edgeAlign * 3, 0, 18),
    );
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % SPARK_COUNT;
      this.origin[i * 3] = impact.at.x;
      this.origin[i * 3 + 1] = impact.at.y;
      this.origin[i * 3 + 2] = impact.at.z;
      const speed = 0.9 + Math.random() * impact.closingSpeed * 0.35;
      const dir = new THREE.Vector3(
        Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5,
      ).normalize().multiplyScalar(speed);
      this.vel[i * 3] = dir.x;
      this.vel[i * 3 + 1] = dir.y;
      this.vel[i * 3 + 2] = dir.z;
      this.life[i] = 1;
    }
  }

  update(): void {
    const dt = 1 / 60;
    for (let i = 0; i < SPARK_COUNT; i++) {
      if (this.life[i] <= 0) {
        this.positions.fill(0, i * 6, i * 6 + 6);
        continue;
      }
      this.life[i] -= dt * 3.2;
      this.vel[i * 3 + 1] -= 9.81 * dt;

      this.origin[i * 3] += this.vel[i * 3] * dt;
      this.origin[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.origin[i * 3 + 2] += this.vel[i * 3 + 2] * dt;

      const o = i * 6;
      this.positions[o] = this.origin[i * 3];
      this.positions[o + 1] = this.origin[i * 3 + 1];
      this.positions[o + 2] = this.origin[i * 3 + 2];
      // Draw each spark as a short streak along its own velocity.
      this.positions[o + 3] = this.origin[i * 3] + this.vel[i * 3] * 0.02;
      this.positions[o + 4] = this.origin[i * 3 + 1] + this.vel[i * 3 + 1] * 0.02;
      this.positions[o + 5] = this.origin[i * 3 + 2] + this.vel[i * 3 + 2] * 0.02;
    }
    this.geom.attributes.position.needsUpdate = true;
  }
}
