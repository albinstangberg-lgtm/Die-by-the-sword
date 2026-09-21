/**
 * One set of human proportions, shared by the practice dummy and by the
 * fighters, so a person and the thing you practise on are built the same way.
 *
 * Heights are metres above the soles of the feet for a standing figure. The
 * dummy hangs rather than stands, so it uses these same segment LENGTHS from a
 * different anchor — the proportions are shared, the pose is not.
 */

export interface Segment {
  radius: number;
  length: number;
  mass: number;
}

export const SEGMENT = {
  head: { radius: 0.115, length: 0.24, mass: 4 },
  torso: { radius: 0.17, length: 0.55, mass: 26 },
  pelvis: { radius: 0.145, length: 0.24, mass: 12 },
  // The sword arm's dimensions are load-bearing: MAX_REACH and the whole PD
  // tuning in arm.ts are set against them, so the other arm matches these
  // rather than the other way round.
  upperArm: { radius: 0.052, length: 0.30, mass: 2.1 },
  foreArm: { radius: 0.046, length: 0.28, mass: 2.1 },
  thigh: { radius: 0.075, length: 0.42, mass: 7 },
  shin: { radius: 0.06, length: 0.40, mass: 4 },
} satisfies Record<string, Segment>;

/** Joint heights for a standing figure, metres above the ground. */
export const STANDING = {
  ankle: 0.0,
  knee: SEGMENT.shin.length,                                    // 0.40
  hip: SEGMENT.shin.length + SEGMENT.thigh.length,              // 0.82
  waist: 0.82 + SEGMENT.pelvis.length,                          // 1.06
  neck: 1.06 + SEGMENT.torso.length,                            // 1.61
  crown: 1.61 + SEGMENT.head.length,                            // 1.85
  /** Shoulders sit a little below the neck joint. */
  shoulder: 1.51,
  shoulderX: 0.21,
  hipX: 0.11,
} as const;

/**
 * The locomotion hull: one capsule that carries the whole figure and does all
 * the walking and wall-bumping.
 *
 * Keeping it separate from the hittable skeleton is what makes the layout
 * possible at all. A torso-shaped collider at chest height has nothing to
 * stand on, and a skeleton built out of jointed limbs that has to hold itself
 * upright is the research project this design exists to avoid. The hull is
 * invisible, blades pass straight through it, and the parts you can actually
 * cut hang off it.
 */
export const HULL = {
  radius: 0.22,
  /** Total height, feet to shoulders. */
  height: 1.68,
  mass: 44,
} as const;

/** The hull's centre when standing — and so the origin every limb hangs from. */
export const HULL_CENTRE_Y = HULL.height / 2;

/** A standing joint height expressed relative to the hull's origin. */
export function local(height: number): number {
  return height - HULL_CENTRE_Y;
}
