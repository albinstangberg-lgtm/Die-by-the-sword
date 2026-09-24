import { makeBuild, type Build } from "./anatomy";
import type { Palette } from "./fighter";
import { AXE, SPEAR, SWORD, type Weapon } from "./weapons";

/**
 * The bestiary.
 *
 * A species is not a stat block. It is a size, a weapon, and the shapes of
 * swing its arm knows; everything that makes an orc feel like an orc comes
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

/** A part of you a swing can be aimed at. */
export type Aim = "head" | "body" | "arm" | "legs";

/** The least and the most a value may be, drawn afresh for every swing. */
export type Span = readonly [number, number];

/**
 * One shape of swing a creature's arm knows how to make.
 *
 * Not an attack: nothing names it to you, nothing tells you how to beat it,
 * and no two swings thrown with it are the same. It is the way the weapon goes
 * round -- forehand, backhand, over the top, along the floor -- and each swing
 * is made up as it is thrown: aimed at a part of you, with its angles, its
 * depth and its edge each drawn from a range. The arm is still a physical limb
 * dragged toward a pose under a clamped force, and it misses, catches on
 * pillars and overswings exactly as yours does.
 *
 * Pitches are offsets in radians from LEVEL: the arm pitch at which this
 * fighter's own weapon would cross the part it is aimed at. That is solved
 * from the arm's kinematics as it winds up, so the same shape describes the
 * same swing at your head or your shins, thrown by a 1.37m goblin or a 2.11m
 * orc.
 *
 * The one thing that is not free is the roll. Swivel and edge are one degree
 * of freedom, a cut is worth its edge squared, and which rolls lead with the
 * edge through a real swing -- the blade lagging the hand, the grip giving --
 * is not something the pose alone says. The bands here were measured, swing by
 * swing: outside them the same shape lands on the flat. Where a band cut far
 * harder than the attack the shape replaced, it is the side of it that cuts
 * about as hard -- the fight was meant to stop announcing itself, not to get
 * more lethal.
 */
export interface Cut {
  /** What the code and the harness call it. You are never told. */
  readonly name: string;
  /** The parts of you it can be aimed at. */
  readonly aims: readonly Aim[];
  /** Wound-up pose: arm yaw, pitch offset from level, reach 0..1. */
  readonly from: { readonly yaw: Span; readonly pitch: Span; readonly reach: Span };
  /** Followed THROUGH to this one. Aiming at the target decelerates into it. */
  readonly to: { readonly yaw: Span; readonly pitch: Span; readonly reach: Span };
  /** Elbow swivel, which is also the cutting edge's roll: the band it cuts in. */
  readonly roll: Span;
  /** Footwork during the swing: 1 steps in, -1 gives ground, 0 holds. */
  readonly step: number;
  /**
   * The band of distances this shape is worth throwing at, as fractions of
   * the creature's own strike reach. Omitted means any distance.
   *
   * This is what stops a spearman sweeping at a target it cannot reach and an
   * axe cleaving at one standing on its toes -- and why getting inside a
   * goblin's point changes what it does, because the only thing it has at that
   * distance is the shaft.
   */
  readonly at?: { readonly min?: number; readonly max?: number };
  /**
   * How much more often than the other shapes that reach the same part of you
   * it throws this one: a relative weight, 1 if omitted. What a creature
   * reaches for first is most of what it is like to fight.
   */
  readonly favour?: number;
}

/**
 * Coming after you through the air: a run at you with the weapon going up, a
 * jump, and the swing brought down out of it.
 *
 * Only once you have got away. Something that had you in reach a moment ago
 * and has just watched you open the ground between you closes it the fastest
 * way it has; something that has never had you in reach walks up like
 * anything else. The jump is yours -- the same key, the same height for its
 * size, and the same line it cannot change once its feet are off the floor --
 * which is the answer to it: be off that line when it comes down.
 */
export interface Leap {
  /** The shape it brings down, by name. */
  readonly cut: string;
  /**
   * How far off you have to be for it, as fractions of its own strike reach:
   * past where a step in would do, and no further than a run and a jump will
   * carry it.
   */
  readonly at: { readonly min: number; readonly max: number };
  /** How recently you must have been in its reach, seconds, for it to count as you getting away. */
  readonly memory: number;
  /** The least time between one leap and the next, seconds. */
  readonly rest: number;
}

/**
 * How a creature moves when it is not swinging.
 *
 * The gap between swings is where a fight is read, and most of what makes
 * one opponent feel unlike another happens in it. None of this is a way of
 * moving the player lacks: it steps with the same keys you do, at the same
 * speed, and sees nothing of you but where you are and where your blade is.
 */
export interface Footwork {
  /**
   * Seconds it circles, once it is at its distance, before it commits: the
   * shortest and the longest. Rolled afresh every time, so the gap between
   * two swings is not a rhythm you can count.
   */
  readonly patience: readonly [number, number];
  /** Its usual pause between one step and the next, seconds. */
  readonly settle: number;
  /**
   * Chance it steps out of a swing it sees coming, 0..1. Rolled once per
   * swing, answered a reaction time later, and never while it is committed:
   * a swing it has started, it finishes.
   */
  readonly wariness: number;
  /** Chance it gives ground after a swing of its own, before anything else. */
  readonly retreat: number;
  /** Chance per step, while circling, that it darts in and straight back out. */
  readonly feint: number;
  /**
   * Chance a step round you is a half-step in or out across the edge of its
   * reach instead: the rocking that means you are never sure whether the next
   * step in is the one it swings from.
   */
  readonly rock: number;
  /**
   * Chance it gives ground as you come at it, step for step, rather than stand
   * -- and standing, it meets you: it swings as you walk into its reach.
   * Whatever it does, it follows you when you back off.
   */
  readonly give: number;
  /**
   * Chance per step round you that it steps inside your reach on purpose,
   * guard up, holds there a beat, and steps back out: a target offered to draw
   * a swing out of you, and out of the way of it, and in on the miss.
   */
  readonly bait: number;
  /**
   * Chance it makes you pay for a swing that came at it and missed: steps in
   * and swings while your weapon is on its way back. Rolled once a miss.
   */
  readonly counter: number;
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
  /** How it shares its swings between the parts of you: relative weights. */
  readonly aim: Readonly<Record<Aim, number>>;
  readonly cuts: readonly Cut[];
  /** Whether, and how, it comes after you through the air. */
  readonly leap?: Leap;
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
    rock: 0.4, give: 0.5, bait: 0.15, counter: 0.7,
  },
  range: { close: 0.68, strike: 1.0, far: 1.26 },
  // Your body, mostly, and everything else as often as each other -- your
  // sword arm included, the one cut that ends a fight without winning it.
  //
  // It went for your head and your arm a quarter of the time each at first,
  // and took them: against someone standing still it beheaded half again as
  // often as the old swordsman and disarmed twice as often. A neck gives way
  // after seven points, and a cut at the head is one clean hit from over.
  aim: { head: 0.15, body: 0.55, arm: 0.15, legs: 0.15 },
  cuts: [
    {
      // Across and down from its own right. The blade is symmetric, so which
      // edge leads costs nothing, and a steeper or a flatter line cuts in the
      // same band of rolls.
      name: "forehand", aims: ["head", "body", "arm"],
      from: { yaw: [-1.3, -1.1], pitch: [0.3, 0.5], reach: [0.45, 0.55] },
      to: { yaw: [0.9, 1.05], pitch: [-0.35, -0.1], reach: [1, 1] },
      roll: [-1.4, -0.8], step: 0,
    },
    {
      name: "backhand", aims: ["head", "body", "arm"],
      from: { yaw: [0.95, 1.1], pitch: [0.3, 0.45], reach: [0.45, 0.55] },
      to: { yaw: [-1.3, -1.1], pitch: [-0.2, -0.1], reach: [1, 1] },
      roll: [-1.2, -0.7], step: 0,
    },
    {
      // Along the floor at your shins, from its right. Legs are thin, and
      // this is the weakest thing it does; you can jump it. Its band is the
      // narrowest here: a fifth of a radian either side of its best it lands
      // on the flat nearly three times as often, and a little past that it
      // barely cuts at all.
      name: "low cut", aims: ["legs"],
      from: { yaw: [-1.35, -1.2], pitch: [0.25, 0.4], reach: [0.45, 0.55] },
      to: { yaw: [0.95, 1.1], pitch: [-0.15, -0.05], reach: [1, 1] },
      roll: [-0.5, -0.1], step: 0,
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
 * paying attention, which is the deal: the axe comes back slowly because it is
 * an axe, and what it does when it arrives is enormous. A swing at your legs
 * cannot be sidestepped, because it is already travelling along the ground --
 * the answer to that one is to be in the air.
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
    rock: 0.12, give: 0.1, bait: 0, counter: 0.5,
  },
  // It keeps its distance more than a swordsman does: an axe wants room.
  range: { close: 0.78, strike: 1.0, far: 1.24 },
  // Mostly the body, sometimes the head, and never your arm: your arm is a
  // small thing to an orc, and in front of your body anyway.
  aim: { head: 0.2, body: 0.65, arm: 0, legs: 0.15 },
  cuts: [
    {
      // Over the top and down through whatever is in the way, stepping in
      // behind it. It is what an orc does: three times as often as it goes
      // round, which makes the axe going up the thing to watch, and one line,
      // so it is the one you can step off.
      //
      // It cuts across more than a radian of roll, and near the middle of that
      // it takes a quarter of your health a swing: twice what the old cleave
      // did on the same edge, because a chop timed by the axe's own weight
      // lands harder than one held for a count. Its edge is the side of the
      // band that cuts about as hard as the cleave did.
      name: "overhead", aims: ["head", "body"],
      from: { yaw: [-0.55, -0.35], pitch: [0.9, 1.1], reach: [0.3, 0.4] },
      to: { yaw: [0, 0.1], pitch: [-0.85, -0.65], reach: [1, 1] },
      roll: [0.45, 0.8], step: 1,
      at: { min: 0.72 },
      favour: 3,
    },
    {
      // The whole axe round at waist height. It runs out of arc: give ground.
      name: "wide swing", aims: ["body", "head"],
      from: { yaw: [-1.5, -1.3], pitch: [0.3, 0.4], reach: [0.5, 0.6] },
      to: { yaw: [1.2, 1.35], pitch: [-0.2, -0.1], reach: [1, 1] },
      roll: [-1.5, -1.1], step: 0,
      at: { min: 0.7 },
    },
    {
      // Backhand along the floor. It is already travelling along the ground,
      // so stepping aside does nothing: be in the air.
      name: "leg sweep", aims: ["legs"],
      from: { yaw: [1.15, 1.3], pitch: [0, 0.1], reach: [0.55, 0.65] },
      to: { yaw: [-1.4, -1.3], pitch: [-0.45, -0.3], reach: [1, 1] },
      roll: [-1.8, -1.5], step: 0,
    },
  ],
  // Back out of its reach and it comes after you through the air, the axe
  // over its head, from a little over two of its reaches to a little over
  // three: see Leap.
  leap: { cut: "overhead", at: { min: 2.0, max: 3.3 }, memory: 3, rest: 4 },
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
    rock: 0.35, give: 0.8, bait: 0.12, counter: 0.45,
  },
  // It thrusts rather than sweeps, so it fights at arm's length and hates
  // anything closer.
  range: { close: 0.86, strike: 1.04, far: 1.3 },
  // The middle of you, mostly: a point goes where it is sent, and a body is
  // the biggest thing to send it at.
  aim: { head: 0.2, body: 0.5, arm: 0.15, legs: 0.15 },
  cuts: [
    {
      // A thrust is REACH and nothing else.
      //
      // Its first draft swept the pitch a quarter of a radian on the way in,
      // which on a metre and a half of lever throws the point sideways at
      // 7 m/s: closing speed said the blow was enormous and alignment said the
      // shaft went in flat, so it scored nothing at all. Take the sweep out
      // and the same 7 m/s runs down the shaft instead of across it. What is
      // left is the hand going from folded to extended under a clamped force,
      // aimed at both ends -- and the deeper it draws back, the more of a lunge
      // it is.
      name: "thrust", aims: ["head", "body", "arm", "legs"],
      from: { yaw: [0, 0.08], pitch: [0.08, 0.18], reach: [0.08, 0.2] },
      to: { yaw: [0, 0], pitch: [0, 0], reach: [1, 1] },
      roll: [-0.3, -0.15], step: 1,
      at: { min: 0.7 },
    },
    {
      // What it is left with once you are inside the point. It gives ground
      // while it swings, because standing there is how a goblin dies.
      name: "shaft sweep", aims: ["body"],
      from: { yaw: [-0.95, -0.85], pitch: [0.25, 0.35], reach: [0.55, 0.65] },
      to: { yaw: [0.95, 1.05], pitch: [-0.2, -0.1], reach: [0.75, 0.85] },
      roll: [-0.9, -0.7], step: -1,
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
