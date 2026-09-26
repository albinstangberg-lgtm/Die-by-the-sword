/**
 * How a body goes over things and up them.
 *
 * A vault and a climb move the hull along a path by its velocity (see
 * `Fighter.beginVault` and `Fighter.beginClimb`): that is what the stone has
 * its say about, and none of it changes here. This is how the body you can
 * see goes with it, which is most of whether it reads as a vault or as a hull
 * floating over a wall with its knees up -- which is what it was.
 *
 * Each is a handful of poses, in order along the way, and the body is carried
 * through them smoothly: a lean, a side bend and a turn of the hips, how far
 * the visible hips sink below the hull's, a tilt of the hips, how far the
 * hands are on the stone, and for each leg its angles -- or how much it is
 * standing on the floor instead, where the standing legs' own two-bone solve
 * puts the foot. The hull is invisible and no blade finds it, so the body is
 * free to be lower than it: that is how a vault gets its hips down over the
 * top it goes across, and a climb its knee onto the edge, while the capsule
 * that actually clears the stone clears it.
 *
 * Where along the way a pose falls is measured on the path, not the clock:
 * a phase that counts the path's own landmarks -- for a vault the near face,
 * the far one and the floor past it -- so the legs are over the top while
 * the hull is, however long the run-up was.
 *
 * Every angle is radians, every length metres at human scale.
 */

/** One leg's share of a pose. */
export interface LegMove {
  /** Hip flexion: the thigh swung forward. */
  hip: number;
  /** Knee flexion: bent, the foot going back. */
  knee: number;
  /** Swung out to the side, positive to the right. */
  roll: number;
  /**
   * How far it is standing on the floor instead, 0..1: at 1 the leg is the
   * standing figure's own -- bent under a sunk hip to keep the foot down --
   * and at 0 it is posed by the angles above.
   */
  ground: number;
}

/** The whole body's share of a pose, on top of however it is carrying itself. */
export interface Move {
  /** Forward lean of the chest. */
  lean: number;
  /** Side bend, positive to the left. */
  bend: number;
  /** The hips turned, positive to the left: the legs go round with them. */
  turn: number;
  /** How far the visible hips are below the hull's. */
  sink: number;
  /** The hips' tilt, positive dropping the left. */
  roll: number;
  /** How far the hands are handed over to the stone, 0..1. */
  hold: number;
  /** Left, then right: the order the fighter builds its legs in. */
  readonly legs: [LegMove, LegMove];
}

export function emptyMove(): Move {
  const leg = (): LegMove => ({ hip: 0, knee: 0, roll: 0, ground: 1 });
  return { lean: 0, bend: 0, turn: 0, sink: 0, roll: 0, hold: 0, legs: [leg(), leg()] };
}

/** A pose on the way, and where on the way it falls: `at` is a phase. */
interface Key {
  at: number;
  lean: number;
  bend: number;
  turn: number;
  sink: number;
  roll: number;
  hold: number;
  /** Left leg, then right: hip, knee, roll, ground. */
  l: readonly [number, number, number, number];
  r: readonly [number, number, number, number];
}

/** Standing, both feet on the floor: where both begin. */
const STAND = { lean: 0, bend: 0, turn: 0, sink: 0, roll: 0, hold: 0 } as const;
const FOOT = [0, 0, 0, 1] as const;

// --- the vault -------------------------------------------------------------------
//
// Over off the left hand, the legs swung round to the right: the other hand
// is the one that is free, and the sword hand, holding a sword, is taking it
// up out of the way (see `Combatant.holdOn`). Phase 0 is setting off, 1 the
// take-off, a stride short of the near face, 2 the hull at the height it
// crosses at, just past that face, 3 past the far face, where it starts
// down, and 4 the floor.
//
// It goes in low, leaning in over the hand going down onto the top, and
// springs off it with the right knee driving up; the hand pushes off as the
// body rises past it, and over the top the body sits back with its hips
// turned and both legs together, swung out to the right and clear of the
// stone; coming down the right leg reaches for the floor first, and the body
// lands on bent knees and straightens.
const VAULT: readonly Key[] = [
  { at: 0, ...STAND, l: FOOT, r: FOOT },
  {
    at: 0.55, lean: 0.28, bend: 0.06, turn: -0.04, sink: 0.08, roll: 0.02, hold: 0.6,
    l: FOOT, r: FOOT,
  },
  {
    at: 1, lean: 0.55, bend: 0.14, turn: -0.1, sink: 0.16, roll: 0.05, hold: 1,
    l: [-0.15, 0.4, 0, 0.7], r: [0.45, 0.95, 0.04, 0],
  },
  {
    at: 1.4, lean: 0.5, bend: 0.2, turn: -0.2, sink: 0.12, roll: 0.08, hold: 0.7,
    l: [0.1, 1.0, 0.04, 0], r: [0.4, 1.35, 0.08, 0],
  },
  {
    at: 1.75, lean: 0.4, bend: 0.28, turn: -0.4, sink: 0.16, roll: 0.16, hold: 0.15,
    l: [0.8, 1.9, 0.12, 0], r: [1.1, 1.9, 0.18, 0],
  },
  {
    at: 2.05, lean: 0.22, bend: 0.32, turn: -0.55, sink: 0.26, roll: 0.22, hold: 0,
    l: [1.3, 1.15, 0.2, 0], r: [1.4, 1.2, 0.26, 0],
  },
  {
    at: 2.5, lean: 0.05, bend: 0.28, turn: -0.6, sink: 0.62, roll: 0.24, hold: 0,
    l: [1.3, 0.55, 0.24, 0], r: [1.4, 0.4, 0.28, 0],
  },
  {
    at: 3, lean: 0.05, bend: 0.14, turn: -0.35, sink: 0.48, roll: 0.12, hold: 0,
    l: [1.0, 0.9, 0.12, 0], r: [0.7, 0.3, 0.12, 0],
  },
  {
    at: 3.55, lean: 0.14, bend: 0.03, turn: -0.1, sink: 0.22, roll: 0.03, hold: 0,
    l: [0.6, 0.8, 0.04, 0], r: [0.3, 0.15, 0.03, 0.3],
  },
  {
    at: 4, lean: 0.2, bend: 0, turn: 0, sink: 0.14, roll: 0, hold: 0,
    l: FOOT, r: FOOT,
  },
];

// --- the climb -------------------------------------------------------------------
//
// Phase 0 is setting off, 1 the hands on the edge, 2 the hips up level with
// it, 3 the hull clear over the top, and 4 stood on it. A ledge low enough
// that the hips are over it already runs through 1 and 2 in no time, and is
// a hand on it and a step up.
//
// It crouches to spring, and goes up the face with the hands on the edge,
// its legs hanging with the toes against the stone and a knee coming up to
// walk it; as the hips come level it folds over the top, chest down over the
// hands, and pushes up off them -- the right foot coming up onto the top
// only once the hips are high enough for the knee to clear the edge -- steps
// up onto it, brings the left leg up after, and stands.
const CLIMB: readonly Key[] = [
  { at: 0, ...STAND, l: FOOT, r: FOOT },
  {
    at: 0.5, lean: 0.12, bend: 0, turn: 0, sink: 0.12, roll: 0, hold: 0.5,
    l: FOOT, r: FOOT,
  },
  {
    at: 1, lean: -0.03, bend: 0, turn: 0, sink: 0, roll: 0, hold: 1,
    l: [0.25, 0.05, -0.04, 0], r: [0.2, 0.1, 0.04, 0],
  },
  {
    at: 1.5, lean: 0.25, bend: 0, turn: 0, sink: 0, roll: 0.03, hold: 1,
    l: [0.4, 0.55, -0.05, 0], r: [0.22, 0.12, 0.04, 0],
  },
  {
    at: 2, lean: 0.95, bend: -0.03, turn: 0, sink: 0.04, roll: 0, hold: 1,
    l: [0.22, 0.2, -0.04, 0], r: [0.38, 0.5, 0.05, 0],
  },
  {
    at: 2.4, lean: 1.0, bend: -0.05, turn: 0.02, sink: 0.05, roll: -0.02, hold: 0.6,
    l: [0.2, 0.3, -0.04, 0], r: [0.3, 0.9, 0.05, 0],
  },
  {
    at: 2.55, lean: 0.95, bend: -0.06, turn: 0.03, sink: 0.05, roll: -0.03, hold: 0.35,
    l: [0.22, 0.35, -0.04, 0], r: [0.5, 1.5, 0.06, 0],
  },
  {
    at: 2.7, lean: 0.88, bend: -0.06, turn: 0.04, sink: 0.07, roll: -0.03, hold: 0.15,
    l: [0.25, 0.4, -0.04, 0], r: [1.15, 1.95, 0.06, 0],
  },
  {
    at: 2.85, lean: 0.77, bend: -0.05, turn: 0.04, sink: 0.12, roll: -0.03, hold: 0.05,
    l: [0.3, 0.5, -0.04, 0], r: [1.5, 1.7, 0.06, 0],
  },
  {
    at: 3, lean: 0.65, bend: -0.04, turn: 0.03, sink: 0.22, roll: -0.02, hold: 0,
    l: [0.35, 0.65, -0.05, 0], r: [1.15, 1.45, 0.05, 0],
  },
  {
    at: 3.15, lean: 0.55, bend: -0.02, turn: 0.02, sink: 0.22, roll: -0.01, hold: 0,
    l: [0.75, 1.5, -0.05, 0], r: [0.95, 1.3, 0.04, 0],
  },
  {
    at: 3.35, lean: 0.42, bend: 0, turn: 0, sink: 0.2, roll: 0, hold: 0,
    l: [1.3, 1.75, -0.05, 0], r: [0.85, 1.35, 0.03, 0],
  },
  {
    at: 3.55, lean: 0.3, bend: 0, turn: 0, sink: 0.15, roll: 0, hold: 0,
    l: [1.05, 1.4, -0.04, 0.1], r: FOOT,
  },
  {
    at: 3.8, lean: 0.18, bend: 0, turn: 0, sink: 0.08, roll: 0, hold: 0,
    l: [0.5, 0.7, -0.02, 0.6], r: FOOT,
  },
  {
    at: 4, lean: 0.1, bend: 0, turn: 0, sink: 0.05, roll: 0, hold: 0,
    l: FOOT, r: FOOT,
  },
];

/** Channels per key, in `flatten`'s order. */
const CHANNELS = 14;

function flatten(k: Key): number[] {
  return [k.lean, k.bend, k.turn, k.sink, k.roll, k.hold, ...k.l, ...k.r];
}

/**
 * A run of poses, sampled smoothly between them: a cubic through each channel
 * with the slope at each pose taken from its neighbours, and still at either
 * end, so the body neither stops at every pose nor starts or ends with a jerk.
 */
class Track {
  private readonly at: number[];
  private readonly value: number[][];
  private readonly slope: number[][];

  constructor(keys: readonly Key[]) {
    this.at = keys.map((k) => k.at);
    this.value = keys.map(flatten);
    const n = keys.length;
    // A leg standing on the floor at a pose takes its angles from the floor,
    // not from the pose, so the angles it is written with mean nothing -- but
    // they are still what the way from one pose to the next passes through,
    // and a leg handed from posed to standing swung through them: a foot
    // stepping up onto a ledge went down through its edge on the way. So a
    // standing leg is given the angles of the posed leg nearest it, before it
    // if there is one, and the hand-over is from those straight to the floor.
    for (let leg = 0; leg < 2; leg++) {
      const c = 6 + leg * 4;
      for (let i = 0; i < n; i++) {
        if (this.value[i][c + 3] < 1) continue;
        let from = -1;
        for (let j = i - 1; j >= 0 && from < 0; j--) if (this.value[j][c + 3] < 1) from = j;
        for (let j = i + 1; j < n && from < 0; j++) if (this.value[j][c + 3] < 1) from = j;
        if (from < 0) continue;
        for (let k = 0; k < 3; k++) this.value[i][c + k] = this.value[from][c + k];
      }
    }
    this.slope = this.value.map((_, i) => {
      const s = new Array<number>(CHANNELS).fill(0);
      if (i === 0 || i === n - 1) return s;
      const span = this.at[i + 1] - this.at[i - 1];
      for (let c = 0; c < CHANNELS; c++) s[c] = (this.value[i + 1][c] - this.value[i - 1][c]) / span;
      return s;
    });
  }

  /** The last phase it has a pose for. */
  get end(): number {
    return this.at[this.at.length - 1];
  }

  sample(phase: number, out: Float64Array): void {
    const at = this.at;
    const n = at.length;
    if (phase <= at[0] || phase >= at[n - 1]) {
      const v = this.value[phase <= at[0] ? 0 : n - 1];
      for (let c = 0; c < CHANNELS; c++) out[c] = v[c];
      return;
    }
    let i = 0;
    while (at[i + 1] < phase) i++;
    const h = at[i + 1] - at[i];
    const t = (phase - at[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const a = this.value[i];
    const b = this.value[i + 1];
    const ma = this.slope[i];
    const mb = this.slope[i + 1];
    for (let c = 0; c < CHANNELS; c++) {
      out[c] = h00 * a[c] + h10 * h * ma[c] + h01 * b[c] + h11 * h * mb[c];
    }
  }
}

const TRACKS = { vault: new Track(VAULT), climb: new Track(CLIMB) } as const;

export type MoveKind = keyof typeof TRACKS;

/** How many landmarks each kind's phase counts, past its start. */
export const PHASES: Readonly<Record<MoveKind, number>> = {
  vault: TRACKS.vault.end,
  climb: TRACKS.climb.end,
};

const _ch = new Float64Array(CHANNELS);

/**
 * The pose `phase` of the way through a vault or a climb, for a body of
 * `scale`: written into `out`, which is returned.
 */
export function moveAt(kind: MoveKind, phase: number, scale: number, out: Move): Move {
  TRACKS[kind].sample(phase, _ch);
  out.lean = _ch[0];
  out.bend = _ch[1];
  out.turn = _ch[2];
  out.sink = Math.max(0, _ch[3]) * scale;
  out.roll = _ch[4];
  out.hold = clamp01(_ch[5]);
  for (let i = 0; i < 2; i++) {
    const leg = out.legs[i];
    const c = 6 + i * 4;
    leg.hip = _ch[c];
    leg.knee = Math.max(0, _ch[c + 1]);
    leg.roll = _ch[c + 2];
    leg.ground = clamp01(_ch[c + 3]);
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A smooth, never-backward curve through points: for how far through its
 * landmarks a body is, given how far through the time it has. Fritsch and
 * Carlson's monotone cubic, still at both ends -- a body starts from
 * standing and arrives at a stand -- and never overshooting a point between,
 * which a plainer cubic does, and which on a climb would put the hull into
 * the face it is going up.
 */
export class Pacing {
  private readonly x: number[];
  private readonly y: number[];
  private readonly m: number[];

  constructor(x: readonly number[], y: readonly number[]) {
    this.x = [...x];
    this.y = [...y];
    const n = x.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = x[i + 1] - x[i];
      d.push(dx > 1e-9 ? (y[i + 1] - y[i]) / dx : 0);
    }
    const m = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] > 0 ? (d[i - 1] + d[i]) / 2 : 0;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const r = a * a + b * b;
      if (r > 9) {
        const tau = 3 / Math.sqrt(r);
        m[i] = tau * a * d[i];
        m[i + 1] = tau * b * d[i];
      }
    }
    this.m = m;
  }

  at(t: number): number {
    const { x, y, m } = this;
    const n = x.length;
    if (t <= x[0]) return y[0];
    if (t >= x[n - 1]) return y[n - 1];
    let i = 0;
    while (x[i + 1] < t) i++;
    const h = x[i + 1] - x[i];
    if (h <= 1e-9) return y[i + 1];
    const s = (t - x[i]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y[i] + (s3 - 2 * s2 + s) * h * m[i]
      + (-2 * s3 + 3 * s2) * y[i + 1] + (s3 - s2) * h * m[i + 1];
  }
}
