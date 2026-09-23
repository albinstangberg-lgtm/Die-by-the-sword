import * as THREE from "three";

/**
 * Keeping the sword arm out of the body it hangs from.
 *
 * The arm cannot collide with its own trunk -- a limb that did would snag on
 * its own shoulder every step -- so nothing physical ever stopped it passing
 * straight through the chest. Measured, the TARGET pose alone put the elbow and
 * forearm up to twenty centimetres inside the body you can see for most of a
 * cross-body swing: the elbow's designed pole points it back, and for an arm
 * aimed across the body "back" is the torso.
 *
 * Two layers, which agree with each other so that neither has to fight:
 *
 *   KINEMATIC  the ghost is solved clear of the trunk. The elbow is swivelled
 *              the least it has to be, and only when it has to be; a hand
 *              asked to be inside the body is placed on its surface instead.
 *              Since the drives chase a target that is already outside, the
 *              arm arrives outside without anything pushing it there.
 *
 *   DYNAMIC    a soft repulsion on the real limb for what the kinematic pass
 *              cannot see coming: a flick the arm lags behind, a parry that
 *              shoves it inward, a roll the player drives into their own ribs.
 *              It starts at the body's surface, rises gently through its first
 *              couple of centimetres, and damps only motion INTO the body, so a
 *              swing sliding past the chest keeps all of its speed.
 *
 * The target keeps a buffer off the surface and the repulsion only starts AT
 * the surface, so a limb that has arrived where it was sent is touching
 * nothing, and the drives spend nothing holding it there.
 *
 * What counts as "the trunk" is the body you can SEE, not the collider a blade
 * hits: an elbow resting against the side of the ribs is where elbows live,
 * and a clearance that forbade it would forbid the guard itself -- and, since
 * swivel is edge roll here, most of the player's edge control with it.
 */

/**
 * A capsule flattened front to back: a segment, the radius across it, and
 * how much shallower it is than it is wide. The trunk is two of these.
 *
 * Flattened because a torso is. The chest is drawn 18cm wide but only 13cm
 * deep, and the round collider it hits with is 17cm all the way round -- so
 * measured against the collider, a hand crossing in front of the chest was
 * "inside" it four centimetres before it touched anything you could see,
 * while an elbow hanging at the side of the ribs, where elbows live, counted
 * as buried.
 */
export interface Capsule {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  /** Half-width, across the body. */
  radius: number;
  /** Which way the body faces, unit length. */
  readonly forward: THREE.Vector3;
  /** Width over depth: 1 is round, 1.3 is a chest. */
  flat: number;
}

/** N per metre of intrusion, at a human's strength. */
const REPEL_STIFFNESS = 9000;
/**
 * The depth over which the push builds up to full stiffness, metres. An elbow
 * brushing the ribs is nudged, not shoved -- a hard onset right at the
 * surface would be felt through the whole arm every time it grazed.
 */
const REPEL_RAMP = 0.02;
/** N per m/s of motion INTO the body. Motion along it is left alone. */
const REPEL_DAMPING = 40;
/** A body can push back hard, but not without limit. */
const REPEL_MAX = 600;

const _q = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _w = new THREE.Vector3();

/** The point on segment ab nearest p. */
export function closestOnSegment(
  p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3,
): THREE.Vector3 {
  const ab = _ab.copy(b).sub(a);
  const len2 = ab.lengthSq();
  const t = len2 > 1e-12 ? Math.min(1, Math.max(0, out.copy(p).sub(a).dot(ab) / len2)) : 0;
  return out.copy(a).addScaledVector(ab, t);
}

/**
 * Distance from a capsule's axis in its own flattened measure: a point in
 * front of the chest counts `flat` times as far as it really is, so the
 * surface is a single radius all the way round. Leaves the offset from the
 * axis, in that measure, in `_w`, and the nearest axis point in `_q`.
 */
function measure(p: THREE.Vector3, c: Capsule): number {
  closestOnSegment(p, c.a, c.b, _q);
  _w.copy(p).sub(_q);
  _w.addScaledVector(c.forward, _w.dot(c.forward) * (c.flat - 1));
  return _w.length();
}

/**
 * How far a sphere at `p` of radius `r` reaches into the trunk plus a buffer
 * of `margin`, metres. 0 when clear. The deepest capsule wins.
 */
export function intrusion(
  p: THREE.Vector3, r: number, caps: readonly Capsule[], margin: number,
): number {
  let worst = 0;
  for (const c of caps) {
    const depth = c.radius + r + margin - measure(p, c);
    if (depth > worst) worst = depth;
  }
  return worst;
}

/**
 * Move a point out of the trunk onto the surface of its buffer, along the
 * shortest way out. Returns whether it moved.
 *
 * Shortest-way-out is the only choice that never jumps as the point moves.
 * Anything cleverer -- always out of the front, say -- has to send a point
 * that drifts in from behind all the way round the body in one step.
 */
export function pushOut(
  p: THREE.Vector3, r: number, caps: readonly Capsule[], margin: number,
): boolean {
  let moved = false;
  for (const c of caps) {
    const need = c.radius + r + margin;
    const d = measure(p, c);
    if (d >= need) continue;
    if (d < 1e-6) {
      // Dead on the axis: no shortest way out, so pick one. Straight ahead
      // is where a hand in front of the body belongs.
      p.copy(_q).addScaledVector(c.forward, need / c.flat);
    } else {
      // Out to the surface in the flattened measure, then back into metres:
      // the forward part of the offset shrinks by the same `flat` it grew by.
      _w.multiplyScalar(need / d);
      _w.addScaledVector(c.forward, _w.dot(c.forward) * (1 / c.flat - 1));
      p.copy(_q).add(_w);
    }
    moved = true;
  }
  return moved;
}

/**
 * The trunk pushing back on one point of the real limb.
 *
 * Nothing until the limb reaches the surface; quadratic through the first
 * `REPEL_RAMP` of it, linear past that, and continuous in both force and
 * stiffness where they meet, so nothing about touching the body can be felt
 * as a bump. Writes the force into `out` and returns how deep the point was.
 */
export function repulsion(
  p: THREE.Vector3, r: number, vel: THREE.Vector3,
  caps: readonly Capsule[], strength: number, out: THREE.Vector3,
): number {
  out.set(0, 0, 0);
  let deepest = 0;
  for (const c of caps) {
    const d = measure(p, c);
    const depth = c.radius + r - d;
    if (depth <= 0 || d < 1e-6) continue;
    deepest = Math.max(deepest, depth);

    // Outward is the gradient of the flattened distance: the forward part of
    // the offset counts `flat` once for the measure and once more for the
    // slope, which is what makes a push off the front of a chest point
    // straight out of it rather than sideways.
    const n = _ab.copy(_w);
    n.addScaledVector(c.forward, n.dot(c.forward) * (c.flat - 1)).normalize();
    const k = REPEL_STIFFNESS * strength;
    const m = REPEL_RAMP;
    let f = depth <= m ? (k * depth * depth) / (2 * m) : k * (depth - m / 2);
    // Only motion INTO the body is damped: a blade sliding past keeps its speed.
    const inward = -vel.dot(n);
    if (inward > 0) f += REPEL_DAMPING * strength * inward;
    out.addScaledVector(n, Math.min(f, REPEL_MAX * strength));
  }
  return deepest;
}

/** The chain's radii, for the swivel search. */
export interface ChainRadii {
  upper: number;
  elbow: number;
  fore: number;
}

/** How finely the swivel circle is searched: every 7.5 degrees, then refined. */
const SWIVEL_SAMPLES = 48;
const STEP = (2 * Math.PI) / SWIVEL_SAMPLES;
const REFINE_STEPS = 7;
/** Squared metres of intrusion that still count as clear. */
const CLEAR_EPS = 1e-6;
/**
 * The live search's exchange rates, in squared metres of intrusion.
 *
 * Going deeper on the way than the elbow already is counts four times what it
 * would to end up there, so it will swing through a graze to get clear but
 * not through the ribs. A radian away from the designed pole is worth about
 * a centimetre and a half, a radian of travel about one -- design above
 * travel, which is what guarantees the elbow comes home once the body is out
 * of its way: staying put always scores worse than going back.
 */
const PATH_WEIGHT = 4;
const DESIGN_WEIGHT = 2e-4;
const TRAVEL_WEIGHT = 1e-4;
/**
 * The furthest one step's decision may send the elbow round, radians. An
 * elbow that finds its side of the chest closing is better left grazing the
 * buffer -- which is still outside the body you can see -- than swung the
 * long way over the top of the arm to the other side, rolling the edge over
 * with it. A real need to go further is met a quarter turn at a time.
 */
const MAX_TRAVEL = Math.PI / 2;

/**
 * Find how far to swivel the elbow off its designed direction to keep the
 * upper arm, the elbow and the forearm out of the trunk.
 *
 * The elbow can only be anywhere on a circle round the shoulder-to-hand line
 * (the hand and both bone lengths fix everything else), so this searches that
 * one circle. Swivel is also edge roll here, so the answer departs from the
 * designed pole only as far as the body forces it to.
 *
 * For a probe that is the whole question: the clear swivel nearest the
 * design. For the live arm it is not, because the elbow has to GET there. The
 * first version answered the probe's question every step, and when the clear
 * arc on the elbow's side of the chest closed up mid-swing it picked the one
 * on the far side -- and the elbow's target swung straight through the ribs
 * to reach it. So the live search scores every place the elbow could go, in
 * either direction round the circle, by how much deeper than it is now it
 * would have to pass on the way, how deep it would end up, and how far from
 * the design and how long the trip.
 */
export class SwivelSearch {
  private readonly p0 = new THREE.Vector3();
  private readonly q0 = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly pt = new THREE.Vector3();
  private readonly costs = new Float64Array(SWIVEL_SAMPLES);

  private shoulder!: THREE.Vector3;
  private armDir!: THREE.Vector3;
  private hand!: THREE.Vector3;
  private upperLen = 0;
  private cosA = 1;
  private sinA = 0;
  private radii!: ChainRadii;
  private caps!: readonly Capsule[];
  private margin = 0;

  /**
   * `pole` is the designed pole, `from` the swivel the live elbow is at now
   * (unwrapped), or null for a probe. Returns radians to add to the swivel:
   * for a probe in (-pi, pi], for the live arm as an unwrapped angle meant to
   * be approached from `from` directly, which is how the chosen way round is
   * kept.
   */
  solve(
    shoulder: THREE.Vector3, armDir: THREE.Vector3, pole: THREE.Vector3,
    shoulderAngle: number, upperLen: number, hand: THREE.Vector3,
    radii: ChainRadii, caps: readonly Capsule[], margin: number,
    from: number | null,
  ): number {
    // The circle's frame: p0 is where the designed pole puts the elbow, q0 a
    // quarter turn further round in the same sense a roll turns it.
    this.p0.copy(pole).addScaledVector(armDir, -pole.dot(armDir));
    if (this.p0.lengthSq() < 1e-10) return from ?? 0;
    this.p0.normalize();
    this.q0.crossVectors(armDir, this.p0);

    this.shoulder = shoulder;
    this.armDir = armDir;
    this.hand = hand;
    this.upperLen = upperLen;
    this.cosA = Math.cos(shoulderAngle);
    this.sinA = Math.sin(shoulderAngle);
    this.radii = radii;
    this.caps = caps;
    this.margin = margin;

    // The common case costs one evaluation: the designed pose is clear, and
    // the elbow is already on it.
    const at = from === null ? 0 : wrap(from);
    if (Math.abs(at) < STEP / 2 && this.cost(0) <= CLEAR_EPS) {
      return from === null ? 0 : from - at;
    }

    const costs = this.costs;
    for (let i = 0; i < SWIVEL_SAMPLES; i++) costs[i] = this.cost(wrap(i * STEP));
    return from === null ? this.nearestClear() : this.bestReachable(from, at);
  }

  /** The probe's answer: the clear swivel nearest the design, else the least bad. */
  private nearestClear(): number {
    let best = 0;
    let bestDist = Infinity;
    let lowest = 0;
    for (let i = 0; i < SWIVEL_SAMPLES; i++) {
      const phi = wrap(i * STEP);
      if (this.costs[i] < this.costs[lowest]) lowest = i;
      if (this.costs[i] <= CLEAR_EPS && Math.abs(phi) < bestDist) {
        bestDist = Math.abs(phi);
        best = phi;
      }
    }
    if (bestDist === Infinity) return wrap(lowest * STEP);
    return this.refine(best);
  }

  /** The live arm's answer: see the class comment. */
  private bestReachable(from: number, at: number): number {
    const n = SWIVEL_SAMPLES;
    const start = ((Math.round(at / STEP) % n) + n) % n;
    // How deep the elbow is where it stands. A way out is only charged for
    // going deeper than this, or no way out of a bad spot would ever beat
    // staying in it.
    const now = this.cost(at);
    let bestTravel = 0;
    let bestPhi = wrap(start * STEP);
    let bestScore = Infinity;

    const reach = Math.floor(MAX_TRAVEL / STEP);
    for (const sense of [1, -1]) {
      let worst = 0;
      for (let k = 0; k <= reach; k++) {
        const i = (((start + sense * k) % n) + n) % n;
        if (k > 0) worst = Math.max(worst, this.costs[i]);
        const phi = wrap(i * STEP);
        const score = PATH_WEIGHT * Math.max(0, worst - now)
          + this.costs[i]
          + DESIGN_WEIGHT * Math.abs(phi) + TRAVEL_WEIGHT * k * STEP;
        if (score < bestScore) {
          bestScore = score;
          bestPhi = phi;
          bestTravel = sense * k * STEP;
        }
      }
    }

    // `from` sat between samples: land on the chosen sample exactly, keeping
    // the way round that was chosen, then settle onto the edge of its clear
    // arc nearest the design.
    const target = from + wrap(start * STEP - at) + bestTravel;
    const i = ((Math.round(bestPhi / STEP) % n) + n) % n;
    const refined = this.costs[i] <= CLEAR_EPS ? this.refine(bestPhi) : bestPhi;
    return target + (refined - bestPhi);
  }

  /**
   * Walk a clear sample back toward the design to the edge of its clear arc,
   * so the answer is not stuck on the sample grid.
   */
  private refine(phi: number): number {
    if (phi === 0) return 0;
    let clear = phi;
    let blocked = phi - Math.sign(phi) * STEP;
    if (Math.sign(blocked) !== Math.sign(phi)) blocked = 0;
    for (let i = 0; i < REFINE_STEPS; i++) {
      const mid = (clear + blocked) / 2;
      if (this.cost(mid) <= CLEAR_EPS) clear = mid; else blocked = mid;
    }
    return clear;
  }

  /** Squared intrusion of the chain for a swivel of `phi` off the design. */
  private cost(phi: number): number {
    const dir = this.dir.copy(this.armDir).multiplyScalar(this.cosA)
      .addScaledVector(this.p0, Math.cos(phi) * this.sinA)
      .addScaledVector(this.q0, Math.sin(phi) * this.sinA);
    let sum = 0;
    for (const t of UPPER_SAMPLES) {
      this.pt.copy(this.shoulder).addScaledVector(dir, this.upperLen * t);
      const r = t === 1 ? this.radii.elbow : this.radii.upper;
      const d = intrusion(this.pt, r, this.caps, this.margin);
      sum += d * d;
    }
    // The forearm, elbow to hand. The hand itself does not move with the
    // swivel, so it is left to `pushOut`.
    const ex = this.shoulder.x + dir.x * this.upperLen;
    const ey = this.shoulder.y + dir.y * this.upperLen;
    const ez = this.shoulder.z + dir.z * this.upperLen;
    for (const t of FORE_SAMPLES) {
      this.pt.set(
        ex + (this.hand.x - ex) * t, ey + (this.hand.y - ey) * t, ez + (this.hand.z - ez) * t);
      const d = intrusion(this.pt, this.radii.fore, this.caps, this.margin);
      sum += d * d;
    }
    return sum;
  }
}

/**
 * Only the elbow end of the upper arm. Its root is the shoulder joint, which
 * sits against the ribs by construction -- as a real one does -- and nothing
 * about a swivel moves it, so it could only ever count against every answer.
 */
const UPPER_SAMPLES = [0.8, 1] as const;
const FORE_SAMPLES = [0.25, 0.5, 0.75] as const;

/** Fold an angle into (-pi, pi]. */
export function wrap(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v <= -Math.PI) v += Math.PI * 2;
  return v;
}
