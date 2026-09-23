/**
 * Two small filters, and the reason there are exactly two.
 *
 * Everything procedural about how a fighter carries itself is one of two kinds
 * of motion. INTENT has to reach the arm with no delay a player can feel, so
 * it may only ever be rounded off where it asks for something no arm could do;
 * that is the Tracker. BODY motion -- a chest turning, a shoulder rising, a
 * head following the blade -- is allowed to lag and overshoot, because that
 * lag is exactly what makes it read as mass rather than as a pose snapped into
 * place; that is the Spring.
 */

/**
 * A follower that is exact for anything a hand does at a human speed and only
 * rounds off what it does impossibly fast.
 *
 * It moves toward its target at whatever speed closes the gap in one step, as
 * long as that is under `vmax`, needs no more than `amax` to get going, and
 * can still stop in the distance left. A slow drag therefore passes through
 * with no lag at all -- the gap is always closable in a step -- and only a
 * flick, which asks for the whole gap at once, is spread across the few steps
 * a limb would actually need.
 *
 * Why it exists for the sword arm: a flick used to TELEPORT the ghost hand two
 * radians round the shoulder, and the linear drive then pulled the real hand
 * along the straight chord to it. That chord runs inside the arm's own reach,
 * so the elbow folded shut, then was hauled out straight, and at straight --
 * where the arm's inertia about its own length is nearly zero -- the saturated
 * angular drive spun the forearm about its axis at 150-170 rad/s. Moving the
 * TARGET along the arc keeps the hand on the arc.
 *
 * N-dimensional so that yaw and pitch share one speed limit: a diagonal flick
 * is limited by how far it goes, not twice over by each axis.
 */
export class Tracker {
  readonly pos: Float64Array;
  readonly vel: Float64Array;
  /** Scratch, so a step allocates nothing. */
  private readonly want: Float64Array;

  constructor(initial: readonly number[]) {
    this.pos = Float64Array.from(initial);
    this.vel = new Float64Array(initial.length);
    this.want = new Float64Array(initial.length);
  }

  /** Jump straight to a value with no motion, for spawns and resets. */
  snap(values: readonly number[]): void {
    for (let i = 0; i < this.pos.length; i++) {
      this.pos[i] = values[i];
      this.vel[i] = 0;
    }
  }

  /**
   * Advance one step toward `target`.
   *
   * `vmax` in units per second, `amax` in units per second squared. Braking is
   * allowed to be twice as hard as speeding up, which is what lets the braking
   * curve stop the follower on its target rather than past it.
   */
  step(target: readonly number[], vmax: number, amax: number, dt: number): void {
    const n = this.pos.length;
    let gap = 0;
    for (let i = 0; i < n; i++) gap += (target[i] - this.pos[i]) ** 2;
    gap = Math.sqrt(gap);

    const brake = amax * 2;
    // The fastest speed that is still (a) allowed, (b) stoppable in the gap
    // that is left, and (c) no more than closes the gap this step.
    const cap = gap > 1e-12
      ? Math.min(vmax, Math.sqrt(2 * brake * gap), gap / dt)
      : 0;

    let speed = 0;
    for (let i = 0; i < n; i++) speed += this.vel[i] ** 2;
    speed = Math.sqrt(speed);

    // The velocity it would like, then the change it is allowed to make.
    let dvLen = 0;
    const want = this.want;
    for (let i = 0; i < n; i++) {
      want[i] = gap > 1e-12 ? ((target[i] - this.pos[i]) / gap) * cap : 0;
      dvLen += (want[i] - this.vel[i]) ** 2;
    }
    dvLen = Math.sqrt(dvLen);
    const dvScale = dvLen > brake * dt ? (brake * dt) / dvLen : 1;

    let next = 0;
    for (let i = 0; i < n; i++) {
      this.vel[i] += (want[i] - this.vel[i]) * dvScale;
      next += this.vel[i] ** 2;
    }
    next = Math.sqrt(next);

    // Speeding up is limited more gently than slowing down: a limb gets going
    // under its own muscle, but can be stopped by anything.
    const limit = speed + amax * dt;
    if (next > limit) {
      const s = limit / next;
      for (let i = 0; i < n; i++) this.vel[i] *= s;
    }

    for (let i = 0; i < n; i++) this.pos[i] += this.vel[i] * dt;
  }
}

/**
 * A damped spring, integrated implicitly so no stiffness can make it explode.
 *
 * `omega` is how fast it responds (radians per second: about 1/omega seconds
 * to get most of the way), `zeta` how much it rings -- 1 arrives without
 * overshoot, lower swings past and settles back, which is follow-through.
 */
export class Spring {
  x = 0;
  v = 0;

  constructor(public omega: number, public zeta = 1) {}

  step(target: number, dt: number): number {
    const w = this.omega;
    // Backward Euler on x'' = w^2 (target - x) - 2 zeta w x'.
    this.v = (this.v + dt * w * w * (target - this.x))
      / (1 + 2 * this.zeta * w * dt + dt * dt * w * w);
    this.x += this.v * dt;
    return this.x;
  }

  reset(x = 0): void {
    this.x = x;
    this.v = 0;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 0 below `a`, 1 above `b`, and a smooth S between. Works with a > b too. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Saturates smoothly at +-limit instead of stopping dead against it. */
export function soft(x: number, limit: number): number {
  return limit > 0 ? limit * Math.tanh(x / limit) : 0;
}
