import { makeBuild, type Build } from "./anatomy";
import type { Palette } from "./fighter";
import { AXE, SPEAR, SWORD, type Weapon } from "./weapons";

/**
 * The bestiary.
 *
 * A species is not a stat block. It is a size, a weapon, and a list of attacks
 * it knows how to throw; everything that makes an orc feel like an orc comes
 * out of the physics those three imply. An orc is slow because it is swinging
 * 3.65kg of iron on the end of a metre of ash, not because a speed number says
 * so. A goblin outranges you because its spear is longer than your sword, not
 * because its attack has more range.
 *
 * The two derived numbers are honest too:
 *
 *   health          scales with the body's mass. A 147kg orc carries four
 *                   times a goblin's punishment because it is four times the
 *                   animal.
 *   joint integrity scales with mass^(2/3) -- cross-sectional area, which is
 *                   literally what a cut has to get through. This is why
 *                   taking an orc's arm off is the answer to an orc: its
 *                   shoulder is only half again as hard to cut as a human's,
 *                   while its health pool is nearly twice as deep.
 */

/**
 * One preset attack.
 *
 * Preset because a telegraphed attack is one you can learn: the same windup
 * always becomes the same swing, so after you have seen a cleave once you know
 * what the axe going up means and you know you have three quarters of a second
 * to not be there. Nothing about it is on rails -- the arm is still a physical
 * limb being dragged toward a target pose under a clamped force, and it misses,
 * catches on pillars and overswings exactly as yours does.
 *
 * Pitches are offsets in radians from LEVEL: the arm pitch at which this
 * fighter's own weapon would cross its target's chest. That is solved from the
 * arm's kinematics every time it winds up, so the same table describes the
 * same attack whether it is thrown by a 1.37m goblin or a 2.11m orc.
 */
export interface Attack {
  name: string;
  /** How to not be hit by it. Shown in the HUD while it winds up. */
  counter: string;
  /** Wound-up pose: arm yaw, pitch offset from level, reach 0..1. */
  from: { yaw: number; pitch: number; reach: number };
  /** Followed THROUGH to this one. Aiming at the target decelerates into it. */
  to: { yaw: number; pitch: number; reach: number };
  /** Elbow swivel, which is also the cutting edge's roll. */
  roll: number;
  /** Seconds of tell. This is the whole contract with the player. */
  windup: number;
  /** Seconds of commitment. Nothing steers during it. */
  strike: number;
  /** Seconds of being open afterwards. Long attacks cost more. */
  recover: number;
  /** Footwork during the strike: 1 steps in, -1 gives ground, 0 holds. */
  step: number;
  /**
   * The band of distances this attack is worth throwing at, as fractions of
   * the creature's own strike reach. Omitted means any distance.
   *
   * This is what stops a spearman sweeping at a target it cannot reach and an
   * axe cleaving at one standing on its toes. It is also the counter-play made
   * legible: get inside a goblin's point and its answer changes, because the
   * only thing it has at that distance is the shaft.
   */
  at?: { min?: number; max?: number };
}

/**
 * How a creature moves when it is not swinging.
 *
 * The gap between attacks is where a fight is read, and most of what makes
 * one opponent feel unlike another happens in it. None of this is a way of
 * moving the player lacks: it steps with the same keys you do, at the same
 * speed, and sees nothing of you but where you are and where your blade is.
 */
export interface Footwork {
  /**
   * Seconds it circles, once it is at its distance, before it commits: the
   * shortest and the longest. Rolled afresh every time, so the gap between
   * two attacks is not a rhythm you can count.
   */
  readonly patience: readonly [number, number];
  /** Its usual pause between one step and the next, seconds. */
  readonly settle: number;
  /**
   * Chance it steps out of a swing it sees coming, 0..1. Rolled once per
   * swing, answered a reaction time later, and never while it is committed:
   * an attack it has started, it finishes.
   */
  readonly wariness: number;
  /** Chance it gives ground after a swing of its own, before anything else. */
  readonly retreat: number;
  /** Chance per step, while circling, that it darts in and straight back out. */
  readonly feint: number;
}

export interface Species {
  readonly key: string;
  /** How the fight panel names it. */
  readonly name: string;
  /** How an impact readout refers to its parts: "the orc's leg". */
  readonly possessive: string;
  readonly note: string;
  readonly build: Build;
  readonly weapon: Weapon;
  readonly palette: Palette;
  /**
   * Arm force budget as a multiple of the tuning clamp, from the square of the
   * body's thickness -- muscle cross-section, which is what force comes from.
   */
  readonly power: number;
  /**
   * How readily it presses after a swing -- straight into the next one --
   * rather than going round you or giving ground first.
   */
  readonly aggression: number;
  readonly footwork: Footwork;
  /**
   * Distances it wants to fight at, as fractions of its own measured strike
   * reach -- the horizontal distance from its own centre to where its weapon
   * does its work. Fractions rather than metres, because that distance is a
   * different number for a spear than for an axe and neither is a human's.
   *
   * `strike` sits at about 1.0 because the reach is measured to the percussion
   * point and the range is measured centre to centre: to put the working part
   * of the weapon through someone's chest, you have to be able to reach their
   * middle, not their front.
   */
  readonly range: { close: number; strike: number; far: number };
  readonly attacks: Attack[];
}

/**
 * Arm strength for a body of this size, times whatever it is made of.
 *
 * The size part is the square of its thickness -- muscle cross-section, which
 * is where force comes from and the reason a 147kg orc swings a 3.65kg axe on
 * the same tuning a human swings a sword. `grit` is the part size does not
 * explain, and there is exactly one creature here that needs it: a goblin's
 * spear is a metre of lever, and at the strength its shoulders imply the arm's
 * torque budget cannot hold the shaft on line while the hand accelerates. Its
 * thrusts arrived rotating and landed flat. A wiry thing that is strong for
 * its size is both the obvious answer and the true one.
 */
function sizedPower(build: Build, grit = 1): number {
  const thick = build.scale * build.girth;
  return thick * thick * grit;
}

// --- the human swordsman -----------------------------------------------------

const HUMAN_BUILD = makeBuild(1, 1);

/**
 * A man with a sword, which is to say: you, with someone else's hands on the
 * mouse. Every number in this project was tuned against this figure, and it is
 * the control the other two are read against.
 */
export const SWORDSMAN: Species = {
  key: "swordsman",
  name: "the swordsman",
  possessive: "his",
  note: "your own build, your own sword — an even fight",
  build: HUMAN_BUILD,
  weapon: SWORD,
  palette: { cloth: 0x3f4a5c, skin: 0x9c8570, mark: 0xc44a2f },
  power: sizedPower(HUMAN_BUILD),
  aggression: 1,
  // It fences: goes round you, gives ground about as often as it takes it,
  // and every so often steps in only to see what you do.
  footwork: {
    patience: [0.5, 1.5], settle: 0.26, wariness: 0.35, retreat: 0.35, feint: 0.12,
  },
  range: { close: 0.68, strike: 1.0, far: 1.26 },
  attacks: [
    {
      name: "cross cut", counter: "step inside it",
      from: { yaw: -1.15, pitch: 0.5, reach: 0.5 },
      to: { yaw: 0.95, pitch: -0.1, reach: 1.0 },
      roll: -1.1, windup: 0.28, strike: 0.42, recover: 0.24, step: 0,
    },
    {
      name: "descending cut", counter: "back off a pace",
      from: { yaw: -1.25, pitch: 0.35, reach: 0.5 },
      to: { yaw: 1.0, pitch: -0.35, reach: 1.0 },
      roll: -0.6, windup: 0.3, strike: 0.42, recover: 0.24, step: 0,
    },
    {
      name: "low sweep", counter: "jump it",
      from: { yaw: -1.3, pitch: -0.2, reach: 0.5 },
      to: { yaw: 1.05, pitch: -0.65, reach: 1.0 },
      roll: 0, windup: 0.26, strike: 0.4, recover: 0.22, step: 0,
    },
    {
      // The blade is symmetric, so which edge leads costs nothing, and this is
      // the arm plane that measured well.
      name: "backhand", counter: "turn with it",
      from: { yaw: 1.05, pitch: 0.4, reach: 0.5 },
      to: { yaw: -1.2, pitch: -0.15, reach: 1.0 },
      roll: -1.0, windup: 0.27, strike: 0.42, recover: 0.24, step: 0,
    },
  ],
};

// --- the orc -----------------------------------------------------------------

const ORC_BUILD = makeBuild(1.14, 1.1);

/**
 * Two metres of orc holding a bearded axe.
 *
 * It is not fast and it does not have to be. Everything it throws takes the
 * better part of a second to arrive and could be walked away from by anyone
 * paying attention, which is the deal: the tell is long and the consequence is
 * enormous. Its leg sweep is the only attack in the game that cannot be
 * sidestepped, because it is already travelling along the ground -- the answer
 * to that one is to be in the air.
 */
export const ORC: Species = {
  key: "orc",
  name: "the orc",
  possessive: "the orc's",
  note: "slow, enormous, and committed to everything it starts",
  build: ORC_BUILD,
  weapon: AXE,
  palette: { cloth: 0x4a4230, skin: 0x6f8355, mark: 0xb5432c },
  power: sizedPower(ORC_BUILD),
  // It presses. Backing off is not in it.
  aggression: 1.15,
  // It stalks rather than circles: a heavy step, a long plant, and never long
  // before the axe goes up. It does not feint -- everything it starts, it
  // means -- and it gets out of the way of very little.
  footwork: {
    patience: [0.25, 0.9], settle: 0.42, wariness: 0.1, retreat: 0.1, feint: 0,
  },
  // It keeps its distance more than a swordsman does: an axe wants room.
  range: { close: 0.78, strike: 1.0, far: 1.24 },
  attacks: [
    {
      // The signature. Nearly a second of axe going up, then all of it coming
      // down on one line -- so stand anywhere but that line.
      name: "overhead cleave", counter: "sidestep — it only covers one line",
      from: { yaw: -0.45, pitch: 1.0, reach: 0.35 },
      to: { yaw: 0.05, pitch: -0.75, reach: 1.0 },
      roll: -0.35, windup: 0.72, strike: 0.46, recover: 0.42, step: 1,
      at: { min: 0.72 },
    },
    {
      name: "wide swing", counter: "give ground — it runs out of arc",
      from: { yaw: -1.4, pitch: 0.35, reach: 0.55 },
      to: { yaw: 1.3, pitch: -0.15, reach: 1.0 },
      roll: -0.9, windup: 0.54, strike: 0.56, recover: 0.4, step: 0,
      at: { min: 0.7 },
    },
    {
      name: "leg sweep", counter: "JUMP",
      from: { yaw: 1.25, pitch: -0.55, reach: 0.6 },
      to: { yaw: -1.35, pitch: -0.95, reach: 1.0 },
      roll: 0.1, windup: 0.46, strike: 0.48, recover: 0.36, step: 0,
    },
  ],
};

// --- the goblin --------------------------------------------------------------

const GOBLIN_BUILD = makeBuild(0.74, 0.98);

/**
 * A small thing at the end of a long spear.
 *
 * It reaches further than you do and knows it, so it fights at a distance
 * where your sword is a gesture. It is also thirty kilos holding a weapon that
 * is mostly lever, so it cannot sweep with it worth anything -- and it only
 * tries at close quarters, where it has nothing else. Get inside the point and
 * the fight is yours.
 */
export const GOBLIN: Species = {
  key: "goblin",
  name: "the goblin",
  possessive: "the goblin's",
  note: "outreaches you and does nothing else well",
  build: GOBLIN_BUILD,
  weapon: SPEAR,
  palette: { cloth: 0x5c4a2f, skin: 0x8a9a53, mark: 0xd8b64a },
  power: sizedPower(GOBLIN_BUILD, 1.8),
  aggression: 0.85,
  // Never still. It skips about at the end of its spear, darts in to make you
  // flinch, and hops back from most of what you swing at it: a goblin that
  // stands and takes a sword cut is a dead goblin.
  footwork: {
    patience: [0.6, 1.8], settle: 0.14, wariness: 0.6, retreat: 0.55, feint: 0.22,
  },
  // It thrusts rather than sweeps, so it fights at arm's length and hates
  // anything closer.
  range: { close: 0.86, strike: 1.04, far: 1.3 },
  attacks: [
    {
      // A thrust is REACH and nothing else.
      //
      // Its first draft swept the pitch a quarter of a radian on the way in,
      // which on a metre and a half of lever throws the point sideways at
      // 7 m/s: closing speed said the blow was enormous and alignment said the
      // shaft went in flat, so it scored nothing at all. Take the sweep out
      // and the same 7 m/s runs down the shaft instead of across it. What is
      // left is the hand going from folded to extended under a clamped force,
      // which is what a thrust is.
      name: "jab", counter: "turn aside — it is only a poke",
      from: { yaw: 0.05, pitch: 0.12, reach: 0.1 },
      to: { yaw: 0, pitch: 0, reach: 1.0 },
      roll: -0.2, windup: 0.22, strike: 0.2, recover: 0.22, step: 1,
      at: { min: 0.7 },
    },
    {
      // Its best move, and the only one worth respecting.
      name: "lunge", counter: "sidestep and close",
      from: { yaw: 0.05, pitch: 0.16, reach: 0.12 },
      to: { yaw: 0, pitch: 0, reach: 1.0 },
      roll: -0.25, windup: 0.45, strike: 0.3, recover: 0.36, step: 1,
      at: { min: 0.8 },
    },
    {
      // What it is left with once you are inside the point. It gives ground
      // while it swings, because standing there is how a goblin dies.
      name: "shaft sweep", counter: "stay inside it and cut",
      from: { yaw: -0.9, pitch: 0.3, reach: 0.6 },
      to: { yaw: 1.0, pitch: -0.15, reach: 0.8 },
      roll: -0.8, windup: 0.26, strike: 0.4, recover: 0.3, step: -1,
      at: { max: 0.82 },
    },
  ],
};

export const SPECIES = {
  swordsman: SWORDSMAN,
  orc: ORC,
  goblin: GOBLIN,
} as const;

/** Health scales with the body's mass -- a bigger animal takes more killing. */
export function maxHealthFor(build: Build): number {
  return 100 * build.massScale;
}

/**
 * Joints scale with cross-sectional area, which is what a cut has to get
 * through. Slower than mass, which is exactly why dismembering a big thing
 * beats trying to out-damage it.
 */
export function jointScaleFor(build: Build): number {
  return Math.pow(build.massScale, 2 / 3);
}
