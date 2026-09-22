import * as THREE from "three";

/**
 * One set of body proportions, built to a scale.
 *
 * A human is `makeBuild(1, 1)` and is exactly the figure this project was
 * tuned against. Everything else in the bestiary is the same skeleton at a
 * different size: a goblin is a small, light one, an orc a tall, heavy one.
 * Nothing about a species is special-cased -- it is proportions, mass and what
 * it is holding, and every consequence follows from those through the physics.
 *
 * Heights are metres above the soles of the feet for a standing figure. The
 * practice dummy hangs rather than stands and keeps its own layout; the
 * proportions here are for things that walk.
 */

export interface Segment {
  radius: number;
  length: number;
  mass: number;
}

export type SegmentName =
  | "head" | "torso" | "pelvis" | "upperArm" | "foreArm" | "thigh" | "shin";

export interface Standing {
  ankle: number;
  knee: number;
  hip: number;
  waist: number;
  neck: number;
  crown: number;
  /** Shoulders sit a little below the neck joint. */
  shoulder: number;
  shoulderX: number;
  hipX: number;
}

export interface Hull {
  radius: number;
  /** Total height, feet to shoulders. */
  height: number;
  mass: number;
}

export interface Build {
  /** Length multiplier against the human. */
  readonly scale: number;
  /** Thickness multiplier on top of `scale`. An orc is not just a tall human. */
  readonly girth: number;
  /** Mass multiplier against the human: `scale * (scale * girth)^2`. */
  readonly massScale: number;
  readonly segment: Record<SegmentName, Segment>;
  readonly standing: Standing;
  readonly hull: Hull;
  /** The hull's centre when standing -- the origin every limb hangs from. */
  readonly hullCentreY: number;
  /** Right shoulder in hull-local space. The weapon arm hangs from here. */
  readonly shoulderLocal: THREE.Vector3;
  /** A standing joint height expressed relative to the hull's origin. */
  local(height: number): number;
  /** Reach from shoulder to fingertips with the arm straight. */
  readonly armLength: number;
}

/** Human proportions at scale 1. Every other build is these, multiplied. */
const HUMAN_SEGMENT: Record<SegmentName, Segment> = {
  head: { radius: 0.115, length: 0.24, mass: 4 },
  torso: { radius: 0.17, length: 0.55, mass: 26 },
  pelvis: { radius: 0.145, length: 0.24, mass: 12 },
  // The weapon arm's dimensions are load-bearing: the reach limits and the
  // whole PD tuning in arm.ts are set against them, so the other arm matches
  // these rather than the other way round.
  upperArm: { radius: 0.052, length: 0.30, mass: 2.1 },
  foreArm: { radius: 0.046, length: 0.28, mass: 2.1 },
  thigh: { radius: 0.075, length: 0.42, mass: 7 },
  shin: { radius: 0.06, length: 0.40, mass: 4 },
};

/** How far the shoulders sit below the neck joint, at human scale. */
const SHOULDER_DROP = 0.10;

const HUMAN_HULL = { radius: 0.22, height: 1.68, mass: 44 };

/**
 * A body at a given size.
 *
 * Lengths go with `scale`, thicknesses with `scale * girth`, and mass with
 * volume -- `scale * (scale * girth)^2`. That cube law is why a goblin at 0.72
 * weighs a third of a human and an orc at 1.16 weighs nearly twice: it is the
 * single number behind an orc shrugging off a cut that would fell a goblin,
 * and it is not a stat, it is geometry.
 */
export function makeBuild(scale = 1, girth = 1): Build {
  const thick = scale * girth;
  const massScale = scale * thick * thick;

  const segment = {} as Record<SegmentName, Segment>;
  for (const key of Object.keys(HUMAN_SEGMENT) as SegmentName[]) {
    const s = HUMAN_SEGMENT[key];
    segment[key] = {
      radius: s.radius * thick,
      length: s.length * scale,
      mass: s.mass * massScale,
    };
  }

  const knee = segment.shin.length;
  const hip = knee + segment.thigh.length;
  const waist = hip + segment.pelvis.length;
  const neck = waist + segment.torso.length;

  const standing: Standing = {
    ankle: 0,
    knee,
    hip,
    waist,
    neck,
    crown: neck + segment.head.length,
    shoulder: neck - SHOULDER_DROP * scale,
    shoulderX: 0.21 * thick,
    hipX: 0.11 * thick,
  };

  const hull: Hull = {
    radius: HUMAN_HULL.radius * thick,
    height: HUMAN_HULL.height * scale,
    mass: HUMAN_HULL.mass * massScale,
  };

  const hullCentreY = hull.height / 2;
  const local = (height: number) => height - hullCentreY;

  return {
    scale,
    girth,
    massScale,
    segment,
    standing,
    hull,
    hullCentreY,
    shoulderLocal: new THREE.Vector3(standing.shoulderX, local(standing.shoulder), 0),
    local,
    armLength: segment.upperArm.length + segment.foreArm.length,
  };
}

/**
 * The reference body, and what every tuning number in this project means.
 *
 * The locomotion hull it describes is one capsule that carries the whole
 * figure and does all the walking and wall-bumping. Keeping it separate from
 * the hittable skeleton is what makes the layout possible at all: a
 * torso-shaped collider at chest height has nothing to stand on, and a
 * skeleton built out of jointed limbs that has to hold itself upright is the
 * research project this design exists to avoid. The hull is invisible, blades
 * pass straight through it, and the parts you can actually cut hang off it.
 */
export const HUMAN = makeBuild(1, 1);
