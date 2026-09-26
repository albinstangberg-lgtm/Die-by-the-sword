import { makeBuild, type Build } from "./anatomy";
import type { Palette } from "./fighter";
import type { Look } from "./look";
import { AXE, CLUB, HATCHET, SPEAR, SWORD, type Weapon } from "./weapons";

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
  /**
   * Whether, having gone round through nothing, it may carry on round with
   * the whole body: the weapon held out where the swing ended, the body going
   * round under it on its heel, its back to you on the way, and the weapon
   * coming round at you again. Only a swing that goes ROUND can.
   *
   * `roll` is the edge it rolls to as it goes round, and it is not the
   * swing's. Carried round by a body turning, the weapon travels a different
   * way through the air than an arm sweeping it does, and the rolls that lead
   * with the edge through a swing are near the worst there are for going
   * round: the orc's wide swing, carried round at its own edge, landed on the
   * flat three times in four. These were measured the same way the swings'
   * were, weapon held out and body turning.
   */
  readonly spin?: { readonly chance: number; readonly roll: Span };
}

/**
 * One swing flowing into the next.
 *
 * A swing that goes through nothing ends where another begins: a forehand's
 * follow-through is a backhand's wind-up, an axe swung round high ends where
 * the sweep along the floor starts, and a spear drawn back off a thrust is a
 * spear ready to thrust. So a creature that misses does not always go back to
 * its guard first. Every swing in the run is still drawn back for -- only the
 * last one's end is the next one's start, and the drawing back is short.
 *
 * Stopped on something -- your guard, your weapon, the stone -- a blade has
 * nothing left to carry on with, and what can follow it is the same again,
 * drawn back the way it came. Never off a swing that drew blood: a run is how
 * it gets past you, not how it finishes you.
 */
export interface Flow {
  /** Chance, after a swing that went through nothing, that another follows from where it ended. */
  readonly combo: number;
  /** The most swings it throws in one run, the first included. */
  readonly chain: number;
}

/** An arm pose, off level: yaw, pitch and reach as a shape's are, and the edge's roll. */
export interface Pose4 {
  readonly yaw: number;
  readonly pitch: number;
  readonly reach: number;
  readonly roll: number;
}

/**
 * What it does with its weapon to taunt you (see `Footwork.taunt`): back and
 * forth between two poses, off level, a beat at each. Neither is anywhere a
 * swing of its own starts from. A weapon going back means a swing is coming,
 * every time, and a taunt that looked like one would be a lie.
 */
export interface Display {
  readonly a: Pose4;
  readonly b: Pose4;
  /** How many times it goes to each. */
  readonly beats: number;
  /** Seconds one beat takes: to the first pose and on to the second. */
  readonly beat: number;
}

/**
 * How it fights once it is badly hurt: whatever it declares here in place of
 * its usual, below this share of its health. Not a difficulty setting -- a
 * mood, and a creature's own: an orc gets angry, a goblin gets away.
 */
export interface Temper {
  readonly below: number;
  readonly aggression?: number;
  readonly footwork?: Partial<Footwork>;
  readonly flow?: Partial<Flow>;
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
  /**
   * Chance a step out of the way is a hop instead: off the floor on the jump
   * key, back and away, further than a step goes -- and, like any jump,
   * committed to the line it left on.
   */
  readonly hop: number;
  /**
   * Chance it answers a swing with its weapon rather than its feet, rolled as
   * it sees your weapon go back -- sooner than it could step out of the swing
   * itself (see `wariness`) -- and put across the line yours is coming on a
   * reaction time later. What comes of it is the weapons' own business (see
   * `Impacts.clash`): held still, a weapon stops a hard swing and is knocked
   * aside by it; the orc's axe, still moving as yours meets it, knocks yours
   * aside instead; and a spear shaft is a broom handle.
   */
  readonly parry: number;
  /**
   * Chance a swing it would throw from where it stands is thrown from giving
   * ground instead: a step back as the weapon goes back, then in again behind
   * it, so that following it is walking onto the swing.
   */
  readonly lunge: number;
  /**
   * Chance a cut that lands on it while it draws back takes the swing off it.
   * Pain rather than balance: a stagger takes a swing off anything light
   * enough to rock, and this is the swing it lets go of because it hurt. The
   * orc does not.
   */
  readonly flinch: number;
  /**
   * Chance, once you have backed out of its reach -- or as it sets off for you
   * from well out of it, or with you on the floor -- that it shows you its
   * weapon first: never drawn back, so never a lie. The orc beats the floor
   * with its axe, the swordsman salutes, the goblin shakes its spear at you.
   * Not when it has stepped out of your reach itself: a creature that
   * saluted every time it gave ground did little else.
   */
  readonly taunt: number;
  /**
   * Chance a step it takes to get out of the way, or out of reach once it has
   * swung, is a quick step -- and, now and then, a step round you: the double
   * tap you have, off the same feet, and rested from the same way. The goblin
   * is never still; the orc throws its weight about once in a while.
   */
  readonly quick: number;
  /**
   * Chance that, its moment come and you not quite in reach, it closes the
   * last of the gap with a quick step as its weapon goes back, straight in or
   * in on a slant round your side, and swings from where it lands -- rather
   * than walk up to you.
   */
  readonly dart: number;
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
  /** What it looks like past its size and colours: its face, what it wears. See look.ts. */
  readonly look: Look;
  /**
   * Arm force budget as a multiple of the tuning clamp, from the square of the
   * body's thickness -- muscle cross-section, which is what force comes from.
   */
  readonly power: number;
  /**
   * How much of its own body it puts behind a blow, as a share of its
   * walking mass, on top of the arm swinging the weapon: 0, if omitted,
   * which is everything that swings from the shoulder. Something that swings
   * from its hips, turning the whole of itself into the blow, lands with some
   * of that as well -- and when the thing weighs three hundred kilos, that is
   * what sends you across the room. See balance.ts.
   */
  readonly heave?: number;
  /**
   * How readily it presses after a swing -- straight into the next one --
   * rather than going round you or giving ground first.
   */
  readonly aggression: number;
  readonly footwork: Footwork;
  /** How one swing runs into the next. */
  readonly flow: Flow;
  /** How it fights once badly hurt, if any differently. */
  readonly temper?: Temper;
  /** What it does with its weapon to taunt you. */
  readonly display: Display;
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
 * explain, and the two smallest creatures here need it. A goblin's spear is a
 * metre of lever, and at the strength its shoulders imply the arm's torque
 * budget cannot hold the shaft on line while the hand accelerates: its thrusts
 * arrived rotating and landed flat. A kobold's hatchet hung off an arm that
 * short and came through too slowly to bite. A wiry thing that is strong for
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
  // A man-at-arms: a steel cap with a nasal, plates on his shoulders.
  look: {
    face: "man", helm: true, eyes: 0x2a2018, dress: "tunic", feet: "boots",
    pauldrons: true, bracers: true, leather: 0x3d2e22, metal: 0xa3aab2,
  },
  power: sizedPower(HUMAN_BUILD),
  aggression: 1,
  // It fences: goes round you, gives ground about as often as it takes it,
  // and every so often steps in only to see what you do. It meets a swing
  // with its sword about as often as with its feet, and now and then hops
  // clear instead of stepping.
  footwork: {
    patience: [0.5, 1.5], settle: 0.26, wariness: 0.35, retreat: 0.35, feint: 0.12,
    rock: 0.4, give: 0.5, bait: 0.15, counter: 0.7,
    hop: 0.3, parry: 0.3, lunge: 0.25, flinch: 0.5, taunt: 0.1, quick: 0.4, dart: 0.45,
  },
  // Forehand into backhand into forehand: a sword is light enough to keep
  // going, and a miss is where a run of them starts.
  flow: { combo: 0.55, chain: 3 },
  // Hurt, it gets careful: longer between swings, and more of them met with
  // the sword than walked into.
  temper: {
    below: 0.4,
    footwork: { patience: [0.9, 2.0], parry: 0.5, bait: 0, taunt: 0 },
  },
  // A salute: the blade upright before its face, then down and out to its
  // side, point to the floor.
  display: {
    a: { yaw: 0.05, pitch: 0.85, reach: 0.25, roll: 0 },
    b: { yaw: -0.8, pitch: -0.65, reach: 0.9, roll: 0 },
    beats: 1, beat: 1.3,
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
      // Round on its heel after a forehand that met nothing: see `spin`.
      spin: { chance: 0.2, roll: [0.4, 1.0] },
    },
    {
      name: "backhand", aims: ["head", "body", "arm"],
      from: { yaw: [0.95, 1.1], pitch: [0.3, 0.45], reach: [0.45, 0.55] },
      to: { yaw: [-1.3, -1.1], pitch: [-0.2, -0.1], reach: [1, 1] },
      roll: [-1.2, -0.7], step: 0,
      spin: { chance: 0.2, roll: [-0.8, -0.2] },
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
  // Tusks, a black topknot, a harness over a bare chest, and eyes that catch
  // the light.
  look: {
    face: "orc", hair: 0x1c1a18, eyes: 0xffa62b, glow: true, dress: "harness", feet: "boots",
    pauldrons: false, bracers: true, leather: 0x3a2618, metal: 0x6d6a66,
  },
  power: sizedPower(ORC_BUILD),
  // It presses. Backing off is not in it.
  aggression: 1.15,
  // It stalks rather than circles: a heavy step, a long plant, and never long
  // before the axe goes up. It does not feint -- everything it starts, it
  // means -- and it gets out of the way of very little. What it does with a
  // swing it sees coming is put the axe in its way, which knocks aside
  // anything you can swing. It does not hop, it does not flinch, and once you
  // have backed off out of its reach it beats the floor with the axe at you.
  footwork: {
    patience: [0.25, 0.9], settle: 0.42, wariness: 0.1, retreat: 0.1, feint: 0,
    rock: 0.12, give: 0.1, bait: 0, counter: 0.5,
    hop: 0, parry: 0.25, lunge: 0, flinch: 0, taunt: 0.2, quick: 0.1, dart: 0.15,
  },
  // Round high and back along the floor, or along the floor and back round
  // high: two, and then it has to get the axe up again. The overhead ends
  // where nothing else starts, and is on its own.
  flow: { combo: 0.35, chain: 2 },
  // Hurt, it gets angry: less waiting, more of it in a run, and no more
  // getting out of the way of anything.
  temper: {
    below: 0.4,
    aggression: 1.6,
    footwork: { patience: [0.1, 0.45], wariness: 0, retreat: 0, parry: 0.1, taunt: 0 },
    flow: { combo: 0.65, chain: 3 },
  },
  // It beats the floor in front of it with the axe head: down, up, down.
  display: {
    a: { yaw: 0.25, pitch: -1.05, reach: 1, roll: 0 },
    b: { yaw: 0.25, pitch: 0.2, reach: 0.7, roll: 0 },
    beats: 3, beat: 0.55,
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
      //
      // Measured again once a raised arm stopped turning over (see
      // `tipPole`): the axe goes up behind the orc's head now, the elbow under
      // it, where it used to go up in front with the elbow over the top and
      // come down turning half over on the way. On the old edge that landed
      // it on the flat -- a leap drew blood one time in five, against seven in
      // ten before -- and the edge next to it is where the same chop does about
      // what it did: over 160 leaps two in three draw blood, against seven in
      // ten, for 1.7 points a leap against 1.4; it comes round about as
      // quickly; and the orc measures its reach, off the middle of this band,
      // two and a half centimetres short of where it did.
      name: "overhead", aims: ["head", "body"],
      from: { yaw: [-0.55, -0.35], pitch: [0.9, 1.1], reach: [0.3, 0.4] },
      to: { yaw: [0, 0.1], pitch: [-0.85, -0.65], reach: [1, 1] },
      roll: [0.25, 0.45], step: 1,
      at: { min: 0.72 },
      favour: 3,
    },
    {
      // The whole axe round at waist height. It runs out of arc: give ground.
      // Give ground just far enough for it to miss and 3.65kg of iron going
      // round carries the orc round after it, and it comes round again.
      name: "wide swing", aims: ["body", "head"],
      from: { yaw: [-1.5, -1.3], pitch: [0.3, 0.4], reach: [0.5, 0.6] },
      to: { yaw: [1.2, 1.35], pitch: [-0.2, -0.1], reach: [1, 1] },
      roll: [-1.5, -1.1], step: 0,
      at: { min: 0.7 },
      spin: { chance: 0.6, roll: [0.4, 0.9] },
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
  // All ears and nose, in rags, barefoot.
  look: {
    face: "goblin", eyes: 0xf2e24a, glow: true, dress: "rags", feet: "claws", leather: 0x4b3a22,
  },
  power: sizedPower(GOBLIN_BUILD, 1.8),
  aggression: 0.85,
  // Never still. It skips about at the end of its spear, darts in to make you
  // flinch, and hops back from most of what you swing at it: a goblin that
  // stands and takes a sword cut is a dead goblin. It gives ground as the
  // spear goes back and comes in behind the point, and a cut that lands on
  // it while it draws back is usually the end of that thrust.
  footwork: {
    patience: [0.6, 1.8], settle: 0.14, wariness: 0.6, retreat: 0.55, feint: 0.22,
    rock: 0.35, give: 0.8, bait: 0.12, counter: 0.45,
    hop: 0.65, parry: 0.08, lunge: 0.35, flinch: 0.8, taunt: 0.12, quick: 0.7, dart: 0.6,
  },
  // Jab, jab, jab: a spear drawn back off a thrust is ready to thrust again.
  flow: { combo: 0.5, chain: 3 },
  // Hurt, it gets away: it waits longer between thrusts, gives ground, hops
  // back from everything, and stops offering you anything to swing at.
  temper: {
    below: 0.5,
    aggression: 0.4,
    footwork: {
      patience: [1.2, 2.6], wariness: 0.85, retreat: 0.85, give: 0.95, bait: 0, hop: 0.9, taunt: 0,
      quick: 0.9,
    },
  },
  // It shakes the spear at you over its head.
  display: {
    a: { yaw: -0.35, pitch: 0.9, reach: 0.75, roll: 0 },
    b: { yaw: 0.35, pitch: 0.9, reach: 0.75, roll: 0 },
    beats: 4, beat: 0.3,
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

// --- the kobold --------------------------------------------------------------

const KOBOLD_BUILD = makeBuild(0.6, 0.95);

/**
 * A kobold with a hatchet: a metre of scaly spite that comes up to your
 * belt.
 *
 * Everything about it is small, and the cube law is merciless to small
 * things: it weighs a fifth of you, and one clean cut takes its head or its
 * arm off. What it has is a little axe that comes round in a flick, and
 * your shins at the height of its shoulder. It darts in, hacks at your legs
 * and is out again before your sword has come round -- and it jumps at you
 * with the hatchet over its head once you have backed off. Hurt, it runs.
 */
export const KOBOLD: Species = {
  key: "kobold",
  name: "the kobold",
  possessive: "the kobold's",
  note: "small, quick, and always at your shins",
  build: KOBOLD_BUILD,
  weapon: HATCHET,
  palette: { cloth: 0x6b5a3e, skin: 0xa0552c, mark: 0xe0c060 },
  // Scaled, snouted and horned, with a tail, and a hide round its middle.
  look: {
    face: "kobold", eyes: 0xffc23a, glow: true, dress: "hide", feet: "claws",
    leather: 0x5b4630, tail: 0.55, scales: true,
  },
  // Wiry, like the goblin: at the strength its shoulders imply, a hatchet on
  // the end of an arm that short hangs off it.
  power: sizedPower(KOBOLD_BUILD, 2),
  aggression: 1.1,
  // Never still, and never where you swung: it skitters about, darts in and
  // back out, hops from most of what comes at it, and flinches from any cut.
  // It does not put its hatchet in the way of anything.
  footwork: {
    patience: [0.3, 1.1], settle: 0.12, wariness: 0.55, retreat: 0.6, feint: 0.3,
    rock: 0.45, give: 0.7, bait: 0.1, counter: 0.6,
    hop: 0.55, parry: 0.03, lunge: 0.3, flinch: 0.85, taunt: 0.25, quick: 0.8, dart: 0.75,
  },
  // Hack, hack, hack: a hatchet is light enough to keep going.
  flow: { combo: 0.6, chain: 4 },
  // Hurt, it runs: long waits, everything given up, nothing offered.
  temper: {
    below: 0.5,
    aggression: 0.35,
    footwork: {
      patience: [1.4, 3.0], wariness: 0.9, retreat: 0.9, give: 0.95, bait: 0, hop: 0.9,
      taunt: 0, dart: 0.3,
    },
  },
  // It waves the hatchet over its head at you.
  display: {
    a: { yaw: -0.4, pitch: 1.0, reach: 0.7, roll: 0 },
    b: { yaw: 0.4, pitch: 0.9, reach: 0.8, roll: 0 },
    beats: 5, beat: 0.22,
  },
  // Close in, since a hatchet has no reach to speak of -- but not too close:
  // its whole arc is inside a stride, and from under your nose it met you
  // on the way back as the hatchet went up, and came through slow. It swings
  // from the edge of its reach, where the head has come round to speed by
  // the time it gets to you.
  range: { close: 1.0, strike: 1.2, far: 1.45 },
  // Your legs, mostly, which are where its shoulders are; your middle when it
  // can get at it; never your head, which is out of its reach.
  aim: { head: 0, body: 0.4, arm: 0.1, legs: 0.5 },
  cuts: [
    {
      // Across, from its right: the orc's swing round, in miniature. Its
      // band was measured on its own arm, not borrowed from the axe's: a
      // hatchet on a kobold's arm leads with its edge a little further over.
      name: "hack", aims: ["legs", "body", "arm"],
      from: { yaw: [-1.4, -1.15], pitch: [0.25, 0.4], reach: [0.5, 0.6] },
      to: { yaw: [1.0, 1.2], pitch: [-0.2, -0.05], reach: [1, 1] },
      roll: [-1.15, -0.9], step: 0,
      spin: { chance: 0.25, roll: [0.4, 0.9] },
    },
    {
      // Over the top and down, stepping in: its jump comes down with this.
      name: "chop", aims: ["legs", "body"],
      from: { yaw: [-0.5, -0.3], pitch: [0.9, 1.1], reach: [0.3, 0.45] },
      to: { yaw: [0, 0.1], pitch: [-0.8, -0.6], reach: [1, 1] },
      roll: [0.15, 0.45], step: 1,
      at: { min: 0.7 },
    },
    {
      // Back across, low: at your shins from its left.
      name: "backhand", aims: ["legs"],
      from: { yaw: [1.1, 1.3], pitch: [0.05, 0.15], reach: [0.55, 0.65] },
      to: { yaw: [-1.35, -1.2], pitch: [-0.4, -0.25], reach: [1, 1] },
      roll: [-1.1, -0.85], step: 0,
    },
  ],
  // Back off and it comes after you through the air, hatchet high.
  leap: { cut: "chop", at: { min: 2.0, max: 3.4 }, memory: 3, rest: 3 },
};

// --- the ogre ----------------------------------------------------------------

const OGRE_BUILD = makeBuild(1.36, 1.24);

/**
 * Two and a half metres of ogre with a club.
 *
 * It is slower than anything else here and it does not need to be quick:
 * it weighs three and a half of you and swings from the hips, putting a
 * good share of all that behind the club (see `heave`), and the club does
 * not stop in you -- it comes back off you and you go where it was going
 * (see `Weapon.rebound`). Caught square, you leave the floor and come down
 * across the room. It cannot take your arm off. It does not have to.
 *
 * It swings up from the floor through you more than anything: the swing that
 * sends you flying. It sweeps round at you and back, and brings the club
 * down on you, all of which put you on the floor rather than across the
 * room. What it never does is hurry, or get out of the way.
 */
export const OGRE: Species = {
  key: "ogre",
  name: "the ogre",
  possessive: "the ogre's",
  note: "huge and slow, and its club sends you flying",
  build: OGRE_BUILD,
  weapon: CLUB,
  palette: { cloth: 0x5a4632, skin: 0x8d8a6a, mark: 0x9c3a26 },
  // A jaw like a trough, a topknot, a gut, and a hide round it.
  look: {
    face: "ogre", hair: 0x2b2118, eyes: 0xc8a050, glow: true, dress: "hide", feet: "claws",
    leather: 0x6a5238, belly: 0.95,
  },
  power: sizedPower(OGRE_BUILD),
  heave: 0.1,
  aggression: 1.2,
  // It lumbers: a long plant between steps, little waiting once it is close,
  // nothing it gets out of the way of, no quick steps and no hops. It will
  // put the club in the way of a swing it sees coming now and then, and
  // what meets it is sent back where it came from.
  footwork: {
    patience: [0.35, 1.0], settle: 0.55, wariness: 0.05, retreat: 0.05, feint: 0,
    rock: 0.08, give: 0.05, bait: 0, counter: 0.45,
    hop: 0, parry: 0.15, lunge: 0, flinch: 0, taunt: 0.3, quick: 0, dart: 0.05,
  },
  // A sweep and back: two, and then the club has to come up again.
  flow: { combo: 0.4, chain: 2 },
  // Hurt, it comes on: no waiting, and it keeps swinging.
  temper: {
    below: 0.35,
    aggression: 1.6,
    footwork: { patience: [0.1, 0.4], parry: 0.05, taunt: 0 },
    flow: { combo: 0.6, chain: 3 },
  },
  // It hefts the club up over its head and shakes it at you.
  display: {
    a: { yaw: 0.2, pitch: 1.05, reach: 0.55, roll: 0 },
    b: { yaw: -0.15, pitch: 1.2, reach: 0.45, roll: 0 },
    beats: 2, beat: 0.85,
  },
  range: { close: 0.75, strike: 1.0, far: 1.25 },
  // Your middle, mostly -- the biggest thing to send across the room -- your
  // head sometimes, your legs now and then, and never your arm.
  aim: { head: 0.25, body: 0.6, arm: 0, legs: 0.15 },
  cuts: [
    {
      // Round from its right, level, rising a little through you: it puts
      // you on the floor, and whatever it catches it carries round with it.
      name: "sweep", aims: ["body", "head"],
      from: { yaw: [-1.5, -1.3], pitch: [-0.12, 0], reach: [0.55, 0.65] },
      to: { yaw: [1.1, 1.3], pitch: [0.15, 0.25], reach: [1, 1] },
      roll: [-0.2, 0.2], step: 0,
      at: { min: 0.65 },
      spin: { chance: 0.4, roll: [-0.2, 0.2] },
    },
    {
      // Over the top and down: you go down, not away.
      name: "smash", aims: ["head", "body"],
      from: { yaw: [-0.5, -0.3], pitch: [0.95, 1.15], reach: [0.3, 0.4] },
      to: { yaw: [0, 0.1], pitch: [-0.85, -0.65], reach: [1, 1] },
      roll: [-0.2, 0.2], step: 1,
      at: { min: 0.7 },
    },
    {
      // Up off the floor from low down on its right, through whatever is in
      // front of it: the one that sends you flying, up and back and down on
      // your back metres away. Its favourite, twice over.
      name: "upswing", aims: ["body", "legs"],
      from: { yaw: [-0.75, -0.55], pitch: [-1.0, -0.85], reach: [0.55, 0.7] },
      to: { yaw: [0.25, 0.45], pitch: [0.55, 0.75], reach: [1, 1] },
      roll: [-0.2, 0.2], step: 1,
      at: { min: 0.6 },
      favour: 2.5,
    },
    {
      // And back the other way, from its left.
      name: "backhand", aims: ["body"],
      from: { yaw: [1.15, 1.3], pitch: [0, 0.15], reach: [0.55, 0.65] },
      to: { yaw: [-1.35, -1.2], pitch: [0.2, 0.35], reach: [1, 1] },
      roll: [-0.2, 0.2], step: 0,
      at: { min: 0.65 },
    },
  ],
};

export const SPECIES = {
  swordsman: SWORDSMAN,
  orc: ORC,
  goblin: GOBLIN,
  kobold: KOBOLD,
  ogre: OGRE,
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
