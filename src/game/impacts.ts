import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "../core/physics";
import type { Arm } from "./arm";
import type { Targets } from "./targets";
import { Cutter, type SweptHit } from "./cutting";
import { Blood } from "./blood";
import { cutDamage } from "./damage";
import type { Weapon } from "./weapons";
import type { Tuning } from "../tuning";
import { judgeClash } from "./balance";

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

/** Ignore repeat events from a sustained contact with the SAME collider. */
const COOLDOWN_MS = 180;

/**
 * Below this the blade is resting on something, not striking it.
 *
 * A blade lying against a target keeps generating contact-force events every
 * step at a fraction of a metre per second. Those are not hits, and worse, a
 * single global cooldown let that noise swallow the real strike that arrived
 * a few frames later.
 */
const RESTING_SPEED = 0.35;

/**
 * A weapon knocked by another: the speed it is sent back at, m/s, below which
 * nothing comes of it and at which an arm loses all it can (`Tuning.clash`),
 * and how long the hardest knock takes to get over, seconds.
 *
 * 0.5 and 4 when a weapon's speed was measured about its grip (see
 * `Arm.velocityAt`), which counted each blade's spin twice, and two blades
 * swinging into each other both of theirs. Fitted to the same nine hundred
 * clashes measured about their centres of mass, these knock about as many
 * weapons aside, and about as hard.
 */
const KNOCK_MIN = 0.12;
const KNOCK_FULL = 2.6;
const KNOCK_TIME = 0.6;

export type Quality = "touch" | "flat" | "glance" | "bite" | "clean";

/** Two weapons met, and one was knocked: see `Impacts.clash`. */
export interface Clash {
  /** The weapon knocked back, and the one that knocked it. */
  knocked: Arm;
  by: Arm;
  /** How much its speed along the line they met on was changed, m/s. */
  speed: number;
  /** The share of its strength the arm holding it lost for the moment. */
  share: number;
  at: THREE.Vector3;
}

export interface Impact {
  quality: Quality;
  what: string;
  closingSpeed: number;   // m/s into the surface
  tangentSpeed: number;   // m/s along it — a draw cut
  /** 0..1 alignment of whatever axis the weapon bites with. */
  edgeAlign: number;
  alongBlade: number;     // 0 at the guard, 1 at the tip
  force: number;          // N, from the solver
  at: THREE.Vector3;
  /** Which collider was struck — how the dummy knows the hit was its own. */
  colliderHandle: number;
  /** Blade velocity at the contact, so a severed limb flies the way you swung. */
  bladeVelocity: THREE.Vector3;
  /** What landed it. Its leverage curve and cut threshold decide the damage. */
  weapon: Weapon;
  /** What that weapon weighs right now, in kg. */
  massKg: number;
  /**
   * The line the blow drives along, into the surface: a unit vector, world.
   * The contact normal, turned to point the way the blade was going.
   */
  into: THREE.Vector3;
  /**
   * The mass behind the blow, kg: the weapon, and as much of the arm swinging
   * it as lands with it. Its momentum is what shoves -- see balance.ts.
   */
  blowMass: number;
  /**
   * Which weapon landed it, as its business end's collider handle, and when,
   * in ms on the clock `Impacts.update` is given -- so a body can tell a
   * second part of one swing going through it from a new swing.
   */
  blade: number;
  time: number;
}

interface BladeEntry {
  arm: Arm;
  onImpact: (i: Impact) => void;
  cutter: Cutter;
  /** The weapon's collider handles as they were last routed here. */
  handles: number[];
}

export class Impacts {
  latest: Impact | null = null;
  /** The last time two weapons met and one was knocked, and who wants to hear of it. */
  latestClash: Clash | null = null;
  onClash?: (c: Clash) => void;

  /**
   * One reporter serves every blade in the fight.
   *
   * `drainContactForceEvents` empties the queue, so a second Impacts instance
   * would find nothing left — whichever blade drained first would be the only
   * one that could ever land a hit. Events are drained once here and routed by
   * collider handle instead.
   */
  private blades = new Map<number, BladeEntry>();
  /** Every weapon, once each, whatever its colliders are this step. */
  private readonly entries: BladeEntry[] = [];

  /** Per-collider, so a graze on the torso cannot mask a cut to the arm. */
  private lastAt = new Map<number, number>();
  /** Off stone and steel. */
  private sparks: Sparks;
  /**
   * Off flesh, and only when the blow did damage: the same streaks as off a
   * wall, but red, and as many as the damage is worth -- see `bleed`.
   */
  private wounds: Sparks;
  /**
   * Blood, and who gets it.
   *
   * What counts as flesh is what the blade's sweep is allowed to cut: the
   * other team's bodies and the practice dummy, `Side.cuttableFilter`. A
   * blade meets those in the solver now, like a wall, so a contact is sorted
   * by what it touched rather than by which path found it. Sparks come off
   * the wall, blood comes out of the body.
   */
  readonly blood: Blood;

  private readonly _n = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _edge = new THREE.Vector3();
  private readonly _local = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();

  constructor(
    private phys: PhysicsWorld,
    scene: THREE.Scene,
    private targets: Targets,
    /** Read live, for how much of an arm lands behind its weapon. */
    private tuning: Tuning,
  ) {
    this.sparks = new Sparks(scene, SPARK_GOLD, 64);
    // Not tone-mapped: graded with the room, a red line a pixel wide goes the
    // brown of the walls.
    this.wounds = new Sparks(scene, SPARK_RED, 160, false);
    this.blood = new Blood(scene);
  }

  /**
   * Register a weapon.
   *
   * A weapon is several colliders on one body -- an axe's haft and its head --
   * and stone can be struck with any of them, so every handle routes back to
   * the same entry. The cutter is kept across re-registration so a blade does
   * not forget where it was and cut the whole room on its next sweep.
   */
  addBlade(arm: Arm, onImpact: (i: Impact) => void): void {
    const existing = this.entries.find((e) => e.arm === arm);
    if (existing) {
      existing.onImpact = onImpact;
    } else {
      this.entries.push({
        arm, onImpact, handles: [], cutter: new Cutter(this.phys, arm, arm.side.cuttableFilter),
      });
    }
    this.route(existing ?? this.entries[this.entries.length - 1]);
  }

  /**
   * Route a weapon's colliders to it, if they have changed: a hand that has
   * taken up another weapon has another weapon's colliders (see `Arm.takeUp`).
   * A weapon that has changed in the hand has nowhere to sweep from.
   */
  private route(entry: BladeEntry): void {
    const now = entry.arm.weaponColliders;
    if (now.length === entry.handles.length && now.every((c, i) => c.handle === entry.handles[i])) return;
    for (const h of entry.handles) if (this.blades.get(h) === entry) this.blades.delete(h);
    entry.handles = now.map((c) => c.handle);
    for (const h of entry.handles) this.blades.set(h, entry);
    entry.cutter.reset();
  }

  /** After teleporting a blade, so its next sweep does not cut the whole room. */
  resetSweeps(): void {
    for (const b of this.entries) b.cutter.reset();
  }

  /**
   * Trace each blade through whatever it passed through this step.
   *
   * A blade is stopped by a body now, so most blows are found by the solver,
   * below. This is what is left: a blade that is inside someone anyway -- a
   * body stepped onto it, or it was there when the step began -- still finds
   * them, at the speed it was actually travelling.
   */
  private sweepBlades(now: number): void {
    for (const entry of this.entries) {
      // A weapon on its owner's back, or on its way there or back, cuts
      // nothing, and when it is back in the hand it must not sweep from the
      // back to the hand through whatever is between. Nor does one nobody is
      // swinging -- in a hand cut off, or let go of, or carried off by
      // someone -- which falls on you, or is put down beside you, and is
      // only steel.
      if (!entry.arm.wielding) {
        entry.cutter.reset();
        continue;
      }
      entry.cutter.sweep(this._swept);
      for (const hit of this._swept) {
        const last = this.lastAt.get(hit.collider.handle);
        if (last !== undefined && now - last < COOLDOWN_MS) continue;

        const impact = this.describeSwept(entry.arm, hit, now);
        if (!impact || impact.closingSpeed < RESTING_SPEED) continue;

        this.lastAt.set(hit.collider.handle, now);
        this.latest = impact;
        entry.onImpact(impact);
        this.bleed(impact);
      }
    }
  }

  private readonly _swept: SweptHit[] = [];

  /** Same measurements as a solver contact, taken from a swept intersection. */
  private describeSwept(arm: Arm, hit: SweptHit, now: number): Impact | null {
    this._n.copy(hit.normal).normalize();
    this._p.copy(hit.point);

    arm.velocityAt(this._p, this._v);
    const normalComponent = this._v.dot(this._n);
    const closingSpeed = Math.abs(normalComponent);
    const tangentSpeed = Math.sqrt(Math.max(0, this._v.lengthSq() - normalComponent ** 2));

    const edgeAlign = this.alignment(arm);

    return {
      quality: classify(closingSpeed, edgeAlign, hit.alongBlade),
      what: this.targets.labelFor(hit.collider.handle),
      closingSpeed,
      tangentSpeed,
      edgeAlign,
      alongBlade: hit.alongBlade,
      force: 0,
      at: this._p.clone(),
      colliderHandle: hit.collider.handle,
      bladeVelocity: this._v.clone(),
      weapon: arm.weapon,
      massKg: arm.liveWeaponMass,
      ...this.blowOf(arm, normalComponent, now),
    };
  }

  /**
   * The push half of a hit: which way it drives into the surface, and how
   * much mass arrives with it. From `_n`, the contact normal just measured.
   */
  private blowOf(
    arm: Arm, normalComponent: number, now: number,
  ): Pick<Impact, "into" | "blowMass" | "blade" | "time"> {
    return {
      into: this._n.clone().multiplyScalar(Math.sign(normalComponent)),
      blowMass: arm.liveWeaponMass + this.tuning.armBehindBlow * arm.armBehind,
      blade: arm.bladeCollider.handle,
      time: now,
    };
  }

  /**
   * How squarely the weapon's biting axis met the surface, 0..1, against
   * the contact normal just measured in `_n`. A club has no biting axis --
   * it lands as hard whichever way round it is -- and always meets square.
   */
  private alignment(arm: Arm): number {
    if (arm.weapon.bite === "blunt") return 1;
    arm.biteDirection(this._edge);
    return Math.abs(this._edge.dot(this._n));
  }

  /** Drain this step's contact events. Call right after `world.step()`. */
  update(now: number): void {
    for (const entry of this.entries) this.route(entry);
    this.sweepBlades(now);

    this.phys.events.drainContactForceEvents((e) => {
      const h1 = e.collider1();
      const h2 = e.collider2();

      // Either collider may be the blade — and with two fighters, a contact can
      // be blade against blade. Whoever is moving faster owns the hit; that is
      // what makes a parry a parry rather than two simultaneous cuts.
      const b1 = this.blades.get(h1);
      const b2 = this.blades.get(h2);
      if (!b1 && !b2) return;

      let entry: BladeEntry;
      let bladeHandle: number;
      let otherHandle: number;
      if (b1 && b2) {
        const first = b1.arm.state.tipSpeed >= b2.arm.state.tipSpeed;
        entry = first ? b1 : b2;
        bladeHandle = first ? h1 : h2;
        otherHandle = first ? h2 : h1;
      } else if (b1) {
        entry = b1;
        bladeHandle = h1;
        otherHandle = h2;
      } else {
        entry = b2!;
        bladeHandle = h2;
        otherHandle = h1;
      }
      const last = this.lastAt.get(otherHandle);
      if (last !== undefined && now - last < COOLDOWN_MS) return;

      const other = this.phys.world.getCollider(otherHandle);
      // The part of the weapon that actually made contact: an axe's haft
      // hitting a pillar is a different manifold from its head doing so.
      const blade = this.phys.world.getCollider(bladeHandle);
      if (!other || !blade) return;

      const force = e.totalForceMagnitude();
      const impact = this.describe(entry.arm, blade, other, force, now);
      if (!impact) return;

      // A resting blade is not a hit, and must not start a cooldown either —
      // otherwise leaning on a target makes you briefly unable to cut it.
      if (impact.closingSpeed < RESTING_SPEED) return;

      this.lastAt.set(otherHandle, now);
      this.latest = impact;
      entry.onImpact(impact);
      if (this.isFlesh(entry.arm, other)) this.bleed(impact);
      else this.strike(impact);
      // Weapon on weapon: after the hit is told, so what came of it is the
      // last word.
      if (b1 && b2 && b1.arm !== b2.arm) this.clash(entry.arm, (entry === b1 ? b2 : b1).arm, impact);
    });

    this.sparks.update();
    this.wounds.update();
    this.blood.update(1 / 60);

    // Colliders come and go as limbs are severed; don't grow the map forever.
    if (this.lastAt.size > 64) {
      for (const [h, t] of this.lastAt) {
        if (now - t > COOLDOWN_MS * 4) this.lastAt.delete(h);
      }
    }
  }

  /**
   * Two weapons have met: whichever had less behind it along the line they met
   * on is knocked back along it, and the arm holding it gives.
   *
   * Weighed the way a blow on a body is (see balance.ts): each weapon, and as
   * much of the arm behind it as lands with it, meeting and sticking. The
   * speed they share afterwards says who won -- the side with more mass times
   * speed along the line carries on its way, the other is sent back -- and the
   * loser's change of speed says how hard. So a spear thrust into a sword held
   * still moves the sword, a sword swung hard into a spear held still moves
   * the spear, the orc's axe moves anything it meets, and two equal blows stop
   * each other and knock neither.
   *
   * The solver has already made them bounce. What this adds is the arm: a
   * driven arm holds its hand where it was sent at a few hundred newtons, and
   * without giving it would have the knocked weapon back in two centimetres.
   */
  private clash(striker: Arm, struck: Arm, impact: Impact): void {
    const into = impact.into;
    const a1 = impact.bladeVelocity.dot(into);
    const a2 = struck.velocityAt(impact.at, this._v).dot(into);
    const m2 = struck.liveWeaponMass + this.tuning.armBehindBlow * struck.armBehind;
    const { knocked: which, speed } = judgeClash(impact.blowMass, a1, m2, a2);
    const knocked = which === 2 ? struck : which === 1 ? striker : null;
    if (knocked === null || !knocked.wielding) return;
    const hard = Math.min(1, Math.max(0, (speed - KNOCK_MIN) / (KNOCK_FULL - KNOCK_MIN)));
    if (hard <= 0) return;
    const share = hard * this.tuning.clash;
    knocked.jolt(share, KNOCK_TIME * hard);
    const clash: Clash = {
      knocked, by: knocked === struck ? striker : struck, speed, share, at: impact.at.clone(),
    };
    this.latestClash = clash;
    this.onClash?.(clash);
  }

  /** Streaks still in the air, off stone and off flesh. The harness counts these. */
  get streaks(): { stone: number; flesh: number } {
    return { stone: this.sparks.live, flesh: this.wounds.live };
  }

  /** Whether this blade would cut what it touched: see `blood`. */
  private isFlesh(arm: Arm, other: RAPIER.Collider): boolean {
    return ((other.collisionGroups() >>> 16) & arm.side.cuttableFilter & 0xffff) !== 0;
  }

  /** Stone or steel: edge-on hits at speed throw a lot of sparks, a flat slap none. */
  strike(impact: Impact): void {
    const n = Math.round(
      THREE.MathUtils.clamp(impact.closingSpeed * impact.edgeAlign * 3, 0, 18),
    );
    this.sparks.burst(impact.at, n, 0.9, impact.closingSpeed * 0.35);
  }

  /**
   * Flesh: a burst of red streaks, and blood, both as big as the damage.
   *
   * It is the one readout of a hit you do not have to look away from the
   * fight for. A blow that did nothing -- too slow, on the flat -- throws
   * nothing, a scratch a few streaks, and a blow that takes a goblin's arm
   * off a fistful, flung harder and further along the cut. Tied to the damage
   * rather than the contact, so it agrees with the number in the HUD.
   */
  bleed(impact: Impact): void {
    const damage = cutDamage(impact);
    if (damage < SCRATCH) return;
    const scale = Math.min(damage, HEAVY_BLOW);
    this.wounds.burst(
      impact.at, Math.round(6 + scale * 1.4), 1.4, 1.8 + scale * 0.16,
      impact.bladeVelocity,
    );
    this.blood.spray(impact.at, impact.bladeVelocity, damage / HEAVY_BLOW);
  }

  private describe(
    arm: Arm, blade: RAPIER.Collider, other: RAPIER.Collider, force: number, now: number,
  ): Impact | null {
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
    arm.velocityAt(this._p, this._v);
    const normalComponent = this._v.dot(this._n);
    const closingSpeed = Math.abs(normalComponent);
    const tangentSpeed = Math.sqrt(Math.max(0, this._v.lengthSq() - normalComponent ** 2));

    // How squarely the weapon's own biting axis met the surface.
    const edgeAlign = this.alignment(arm);

    // Where along the weapon — project the contact into weapon-local space,
    // again from the pre-step snapshot so all three measurements agree.
    const bp = arm.snapshotPos;
    this._local.set(this._p.x - bp.x, this._p.y - bp.y, this._p.z - bp.z)
      .applyQuaternion(this._q.copy(arm.snapshotQuat).invert());
    const alongBlade = clamp01((this._local.y - arm.weapon.grip) / arm.weapon.span);

    return {
      quality: classify(closingSpeed, edgeAlign, alongBlade),
      what: this.targets.labelFor(other.handle),
      closingSpeed,
      tangentSpeed,
      edgeAlign,
      alongBlade,
      force,
      at: this._p.clone(),
      colliderHandle: other.handle,
      bladeVelocity: this._v.clone(),
      weapon: arm.weapon,
      massKg: arm.liveWeaponMass,
      ...this.blowOf(arm, normalComponent, now),
    };
  }
}

/**
 * What the HUD calls a hit. The speeds were 1.2, 4.5 and 2.5 m/s when a
 * weapon's speed was measured about its grip (see `Arm.velocityAt`); these
 * call as many of the same fights' hits touches, clean cuts and bites.
 */
function classify(speed: number, edgeAlign: number, alongBlade: number): Quality {
  if (speed < 0.7) return "touch";
  if (edgeAlign < 0.35) return "flat";
  if (alongBlade < 0.15) return "glance";   // caught it on the guard
  if (edgeAlign > 0.72 && speed > 3) return "clean";
  if (edgeAlign > 0.5 && speed > 1.7) return "bite";
  return "glance";
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The damage a flesh burst tops out at: about what the orc's chop does. A
 * clean sword cut is 6-12, so the burst has room to say which was which.
 */
const HEAVY_BLOW = 25;

/**
 * Less damage than this shows nothing: a flat slap that grazes a hundredth of
 * a point is a slap. It is where `Blood.spray` starts to show, as well.
 */
const SCRATCH = 0.5;

const SPARK_GOLD = 0xffd08a;
const SPARK_RED = 0xff2414;

/**
 * A pool of short line bursts at the contact point. Cheap, and it makes the
 * difference between an edge-on hit and a flat slap legible at a glance.
 */
class Sparks {
  private geom = new THREE.BufferGeometry();
  private positions: Float32Array;
  private life: Float32Array;
  private vel: Float32Array;
  private origin: Float32Array;
  private next = 0;
  private lines: THREE.LineSegments;
  private readonly _dir = new THREE.Vector3();
  private readonly _along = new THREE.Vector3();

  constructor(
    scene: THREE.Scene, colour: number, private readonly count: number, toneMapped = true,
  ) {
    this.positions = new Float32Array(count * 6);
    this.life = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.origin = new Float32Array(count * 3);
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.lines = new THREE.LineSegments(
      this.geom,
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.9, toneMapped }),
    );
    this.lines.frustumCulled = false;
    scene.add(this.lines);
  }

  /**
   * `n` streaks from `at`, each flung at `base` plus up to `extra` m/s.
   * Every way at once, a little upward -- or, given `along`, mostly that way:
   * what comes out of a cut goes where the blade was going.
   */
  burst(at: THREE.Vector3, n: number, base: number, extra: number, along?: THREE.Vector3): void {
    const lean = along && along.lengthSq() > 1e-6;
    if (lean) this._along.copy(along).normalize();
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      this.origin[i * 3] = at.x;
      this.origin[i * 3 + 1] = at.y;
      this.origin[i * 3 + 2] = at.z;
      const speed = base + Math.random() * extra;
      const dir = this._dir.set(
        Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5,
      ).normalize();
      if (lean) dir.addScaledVector(this._along, 1.1).normalize();
      dir.multiplyScalar(speed);
      this.vel[i * 3] = dir.x;
      this.vel[i * 3 + 1] = dir.y;
      this.vel[i * 3 + 2] = dir.z;
      this.life[i] = 1;
    }
  }

  /** How many are still flying. */
  get live(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.life[i] > 0) n++;
    return n;
  }

  update(): void {
    const dt = 1 / 60;
    for (let i = 0; i < this.count; i++) {
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
