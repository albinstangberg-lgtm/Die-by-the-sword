import * as THREE from "three";
import { ARM_RANGE, type ArmInput } from "./arm";
import type { Combatant } from "./combatant";
import type { Keys } from "../input/input";
import { QUICK_TIME } from "./fighter";
import type { Tuning } from "../tuning";
import type { Aim, Cut, Flow, Footwork, Leap, Span, Species } from "./species";

/**
 * An opponent that fights the way you do.
 *
 * It does not get to cheat. It drives its weapon arm by emitting MOUSE DELTAS
 * through the same `ArmInput` surface the player's pointer feeds, so its blade
 * is subject to the same force clamp, the same reach limits, the same
 * saturating PD controller. It cannot teleport its weapon, it cannot swing
 * faster than an arm can be moved, and if it buries its axe in a pillar it is
 * stuck there exactly as long as you would be.
 *
 * Nor does it announce anything. It used to throw a short list of named
 * attacks, each held wound up for a set time while its weapon glowed and the
 * fight panel said what was coming and how to beat it. That read clearly and
 * fought like a quiz: you learned the tells and stopped watching the body.
 * Now every swing is made up as it is thrown -- a part of you picked out, one
 * of the shapes its arm knows, and the angles, depth and edge each drawn
 * afresh -- and it draws back only for as long as its arm takes to get there.
 * A sword comes back in a blink and an axe does not, so what you read is what
 * you would read off anyone: the weapon going back, where to, and how far.
 *
 * None of that makes a swing scripted. Once it goes, the arm is still being
 * dragged toward a target pose under a clamped force. It overswings, it
 * catches the low beam, it plants the axe in the floor, and the damage it does
 * comes out of how fast the weapon happened to be travelling when it arrived.
 *
 * The shapes are written in offsets from LEVEL -- the arm pitch at which this
 * creature's own weapon would cross the part of you it is aimed at -- which is
 * solved from its own kinematics while it winds up. One shape therefore
 * describes the same swing at your head and at your shins, thrown by a goblin
 * or by an orc twice its height.
 *
 * And between swings it has FOOTWORK. It used to walk up to you, stop, and
 * swing, and swing again: nine tenths of a fight went on winding up, striking
 * and recovering, and in forty seconds of it an opponent moved twenty
 * centimetres sideways. Now it circles you in short steps at the edge of its
 * own reach, drifting in or out to stay there; it gives ground after a swing
 * about as often as it presses; now and then it darts in and straight back
 * out; and it gets out of the way of a blade it sees coming. Every step goes
 * through the same four keys yours do -- its sidestep is Q and E too -- so it
 * has no way of moving that you have not.
 *
 * And it moves in and out as well as round: half-steps across the edge of its
 * reach, back as you come at it and after you as you go, and now and then a
 * step inside your reach on purpose, to draw a swing out of you -- and a swing
 * of yours that comes at it and misses is the moment it steps in. So is your
 * weapon knocked aside by its own; its own knocked aside by yours, the swing
 * it was throwing is gone (see `Impacts.clash`).
 *
 * Its jump is yours as well. Something that leaps (see `Leap`) and has just
 * lost you out of its reach runs at you with its weapon going up and comes
 * down on you out of the air, on your key, from a jump its legs could make.
 *
 * And it knows no more of you than it has seen. Lose it -- behind a pillar,
 * through a door -- and all it has is where you were and which way you were
 * going: it goes there, on a little the way you went, and looks round. Still
 * nothing, and it goes back to its post the way it came.
 *
 * And a fight flows. A swing that meets nothing runs into the one that starts
 * where it ended, and one stopped on your guard into the same again (see
 * `carryOn`); a swing that goes round and meets nothing can carry the whole
 * body round after it on its heel (see `carryRound`). Between swings its
 * guard is where the last one left it, shifting and swaying (see `guard`); it
 * draws back on its way in, or while giving ground (see `Approach`); it meets
 * a swing it sees drawn back with its own weapon (see `meet`), hops clear,
 * lets go of a swing a cut hurts it out of (see `feel`), fights differently
 * once badly hurt (see `Temper`), and shows you its weapon from out of its
 * reach (see `taunt`). Every swing is still drawn back for, and far enough to
 * see (see `gauge`): whatever else moves, a weapon going back means a swing is
 * coming.
 */

/** How fast the AI is allowed to move its hand, in pixels of mouse per second. */
const HAND_SPEED = 1100;

/**
 * Where a body's middle is, 0 at the feet and 1 at the crown: what a swing at
 * your body is aimed at, and what its reach is measured to.
 */
const CHEST = 0.72;

/**
 * How long it may want to walk, and not walk, before it concludes it is stuck.
 *
 * Something always eventually is. A hull's velocity is merely SET each step,
 * while the arm holding a caught weapon drives at hundreds of newtons through
 * a joint chain, and that is no contest: the body gets dragged straight back
 * to wherever the weapon is snagged. The case that found this was an orc
 * hooking its axe over the low beam on the way across the room and then
 * standing there for the rest of the fight, still dutifully pressing forward
 * at zero metres per second. The beam is higher now; pillars, walls and the
 * floor are all still there.
 */
const SNAG_TIME = 0.5;

/**
 * How long it goes on fighting where it last saw you, seconds, before it goes
 * to look for you.
 *
 * Not zero, and the reason is the pillars: stepping behind one mid-fight
 * breaks the line for a few frames, and an opponent that broke off every time
 * that happened would be absurd to watch. For that long it carries on as it
 * was, squared up to where you were.
 *
 * Where you WERE. It used to keep coming for two and a half seconds after the
 * line broke, and for all of them it knew where you actually were -- through
 * the stone -- and turned to follow you along the far side of the wall.
 */
const GLIMPSE = 0.4;

/**
 * Having got to where it last saw you, how far on it goes the way you were
 * heading, metres at human size -- through the door you went through, past
 * the pillar -- and the longest it gives that, seconds, if something is in the
 * way. Then how long it stands and looks round for you, seconds.
 */
const FOLLOW = 1.5;
const FOLLOW_TIME = 1.2;
const SEARCH: Span = [1.6, 2.6];

/**
 * How far to either side it looks round, radians, and how long one look there
 * and back takes, seconds -- slow enough that its turn keeps up.
 */
const SWEEP = 0.9;
const SWEEP_TIME = 2.4;

/** How fast you have to have been going for it to follow the way you went, m/s. */
const MOVING = 0.5;

/**
 * The longest it looks for you, seconds since it last saw you, before it gives
 * you up whatever it is doing: the bound for somewhere it cannot get to.
 */
const HUNT = 12;

/**
 * How near somewhere it walks to has to be before it is there, metres at human
 * size -- and nearer for its post, where it means to stand.
 */
const ARRIVE = 0.4;
const HOME = 0.15;

/**
 * How far off its line to somewhere it may be and still walk, radians -- on a
 * slant past the first -- rather than turn on the spot first. At full pace it
 * turns a circle over two metres across, so somewhere near it and well off to
 * one side is somewhere it would go round rather than get to.
 */
const SLANT = 0.4;
const TURN_FIRST = 1.2;

/** How far it walks between the marks it leaves for the way home, metres at human size. */
const CRUMB = 1;

/**
 * How near you have to be before it takes an interest, metres.
 *
 * Sight alone is not enough, and a doorway is why: a door is a hole you can
 * see a long way through, so a bare line-of-sight test had the orc set off
 * across its hall the moment you lined up with the door eighteen metres away
 * on the far side of another room. Notice is close range; once it HAS noticed
 * you, the line of sight alone keeps it coming, and it will follow you as far
 * as it can see you.
 */
const NOTICE = 9;

// --- footwork -----------------------------------------------------------------

/**
 * How long one step keeps the feet moving, seconds: the shortest and the
 * longest. At walking pace that is half a metre to most of one -- a step, not
 * a stroll -- and it scales with the body, because the pace does.
 */
const STRIDE = [0.16, 0.28] as const;

/**
 * How far out it circles, past the most it can reach, as a multiple of that.
 *
 * It goes round you from halfway between where its weapon does its work and
 * the most it can reach, out to a little beyond -- and when its moment comes it
 * steps in to the near edge of that before it winds up, so you see it come.
 *
 * The near edge and not the far one. It first committed the moment it was
 * barely in reach, and threw nearly nine in ten swings from the last hand's
 * width of it: with the tip, for half the blood and two thirds of the damage
 * of the swings it threw from where its weapon works.
 */
const HOVER = 1.12;

/** Chance, per step round you, that it turns and goes round the other way. */
const REVERSE = 0.22;

/**
 * How often it goes round to its own right -- your left, away from the hand
 * your sword is in -- rather than to its left.
 */
const OFF_HAND = 0.62;

/** Chance a step round you is spent standing still and watching instead. */
const WATCH = 0.14;

/** A feint's dart in, seconds. The step back out is a little longer. */
const DART = 0.15;

/**
 * Coming in from further off than it can reach, most of the time it comes on
 * a slant rather than down a rail -- but not from across a room: only inside
 * this many metres, and only beyond this many times its own reach.
 */
const WEAVE_IN = 4.5;
const WEAVE_OUT = 1.6;

/** How far ahead it looks for something in its way, in seconds of walking. */
const LOOK = 0.25;

/** The longest one bout of giving ground lasts, seconds. */
const RETREAT = 0.9;

/**
 * After a swing, the chance it presses straight into another, before its
 * aggression is applied. Retreat is rolled first; whatever is left over, it
 * goes round.
 */
const PRESS = 0.4;

/**
 * How long it will let you stand inside its guard, seconds, before it stops
 * trying to back away and swings at you from there.
 */
const CROWD = 0.6;

/** How squarely it must face you to commit, radians: it aims off its own chest. */
const SQUARE = 0.2;

// --- getting out of the way ---------------------------------------------------

/**
 * How fast your blade has to be coming AT it, relative to the body carrying
 * it, before it counts as a swing, m/s.
 *
 * Not how fast it is going. A sword whips about at seven, eight, nine metres a
 * second when its owner merely starts to walk, sidesteps or turns -- the body's
 * velocity is set outright and the arm lags it, then catches up -- and a
 * threshold on speed that ignored all of that also ignored every overhead
 * chop. What a cut does that footwork does not is come at you. Measured on the
 * same arm: thirty-six seconds of shuffling in and out, sidestepping and
 * turning never took this past 5 m/s, and nine cuts and nine chops each took
 * it past once.
 */
const SWING = 5;

/** How near a swinging blade must come to be its problem: metres past its hull. */
const DANGER = 0.75;

/**
 * And how much further off than that it reads your weapon going back, metres:
 * drawn back, a weapon is further away than it will be coming through.
 */
const WIND_SEEN = 0.5;

/**
 * Below this, m/s, your weapon moving fast is not coming at it: drawn back,
 * or carried aside. See `threat`.
 */
const GOING_BACK = 1;

/** Its reaction time, seconds: the quickest and the slowest. */
const REACT = [0.12, 0.22] as const;

/** How long a step out of the way lasts, seconds. */
const DODGE = 0.3;

/** How long before it will get out of the way of anything again, seconds. */
const DODGE_REST = 0.9;

/**
 * Having stepped out of a swing, the longest it waits before swinging back:
 * the moment after a big cut is the one to hit you in.
 */
const RIPOSTE = 0.35;

// --- in and out ---------------------------------------------------------------

/**
 * A half-step in or out, as a share of its shortest step: enough to cross the
 * edge of its reach and come back, not enough to go anywhere.
 */
const HALF: Span = [0.6, 0.9];

/**
 * How fast you have to be coming at it, or going away from it, before it
 * counts as you stepping in or out, m/s. Well clear of what swinging a sword
 * does to the body holding it, which is a tenth of this.
 */
const ADVANCE = 1;

/**
 * Baiting: how far inside your reach it stands, as a share of it, and how long
 * it stands there, seconds -- and how readily it gets out of the way of what
 * that draws, whatever its usual wariness. That is what it is there for.
 *
 * The reach it reads is your arm and weapon laid end to end (`strikeLength`),
 * and a guard holds a blade angled up out of the hand, not straight on: your
 * sword reads 1.26 m and does its work at 1.11. Three quarters of the first is
 * a hand's width inside the second.
 */
const BAIT_DEPTH = 0.75;
const BAIT_HOLD: Span = [0.35, 0.7];
const BAIT_WARY = 0.9;

/**
 * How long a swing of yours that came at it and missed leaves you open,
 * seconds: the time it has to step in and make you pay for it.
 */
const OPENING = 0.6;

/**
 * How much of an arm's strength a knock on its weapon has to have taken
 * before it counts: its own, and the swing it was throwing is gone; yours,
 * and that is an opening. See `Arm.jolt`.
 */
const KNOCKED = 0.2;

// --- swinging -----------------------------------------------------------------

/**
 * The least and the most each part of a swing may take, seconds: drawing
 * back, going through, getting the guard back up.
 *
 * Bounds, not lengths. Each part is over when the weapon has got where it was
 * sent, and how long that takes is the arm's business -- a sword is back in a
 * blink, an axe is not, and one caught on a pillar never is, which is what the
 * longest is for. The shortest keeps a part from counting as done before the
 * arm has so much as started on it.
 */
const WINDUP: Span = [0.1, 0.8];
const STRIKE: Span = [0.2, 0.7];
const RECOVER: Span = [0.12, 0.7];

/**
 * How near the hand has to be to where its pose puts it for the weapon to
 * count as there, metres at human size.
 *
 * Looser going through than drawing back: the follow-through is aimed past
 * you, and a hand that has come most of the way through has done what it was
 * thrown for.
 */
const THERE = { windup: 0.1, strike: 0.15, recover: 0.12 } as const;

/**
 * A weapon that has been stopped dead: the tip slower than this, m/s, for
 * this long, s, once the least of a part of a swing has gone by.
 *
 * A blade that lands on someone stops there now, as it does on a wall, so
 * the pose it was sent through is one it will never get to, and a swing that
 * waited for it leaned the weapon on you until its time ran out -- a third
 * of a second of sword held against your ribs, every blow. Getting the guard
 * back up is the same: close in, the guard it wants is where you are standing.
 * A stopped blade sits well under a metre a second; one checked for a step by
 * your sword and going on through is at two or more, and not for long.
 */
const STALLED = 1;
const STALL_TIME = 0.08;

/**
 * The least a swing is drawn back by: radians of arm, or metres of reach. A
 * swing that starts where the last one ended, or out of a parry, or from a
 * guard held where it happens to begin, would otherwise start with no
 * drawing back at all -- a cut nobody could read. See `gauge`.
 */
const DRAW = { angle: 0.35, reach: 0.1 } as const;

/**
 * The furthest an edge comes round off your chest toward the part of you it
 * is after, radians.
 */
const TURN_IN = 0.7;

// --- leaping ------------------------------------------------------------------

/**
 * How far into its reach you have to be for a chop to meet you, as a fraction
 * of its strike reach: the part of the weapon that does the work a little past
 * your middle.
 */
const LAND = 0.95;

/**
 * Where a leap should put it down, as a fraction of its strike reach -- closer
 * than it swings from on its feet. An overhead meets you at chest height a
 * metre in front of it, not at the end of its reach, and on its feet it
 * closes that last stretch by stepping into the swing, which in the air it
 * cannot: landed where it swings from, its axe came down half a metre short.
 */
const LEAP_LAND = 0.7;

/**
 * How long an overhead takes to come down from the top, seconds, measured on
 * the orc's axe: the time a leap goes on covering ground while it falls, and
 * so how far ahead of you it has to start.
 */
const CHOP = 0.28;

/** The longest it runs at you with the weapon going up before it gives up, seconds. */
const CHASE = 1.5;

/** How long after it leaves the floor before finding it again counts as landing, seconds. */
const LIFT = 0.15;

// --- one swing into the next --------------------------------------------------

/**
 * How near the end of one swing the start of another has to be for it to
 * follow on from it, radians of arm yaw. A forehand's follow-through and a
 * backhand's wind-up are the same place, give or take a tenth of a radian.
 */
const LINK = 0.45;

/**
 * How long it stands getting its breath with its guard up at the end of a run
 * of swings, seconds for each swing in it past the first -- and, out of a
 * spin, for having been round. Still in the swing, and so no more able to get
 * out of the way of anything than it is while its guard comes back up: a run
 * is paid for at the end of it.
 */
const WINDED = 0.15;
const DIZZY = 0.2;

/**
 * The longest a spin may take to come round, seconds, and the furthest round
 * it may carry the body, radians: bounds, for a weapon that never gets past
 * you because something is in the way.
 */
const SPIN_TIME = 1.6;
const SPIN_MOST = Math.PI * 2.6;

/** How far along its weapon, hand to tip, the part that works is taken to be. */
const WORKS = 0.8;

/**
 * Going round, how far inside and outside the circle its weapon is going round
 * on you may be before it steps to put you back on it, metres.
 */
const RING: Span = [0.25, 0.1];

/**
 * How far off you may be for a spin to be worth it, as a multiple of the
 * furthest it fights at: you stepped just out of the swing, not across the
 * room.
 */
const SPIN_FAR = 1.3;

/** Going round, how far off a step's line you may be before it takes a key for it: cos or sin of 67.5°. */
const STEER = 0.38;

/**
 * How often, pressing in, it comes in drawing back rather than steps in to
 * where it swings from and draws back there: rolled once each time it comes.
 */
const COME_IN = 0.55;

/**
 * Coming at you with the weapon going back: how far out of where it swings
 * from it may start drawing back, in seconds of its walking pace, and the
 * longest it keeps coming with the weapon back before it gives the swing up.
 */
const APPROACH = 0.35;
const CARRY = 1.2;

/** A lunge's first part, seconds: the step back as the weapon goes back. */
const LUNGE_BACK = 0.24;

// --- its guard ----------------------------------------------------------------

/** The resting guard, off level: a little across, and a little up. */
const GUARD_YAW = 0.3;
const GUARD_LIFT = 0.15;

/**
 * The guards it moves between, off level -- across, and how high -- and how
 * long it holds one before it shifts to another, seconds. A swing is drawn
 * back from wherever the guard is, so where it holds its weapon changes
 * nothing about what the drawing back says; it only makes a still weapon
 * something other than a thing you can learn to stop watching.
 *
 * Never below the chest, and never far across it. It held its axe low in
 * front of it after an overhead at first, where the overhead ends, and far
 * over on its left after a swing round, and the next overhead's drawing back
 * brought the head up through whoever was standing there, or across them:
 * it met you on the way back eight times as often as from its old guard, did
 * nothing, and came down late off a weapon that had been stopped. The orc's
 * axe staggered you less than half as often as it had.
 */
const STANCE_YAW: Span = [-0.15, 0.4];
const STANCE_LIFT: Span = [0.1, 0.5];
const STANCE_HOLD: Span = [1.2, 3.2];

/**
 * How much of the way to where a swing ended its guard is held afterwards.
 * It keeps its weapon where the swing left it rather than bringing it all
 * the way back to the middle, and brings it back to the middle later.
 */
const HELD = 0.6;

/**
 * How long it takes to shift its guard, seconds: the time it takes to get
 * most of the way. A guard shifted at the speed a swing goes is a swing, and
 * a sword brought round a foot from you that fast cuts you.
 */
const SHIFT_TIME = 0.5;

/**
 * A guard is never quite still: how far it sways, radians of arm yaw and of
 * pitch, and how long one sway takes, seconds at human size.
 */
const SWAY = { yaw: 0.05, pitch: 0.035, time: 2.4 } as const;

// --- meeting your blade with its own -------------------------------------------

/**
 * How far ahead of your blade it puts its own, seconds of your blade's
 * travel: where it will be, not where it was.
 */
const LEAD = 0.08;

/** A parry's reach, 0..1 of its arm: out from the body, not at full stretch. */
const PARRY_REACH = 0.55;

/**
 * How long a parry is held once your swing has come and gone, seconds, and the
 * longest it waits for a swing that never comes.
 */
const PARRY_HOLD: Span = [0.15, 0.9];

// --- hops -----------------------------------------------------------------------

/** How far a hop is expected to carry it, in seconds of its walking pace: the room it asks for. */
const HOP = 0.6;

// --- quick steps ------------------------------------------------------------------

/**
 * How often a step round you is a quick one, as a share of `Footwork.quick`
 * -- which is mostly about getting out of the way, and a creature that shot
 * round you every other step would be doing little else.
 */
const QUICK_ROUND = 0.25;

// --- being hurt -----------------------------------------------------------------

/** The least a cut has to take off it, health, to count as one it feels. */
const FELT = 1;

// --- taunting -------------------------------------------------------------------

/** How far out of its circle you have to be for it to taunt you, as a multiple of it. */
const TAUNT_OUT = 1.1;

/**
 * And how far off you have to be, as a multiple of its circle, for it to stop
 * and taunt you on its way to you.
 */
const TAUNT_FAR = 1.4;

/** The least time between one taunt and the next, seconds. */
const TAUNT_REST = 6;

/**
 * How its feet go while it draws back.
 *
 *   stand     it stands, and the swing goes once the weapon is back
 *   approach  it comes in with the weapon going back, and swings as it arrives
 *   lunge     it gives ground as the weapon goes back, then comes in behind it
 *   dart      it quick-steps in as the weapon goes back, and swings from where it lands
 */
export type Approach = "stand" | "approach" | "lunge" | "dart";

/**
 * One swing, made up as it is thrown: the shape its arm makes, the part of you
 * it is aimed at, and the numbers drawn for this one.
 */
export interface Swing {
  readonly cut: Cut;
  readonly aim: Aim;
  readonly from: { readonly yaw: number; readonly pitch: number; readonly reach: number };
  readonly to: { readonly yaw: number; readonly pitch: number; readonly reach: number };
  readonly roll: number;
  /** Brought down out of a jump: see `Leap`. */
  readonly leap: boolean;
  /** What its feet do while it draws back. */
  readonly move: Approach;
}

/** Somewhere in a span, any of it as likely as the rest. */
function draw([lo, hi]: Span): number {
  return lo + Math.random() * (hi - lo);
}

/** The middle of a span. */
function mid([lo, hi]: Span): number {
  return (lo + hi) / 2;
}

/** Whether a shape is any use from this far off, in the creature's own reaches. */
function fits(c: Cut, at: number): boolean {
  return !c.at || (at >= (c.at.min ?? 0) && at <= (c.at.max ?? Infinity));
}

/** One of these, as often as its weight says. */
function weighted<T>(items: readonly T[], weight: (item: T) => number): T {
  let left = Math.random() * items.reduce((sum, item) => sum + weight(item), 0);
  for (const item of items) {
    left -= weight(item);
    if (left < 0) return item;
  }
  return items[items.length - 1];
}

function within(v: number, [lo, hi]: readonly [number, number]): number {
  return Math.max(lo, Math.min(hi, v));
}

function cap(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function copy(out: THREE.Vector3, p: { x: number; y: number; z: number }): THREE.Vector3 {
  return out.set(p.x, p.y, p.z);
}

type State =
  | "close" | "circle" | "backoff" | "evade" | "parry" | "taunt"
  | "windup" | "leap" | "strike" | "recover" | "free" | "beaten"
  | "waiting" | "reeling" | "down" | "hunt" | "return";

/** How far into looking for you it has got. See `search`. */
type Leg = "go" | "follow" | "look";

const ZERO = { x: 0, y: 0, z: 0 } as const;

/**
 * The states in which it is loose on its feet -- committed to nothing -- and
 * so free to get out of the way of something. Showing you its weapon is not
 * being committed to anything.
 */
const LOOSE: ReadonlySet<State> = new Set<State>(["close", "circle", "backoff", "taunt"]);

/** How a creature fights, which a bad enough wound can change. See `Temper`. */
interface Mood {
  readonly footwork: Footwork;
  readonly flow: Flow;
  readonly aggression: number;
}

/** One step of footwork: which way the feet go, relative to where it faces. */
interface Step {
  /** 1 forward, -1 back, 0 neither. */
  fwd: number;
  /** 1 to its right, -1 to its left, 0 neither. */
  side: number;
  /** Seconds the feet move for. */
  time: number;
  /** Seconds it stands afterwards, before the next. */
  settle: number;
}

export class Ai implements ArmInput {
  readonly keys: Keys = {
    forward: false, back: false, left: false, right: false,
    turnLeft: false, turnRight: false, jump: false, vault: false, crouch: false, pivot: false,
    dash: false,
  };

  private state: State = "waiting";
  private timer = 0;
  /** Seconds since whatever it is doing began. */
  private clock = 0;
  /** The swing it is throwing, or threw last. */
  private swing: Swing | null = null;
  /**
   * Level at your chest: where it holds its guard, and what it measures its
   * reach against. Kept apart from a swing's own, which is aimed wherever that
   * swing is going.
   */
  private readonly level = { yaw: 0, pitch: 0 };
  /**
   * Level for the swing it is throwing, at the wound-up reach and at the
   * extended one: the arm angles at which its weapon would cross the part of
   * you it is aimed at.
   *
   * Two of them, because a thrust needs both. Extending the arm swings the
   * elbow through a large angle, and the weapon held along the forearm swings
   * with it -- so a thrust that only aims its end pose comes in rotating about
   * the hand, which puts the point's whole velocity at right angles to the
   * shaft. Aiming BOTH ends at the target leaves the shaft pointing the same
   * way in each, and the only thing left between them is the hand travelling
   * up its own line. That is a thrust.
   *
   * For an edge the yaw is only how far round from your chest the part it is
   * after lies -- your sword arm is off to one side of you -- because its
   * shapes are written against torso-forward and were measured that way.
   */
  private readonly aimFrom = { yaw: 0, pitch: 0 };
  private readonly aimTo = { yaw: 0, pitch: 0 };
  /** Measured horizontal distance its percussion point covers, metres. */
  private strikeReach = 1;
  /**
   * The edge it measures that with: the middle of the band its first shape
   * cuts in, so the distance it keeps does not depend on its last swing.
   */
  private readonly refRoll: number;
  /**
   * The part of you its reach is measured at: whichever of your head, your
   * middle and your legs it goes for most. Your middle, for nearly everything.
   * Measured at your chest, a kobold's arm reaches up for it and has half a
   * metre in front of it, and it stood on your toes to swing -- and hacked
   * at you on the way back as much as on the way through.
   */
  private readonly reachAim: Aim;

  /**
   * Pin the shape a swing is thrown with, the part of you it goes for, or
   * both, so one kind of swing can be measured on its own. This is how the
   * shapes are tuned; leave them null in play.
   */
  cutOverride: string | null = null;
  aimOverride: Aim | null = null;

  /**
   * What its feet have done in and out, counted: half-steps across the edge
   * of its reach, answers to your stepping in (given ground, or met you) and
   * out (followed), steps into your reach to draw a swing, and misses of
   * yours it made you pay for. For the harness; nothing you are shown reads it.
   */
  readonly tally = {
    rockIn: 0, rockOut: 0, gives: 0, meets: 0, follows: 0, baits: 0, punishes: 0,
    /**
     * And what it has done with its weapon and its body besides swing: swings
     * that followed on from the last one, spins, swings thrown coming in and
     * from giving ground, parries, hops, swings let go of because a cut hurt,
     * and taunts.
     */
    combos: 0, spins: 0, approaches: 0, lunges: 0, parries: 0, hops: 0, flinches: 0, taunts: 0,
    /**
     * And its quick steps: all of them, and of those, swings thrown off one
     * in, steps straight back out of reach after a swing, out of the way of
     * one of yours, and round you.
     */
    quickSteps: 0, darts: 0, quickOuts: 0, quickDodges: 0, quickRounds: 0,
  };

  private want = { yaw: 0.3, pitch: -0.15, reach: 0.6, roll: 0 };

  private dx = 0;
  private wheel = 0;
  private dy = 0;
  private rollDx = 0;
  /** Whether the last step's input took its intent all the way onto `want`. */
  private onPose = false;

  private readonly _self = new THREE.Vector3();
  private readonly _foe = new THREE.Vector3();
  /** Where it is looking: the eyes of whatever it has seen. */
  private readonly _gaze = new THREE.Vector3();
  private readonly _probe = new THREE.Vector3();
  private readonly _reachAt = new THREE.Vector3();
  /** The pitch its reach was last measured at, when that is not your middle's. */
  private reachPitch = 0;
  private readonly _mark = new THREE.Vector3();
  /** The part of you a swing is aimed at, and its own shoulder, for bearings. */
  private readonly _part = new THREE.Vector3();
  private readonly _shoulder = new THREE.Vector3();
  /** Where the part of you a leap was aimed at was when its feet left the floor. */
  private readonly _leapMark = new THREE.Vector3();
  private readonly _was = new THREE.Vector3();
  /** The nearest your swinging blade came to it, flat: the side to step away from. */
  private readonly _near = new THREE.Vector3();
  /** Where it puts its weapon to meet yours, and the arm angles that put it there. */
  private readonly _meet = new THREE.Vector3();
  private readonly _parry = { yaw: 0, pitch: 0 };
  /** Coming for you, it draws back on the way in: see `comeOn`. */
  private comingIn = false;
  /** Coming for you, it stops to show you its weapon first: see `taunt`. */
  private showOff = false;
  /** Coming for you, it closes the last of the gap with a quick step: see `dartIn`. */
  private darting = false;
  /**
   * How far a quick step takes it from standing, metres, to a stop: what it
   * has to go by to land one where its weapon works. See `Footwork.quick`.
   */
  private quick = 1;
  private snag = 0;
  /** Seconds its weapon has been all but still in this part of a swing. See `STALLED`. */
  private stall = 0;
  /** Whether it is after you: it has noticed you and not yet given you up. */
  private engaged = false;
  /**
   * After you only because it heard something, and not yet having seen you:
   * see `hear`.
   */
  private heard = false;
  /** Seconds since it last saw you. */
  private lost = Infinity;
  /**
   * All it has of you once it cannot see you: where you were, your middle and
   * your eyes, and which way you were going, the last time it could.
   */
  private readonly _lastSeen = new THREE.Vector3();
  private readonly _lastChest = new THREE.Vector3();
  private readonly _lastEyes = new THREE.Vector3();
  private readonly _heading = new THREE.Vector3();
  /** Where it is going on to, the way you went. */
  private readonly _goal = new THREE.Vector3();
  private leg: Leg = "go";
  /** Which way it looks round from, and which way first. */
  private lookYaw = 0;
  private sweep = 1;
  /**
   * The way home: its post first, where it stood before it noticed you, then
   * the corners of the way it has come since. See `mark`.
   */
  private readonly trail: THREE.Vector3[] = [];
  /** The way it faced at its post. */
  private postYaw = 0;

  /** The step it is taking, and any it has already decided to take after it. */
  private step: Step = { fwd: 0, side: 0, time: 0, settle: 0 };
  private readonly queue: Step[] = [];
  /** Which way round it is going: 1 is to its own right, -1 to its left. */
  private side = 1;
  /** Seconds it will circle, once it is at its distance, before it commits. */
  private patience = 0;
  /** The slant it comes in on, the same way round as `side`; 0 is straight. */
  private weave = 0;
  /** Seconds you have been inside its guard. */
  private crowd = 0;
  /** Facing you squarely enough to aim a swing at you. */
  private squared = false;
  /**
   * Whether it can see you this step, as opposed to remembering where you
   * were. Memory will bring it round a pillar after you; only sight will let
   * it swing -- otherwise it wound up at you through the stone.
   */
  private sighted = false;
  /** Walking pace, m/s: your move speed, at its size. */
  private pace = 1;
  /** Was your blade a threat last step? A swing is weighed once, not every frame. */
  private threatened = false;
  /** Seconds until it answers the swing it has seen; negative if it is not going to. */
  private answerIn = -1;
  /** Your weapon going back near it, this step and last: see `threat`. */
  private readBack = false;
  private wasBack = false;
  /** Parrying, when your swing last came at it: negative if it has not yet. */
  private cameAt = -1;
  /** Seconds before it will get out of the way of anything again. */
  private rest = 0;
  /**
   * Seconds since you were last within its reach: whether you have just got
   * away from it, or were never there. Infinite until it has had you.
   */
  private sinceNear = Infinity;
  /** Seconds before it will leap again. */
  private leapRest = 0;
  /** How fast the gap between you is closing, m/s, and how much of that is you coming at it. */
  private closing = 0;
  private coming = 0;
  /**
   * You, stepping: 1 coming at it, -1 going away, 0 neither -- how long you
   * have been at it, how long it takes to see, and whether it has answered.
   */
  private yourMove = 0;
  private moveFor = 0;
  private moveReact = 0;
  private answered = false;
  /** Its answer: giving ground step for step, standing to meet you, or following you out. */
  private giving = false;
  private meeting = false;
  private following = false;
  /** Standing inside your reach on purpose, to draw a swing. */
  private baiting = false;
  /** Which way its last half-step across the edge of its reach went: 1 in, -1 out. */
  private rockDir = 1;
  /** How far from your middle your weapon does its work, metres, as far as it can see. */
  private yourReach = 0;
  /** Seconds left of the opening a swing of yours that missed has given it. */
  private opening = 0;
  /** Whether your weapon, and its own, had been knocked as of the last step. */
  private yoursKnocked = false;
  /** Its own weapon knocked, and its arm not yet got over it: no swing starts. */
  private knocked = false;
  /**
   * When a swing of yours began coming at it: its health then, for whether
   * that one landed, and whether it was standing in your reach to draw it.
   */
  private hpBefore = 0;
  private drawn = false;
  /** Swings thrown in the run it is in, this one included. See `Flow`. */
  private chain = 0;
  /** Your health as the swing it is throwing went: whether it went through nothing. */
  private yoursBefore = 0;
  /**
   * Carrying a swing on round with its whole body: which way, 1 to its left
   * and -1 to its right, or 0 when it is not. See `Cut.spin`. And how far
   * round it has come so far, radians, and its facing last step.
   */
  private whirl = 0;
  private spun = 0;
  private yawWas = 0;
  /** Where its weapon was, from you, the way it is going round, last step. */
  private bladeWas = 0;
  /** The edge it goes round on: see `Cut.spin`. */
  private whirlRoll = 0;
  /**
   * How much further back this swing is drawn than its shape says, so that it
   * is drawn back at all -- and whether that has been settled yet. See `gauge`.
   */
  private readonly further = { yaw: 0, pitch: 0, reach: 0 };
  private gauged = false;
  /** Seconds it stands getting its breath once its guard is up: after a run of swings, or a spin. */
  private winded = 0;
  /** When, into getting its guard back up, it was up; negative until it is. */
  private upAt = -1;
  /**
   * The guard it holds between swings, off level: where the last swing left
   * its weapon, or wherever it has since chosen to hold it. See `guard`.
   */
  private readonly stance = { yaw: GUARD_YAW, lift: GUARD_LIFT };
  /** Where its guard is on its way to `stance`: see SHIFT_TIME. */
  private readonly held = { yaw: GUARD_YAW, lift: GUARD_LIFT };
  /** Seconds before it shifts its guard of its own accord. */
  private shift = 0;
  /** How far through its sway the guard is, radians. */
  private sway = Math.random() * Math.PI * 2;
  /** How it will answer the swing it has seen: with its weapon, or its feet. */
  private answerWith: "parry" | "dodge" = "dodge";
  /** Off the floor on a hop of its own, and for how long. */
  private hopping = false;
  private hopClock = 0;
  /** Its health last step: whether something has just cut it. */
  private hpWas = 0;
  /** It let go of the swing because the cut hurt, and gives ground as its guard comes back. */
  private flinched = false;
  /** Seconds before it will taunt you again. */
  private tauntRest = 0;
  /** Badly hurt, and fighting like it: see `Temper`. */
  private wounded = false;
  /** How it fights: as it always does, and as it does once badly hurt. */
  private readonly calm: Mood;
  private readonly hurt: Mood;

  constructor(readonly species: Species) {
    const [lo, hi] = species.cuts[0].roll;
    this.refRoll = (lo + hi) / 2;
    const most = (["body", "head", "legs"] as const)
      .reduce((a, b) => (species.aim[b] > species.aim[a] ? b : a));
    this.reachAim = most;
    this.calm = { footwork: species.footwork, flow: species.flow, aggression: species.aggression };
    const temper = species.temper;
    this.hurt = temper === undefined ? this.calm : {
      footwork: { ...species.footwork, ...temper.footwork },
      flow: { ...species.flow, ...temper.flow },
      aggression: temper.aggression ?? species.aggression,
    };
  }

  /** How it fights just now. */
  private get mood(): Mood {
    return this.wounded ? this.hurt : this.calm;
  }

  /** Badly hurt, and fighting like it. For the harness. */
  get temper(): "calm" | "wounded" {
    return this.wounded ? "wounded" : "calm";
  }

  /** How many swings into a run it is: see `Flow`. For the harness. */
  get run(): number {
    return this.chain;
  }

  /** Carrying a swing on round with its body: see `Cut.spin`. For the harness. */
  get spinning(): boolean {
    return this.whirl !== 0;
  }

  /** What it is up to, state by state: for the harness and for debugging. */
  get intent(): string {
    return this.state;
  }

  /**
   * All the fight panel says about it: whether it has noticed you -- or only
   * heard something, and gone to look -- and whether it has anything left to
   * fight with. Never what it is about to do. That is on its arm, where
   * anybody's is.
   */
  get outlook(): "waiting" | "looking" | "fighting" | "beaten" {
    if (this.state === "waiting" || this.state === "return") return "waiting";
    if (this.state === "beaten") return "beaten";
    return this.heard ? "looking" : "fighting";
  }

  /**
   * The swing it is drawing back for or throwing, or null. For the harness:
   * nothing you are shown reads it.
   */
  get committed(): Swing | null {
    const s = this.state;
    return s === "windup" || s === "leap" || s === "strike" ? this.swing : null;
  }

  /** Run once per fixed step, before the arm reads its input. */
  think(self: Combatant, foe: Combatant, t: Tuning, dt: number): void {
    if (self.dead) {
      this.state = "beaten";
      this.idle();
      self.fighter.focus = null;
      return;
    }

    // On the floor. There is nothing to decide: the body gets itself up, and
    // whatever it was winding up when it went over is gone.
    if (self.fighter.down) {
      if (this.state !== "down") this.begin("down", 0);
      this.idle();
      self.fighter.focus = null;
      self.position(this._was);
      this.snag = 0;
      this.answerIn = -1;
      return;
    }
    if (this.state === "down") this.resume();

    self.position(this._self);
    // Where it stands before anything has happened is its post.
    if (this.trail.length === 0) {
      this.trail.push(this._self.clone());
      this.postYaw = self.fighter.yaw;
    }
    this.pace = self.fighter.walkSpeed(t);
    this.quick = self.fighter.quickReach(t) + this.pace * t.stepEase / 2;
    this.timer -= dt;
    this.clock += dt;
    this.keys.jump = false;
    this.keys.pivot = false;
    this.keys.dash = false;
    this.tauntRest = Math.max(0, this.tauntRest - dt);
    // Back on the floor from a hop of its own. Not for the first moment of it:
    // the ground probe goes on finding the floor for two steps after the feet
    // have left it.
    if (this.hopping) {
      this.hopClock += dt;
      if (this.hopClock > LIFT && self.fighter.grounded) this.hopping = false;
    }

    // An animal that cannot see you does not come for you.
    //
    // The rooms are walled off from each other, and without this the orc
    // would spend the fight walking into the far side of a wall because it
    // knew, through the stone, exactly where you were standing. One ray, the
    // same one either of them could cast, and it is also what makes a doorway
    // worth something: step into the light and the thing in the next room
    // starts moving. From here on `_foe` is where it believes you are.
    this.look(self, foe, dt);
    const toFoe = this._foe.clone().sub(this._self);
    const range = Math.hypot(toFoe.x, toFoe.z);

    // Once it has seen you it watches you -- not its own blade, which is what
    // the player's fighter watches. A head turned toward you is the first
    // thing that says it has noticed, from further off than any weapon tell;
    // out of sight, it watches where you were.
    self.fighter.focus = this.engaged ? this._gaze.copy(this._lastEyes) : null;

    if (!this.engaged) {
      // Holding its post, or on its way back to it. It does not track you,
      // and it keeps its weapon where a waiting animal keeps it.
      this.want = { yaw: 0.3, pitch: -0.12, reach: 0.55, roll: 0 };
      this.sinceNear = Infinity;
      this.checkSnag(dt);
      if (this.state === "free") this.getFree();
      else this.goHome(self);
      this.steerArm(self, t, dt);
      return;
    }
    if (this.state === "waiting" || this.state === "return") this.engage();
    this.mark(self);

    this.face(self, toFoe);
    this.stall = self.arm.state.tipSpeed < STALLED ? this.stall + dt : 0;

    // Disarmed: no weapon, no plan. It backs away rather than pretending, and
    // once it has lost you, it goes home.
    if (self.arm.disarmed) {
      if (this.lost >= GLIMPSE) {
        this.giveUp();
      } else {
        this.state = "beaten";
        this.hold(range < 3.0 && this.roomFor(self, -1, 0, 0.3) ? -1 : 0, 0);
      }
      this.steerArm(self, t, dt);
      return;
    }

    // Rocked back on its heels. Its feet are busy keeping it up, and whatever
    // it was doing -- a wind-up, a swing half thrown -- it is not doing now.
    // This is the only way to take a swing off something once it has
    // started, and it only works on something light enough to rock: nothing
    // you can swing moves the orc that far, which is what "committed to
    // everything it starts" means.
    if (self.fighter.reeling && this.state !== "reeling") {
      this.begin("reeling", self.fighter.reelLeft);
    }

    this.measure(self, foe, t);
    // Its own weapon knocked aside: whatever it was drawing back for or
    // throwing is gone -- the arm is not its own for the moment -- and it
    // starts nothing new until it is. The time its guard takes to come back
    // up behind a weak arm is your opening.
    this.knocked = self.arm.jarred > KNOCKED;
    if (this.knocked && (this.state === "windup" || this.state === "strike")) {
      this.winded = 0;
      this.begin("recover", 0);
    }

    // Badly hurt, it fights like it: see `Temper`.
    const temper = this.species.temper;
    this.wounded = temper !== undefined && self.health < temper.below * self.maxHealth;
    // Something has just cut it.
    const felt = this.hpWas - self.health;
    this.hpWas = self.health;
    if (felt >= FELT) this.feel(self);

    // How far round it has turned since last step, for a spin.
    const turned = wrapPi(self.fighter.yaw - this.yawWas);
    this.yawWas = self.fighter.yaw;
    if (this.whirl !== 0) this.spun += turned * this.whirl;
    // Your health for as long as it is not in the middle of a swing, so that
    // while it is, this is what you had as it went: see `carryOn`.
    if (this.state !== "strike") this.yoursBefore = foe.health;
    // Its guard: swaying, and now and then held somewhere else, taken there
    // at a guard's pace rather than a swing's.
    this.sway += (dt * Math.PI * 2) / (SWAY.time * Math.sqrt(this.species.build.scale));
    this.shift -= dt;
    const ease = Math.min(1, dt / SHIFT_TIME);
    this.held.yaw += (this.stance.yaw - this.held.yaw) * ease;
    this.held.lift += (this.stance.lift - this.held.lift) * ease;
    const close = this.strikeReach * this.species.range.close;
    const strike = this.strikeReach * this.species.range.strike;
    const far = this.strikeReach * this.species.range.far;
    // The band it goes round you in, and swings from the near edge of. See HOVER.
    const inner = (strike + far) / 2;
    const outer = far * HOVER;

    // Whether you have just got away from it, and how fast the gap is
    // closing -- its own feet, and yours, which it can see: what a leap is
    // decided and timed by.
    this.sinceNear = range <= far ? 0 : this.sinceNear + dt;
    this.leapRest = Math.max(0, this.leapRest - dt);
    if (range > 1e-6) {
      const mine = self.fighter.body.linvel();
      // Out of sight you are standing where you were.
      const yours = this.sighted ? foe.fighter.body.linvel() : ZERO;
      const ux = toFoe.x / range;
      const uz = toFoe.z / range;
      this.coming = -(yours.x * ux + yours.z * uz);
      this.closing = mine.x * ux + mine.z * uz + this.coming;
    }

    this.readYou(foe, dt);

    this.checkSnag(dt);
    this.crowd = range < close ? this.crowd + dt : 0;
    this.watch(self, foe, dt);

    // Out of sight for longer than a pillar hides you, and it goes to look.
    // Not out of a swing: one it has started it finishes, at where you were.
    if (this.lost >= GLIMPSE && LOOSE.has(this.state)) this.hunt();

    switch (this.state) {
      case "close": {
        // On its way to where the fight is. Once there it goes round you until
        // its patience runs out -- or, pressing, it has none, and swings the
        // moment it has stepped in to where its weapon works.
        this.guard();
        if (this.lashOut(self, range, close)) break;
        if (this.leapAt(self, range)) break;
        if (this.punish(range, close, inner, outer)) break;
        // Coming for you from well out of reach, and in no hurry, it may stop
        // and show you its weapon first -- decided once, as it sets off.
        if (this.patience > 0 && this.showOff && range > outer * TAUNT_FAR) {
          this.showOff = false;
          if (this.taunt(range, outer, false, 1)) break;
        }
        // Coming in to go round you, it answers your feet too. Pressing, it
        // has nothing to answer with but the swing it is already bringing.
        if (this.patience > 0 && range <= outer * 1.2 && this.answer(range, close, inner)) break;
        if (this.patience > 0 && range <= outer) {
          this.circle(this.patience);
          break;
        }
        if (this.patience <= 0 && this.canSwing(range, close, inner)) {
          this.hold(0, 0);
          this.commit(range, null, this.lungeFrom(self) ? "lunge" : "stand");
          break;
        }
        // Or it does not walk up to you at all: it closes the last of the gap
        // with a quick step, as its weapon goes back. See `dartIn`.
        if (this.patience <= 0 && this.darting && this.dartIn(self, range, close, inner)) break;
        // Nearly there, and pressing: it draws back on its way in, and swings
        // as it arrives. See `comeOn`.
        if (this.patience <= 0 && this.comingIn && this.onTheWay(self, range, inner)) {
          this.commit(range, null, "approach");
          break;
        }
        this.restance();
        const fwd = range > strike ? 1 : range < close ? -1 : 0;
        // From further off than it can reach, it comes in on a slant when there
        // is floor for one. The slant is checked every step, not once, so it
        // straightens up rather than walk into the side of a doorway.
        const side = fwd > 0 && this.weave !== 0 && range < WEAVE_IN
          && range > far * WEAVE_OUT && this.roomFor(self, 1, this.weave, this.pace * 0.5)
          ? this.weave : 0;
        this.detour(self, fwd, side);
        break;
      }

      case "circle":
        // Looking for its moment: short steps round you at the edge of its
        // reach, a pause between each, and in and out across that edge --
        // answering your feet, and now and then offering you a target.
        this.guard();
        // You are on the floor: now and then it stands off and shows you its
        // weapon rather than come and finish it.
        if (foe.fighter.down && this.taunt(range, outer, true)) break;
        if (this.lashOut(self, range, close)) break;
        if (this.leapAt(self, range)) break;
        if (this.punish(range, close, inner, outer)) break;
        if (range > outer * 1.4) {
          // You have backed out of its circle. It shows you what it thinks of
          // that, now and then -- or comes after you, and carries on waiting
          // once it has you again.
          if (this.taunt(range, outer)) break;
          this.patience = Math.max(this.timer, 0.01);
          this.begin("close", 0);
          this.hold(1, 0);
          break;
        }
        // Its moment -- but not in the middle of offering you a target: that
        // runs its course, in and back out, and a bait that ended in a swing
        // from inside your reach whenever its patience happened to run out
        // was not an offer at all.
        if (this.timer <= 0 && !this.baiting) {
          // It swings from here if its weapon works from here; otherwise it
          // steps in to where it does, and swings from there.
          this.patience = 0;
          this.hold(0, 0);
          if (this.canSwing(range, close, inner)) {
            this.commit(range, null, this.lungeFrom(self) ? "lunge" : "stand");
          } else {
            this.begin("close", 0);
          }
          break;
        }
        if (this.answer(range, close, inner)) break;
        this.restance();
        if (this.walk(dt)) this.nextStep(self, range, inner, outer);
        break;

      case "backoff":
        // Giving ground: a step or two back, usually on a slant, until it is
        // out past its own reach. Then it goes round.
        this.guard(0.1);
        if (this.punish(range, close, inner, outer)) break;
        // Off the floor, it is going where the hop sends it until it lands.
        if (this.walk(dt) && !this.hopping) {
          if (range >= outer || this.timer <= 0) this.circle(this.rollPatience());
          else this.retreat(self);
        }
        break;

      case "evade":
        // Out of the way of your blade: one quick step back and aside, or a
        // hop. It is not armour -- a cut that was already on it lands on
        // something moving away, and that is all the step buys.
        this.guard(0.1);
        if (this.walk(dt) && !this.hopping) this.circle(Math.random() * RIPOSTE);
        break;

      case "parry":
        // Its weapon across the line yours is coming on, meeting it. What
        // comes of that is the weapons' business (see `Impacts.clash`), and
        // your weapon knocked aside is an opening it takes.
        if (this.punish(range, close, inner, outer)) break;
        this.meet(self, foe, t);
        this.hold(0, 0);
        if (this.threatened) this.cameAt = this.clock;
        if (this.clock >= PARRY_HOLD[1]
          || (this.cameAt >= 0 && !this.threatened && this.clock - this.cameAt >= PARRY_HOLD[0])) {
          this.circle(Math.random() * RIPOSTE);
        }
        break;

      case "taunt":
        // Showing you its weapon, with you out of its reach. Come back in, and
        // it is done showing you.
        this.display();
        this.hold(0, 0);
        if (this.leapAt(self, range)) break;
        if (this.timer <= 0 || this.yourMove > 0 || (range < outer && !foe.fighter.down)) {
          this.patience = this.rollPatience();
          this.begin("close", 0);
        }
        break;

      case "windup": {
        // Drawing back: it stands and takes the weapon to where the swing
        // starts, and goes the moment it is there.
        //
        // Every wind-up used to be held for a declared length -- three
        // quarters of a second of glowing axe -- and waited out even once the
        // arm was there, because a telegraph whose length depended on how the
        // last swing ended was one a player could not learn. There is nothing
        // to learn now but the arm, and an arm goes when it is ready: how long
        // that takes is how far the weapon had to come back and how much of it
        // there is to move. The longest only bounds a weapon caught on
        // something, which never gets there at all.
        const s = this.swing!;
        if (!this.gauged) this.gauge(self, s);
        this.want = {
          yaw: this.aimFrom.yaw + s.from.yaw + this.further.yaw,
          pitch: this.aimFrom.pitch + s.from.pitch + this.further.pitch,
          reach: s.from.reach + this.further.reach,
          roll: s.roll,
        };
        if (s.leap) {
          this.charge(self, foe, range, t);
          break;
        }
        switch (s.move) {
          case "approach":
            this.comeOn(self, range, strike, inner, t);
            break;
          case "lunge":
            this.lungeIn(self, range, strike, inner, t);
            break;
          case "dart":
            this.darted(self, range, strike, inner, t);
            break;
          case "stand":
            this.hold(0, 0);
            if (this.done(self, WINDUP, THERE.windup)) this.begin("strike", 0);
            break;
        }
        break;
      }

      case "leap": {
        // Off the floor with the weapon up and following you, and down it
        // comes at the top of the jump -- or when the feet find the floor
        // again, if the top came and went with the weapon still going up.
        const s = this.swing!;
        this.want = {
          yaw: this.aimFrom.yaw + s.from.yaw,
          pitch: this.aimFrom.pitch + s.from.pitch,
          reach: s.from.reach,
          roll: s.roll,
        };
        this.hold(1, 0);
        const landed = this.clock > LIFT && self.fighter.grounded;
        const top = this.clock > LIFT && self.fighter.body.linvel().y <= 0;
        if ((top && this.raised(self, t)) || landed) this.begin("strike", 0);
        break;
      }

      case "strike": {
        const s = this.swing!;
        if (this.whirl !== 0) {
          this.carryRound(self, s, range, t);
          break;
        }
        // Aim THROUGH the target, not at it. Sweeping to a point short of the
        // foe decelerates into the hit and lands a shove; the whole damage
        // model is built on speed at contact.
        this.want = {
          yaw: this.aimTo.yaw + s.to.yaw,
          pitch: this.aimTo.pitch + s.to.pitch,
          reach: s.to.reach,
          roll: s.roll,
        };
        // Stepping in closes to where the weapon works, not to contact. A
        // swing that walks all the way in ends up sweeping its arc past the
        // target and connecting with whatever is left -- which for an axe
        // meant landing every single blow on a shin.
        //
        // A swing drawn back on the way in, or from giving ground, comes in
        // behind itself whatever its shape: that is what it was for.
        const stepIn = s.cut.step > 0 || s.move === "approach" || s.move === "lunge"
          || s.move === "dart";
        this.hold(
          stepIn && range > strike ? 1
            : s.cut.step < 0 && this.roomFor(self, -1, 0, 0.3) ? -1 : 0,
          0);
        // Over when the weapon is through -- or when it has been stopped, on
        // you or on anything else, because then the rest of it is not coming.
        // Through nothing at all, it may not stop: see `spinOn`. And another
        // may follow on from it: see `carryOn`.
        if (this.stopped(STRIKE) || this.done(self, STRIKE, THERE.strike)) {
          const landed = foe.health < this.yoursBefore;
          const through = !landed && this.arrived(self, THERE.strike);
          if (through && this.spinOn(range, far)) break;
          if (landed || !this.carryOn(foe, range, close, through)) this.recover(self);
        }
        break;
      }

      case "recover":
        // Open, for as long as its guard takes to come back up: hardly any
        // time behind a sword, long enough to make an axe pay for itself.
        //
        // And then a moment more at the end of a run, or out of a spin: see
        // WINDED. Having let go of a swing because it hurt, it gives ground.
        this.guard();
        this.hold((range < close || this.flinched) && this.roomFor(self, -1, 0, 0.3) ? -1 : 0, 0);
        if (this.upAt < 0 && (this.stopped(RECOVER) || this.done(self, RECOVER, THERE.recover))) {
          this.upAt = this.clock;
        }
        if (this.upAt >= 0 && this.clock - this.upAt >= this.winded) {
          this.flinched = false;
          this.afterSwing(self);
        }
        break;

      case "reeling":
        // Guard up, feet under it. It carries on only once they are.
        this.guard();
        this.hold(0, 0);
        if (this.timer <= 0 && !self.fighter.reeling) this.engage();
        break;

      case "free":
        this.getFree();
        break;

      case "hunt":
        // Gone to look for you. See `search`.
        this.guard();
        if (this.sighted) {
          this.engage();
          this.hold(0, 0);
        } else if (this.lost >= HUNT) {
          this.giveUp();
        } else {
          this.search(self);
        }
        break;

      case "beaten":
      case "waiting":
      case "return":
      case "down":
        this.idle();
        break;
    }

    // Off the floor in a leap it is committed to the line it jumped on, as
    // `measure` holds its aim at where you were when it jumped. Your air
    // control and your turn would let it bend the leap round after you, and
    // with the aim following you down, stepping aside -- the one answer a
    // leap has -- still took the axe twelve times in sixteen.
    if (this.swing?.leap && !self.fighter.grounded
      && (this.state === "leap" || this.state === "strike")) {
      this.keys.turnLeft = false;
      this.keys.turnRight = false;
      this.hold(1, 0);
    }

    this.steerArm(self, t, dt);
  }

  /**
   * Notice when the feet are turning and the body is not going anywhere.
   *
   * Measured rather than inferred: it compares where it wanted to be with
   * where it got, which needs nothing the creature does not already have. A
   * weapon planted in stone is a real state the player gets into too, and the
   * way out of it is the same for both of them.
   *
   * Only a step that was taken can have failed. Footwork stands still between
   * steps, and a pause must not wipe out what a run of failed steps has added
   * up to -- that is how a weapon snagged while it circles is noticed at all.
   */
  private checkSnag(dt: number): void {
    const moved = this._self.distanceTo(this._was);
    this._was.copy(this._self);
    if (this.state === "free" || this.state === "beaten"
      || this.state === "waiting" || this.state === "reeling") { this.snag = 0; return; }

    const k = this.keys;
    const trying = k.forward || k.back || k.left || k.right;
    const expected = this.pace * dt;
    if (trying) this.snag = moved < expected * 0.3 ? this.snag + dt : 0;

    if (this.snag > SNAG_TIME) {
      this.snag = 0;
      this.begin("free", 0.6);
    }
  }

  /**
   * Make up a swing and start drawing back for it.
   *
   * First the shapes that are any use from here -- a spear's point is no use
   * inside it, and an axe wants room -- then a part of you those can reach,
   * weighted by what this creature goes for, then one of the shapes that
   * reaches it, with every number in it drawn afresh. No two swings are the
   * same, and there is no list of them to learn.
   *
   * Where it is aimed is solved from the arm while it draws back, and held once
   * it goes (see `measure`). A leap brings down its own shape, whatever the
   * distance says.
   */
  private commit(range: number, leap: Leap | null = null, move: Approach = "stand"): void {
    this.swing = this.makeUp(range / this.strikeReach, leap, move);
    this.chain = 1;
    this.answerIn = -1;
    if (move === "approach") this.tally.approaches++;
    if (move === "lunge") this.tally.lunges++;
    if (move === "dart") this.tally.darts++;
    this.begin("windup", 0);
  }

  /**
   * A swing it might throw from this far off -- a fraction of its strike
   * reach -- made up exactly as a real one is, and never thrown. For the
   * harness: what a creature reaches for is a claim about thousands of swings,
   * and half a minute of a fight throws a couple of dozen.
   */
  imagine(at: number): Swing {
    return this.makeUp(at, null);
  }

  /**
   * The swing itself: see `commit`. `at` is the distance in its own reaches.
   * `among` is the shapes it may be, when something other than the distance
   * has already decided that: the run it is part of (see `carryOn`).
   */
  private makeUp(
    at: number, leap: Leap | null, move: Approach = "stand", among?: readonly Cut[],
  ): Swing {
    const all = this.species.cuts;
    let cuts: Cut[];
    if (leap !== null) {
      cuts = all.filter((c) => c.name === leap.cut);
    } else if (among !== undefined) {
      cuts = [...among];
    } else {
      cuts = all.filter((c) => fits(c, at));
      if (cuts.length === 0) cuts = [...all];
      const pinned = all.filter((c) => c.name === this.cutOverride);
      if (pinned.length > 0) cuts = pinned;
    }

    // A part of you as often as this creature goes for it, then a shape that
    // reaches it as often as this creature reaches for that shape.
    const aims = (Object.keys(this.species.aim) as Aim[])
      .filter((a) => cuts.some((c) => c.aims.includes(a)));
    const aim = this.aimOverride !== null && aims.includes(this.aimOverride)
      ? this.aimOverride : weighted(aims, (a) => this.species.aim[a]);
    const cut = weighted(cuts.filter((c) => c.aims.includes(aim)), (c) => c.favour ?? 1);

    return {
      cut,
      aim,
      from: { yaw: draw(cut.from.yaw), pitch: draw(cut.from.pitch), reach: draw(cut.from.reach) },
      to: { yaw: draw(cut.to.yaw), pitch: draw(cut.to.pitch), reach: draw(cut.to.reach) },
      roll: draw(cut.roll),
      leap: leap !== null,
      move,
    };
  }

  /**
   * You have got out of its reach, and it comes after you through the air.
   *
   * Only if you were in its reach a moment ago, only from where a run and a
   * jump will carry it to you, and only down a clear line: a leap asks the
   * stone for the whole of its run first, knee high and a body wide, and
   * something between you is a reason to walk round it instead. See `Leap`.
   */
  private leapAt(self: Combatant, range: number): boolean {
    const leap = this.species.leap;
    if (leap === undefined || this.leapRest > 0 || this.sinceNear > leap.memory) return false;
    if (!this.squared || !this.sighted || !self.fighter.grounded || this.knocked) return false;
    if (this.cutOverride !== null && this.cutOverride !== leap.cut) return false;
    const f = range / this.strikeReach;
    if (f < leap.at.min || f > leap.at.max) return false;
    if (!this.roomFor(self, 1, 0, range - this.strikeReach)) return false;
    this.leapRest = leap.rest;
    this.commit(range, leap);
    return true;
  }

  /**
   * The run-up: at you with the weapon going up, and off the floor once it is
   * up and you are one jump away -- the jump whose top is where the weapon has
   * to start down to meet you. Already that close with the weapon not yet up,
   * it stands and gets it up.
   *
   * The weapon has to be up before the feet leave the floor. Jumping with it
   * half raised, the axe went on rising for half a second of the leap and came
   * down after the orc had landed, a foot inside where it cuts. All of it is
   * the same jump you have, worked out from the same numbers -- how high its
   * legs put it for its size, under the same gravity. Come back into its reach
   * and it swings from its feet instead; stay out of it long enough and it
   * gives the chase up.
   */
  private charge(self: Combatant, foe: Combatant, range: number, t: Tuning): void {
    // Timed on the run it is making, not on how fast it happens to be going
    // this step: a leap planned from a standing start left the floor half a
    // metre late.
    const run = Math.max(0, this.pace + this.coming);
    const chop = this.chopAt(run);
    const up = this.raised(self, t);
    if (range <= chop) {
      // Back in its reach before it could leave the floor: it swings from
      // where it stands, and stops being a leap -- otherwise, standing, the gap
      // stopped closing, a chop needed less of a lead, and it ran on again.
      this.swing = { ...this.swing!, leap: false };
      this.hold(0, 0);
      if (up) this.begin("strike", 0);
      return;
    }
    const apex = Math.sqrt(2 * self.fighter.jumpHeight(t) / Math.abs(t.gravity));
    const takeoff = this.strikeReach * LEAP_LAND + run * (CHOP + apex);
    // Still getting the weapon up, it stops where it will jump from -- short
    // of it by as far as its feet carry it once they stop, or it coasts in
    // past it, jumps from too close, and the axe comes down behind you.
    const coast = range > 1e-6 ? self.fighter.coast(
      (this._foe.x - this._self.x) / range, (this._foe.z - this._self.z) / range) : 0;
    if (!up && range - coast <= takeoff && range > takeoff) {
      this.hold(0, 0);
      return;
    }
    if (range <= takeoff) {
      if (!up || !self.fighter.grounded) {
        this.hold(0, 0);
        return;
      }
      this.keys.jump = true;
      this.hold(1, 0);
      this.target(foe, this.swing!.aim, this._leapMark);
      this.begin("leap", 0);
      return;
    }
    if (this.clock > CHASE) {
      this.begin("close", 0);
      return;
    }
    this.hold(1, 0);
  }

  /**
   * Is the weapon up, for a body that is moving?
   *
   * A running body drags its hand behind it: the drive's damping works against
   * the hand's speed through the world, not past the shoulder, so the hand
   * trails the pose it was sent to by that speed times the drive's damping
   * over its stiffness -- a fifth of a metre at an orc's run, twice what counts
   * as there. Waiting for less, it never counted its axe as up until it had
   * stopped running.
   */
  private raised(self: Combatant, t: Tuning): boolean {
    const v = self.fighter.body.linvel();
    return this.done(self, WINDUP, THERE.windup, Math.hypot(v.x, v.z) * t.armKd / t.armKp);
  }

  /**
   * How far off you must be for a chop begun now to meet you: its reach, and
   * the ground the gap will close by while the weapon comes down.
   */
  private chopAt(closing = this.closing): number {
    return this.strikeReach * LAND + Math.max(0, closing) * CHOP;
  }

  /**
   * Has its weapon been stopped short in this part of a swing? It knows the
   * way you know your own arm has stopped. See `STALLED`.
   */
  private stopped([least]: Span): boolean {
    return this.clock >= least && this.stall >= STALL_TIME;
  }

  /**
   * Is this part of a swing over: the weapon where it was sent, or the longest
   * it may take gone by? `give` is metres more the hand may trail by: see
   * `charge`.
   */
  private done(self: Combatant, [least, most]: Span, slack: number, give = 0): boolean {
    if (this.clock >= most) return true;
    return this.clock >= least && this.arrived(self, slack, give);
  }

  /**
   * Is its weapon where it sent it: the arm's intent all the way onto the pose
   * it asked for, and the hand within `slack` metres -- at human size -- of
   * where that pose puts it?
   *
   * Nothing it could not know. It is what you know about your own arm by
   * looking at it, and it is all a swing waits on.
   */
  private arrived(self: Combatant, slack: number, give = 0): boolean {
    return this.onPose
      && self.arm.state.trackingError < slack * this.species.build.scale + give;
  }

  /** Where its weapon works, squared up to you, and able to see what it swings at. */
  private canSwing(range: number, close: number, near: number): boolean {
    return range <= near && range >= close && this.squared && this.sighted && !this.knocked;
  }

  /**
   * You are inside its guard. It gives ground while it can -- but backed
   * against stone, or pressed for long enough, it swings at you from where it
   * stands with whatever works at that distance.
   *
   * Without this, walking into an opponent and staying there all but stopped
   * it fighting: it would only ever step back, and every swing wanted room it
   * never got. For a goblin it is the shaft, which was otherwise never thrown
   * at all.
   */
  private lashOut(self: Combatant, range: number, close: number): boolean {
    if (range >= close || !this.squared || !this.sighted || this.knocked) return false;
    const roomBehind = this.roomFor(self, -1, 0, this.pace * STRIDE[0]);
    if (this.crowd < CROWD && roomBehind) return false;
    this.hold(0, 0);
    this.commit(range);
    return true;
  }

  /**
   * Once a swing is over and its guard is back: press, give ground, or go
   * round -- in proportions that are most of what makes one creature feel
   * unlike another. The orc mostly presses. The goblin mostly gets out of there.
   */
  private afterSwing(self: Combatant): void {
    const fw = this.mood.footwork;
    // Which way it goes from here is decided afresh after every exchange --
    // otherwise something that circles only briefly between swings, like the
    // orc, went round you the same way all fight.
    this.side = Math.random() < OFF_HAND ? 1 : -1;
    // Out of a run of swings, the first step back may be a hop -- or out of
    // any swing, a quick step. In off a quick step, it goes straight back out
    // as readily as it quick-steps at all: in, swing, and out.
    const run = this.chain > 1;
    this.chain = 0;
    const retreat = this.swing?.move === "dart" ? Math.max(fw.retreat, fw.quick) : fw.retreat;
    const roll = Math.random();
    if (roll < retreat) {
      this.begin("backoff", RETREAT);
      this.retreat(self, run && Math.random() < fw.hop, Math.random() < fw.quick);
    } else if (roll < retreat + PRESS * this.mood.aggression) {
      this.patience = 0;
      this.begin("close", 0);
    } else {
      this.circle(this.rollPatience() * 0.5);
    }
  }

  /**
   * However a swing began -- out of the end of another, out of a parry, from
   * wherever its guard happened to be -- its weapon goes back for it, and far
   * enough to see: see DRAW. Where the arm is already nearly where the swing
   * starts, it goes back further: round further, the way the swing is not
   * going, for a swing that goes across; for a thrust, drawn all the way in,
   * or if it is already, raised.
   */
  private gauge(self: Combatant, s: Swing): void {
    this.gauged = true;
    const f = this.further;
    f.yaw = f.pitch = f.reach = 0;
    const a = self.arm.aim;
    const angle = Math.hypot(
      this.aimFrom.yaw + s.from.yaw - a.yaw, this.aimFrom.pitch + s.from.pitch - a.pitch);
    const reach = Math.abs(self.arm.reachAt(s.from.reach) - a.reach);
    if (angle >= DRAW.angle || reach >= DRAW.reach) return;
    const short = DRAW.angle - angle;
    const across = s.from.yaw - s.to.yaw;
    const [least, most] = self.arm.reachLimits;
    if (Math.abs(across) > 0.3) f.yaw = Math.sign(across) * short;
    else if (s.from.reach * (most - least) >= 2 * DRAW.reach) f.reach = -s.from.reach;
    else f.pitch = short;
  }

  /**
   * A swing has gone through nothing, round: does it stop? A swing that goes
   * round, and a creature near enough to you for going on round to be worth
   * it, and it may not -- the weapon held out where the swing ended, the
   * whole body carried on round after it on its heel, and the same edge
   * coming round at you again. See `Cut.spin`.
   */
  private spinOn(range: number, far: number): boolean {
    const s = this.swing!;
    const spin = s.cut.spin;
    if (spin === undefined || s.leap || range > far * SPIN_FAR || !this.sighted || this.knocked) {
      return false;
    }
    if (Math.random() >= spin.chance) return false;
    this.whirl = Math.sign(s.to.yaw - s.from.yaw);
    this.whirlRoll = draw(spin.roll);
    this.spun = 0;
    // The swing has just gone past you.
    this.bladeWas = 1;
    this.tally.spins++;
    this.begin("strike", 0);
    return true;
  }

  /**
   * The swing carrying on round: the weapon out at full stretch where the
   * swing ended, at the height of your middle, the edge rolled over to lead
   * the way it is now going (see `Cut.spin`), and the body going round under
   * it on its heel. Whatever is in the way on the way round is met at the
   * speed a body turning carries it. Its back is to you for the middle of it:
   * that is the moment to go in.
   *
   * Its feet keep the part of the weapon that works on the circle you are
   * standing on -- in if the weapon comes round short of you, back if you
   * are inside it, where all that would reach you is the haft. And it is over
   * once the weapon has come round past you, not once the body has: a heavy
   * head trails a body turning that fast by the better part of a quarter
   * turn. Or once the weapon is stopped on something.
   */
  private carryRound(self: Combatant, s: Swing, range: number, t: Tuning): void {
    const yaw = this.aimTo.yaw + s.to.yaw;
    // The pitch that puts your middle's height under the weapon with the arm
    // held out to the side as it is: the same pitch that crosses your chest
    // with the arm in front of it goes over your head with it out there.
    this.want = {
      yaw,
      pitch: self.arm.solvePitchForHeight(this._mark.y, yaw, 1, this.whirlRoll, t),
      reach: 1,
      roll: this.whirlRoll,
    };
    this.pivot(this.whirl);
    const p = this._meet.copy(self.arm.handPosition).lerp(self.arm.tipPosition, WORKS);
    const dx = p.x - this._self.x;
    const dz = p.z - this._self.z;
    const round = Math.hypot(dx, dz);
    this.toward(self, range > round + RING[1] ? 1 : range < round - RING[0] ? -1 : 0);
    // Where the weapon is, from you, the way it is going round: behind you
    // until it is past.
    const b = wrapPi(Math.atan2(-dx, -dz)
      - Math.atan2(-(this._foe.x - this._self.x), -(this._foe.z - this._self.z))) * this.whirl;
    const past = this.spun > Math.PI && this.bladeWas < 0 && b >= 0;
    this.bladeWas = b;
    if (past || this.spun >= SPIN_MOST || this.stopped(STRIKE) || this.clock >= SPIN_TIME) {
      this.recover(self);
    }
  }

  /**
   * A swing is over. Does another follow on from it?
   *
   * Through nothing at all, now and then it throws whichever of its shapes
   * starts where this one ended (see `Flow`).
   *
   * Stopped on something -- your guard, your weapon, the stone -- the weapon
   * has nothing left to carry on with, and what can follow is the same
   * again: a shape drawn back the way this one came, hacking at the same
   * place.
   *
   * Never off a swing that drew blood: a run is how it gets past you, not
   * how it finishes you, and a player who stands and takes a cut should be
   * no worse off than before any of this. Never off a leap, never past the
   * most it throws in one run, and never at something it cannot see or that
   * is already on the floor.
   */
  private carryOn(
    foe: Combatant, range: number, close: number, through: boolean,
  ): boolean {
    const s = this.swing!;
    const flow = this.mood.flow;
    if (s.leap || this.chain >= flow.chain || !this.sighted || this.knocked) return false;
    if (foe.dead || foe.fighter.down || range < close) return false;
    const at = range / this.strikeReach;
    if (Math.random() >= flow.combo) return false;
    // Where the next has to start: where this one ended, or where it began.
    const start = through ? s.to.yaw : s.from.yaw;
    const next = this.species.cuts.filter((c) => Math.abs(mid(c.from.yaw) - start) < LINK
      && fits(c, at) && (this.cutOverride === null || c.name === this.cutOverride));
    if (next.length === 0) return false;
    this.swing = this.makeUp(at, null, "stand", next);
    this.chain++;
    this.tally.combos++;
    this.begin("windup", 0);
    return true;
  }

  /**
   * The swing is over, and its guard comes back up -- to where the swing
   * left the weapon, most of the way, rather than all the way back to the
   * middle: a forehand ends on its left and it keeps its guard over on its
   * left, a backhand on its right. Never below the chest, or far across it
   * (see STANCE_YAW). The next swing is drawn back from there, so where one
   * ends is where the next one is quickest from. It shifts its guard again
   * in its own time.
   */
  private recover(self: Combatant): void {
    const aim = self.arm.aim;
    this.stance.yaw = within(
      (aim.yaw - this.level.yaw) * HELD + GUARD_YAW * (1 - HELD), STANCE_YAW);
    this.stance.lift = within(
      (aim.pitch - this.level.pitch) * HELD + GUARD_LIFT * (1 - HELD), STANCE_LIFT);
    this.held.yaw = this.stance.yaw;
    this.held.lift = this.stance.lift;
    this.shift = draw(STANCE_HOLD);
    this.winded = WINDED * Math.max(0, this.chain - 1) + (this.whirl !== 0 ? DIZZY : 0);
    this.whirl = 0;
    this.begin("recover", 0);
  }

  /**
   * Drawing back on its way in: it keeps coming with the weapon going back,
   * and the swing goes once the weapon is back and you are where it swings
   * from. What you see is a weapon going back on something still walking at
   * you -- and if you get away, it gives the swing up, as a leap does.
   */
  private comeOn(self: Combatant, range: number, strike: number, inner: number, t: Tuning): void {
    this.detour(self, range > strike ? 1 : 0, 0);
    if (this.clock >= WINDUP[0] && range <= inner && this.raised(self, t)) {
      this.begin("strike", 0);
    } else if (this.clock > CARRY) {
      this.begin("close", 0);
    }
  }

  /**
   * Drawing back from giving ground: a step back as the weapon goes back,
   * then in again behind it, and the swing goes as it gets to where its
   * weapon works. Follow it as it gives ground and you walk onto it.
   */
  private lungeIn(self: Combatant, range: number, strike: number, inner: number, t: Tuning): void {
    if (this.clock < LUNGE_BACK) {
      this.hold(this.roomFor(self, -1, 0, this.pace * 0.1) ? -1 : 0, 0);
      return;
    }
    this.detour(self, range > strike ? 1 : 0, 0);
    if (range <= inner && this.raised(self, t)) {
      this.begin("strike", 0);
    } else if (this.clock > LUNGE_BACK + CARRY) {
      this.begin("close", 0);
    }
  }

  /**
   * Its moment come, and you not quite where its weapon works: a quick step
   * in with the weapon going back -- straight at you from further off, in on
   * a slant round your side from nearer -- if either lands it where it can
   * swing from, and there is floor for it. What you see is a weapon going
   * back on something that was not coming, and then is.
   */
  private dartIn(self: Combatant, range: number, close: number, inner: number): boolean {
    if (!this.squared || !this.sighted || this.knocked || !self.fighter.quickReady) return false;
    const d = this.quick;
    const lands = (r: number) => r >= close && r <= inner;
    let side = 0;
    let at = range - d;
    if (!lands(at) || !this.roomFor(self, 1, 0, d)) {
      // As much of it round you as in.
      const k = d * Math.SQRT1_2;
      at = Math.hypot(range - k, k);
      if (!lands(at)) return false;
      side = [this.side, -this.side].find((way) => this.roomFor(self, 1, way, d)) ?? 0;
      if (side === 0) return false;
      this.side = side;
    }
    this.commit(at, null, "dart");
    this.quickStep(1, side, 0);
    return true;
  }

  /**
   * Drawing back off a quick step in: the feet go where the step throws them,
   * the weapon going back meanwhile, and once they are down it comes on as if
   * it had walked in -- squared up to you, since a step in on a slant lands
   * it turned off you.
   */
  private darted(self: Combatant, range: number, strike: number, inner: number, t: Tuning): void {
    if (self.fighter.quickStepping) {
      this.hold(0, 0);
      return;
    }
    if (!this.squared) {
      this.hold(0, 0);
      if (this.clock > CARRY) this.begin("close", 0);
      return;
    }
    this.comeOn(self, range, strike, inner, t);
  }

  /**
   * A quick step that way, on the keys you would use: the feet that way, and
   * the double tap. See `Keys.dash`.
   */
  private quickStep(fwd: number, side: number, settle: number): void {
    this.step = { fwd, side, time: QUICK_TIME, settle };
    this.hold(fwd, side);
    this.keys.dash = true;
    this.tally.quickSteps++;
  }

  /**
   * Step toward you (1) or away from you (-1), whichever way it happens to be
   * facing: the keys that go nearest that way from where it is turned. For a
   * body going round.
   */
  private toward(self: Combatant, go: number): void {
    if (go === 0) {
      this.hold(0, 0);
      return;
    }
    const rel = wrapPi(
      Math.atan2(-(this._foe.x - this._self.x), -(this._foe.z - this._self.z)) - self.fighter.yaw);
    const c = Math.cos(rel);
    const s = Math.sin(rel);
    // Off to its left is a positive bearing, and a step to its left is -1.
    this.hold(
      (c > STEER ? 1 : c < -STEER ? -1 : 0) * go,
      (s > STEER ? -1 : s < -STEER ? 1 : 0) * go);
  }

  /** Turn on its heel, on the same keys you would: Shift, and a turn. */
  private pivot(turn: number): void {
    this.keys.turnLeft = turn > 0;
    this.keys.turnRight = turn < 0;
    this.keys.pivot = true;
  }

  /**
   * Nearly where its weapon works, walking in, and able to swing at you:
   * near enough to start drawing back now and arrive as the weapon does.
   */
  private onTheWay(self: Combatant, range: number, inner: number): boolean {
    if (range <= inner || range > inner + this.pace * APPROACH) return false;
    if (!this.squared || !this.sighted || this.knocked) return false;
    return this.roomFor(self, 1, 0, range - inner);
  }

  /** Will the swing it is about to throw from where it stands be thrown from giving ground? */
  private lungeFrom(self: Combatant): boolean {
    return Math.random() < this.mood.footwork.lunge
      && this.roomFor(self, -1, 0, this.pace * LUNGE_BACK * 1.5);
  }

  /**
   * Something has just cut it. Drawing back, it may let go of the swing --
   * pain, not balance, and the orc does not (see `Footwork.flinch`). Going
   * round you, it may give ground, as readily as it does after a swing of
   * its own.
   */
  private feel(self: Combatant): void {
    const fw = this.mood.footwork;
    const s = this.swing;
    if (this.state === "windup" && s !== null && !s.leap && Math.random() < fw.flinch) {
      this.tally.flinches++;
      this.flinched = true;
      this.winded = 0;
      this.begin("recover", 0);
      return;
    }
    if ((this.state === "close" || this.state === "circle" || this.state === "taunt")
      && Math.random() < fw.retreat && this.roomFor(self, -1, 0, this.pace * STRIDE[0])) {
      this.stand();
      this.begin("backoff", RETREAT);
      this.retreat(self);
    }
  }

  /** Come for you, and look for an opening once there. */
  private engage(): void {
    this.heard = false;
    this.patience = this.rollPatience();
    this.side = Math.random() < OFF_HAND ? 1 : -1;
    this.weave = Math.random() < 0.65 ? this.side : 0;
    this.stand();
    this.begin("close", 0);
  }

  /** Start going round you, and give it this long before it commits. */
  private circle(patience: number): void {
    this.stand();
    this.begin("circle", patience);
  }

  /**
   * What it knows of where you are: what it can see of you or, failing that,
   * the last it saw. Leaves `_foe` at whichever that is.
   */
  private look(self: Combatant, foe: Combatant, dt: number): void {
    foe.position(this._foe);
    const near = Math.hypot(this._foe.x - this._self.x, this._foe.z - this._self.z) < NOTICE;
    this.sighted = (this.engaged || near) && self.sees(foe);
    if (this.sighted) {
      this.engaged = true;
      this.heard = false;
      this.lost = 0;
      this._lastSeen.copy(this._foe);
      const v = foe.fighter.body.linvel();
      this._heading.set(v.x, 0, v.z);
      this.chest(foe, this._lastChest);
      foe.fighter.eyeWorld(this._lastEyes);
    } else {
      this.lost += dt;
      this._foe.copy(this._lastSeen);
    }
  }

  /** Back to it after something that took it out of its footwork. */
  private resume(): void {
    if (this.engaged) this.engage();
    else this.begin("return", 0);
  }

  /**
   * Caught on something. Pull the hand in and low and give ground -- which is
   * exactly what a player does with a blade planted in a wall, and works for
   * the same reason: a folded arm has leverage a straight one does not.
   */
  private getFree(): void {
    this.want = {
      yaw: this.level.yaw + 0.2, pitch: this.level.pitch - 0.9, reach: 0, roll: 0,
    };
    this.hold(-1, 0);
    if (this.timer <= 0) this.resume();
  }

  /**
   * Go and look for you: given twice as long as walking there would take, and
   * a second over, to go round what is in the way -- and no longer, or it
   * would go on trying for somewhere it cannot get to, like the top of the
   * ledge.
   */
  private hunt(): void {
    this.stand();
    const d = Math.hypot(this._lastSeen.x - this._self.x, this._lastSeen.z - this._self.z);
    this.begin("hunt", 1 + (2 * d) / this.pace);
    this.leg = "go";
  }

  /** On to the next part of looking for you, with this long for it. */
  private onLeg(leg: Leg, seconds: number): void {
    this.leg = leg;
    this.clock = 0;
    this.timer = seconds;
  }

  /**
   * Looking for you: to where it last saw you, then on a little the way you
   * were going, then a look round from there. It sees nothing of you it could
   * not -- the same ray it always casts decides when it has found you -- and
   * looking round does not help it see: turning is what it looks like.
   */
  private search(self: Combatant): void {
    const scale = this.species.build.scale;
    switch (this.leg) {
      case "go": {
        if (this.timer > 0 && this.walkTo(self, this._lastSeen)) return;
        // There, or as near as it is getting, and you are not.
        this.hold(0, 0);
        const speed = Math.hypot(this._heading.x, this._heading.z);
        this.sweep = Math.random() < 0.5 ? 1 : -1;
        if (speed < MOVING) {
          this.lookYaw = self.fighter.yaw;
          this.onLeg("look", draw(SEARCH));
          return;
        }
        // Which way were you going? On that way, as far as there is floor.
        const ux = this._heading.x / speed;
        const uz = this._heading.z / speed;
        this.lookYaw = Math.atan2(-ux, -uz);
        const body = self.fighter.build.hull.radius;
        const on = self.fighter.clearAlong(ux, uz, FOLLOW * scale + body, body) - body;
        this._goal.set(this._self.x + ux * on, this._self.y, this._self.z + uz * on);
        if (on > ARRIVE * scale) this.onLeg("follow", FOLLOW_TIME);
        else this.onLeg("look", draw(SEARCH));
        return;
      }
      case "follow":
        this.gazeAt(self, this.lookYaw);
        if (this.timer > 0 && this.walkTo(self, this._goal)) return;
        this.onLeg("look", draw(SEARCH));
        return;
      case "look": {
        // Its head goes round a little ahead of its chest.
        const round = (lead: number) => this.lookYaw
          + this.sweep * SWEEP * Math.sin((2 * Math.PI * (this.clock + lead)) / SWEEP_TIME);
        this.hold(0, 0);
        this.turnTo(self, round(0));
        this.gazeAt(self, round(0.25));
        if (this.timer <= 0) this.giveUp();
        return;
      }
    }
  }

  /** Look along a heading, from its own eyes. */
  private gazeAt(self: Combatant, yaw: number): void {
    self.fighter.eyeWorld(this._gaze);
    this._gaze.x -= Math.sin(yaw) * 4;
    this._gaze.z -= Math.cos(yaw) * 4;
  }

  /**
   * It heard something, at `at` -- the pen's gate going up. If it is not
   * already after you, it goes to look, as it would where it last saw you:
   * there, on a little the way `on` points if there is floor that way, and a
   * look round from there. It learns nothing of you by it. The same ray it
   * always casts decides whether it finds you, from wherever looking takes
   * it -- and once it has heard something it is after it, so that ray is not
   * held to the distance at which it would notice you -- and if it does not
   * find you, it gives up and goes home the way it came.
   */
  hear(at: THREE.Vector3, on: THREE.Vector3): void {
    if (this.engaged || (this.state !== "waiting" && this.state !== "return")) return;
    // Not at its post yet: it would have nowhere to go home to.
    if (this.trail.length === 0) return;
    this.engaged = true;
    this.heard = true;
    this.lost = GLIMPSE;
    this._lastSeen.copy(at);
    this._lastChest.copy(at);
    this._lastEyes.copy(at);
    // As if whatever it was had gone on that way at a walk.
    const len = Math.hypot(on.x, on.z);
    if (len > 1e-6) this._heading.set(on.x / len, 0, on.z / len).multiplyScalar(2 * MOVING);
    else this._heading.set(0, 0, 0);
    this.hunt();
  }

  /** It has lost you, and looked, and it has had enough. */
  private giveUp(): void {
    this.engaged = false;
    this.heard = false;
    this.stand();
    this.idle();
    this.begin("return", 0);
  }

  /**
   * Back to its post the way it came, and turn to face the way it stood
   * there. Once it faces that way it is waiting again, as if nothing had
   * happened.
   *
   * The way it came, not the straight line: that goes through a wall as often
   * as not, and a body that only looks where it puts its feet can find its
   * way round a pillar but not round a wall to the door in it.
   */
  private goHome(self: Combatant): void {
    if (this.state === "waiting") {
      this.idle();
      return;
    }
    if (this.state !== "return") this.begin("return", 0);
    const trail = this.trail;
    // Straight to any mark nearer home it can walk to from here.
    while (trail.length > 1 && this.reaches(self, trail[trail.length - 2])) trail.pop();
    if (this.walkTo(self, trail[trail.length - 1], trail.length > 1 ? ARRIVE : HOME)) return;
    if (trail.length > 1) {
      trail.pop();
      return;
    }
    this.turnTo(self, this.postYaw);
    if (!this.keys.turnLeft && !this.keys.turnRight) this.begin("waiting", 0);
  }

  /**
   * Leave a mark for the way home: one every metre it walks while it is after
   * you, keeping only the corners. A mark it could walk past straight from
   * here, to the one before it, is not a corner.
   */
  private mark(self: Combatant): void {
    if (!self.fighter.grounded) return;
    const trail = this.trail;
    const last = trail[trail.length - 1];
    const walked = Math.hypot(this._self.x - last.x, this._self.z - last.z);
    if (walked < CRUMB * this.species.build.scale) return;
    while (trail.length > 1 && this.reaches(self, trail[trail.length - 2])) trail.pop();
    trail.push(this._self.clone());
  }

  /** Is there a body's width of clear floor from here straight to there? */
  private reaches(self: Combatant, p: THREE.Vector3): boolean {
    const dx = p.x - this._self.x;
    const dz = p.z - this._self.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return true;
    return self.fighter.clearAlong(dx / d, dz / d, d, self.fighter.build.hull.radius) >= d;
  }

  /**
   * A step toward somewhere, turning to face it: on a slant while it comes
   * round, and on the spot first if it is well off to one side. See `SLANT`.
   * True while it is on its way, false once it is there.
   */
  private walkTo(self: Combatant, p: THREE.Vector3, within = ARRIVE): boolean {
    const dx = p.x - this._self.x;
    const dz = p.z - this._self.z;
    const d = Math.hypot(dx, dz);
    // There once the feet will carry it the rest of the way.
    const coast = d > 1e-6 ? self.fighter.coast(dx / d, dz / d) : 0;
    if (d < within * this.species.build.scale + coast) {
      this.hold(0, 0);
      return false;
    }
    // Off to its left is a positive turn, and a step to its left is -1.
    const off = this.turnTo(self, Math.atan2(-dx, -dz));
    if (Math.abs(off) > TURN_FIRST) this.hold(0, 0);
    else this.detour(self, 1, Math.abs(off) > SLANT ? -Math.sign(off) : 0);
    return true;
  }

  /**
   * Its next step round you.
   *
   * Mostly sideways, and mostly the same way round as the last, so it reads as
   * circling rather than twitching. In or out only once it has drifted out of
   * its band -- a sidestep round a circle always carries it a little further
   * off. Now and then it stands and watches instead, and a creature with the
   * taste for it darts in and straight back out, which the weapon takes no
   * part in: it is a question put to your nerve, not a tell that lies.
   */
  private nextStep(self: Combatant, range: number, inner: number, outer: number): void {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.step = queued;
      return;
    }

    this.baiting = false;
    const fw = this.mood.footwork;
    const settle = fw.settle * (0.5 + Math.random());

    // Answering your feet (see `answer`): back as you come, after you as you go.
    // Straight back, and without a pause, while there is floor for it: on a
    // slant it gave you only two thirds of each step, and at a goblin's pace
    // against yours that gave you nearly all the ground you came for.
    if (this.giving && this.yourMove > 0) {
      const time = this.stride();
      const move = this.roomFor(self, -1, 0, this.pace * time)
        ? { fwd: -1, side: 0 } : this.findRoom(self, -1, this.side, this.pace * time);
      if (move !== null && move.fwd < 0) {
        if (move.side !== 0) this.side = move.side;
        this.step = { fwd: move.fwd, side: move.side, time, settle: 0 };
        return;
      }
      // Stone at its back: it stops giving ground, and meets you instead.
      this.giving = false;
      this.meeting = true;
    }
    if (this.following && this.yourMove < 0 && range > inner) {
      const time = this.stride();
      if (this.roomFor(self, 1, 0, this.pace * time)) {
        this.step = { fwd: 1, side: 0, time, settle: 0.04 };
        return;
      }
    }

    const fwd = range > outer ? 1 : range < inner ? -1 : 0;

    if (fwd === 0 && Math.random() < WATCH) {
      this.step = { fwd: 0, side: 0, time: 0, settle: settle * 2 };
      return;
    }
    if (fwd >= 0 && this.bait(self, range)) return;
    if (fwd >= 0 && Math.random() < fw.feint
      && this.roomFor(self, -1, 0, this.pace * DART * 1.3)) {
      this.step = { fwd: 1, side: 0, time: DART, settle: 0.04 };
      this.queue.push({ fwd: -1, side: 0, time: DART * 1.3, settle });
      return;
    }
    // A half-step straight in or out across the edge of its reach, the other
    // way from the last one -- in, out, in -- unless it has drifted out of its
    // band, when it is the way back. It had drifted, most of the time: a step
    // round a circle always carries it further off, and while only a body
    // squarely in its band rocked, the swordsman never once stepped out.
    if (Math.random() < fw.rock) {
      const dir = fwd !== 0 ? fwd : -this.rockDir;
      this.rockDir = dir;
      const time = STRIDE[0] * draw(HALF);
      if (this.roomFor(self, dir, 0, this.pace * time)) {
        this.step = { fwd: dir, side: 0, time, settle: settle * 0.6 };
        if (dir > 0) this.tally.rockIn++; else this.tally.rockOut++;
        return;
      }
    }

    if (Math.random() < REVERSE) this.side = -this.side;
    // Now and then the step round you is a quick one: a flick round your side
    // and out of its band, and back in to it on the next.
    if (fwd === 0 && Math.random() < fw.quick * QUICK_ROUND && self.fighter.quickReady
      && this.roomFor(self, 0, this.side, this.quick)) {
      this.quickStep(0, this.side, settle);
      this.tally.quickRounds++;
      return;
    }
    const time = this.stride();
    const move = this.findRoom(self, fwd, this.side, this.pace * time);
    if (move === null) {
      this.step = { fwd: 0, side: 0, time: 0, settle };
      return;
    }
    if (move.side !== 0) this.side = move.side;
    this.step = { fwd: move.fwd, side: move.side, time, settle };
  }

  /**
   * One step of giving ground: back, usually on a slant. With no floor behind
   * it, it goes round instead.
   */
  private retreat(self: Combatant, hop = false, quick = false): void {
    const time = this.stride();
    const slant = Math.random() < 0.6 ? this.side : 0;
    // A hop goes further than a step, and asks the stone for all of it. So
    // does a quick step.
    const far = hop && self.fighter.grounded
      && this.findRoom(self, -1, slant, this.pace * HOP)?.fwd === -1;
    const dash = !far && quick && self.fighter.quickReady
      && this.findRoom(self, -1, slant, this.quick)?.fwd === -1;
    const move = this.findRoom(self, -1, slant,
      far ? this.pace * HOP : dash ? this.quick : this.pace * time);
    if (move === null || move.fwd >= 0) {
      this.circle(this.rollPatience());
      return;
    }
    if (move.side !== 0) this.side = move.side;
    if (dash) {
      this.quickStep(move.fwd, move.side, 0.05);
      this.tally.quickOuts++;
      return;
    }
    this.step = { fwd: move.fwd, side: move.side, time, settle: 0.05 };
    if (far) this.hop();
  }

  /** Off the floor, on the jump key: see `Footwork.hop`. */
  private hop(): void {
    this.keys.jump = true;
    this.hopping = true;
    this.hopClock = 0;
    this.tally.hops++;
  }

  /**
   * Keep an eye on your blade.
   *
   * Nothing here is privileged: where your weapon is and which way it is
   * going, no more than you can see of its. A swing that comes at it is
   * noticed once, weighed once against how wary a creature this is, and
   * answered -- if at all -- a reaction time later, by which point a quick cut
   * has already landed. What it gets out of the way of is a slow one, a big
   * one, and the second of two.
   */
  private watch(self: Combatant, foe: Combatant, dt: number): void {
    this.rest = Math.max(0, this.rest - dt);
    const threat = this.threat(self, foe);
    // Your weapon going back, near it: it may put its own in the way of the
    // swing that is coming, a reaction time later -- not when it arrives,
    // which is too late for a weapon, but as it is drawn back, which is what
    // anyone watching an arm reads. Not while it stands in your reach to
    // draw a swing: what it is there for then is to get out of the way.
    if (this.readBack && !this.wasBack && this.rest <= 0 && this.answerIn < 0 && !this.baiting
      && LOOSE.has(this.state) && Math.random() < this.mood.footwork.parry) {
      this.answerWith = "parry";
      this.answerIn = draw(REACT);
    }
    this.wasBack = this.readBack;
    // Standing in your reach to draw a swing, it is ready for the swing.
    const wary = this.baiting
      ? Math.max(BAIT_WARY, this.mood.footwork.wariness) : this.mood.footwork.wariness;
    if (threat && !this.threatened) {
      this.hpBefore = self.health;
      this.drawn = this.baiting;
      if (this.rest <= 0 && this.answerIn < 0 && LOOSE.has(this.state) && Math.random() < wary) {
        this.answerWith = "dodge";
        this.answerIn = draw(REACT);
      }
    }
    // A swing of yours has come at it and gone by, and it is none the worse:
    // your weapon is on its way back, and you are open -- if it takes it.
    // Having stood in your reach to draw that swing, it always does.
    if (!threat && this.threatened && self.health >= this.hpBefore && !self.fighter.reeling
      && (this.drawn || Math.random() < this.mood.footwork.counter)) {
      this.opening = OPENING;
    }
    this.threatened = threat;

    if (this.answerIn < 0) return;
    this.answerIn -= dt;
    if (this.answerIn < 0 && LOOSE.has(this.state)) {
      if (this.answerWith === "parry") this.parry(); else this.evade(self);
    }
  }

  /**
   * Is a swing coming its way: your blade near it, and coming at it? Leaves
   * in `readBack` whether your weapon is instead going back -- near it, moving
   * as fast as a swing does, and not at it: what a swing of yours starts with,
   * as a swing of its own does, and what it can read off your arm as you can
   * read its.
   */
  private threat(self: Combatant, foe: Combatant): boolean {
    this.readBack = false;
    // Nothing in the hand is nothing to get out of the way of.
    if (foe.dead || foe.fighter.down || !foe.arm.wielding) return false;
    const arm = foe.arm;

    // The nearest the weapon comes to it, hand to tip, flat on the floor.
    const hand = arm.handPosition;
    const tip = arm.tipPosition;
    const ax = tip.x - hand.x;
    const az = tip.z - hand.z;
    const length2 = ax * ax + az * az;
    const u = length2 < 1e-6 ? 1 : Math.max(0, Math.min(1,
      ((this._self.x - hand.x) * ax + (this._self.z - hand.z) * az) / length2));
    const nearX = hand.x + ax * u;
    const nearZ = hand.z + az * u;
    const gap = Math.hypot(nearX - this._self.x, nearZ - this._self.z);
    const hull = self.fighter.build.hull.radius;
    if (gap >= hull + DANGER + WIND_SEEN) return false;

    // And how fast the point is coming at its middle. See SWING.
    const v = arm.tipVelocity;
    const carried = foe.fighter.body.linvel();
    const dx = this._self.x - tip.x;
    const dy = this._self.y - tip.y;
    const dz = this._self.z - tip.z;
    const d = Math.hypot(dx, dy, dz);
    const closing = d < 1e-6 ? SWING + 1
      : ((v.x - carried.x) * dx + (v.y - carried.y) * dy + (v.z - carried.z) * dz) / d;
    const speed = Math.hypot(v.x - carried.x, v.y - carried.y, v.z - carried.z);
    this.readBack = speed > SWING && closing < GOING_BACK;
    if (gap >= hull + DANGER || closing <= SWING) return false;
    this._near.set(nearX, 0, nearZ);
    return true;
  }

  /** Step back, and away from the side your blade is on. */
  private evade(self: Combatant): void {
    this.rest = DODGE_REST;
    const yaw = self.fighter.yaw;
    const across = (this._near.x - this._self.x) * Math.cos(yaw)
      - (this._near.z - this._self.z) * Math.sin(yaw);
    const away = across > 0 ? -1 : 1;
    // A hop, if it is a creature for them and there is floor for one: back
    // and away, off the floor, further than a step goes.
    const hop = self.fighter.grounded && Math.random() < this.mood.footwork.hop
      && this.findRoom(self, -1, away, this.pace * HOP) !== null;
    // Or a quick step, the same way, and out of it sooner than a step gets it.
    const quick = !hop && self.fighter.quickReady && Math.random() < this.mood.footwork.quick
      && this.findRoom(self, -1, away, this.quick) !== null;
    const move = this.findRoom(self, -1, away,
      hop ? this.pace * HOP : quick ? this.quick : this.pace * DODGE);
    // Nowhere to go, it stands and takes it.
    if (move === null) return;
    this.stand();
    if (quick) {
      this.quickStep(move.fwd, move.side, 0.06);
      this.tally.quickDodges++;
    } else {
      this.step = { fwd: move.fwd, side: move.side, time: DODGE, settle: 0.06 };
      this.hold(move.fwd, move.side);
    }
    this.begin("evade", 0);
    if (hop) this.hop();
  }

  /**
   * Meet your swing with its weapon: see `Footwork.parry`. It holds its feet
   * and puts its blade where yours is going.
   */
  private parry(): void {
    this.rest = DODGE_REST;
    this.stand();
    this.hold(0, 0);
    this.tally.parries++;
    this.cameAt = -1;
    this.begin("parry", 0);
  }

  /**
   * Where its weapon goes to meet yours: the part of it that does the work
   * put where the part of yours that does is going -- a moment ahead of it,
   * along the way it is travelling -- at a guard's reach, the edge square to
   * it. It is the same probe it aims a chop with, asking where its own
   * weapon would be, and nothing about yours it could not see.
   */
  private meet(self: Combatant, foe: Combatant, t: Tuning): void {
    const arm = foe.arm;
    if (!arm.wielding) {
      this.guard();
      return;
    }
    const v = arm.tipVelocity;
    this._meet.copy(arm.handPosition).lerp(arm.tipPosition, 0.7)
      .addScaledVector(v, LEAD * 0.7);
    self.arm.aimCutAt(this._meet, PARRY_REACH, 0, t, this._parry);
    this.want = {
      yaw: within(this._parry.yaw, [-1.3, 1.3]),
      pitch: this._parry.pitch,
      reach: PARRY_REACH,
      roll: 0,
    };
  }

  /**
   * Is there floor for a step that way, this far? Asked of the stone before
   * the step is taken, rather than found out by walking into it.
   */
  private roomFor(self: Combatant, fwd: number, side: number, metres: number): boolean {
    const yaw = self.fighter.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // The frame Fighter.update walks in: forward is -Z at yaw zero, right is +X.
    const x = side * cos - fwd * sin;
    const z = -side * sin - fwd * cos;
    const length = Math.hypot(x, z);
    if (length < 1e-6) return true;
    const body = self.fighter.build.hull.radius;
    const need = metres + body;
    return self.fighter.clearAlong(x / length, z / length, need, body) >= need;
  }

  /**
   * The step it wanted, or the nearest one it has room for: the other way
   * round, then straight in or out, then sideways alone. Null if it is boxed in.
   */
  private findRoom(
    self: Combatant, fwd: number, side: number, metres: number,
  ): { fwd: number; side: number } | null {
    const tries = [[fwd, side], [fwd, -side], [fwd, 0], [0, side], [0, -side]];
    for (const [f, s] of tries) {
      if ((f !== 0 || s !== 0) && this.roomFor(self, f, s, metres)) {
        return { fwd: f, side: s };
      }
    }
    return null;
  }

  /**
   * Take a step, or -- something in the way, a pillar between you, the block
   * -- go round rather than into it: on a slant, or sideways, until the way is
   * clear. No pathfinding, only a body that looks where it puts its feet;
   * before it did, a pillar on the line to you could hold it long enough to
   * lose sight of you, and it gave you up.
   */
  private detour(self: Combatant, fwd: number, side: number): void {
    if (fwd !== 0 && !this.roomFor(self, fwd, side, this.pace * LOOK)) {
      const move = this.findRoom(self, fwd, side !== 0 ? side : this.side, this.pace * LOOK);
      if (move !== null) {
        fwd = move.fwd;
        side = move.side;
        // And it keeps going round the same side until it is past.
        if (side !== 0) this.side = side;
      }
    }
    this.hold(fwd, side);
  }

  /** Carry on with the step it is taking. True once it, and its pause, are done. */
  private walk(dt: number): boolean {
    const s = this.step;
    if (s.time > 0) {
      s.time -= dt;
      this.hold(s.fwd, s.side);
      return false;
    }
    this.hold(0, 0);
    if (s.settle > 0) {
      s.settle -= dt;
      return false;
    }
    return true;
  }

  /** Drop whatever steps it had in mind. */
  private stand(): void {
    this.step = { fwd: 0, side: 0, time: 0, settle: 0 };
    this.queue.length = 0;
    this.baiting = false;
  }

  /**
   * What it can see of you besides where you are: whether you are stepping in
   * or out, and how far your weapon reaches. Anyone could read the same.
   */
  private readYou(foe: Combatant, dt: number): void {
    this.opening = Math.max(0, this.opening - dt);
    // Your weapon knocked aside is an opening as plain as a miss, and it
    // takes it every time. It can see your arm give, as you can see its.
    const yours = this.sighted && foe.arm.jarred > KNOCKED;
    if (yours && !this.yoursKnocked) this.opening = OPENING;
    this.yoursKnocked = yours;
    if (this.sighted) this.yourReach = foe.arm.strikeLength;
    const move = !this.sighted ? 0 : this.coming > ADVANCE ? 1 : this.coming < -ADVANCE ? -1 : 0;
    if (move === this.yourMove) {
      this.moveFor += dt;
      return;
    }
    this.yourMove = move;
    this.moveFor = 0;
    this.moveReact = draw(REACT);
    this.answered = false;
    this.giving = false;
    this.meeting = false;
    this.following = false;
  }

  /**
   * You are stepping in, or out, and it answers -- a reaction time later, once
   * each time you start. Coming in, you are given ground step for step, or met:
   * it stands, and swings as you walk into its reach. Going out, you are
   * followed, rather than left to set the distance yourself. True if it swung.
   */
  private answer(range: number, close: number, inner: number): boolean {
    if (this.meeting && this.canSwing(range, close, inner)) {
      this.meeting = false;
      this.hold(0, 0);
      this.commit(range);
      return true;
    }
    if (this.yourMove === 0 || this.answered || this.moveFor < this.moveReact) return false;
    this.answered = true;
    if (this.yourMove < 0) {
      this.following = true;
      this.tally.follows++;
    } else if (Math.random() < this.mood.footwork.give) {
      this.giving = true;
      this.tally.gives++;
    } else {
      this.meeting = true;
      this.tally.meets++;
    }
    // Whatever its feet were about to do, they do this instead: see `nextStep`,
    // which only a body going round you takes its steps from.
    if (this.state === "close" && !this.meeting) this.circle(Math.max(this.patience, 0.3));
    else this.stand();
    return false;
  }

  /**
   * Step inside your reach on purpose, guard up, hold there a beat, and step
   * back out: a target offered, to draw a swing. It gets out of the way of
   * what that draws more readily than of anything else (see `watch`), and a
   * swing of yours that misses leaves you open to it (see `punish`). Not at an
   * empty hand, not from so far off it would be a charge, and not with no
   * floor to come back out on.
   */
  private bait(self: Combatant, range: number): boolean {
    if (this.yourReach <= 0 || Math.random() >= this.mood.footwork.bait) return false;
    const inBy = range - this.yourReach * BAIT_DEPTH;
    if (inBy < 0.1 * this.species.build.scale || inBy > this.pace * 0.5) return false;
    if (!this.roomFor(self, 1, 0, inBy) || !this.roomFor(self, -1, 0, inBy)) return false;
    // A step at pace covers pace x time, easing and all: what it loses
    // getting going it makes up coasting to a stop. Already on its way in,
    // it loses nothing getting going, and coasts as far again: one baited
    // from a step in went half again as deep, inside its own guard, stood
    // there long enough to be crowded, and swung.
    const dx = this._foe.x - this._self.x;
    const dz = this._foe.z - this._self.z;
    const d = Math.hypot(dx, dz);
    const going = d > 1e-6 ? 2 * self.fighter.coast(dx / d, dz / d) : 0;
    const time = Math.max(inBy - going, 0.1 * this.species.build.scale) / this.pace;
    this.baiting = true;
    this.tally.baits++;
    this.step = { fwd: 1, side: 0, time, settle: draw(BAIT_HOLD) };
    this.queue.push({ fwd: -1, side: 0, time: time * 1.2, settle: this.mood.footwork.settle });
    return true;
  }

  /**
   * A swing of yours came at it and missed: step in and make you pay while
   * your weapon is still on its way back. From where it reaches you it swings
   * now; from anywhere it would still be going round you, it steps in and
   * swings.
   */
  private punish(range: number, close: number, inner: number, outer: number): boolean {
    if (this.opening <= 0 || !this.squared || !this.sighted || this.knocked) return false;
    if (range < close || range > outer * 1.4) return false;
    this.opening = 0;
    this.patience = 0;
    this.tally.punishes++;
    this.stand();
    if (range <= inner) {
      this.hold(0, 0);
      this.commit(range);
    } else {
      this.begin("close", 0);
    }
    return true;
  }

  private stride(): number {
    return STRIDE[0] + Math.random() * (STRIDE[1] - STRIDE[0]);
  }

  private rollPatience(): number {
    const [lo, hi] = this.mood.footwork.patience;
    return lo + Math.random() * (hi - lo);
  }

  /** Put its feet where a step says, on the same four keys yours are on. */
  private hold(fwd: number, side: number): void {
    this.keys.forward = fwd > 0;
    this.keys.back = fwd < 0;
    this.keys.left = side < 0;
    this.keys.right = side > 0;
  }

  /**
   * Re-measure what this body can reach, where level is at your chest, and --
   * while it draws back -- where level is for the part of you it is after.
   *
   * All of it comes from the arm's own kinematics, so a goblin measures a
   * goblin's spear and an orc measures an orc's axe, and neither needs to be
   * told a number in metres.
   *
   * A swing's aim follows you while it draws back, as anybody's does, and is
   * held once it goes. Chasing you through the swing would make every one of
   * them home, and you should be able to step off the line it went on.
   */
  private measure(self: Combatant, foe: Combatant, t: Tuning): void {
    const arm = self.arm;
    const point = arm.weapon.bite === "point";
    const chest = this.target(foe, "body", this._mark);

    if (this.state !== "strike") {
      if (point) {
        arm.aimPointAt(chest, 1, this.refRoll, t, this.level);
      } else {
        this.level.yaw = 0;
        this.level.pitch = arm.solvePitchForHeight(chest.y, 0, 1, this.refRoll, t);
      }
    }

    const s = this.swing;
    if (s !== null && (this.state === "windup" || this.state === "leap")) {
      // An edge wants its arc to cross the part it is aimed at; a point wants
      // to be aimed at it, which takes both angles rather than just the pitch.
      // Same shapes either way -- only what "level" means changes, and it
      // changes with what is in the hand. Off the floor in a leap it is aimed
      // at where you were when it jumped: it follows its own flight, not you.
      const part = this.state === "leap"
        ? this._part.copy(this._leapMark) : this.target(foe, s.aim, this._part);
      if (point) {
        arm.aimPointAt(part, s.from.reach, s.roll, t, this.aimFrom);
        arm.aimPointAt(part, s.to.reach, s.roll, t, this.aimTo);
      } else if (s.leap) {
        // Out of a leap the chop comes straight down the line it jumped on,
        // with no step into the swing to bring it round onto you, so it is
        // aimed where the axe head arrives rather than off its chest: aimed as
        // everything else is, it came down half a metre to one side of you.
        arm.aimCutAt(part, 1, s.roll, t, this.aimTo);
        this.aimTo.yaw = within(this.aimTo.yaw, [-TURN_IN, TURN_IN]);
        this.aimFrom.yaw = this.aimTo.yaw;
        this.aimFrom.pitch = this.aimTo.pitch;
      } else {
        // Round toward it, but not so far round that the shape stops being
        // itself: an arm flung out wide is not worth a swing at the air.
        const yaw = within(
          wrapPi(this.bearing(self, part) - this.bearing(self, chest)), [-TURN_IN, TURN_IN]);
        // The follow-through comes round to it. The wind-up goes further back
        // for it, and never less far: a part of you lying the way the swing is
        // already going is met later in the same swing, and taking the arc
        // round to it would start the swing from the guard with no draw-back
        // at all -- a cut nobody could read.
        const along = yaw * (s.to.yaw - s.from.yaw) > 0;
        this.aimTo.yaw = yaw;
        this.aimFrom.yaw = along ? 0 : yaw;
        this.aimFrom.pitch = this.aimTo.pitch
          = arm.solvePitchForHeight(part.y, yaw, 1, s.roll, t);
      }
    }

    // How far its weapon works, at what it goes for most.
    let reachPitch = this.level.pitch;
    if (this.reachAim !== "body" && this.state !== "strike") {
      const at = this.target(foe, this.reachAim, this._reachAt);
      reachPitch = point ? this.level.pitch : arm.solvePitchForHeight(at.y, 0, 1, this.refRoll, t);
      this.reachPitch = reachPitch;
    } else if (this.reachAim !== "body") {
      reachPitch = this.reachPitch;
    }
    arm.probeStrike(this.level.yaw, reachPitch, 1, this.refRoll, t, this._probe);
    this.strikeReach = Math.max(
      0.2, Math.hypot(this._probe.x - this._self.x, this._probe.z - this._self.z));
  }

  /**
   * Where the part of you a swing is aimed at is, now.
   *
   * Only what it can see of you: your head, the middle of your chest, the
   * forearm your sword is in, and the nearer of your thighs. A part that is no
   * longer there to aim at -- an arm you have lost -- leaves your chest. Out
   * of sight, all it has is where your middle was.
   */
  private target(foe: Combatant, aim: Aim, out: THREE.Vector3): THREE.Vector3 {
    if (!this.sighted) return out.copy(this._lastChest);
    const f = foe.fighter;
    switch (aim) {
      case "head": {
        const head = f.parts.find((p) => p.name === "head");
        if (head && !head.severed) return copy(out, head.collider.translation());
        break;
      }
      case "arm":
        if (!foe.arm.disarmed) return copy(out, foe.arm.fore.translation());
        break;
      case "legs": {
        let nearest = Infinity;
        for (const p of f.parts) {
          if (!p.name.endsWith("thigh")) continue;
          const c = p.collider.translation();
          const d = Math.hypot(c.x - this._self.x, c.z - this._self.z);
          if (d < nearest) {
            nearest = d;
            copy(out, c);
          }
        }
        if (nearest < Infinity) return out;
        break;
      }
      case "body":
        break;
    }
    return this.chest(foe, out);
  }

  /** The middle of your chest, wherever a crouch has taken it. */
  private chest(foe: Combatant, out: THREE.Vector3): THREE.Vector3 {
    const f = foe.fighter;
    return out.set(
      this._foe.x,
      this._foe.y - f.build.hullCentreY + f.build.standing.crown * CHEST - f.sink,
      this._foe.z);
  }

  /** Which way a point lies from its own sword shoulder, as a yaw. */
  private bearing(self: Combatant, p: THREE.Vector3): number {
    self.fighter.shoulderWorld(this._shoulder);
    return Math.atan2(-(p.x - this._shoulder.x), -(p.z - this._shoulder.z));
  }

  /**
   * Its guard: weapon up, level with the chest, wherever across and however
   * high it is holding it just now (see `recover` and `restance`), and never
   * quite still. `raise` lifts it further: giving ground, it keeps it high.
   */
  private guard(raise = 0): void {
    this.want = {
      yaw: this.level.yaw + this.held.yaw + SWAY.yaw * Math.sin(this.sway),
      pitch: this.level.pitch + this.held.lift + raise
        + SWAY.pitch * Math.sin(2 * this.sway + 1),
      reach: 0.55,
      roll: 0,
    };
  }

  /**
   * Shift its guard, in its own time: to another of the guards it holds --
   * higher, further across or less -- or back to the middle. Only while it is
   * on its feet and going round you: it is something a weapon does while
   * nothing else is asked of it.
   */
  private restance(): void {
    if (this.shift > 0) return;
    this.shift = draw(STANCE_HOLD);
    if (Math.random() < 0.35) {
      this.stance.yaw = GUARD_YAW;
      this.stance.lift = GUARD_LIFT;
    } else {
      this.stance.yaw = draw(STANCE_YAW);
      this.stance.lift = draw(STANCE_LIFT);
    }
  }

  /**
   * You are out of its reach and not coming -- or on the floor -- and now and
   * then it shows you its weapon (see `Display`), and not again for a while.
   */
  private taunt(
    range: number, outer: number, standingOver = false, chance = this.mood.footwork.taunt,
  ): boolean {
    const d = this.species.display;
    if (this.tauntRest > 0 || !this.sighted || this.yourMove > 0) return false;
    if (!standingOver && range < outer * TAUNT_OUT) return false;
    // You have only just got out of its reach: for something that leaps,
    // that is what a leap is for. Taunting then, it came after you with its
    // axe still coming up off the floor, and the chop came down late.
    const leap = this.species.leap;
    if (!standingOver && leap !== undefined && this.sinceNear <= leap.memory) return false;
    if (Math.random() >= chance) return false;
    this.stand();
    this.hold(0, 0);
    this.tauntRest = TAUNT_REST;
    this.tally.taunts++;
    this.begin("taunt", d.beats * d.beat);
    return true;
  }

  /** Its weapon, a beat at each of the two poses it taunts you with. */
  private display(): void {
    const d = this.species.display;
    const p = (this.clock % d.beat) < d.beat / 2 ? d.a : d.b;
    this.want = {
      yaw: this.level.yaw + p.yaw,
      pitch: this.level.pitch + p.pitch,
      reach: p.reach,
      roll: p.roll,
    };
  }

  private begin(state: State, seconds: number): void {
    this.state = state;
    this.timer = seconds;
    this.clock = 0;
    this.stall = 0;
    this.upAt = -1;
    this.gauged = false;
    // Carrying a swing round is part of the swing, and stops with it.
    if (state !== "strike") this.whirl = 0;
    // Coming for you, it decides once whether it will draw back on the way
    // in, and whether it will stop and show you its weapon first.
    if (state === "close") {
      this.comingIn = Math.random() < COME_IN * Math.min(1, this.mood.aggression);
      this.showOff = Math.random() < this.mood.footwork.taunt;
      this.darting = Math.random() < this.mood.footwork.dart;
    }
  }

  private idle(): void {
    this.keys.forward = false;
    this.keys.back = false;
    this.keys.left = false;
    this.keys.right = false;
    this.keys.turnLeft = false;
    this.keys.turnRight = false;
    this.keys.jump = false;
    this.keys.pivot = false;
    this.keys.dash = false;
  }

  /** Turn toward the foe. */
  private face(self: Combatant, toFoe: THREE.Vector3): void {
    // Torso-forward is -Z, so the yaw that points at a direction d is
    // atan2(-d.x, -d.z).
    const err = this.turnTo(self, Math.atan2(-toFoe.x, -toFoe.z));
    this.squared = Math.abs(err) < SQUARE;
  }

  /**
   * Turn toward a heading using the same turn keys the player has. Returns
   * how far it still has to turn, radians, positive to its left.
   */
  private turnTo(self: Combatant, yaw: number): number {
    const err = wrapPi(yaw - self.fighter.yaw);
    const dead = 0.06;
    this.keys.turnLeft = err > dead;
    this.keys.turnRight = err < -dead;
    return err;
  }

  /**
   * Convert "where I want the arm" into mouse travel, capped at a human hand
   * speed. This is the only channel the AI has to its own weapon.
   */
  private steerArm(self: Combatant, t: Tuning, dt: number): void {
    const aim = self.arm.aim;
    const budget = HAND_SPEED * dt;

    // Only as far as the arm goes. Past the end of its travel there is
    // nothing to steer toward, and a pose it can never reach is one it would
    // wait on for ever.
    const yawPx = (within(this.want.yaw, ARM_RANGE.yaw) - aim.yaw) / t.sensitivity;
    const pitchPx = (within(this.want.pitch, ARM_RANGE.pitch) - aim.pitch) / t.sensitivity;
    const rollPx = (within(this.want.roll, ARM_RANGE.roll) - aim.roll) / t.rollSensitivity;
    // Reach is a fraction of its own arm, turned back into wheel notches.
    const notches = (self.arm.reachAt(this.want.reach) - aim.reach) / t.reachRate;

    // readInput does `armYaw -= dx * sensitivity`, so closing a positive yaw
    // gap needs a negative dx.
    this.dx += -cap(yawPx, budget);
    // and `armPitch += dy * sensitivity * -1` when invertY is off.
    this.dy += -cap(pitchPx, budget) * (t.invertY ? -1 : 1);
    this.rollDx += cap(rollPx, budget);
    this.wheel += cap(notches, 4);

    this.onPose = Math.abs(yawPx) <= budget && Math.abs(pitchPx) <= budget
      && Math.abs(rollPx) <= budget && Math.abs(notches) <= 4;
  }

  // --- ArmInput ---
  consumeMouse(): { dx: number; dy: number; wheel: number; rollDx: number } {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel, rollDx: this.rollDx };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.rollDx = 0;
    return out;
  }

  reset(): void {
    this.state = "waiting";
    this.timer = 0;
    this.engaged = false;
    this.heard = false;
    this.lost = Infinity;
    this.leg = "go";
    // Its post is wherever it next stands.
    this.trail.length = 0;
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.rollDx = 0;
    this.onPose = false;
    this.clock = 0;
    this.swing = null;
    for (const l of [this.level, this.aimFrom, this.aimTo]) {
      l.yaw = 0;
      l.pitch = 0;
    }
    this.snag = 0;
    this.stand();
    this.patience = 0;
    this.crowd = 0;
    this.squared = false;
    this.sighted = false;
    this.threatened = false;
    this.answerIn = -1;
    this.rest = 0;
    this.sinceNear = Infinity;
    this.leapRest = 0;
    this.closing = 0;
    this.coming = 0;
    this.yourMove = 0;
    this.moveFor = 0;
    this.answered = false;
    this.giving = false;
    this.meeting = false;
    this.following = false;
    this.baiting = false;
    this.rockDir = 1;
    this.yourReach = 0;
    this.opening = 0;
    this.drawn = false;
    this.yoursKnocked = false;
    this.knocked = false;
    this.chain = 0;
    this.yoursBefore = 0;
    this.whirl = 0;
    this.spun = 0;
    this.yawWas = 0;
    this.winded = 0;
    this.stance.yaw = GUARD_YAW;
    this.stance.lift = GUARD_LIFT;
    this.held.yaw = GUARD_YAW;
    this.held.lift = GUARD_LIFT;
    this.shift = 0;
    this.answerWith = "dodge";
    this.readBack = false;
    this.wasBack = false;
    this.cameAt = -1;
    this.hopping = false;
    this.hopClock = 0;
    this.hpWas = 0;
    this.flinched = false;
    this.tauntRest = 0;
    this.wounded = false;
    this.comingIn = false;
    this.showOff = false;
    this.darting = false;
    this.idle();
  }
}

/**
 * A noise at `at` -- the pen's gate going up: every one of `listeners` alive
 * and within `earshot` of it, flat metres, hears it (see `Ai.hear`) and goes
 * to see, on out the far side of it from where it stood. How many did.
 */
export function noise(
  at: THREE.Vector3, earshot: number,
  listeners: readonly { readonly combatant: Combatant; readonly ai: Ai }[],
): number {
  let heard = 0;
  for (const { combatant, ai } of listeners) {
    if (combatant.dead) continue;
    combatant.position(_listener);
    const dx = at.x - _listener.x;
    const dz = at.z - _listener.z;
    if (Math.hypot(dx, dz) > earshot) continue;
    ai.hear(at, _on.set(dx, 0, dz));
    heard++;
  }
  return heard;
}

const _listener = new THREE.Vector3();
const _on = new THREE.Vector3();
