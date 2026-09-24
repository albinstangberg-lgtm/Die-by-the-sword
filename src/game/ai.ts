import * as THREE from "three";
import { ARM_RANGE, type ArmInput } from "./arm";
import type { Combatant } from "./combatant";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";
import type { Aim, Cut, Leap, Span, Species } from "./species";

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
 * Its jump is yours as well. Something that leaps (see `Leap`) and has just
 * lost you out of its reach runs at you with its weapon going up and comes
 * down on you out of the air, on your key, from a jump its legs could make.
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
 * How long it keeps coming after losing sight of you, seconds.
 *
 * Not zero, and the reason is the pillars: stepping behind one mid-fight
 * breaks the line for a few frames, and an opponent that downed tools every
 * time that happened would be trivial to beat and absurd to watch. Long
 * enough to cover a pillar, short enough that leaving the room ends it.
 */
const MEMORY = 2.5;

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
}

/** Somewhere in a span, any of it as likely as the rest. */
function draw([lo, hi]: Span): number {
  return lo + Math.random() * (hi - lo);
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
  | "close" | "circle" | "backoff" | "evade"
  | "windup" | "leap" | "strike" | "recover" | "free" | "beaten"
  | "waiting" | "reeling" | "down";

/**
 * The states in which it is loose on its feet -- committed to nothing -- and
 * so free to get out of the way of something.
 */
const LOOSE: ReadonlySet<State> = new Set<State>(["close", "circle", "backoff"]);

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
    turnLeft: false, turnRight: false, jump: false, vault: false, crouch: false,
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
   * Pin the shape a swing is thrown with, the part of you it goes for, or
   * both, so one kind of swing can be measured on its own. This is how the
   * shapes are tuned; leave them null in play.
   */
  cutOverride: string | null = null;
  aimOverride: Aim | null = null;

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
  private readonly _mark = new THREE.Vector3();
  /** The part of you a swing is aimed at, and its own shoulder, for bearings. */
  private readonly _part = new THREE.Vector3();
  private readonly _shoulder = new THREE.Vector3();
  /** Where the part of you a leap was aimed at was when its feet left the floor. */
  private readonly _leapMark = new THREE.Vector3();
  private readonly _was = new THREE.Vector3();
  /** The nearest your swinging blade came to it, flat: the side to step away from. */
  private readonly _near = new THREE.Vector3();
  private snag = 0;
  /** Seconds its weapon has been all but still in this part of a swing. See `STALLED`. */
  private stall = 0;
  /** Seconds of "I know where you are" left. Zero means it holds its post. */
  private seen = 0;

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
  private flinch = -1;
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

  constructor(readonly species: Species) {
    const [lo, hi] = species.cuts[0].roll;
    this.refRoll = (lo + hi) / 2;
  }

  /** What it is up to, state by state: for the harness and for debugging. */
  get intent(): string {
    return this.state;
  }

  /**
   * All the fight panel says about it: whether it has noticed you, and whether
   * it has anything left to fight with. Never what it is about to do. That is
   * on its arm, where anybody's is.
   */
  get outlook(): "waiting" | "fighting" | "beaten" {
    if (this.state === "waiting") return "waiting";
    return this.state === "beaten" ? "beaten" : "fighting";
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
      this.flinch = -1;
      return;
    }
    if (this.state === "down") this.engage();

    self.position(this._self);
    foe.position(this._foe);
    const toFoe = this._foe.clone().sub(this._self);
    const range = Math.hypot(toFoe.x, toFoe.z);
    this.pace = t.moveSpeed * this.species.build.scale;

    // An animal that cannot see you does not come for you.
    //
    // The rooms are walled off from each other, and without this the orc
    // would spend the fight walking into the far side of a wall because it
    // knew, through the stone, exactly where you were standing. One ray, the
    // same one either of them could cast, and it is also what makes a doorway
    // worth something: step into the light and the thing in the next room
    // starts moving.
    const sighted = self.sees(foe);
    if (sighted && (this.seen > 0 || range < NOTICE)) this.seen = MEMORY;
    else this.seen = Math.max(0, this.seen - dt);
    this.sighted = sighted;

    // Once it has seen you it watches you -- not its own blade, which is what
    // the player's fighter watches. A head turned toward you is the first
    // thing that says it has noticed, from further off than any weapon tell.
    self.fighter.focus = this.seen > 0 ? foe.fighter.eyeWorld(this._gaze) : null;

    if (this.seen <= 0) {
      // Holding its post. It does not track you, it does not turn, and it
      // keeps its weapon where a waiting animal keeps it.
      if (this.state !== "waiting") this.begin("waiting", 0);
      this.idle();
      this.want = { yaw: 0.3, pitch: -0.12, reach: 0.55, roll: 0 };
      this.steerArm(self, t, dt);
      this._was.copy(this._self);
      this.sinceNear = Infinity;
      return;
    }
    if (this.state === "waiting") this.engage();

    this.face(self, toFoe);
    this.timer -= dt;
    this.clock += dt;
    this.stall = self.arm.state.tipSpeed < STALLED ? this.stall + dt : 0;

    // Disarmed: no weapon, no plan. It backs away rather than pretending.
    if (self.arm.disarmed) {
      this.state = "beaten";
      this.hold(range < 3.0 && this.roomFor(self, -1, 0, 0.3) ? -1 : 0, 0);
      this.keys.jump = false;
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
      const yours = foe.fighter.body.linvel();
      const ux = toFoe.x / range;
      const uz = toFoe.z / range;
      this.coming = -(yours.x * ux + yours.z * uz);
      this.closing = mine.x * ux + mine.z * uz + this.coming;
    }
    // Its feet leave the floor for one step at a time, and only in a leap.
    this.keys.jump = false;

    this.checkSnag(t, dt);
    this.crowd = range < close ? this.crowd + dt : 0;
    this.watch(self, foe, dt);

    switch (this.state) {
      case "close": {
        // On its way to where the fight is. Once there it goes round you until
        // its patience runs out -- or, pressing, it has none, and swings the
        // moment it has stepped in to where its weapon works.
        this.guard();
        if (this.lashOut(self, range, close)) break;
        if (this.leapAt(self, range)) break;
        if (this.patience > 0 && range <= outer) {
          this.circle(this.patience);
          break;
        }
        if (this.patience <= 0 && this.canSwing(range, close, inner)) {
          this.hold(0, 0);
          this.commit(range);
          break;
        }
        let fwd = range > strike ? 1 : range < close ? -1 : 0;
        // From further off than it can reach, it comes in on a slant when there
        // is floor for one. The slant is checked every step, not once, so it
        // straightens up rather than walk into the side of a doorway.
        let side = fwd > 0 && this.weave !== 0 && range < WEAVE_IN
          && range > far * WEAVE_OUT && this.roomFor(self, 1, this.weave, this.pace * 0.5)
          ? this.weave : 0;
        // Something in the way -- a pillar between you, the block -- and it goes
        // round rather than into it: on a slant, or sideways, until the way is
        // clear. No pathfinding, only a body that looks where it puts its feet;
        // before it did, a pillar on the line to you could hold it long enough
        // to lose sight of you, and it went back to its post.
        if (fwd !== 0 && !this.roomFor(self, fwd, side, this.pace * LOOK)) {
          const move = this.findRoom(
            self, fwd, side !== 0 ? side : this.side, this.pace * LOOK);
          if (move !== null) {
            fwd = move.fwd;
            side = move.side;
            // And it keeps going round the same side until it is past.
            if (side !== 0) this.side = side;
          }
        }
        this.hold(fwd, side);
        break;
      }

      case "circle":
        // Looking for its moment: short steps round you at the edge of its
        // reach, a pause between each, in or out only as far as it takes to
        // stay there.
        this.guard();
        if (this.lashOut(self, range, close)) break;
        if (this.leapAt(self, range)) break;
        if (range > outer * 1.4) {
          // You have backed out of its circle. It comes after you, and carries
          // on waiting once it has you again.
          this.patience = Math.max(this.timer, 0.01);
          this.begin("close", 0);
          this.hold(1, 0);
          break;
        }
        if (this.timer <= 0) {
          // Its moment. It swings from here if its weapon works from here;
          // otherwise it steps in to where it does, and swings from there.
          this.patience = 0;
          this.hold(0, 0);
          if (this.canSwing(range, close, inner)) this.commit(range);
          else this.begin("close", 0);
          break;
        }
        if (this.walk(dt)) this.nextStep(self, range, inner, outer);
        break;

      case "backoff":
        // Giving ground: a step or two back, usually on a slant, until it is
        // out past its own reach. Then it goes round.
        this.guard(0.25);
        if (this.walk(dt)) {
          if (range >= outer || this.timer <= 0) this.circle(this.rollPatience());
          else this.retreat(self);
        }
        break;

      case "evade":
        // Out of the way of your blade: one quick step back and aside. It is
        // not a parry and it is not armour -- a cut that was already on it
        // lands on something moving away, and that is all the step buys.
        this.guard(0.25);
        if (this.walk(dt)) this.circle(Math.random() * RIPOSTE);
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
        this.want = {
          yaw: this.aimFrom.yaw + s.from.yaw,
          pitch: this.aimFrom.pitch + s.from.pitch,
          reach: s.from.reach,
          roll: s.roll,
        };
        if (s.leap) {
          this.charge(self, foe, range, t);
          break;
        }
        this.hold(0, 0);
        if (this.done(self, WINDUP, THERE.windup)) this.begin("strike", 0);
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
        // Aim THROUGH the target, not at it. Sweeping to a point short of the
        // foe decelerates into the hit and lands a shove; the whole damage
        // model is built on speed at contact.
        const s = this.swing!;
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
        this.hold(
          s.cut.step > 0 && range > strike ? 1
            : s.cut.step < 0 && this.roomFor(self, -1, 0, 0.3) ? -1 : 0,
          0);
        // Over when the weapon is through -- or when it has been stopped, on
        // you or on anything else, because then the rest of it is not coming.
        if (this.stopped(STRIKE) || this.done(self, STRIKE, THERE.strike)) {
          this.begin("recover", 0);
        }
        break;
      }

      case "recover":
        // Open, for as long as its guard takes to come back up: hardly any
        // time behind a sword, long enough to make an axe pay for itself.
        this.guard();
        this.hold(range < close && this.roomFor(self, -1, 0, 0.3) ? -1 : 0, 0);
        if (this.stopped(RECOVER) || this.done(self, RECOVER, THERE.recover)) {
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
        // Caught on something. Pull the hand in and low and give ground --
        // which is exactly what a player does with a blade planted in a wall,
        // and works for the same reason: a folded arm has leverage a straight
        // one does not.
        this.want = {
          yaw: this.level.yaw + 0.2, pitch: this.level.pitch - 0.9, reach: 0, roll: 0,
        };
        this.hold(-1, 0);
        if (this.timer <= 0) this.engage();
        break;

      case "beaten":
      case "waiting":
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
  private checkSnag(t: Tuning, dt: number): void {
    const moved = this._self.distanceTo(this._was);
    this._was.copy(this._self);
    if (this.state === "free" || this.state === "beaten"
      || this.state === "waiting" || this.state === "reeling") { this.snag = 0; return; }

    const k = this.keys;
    const trying = k.forward || k.back || k.left || k.right;
    const expected = t.moveSpeed * this.species.build.scale * dt;
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
  private commit(range: number, leap: Leap | null = null): void {
    this.swing = this.makeUp(range / this.strikeReach, leap);
    this.flinch = -1;
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

  /** The swing itself: see `commit`. `at` is the distance in its own reaches. */
  private makeUp(at: number, leap: Leap | null): Swing {
    const all = this.species.cuts;
    let cuts: Cut[];
    if (leap !== null) {
      cuts = all.filter((c) => c.name === leap.cut);
    } else {
      cuts = all.filter((c) =>
        !c.at || (at >= (c.at.min ?? 0) && at <= (c.at.max ?? Infinity)));
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
    if (!this.squared || !this.sighted || !self.fighter.grounded) return false;
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
    const apex = Math.sqrt(2 * t.jumpHeight * this.species.build.scale / Math.abs(t.gravity));
    const takeoff = this.strikeReach * LEAP_LAND + run * (CHOP + apex);
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
    return range <= near && range >= close && this.squared && this.sighted;
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
    if (range >= close || !this.squared || !this.sighted) return false;
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
    const fw = this.species.footwork;
    // Which way it goes from here is decided afresh after every exchange --
    // otherwise something that circles only briefly between swings, like the
    // orc, went round you the same way all fight.
    this.side = Math.random() < OFF_HAND ? 1 : -1;
    const roll = Math.random();
    if (roll < fw.retreat) {
      this.begin("backoff", RETREAT);
      this.retreat(self);
    } else if (roll < fw.retreat + PRESS * this.species.aggression) {
      this.patience = 0;
      this.begin("close", 0);
    } else {
      this.circle(this.rollPatience() * 0.5);
    }
  }

  /** Come for you, and look for an opening once there. */
  private engage(): void {
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

    const fw = this.species.footwork;
    const settle = fw.settle * (0.5 + Math.random());
    const fwd = range > outer ? 1 : range < inner ? -1 : 0;

    if (fwd === 0 && Math.random() < WATCH) {
      this.step = { fwd: 0, side: 0, time: 0, settle: settle * 2 };
      return;
    }
    if (fwd >= 0 && Math.random() < fw.feint
      && this.roomFor(self, -1, 0, this.pace * DART * 1.3)) {
      this.step = { fwd: 1, side: 0, time: DART, settle: 0.04 };
      this.queue.push({ fwd: -1, side: 0, time: DART * 1.3, settle });
      return;
    }

    if (Math.random() < REVERSE) this.side = -this.side;
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
  private retreat(self: Combatant): void {
    const time = this.stride();
    const slant = Math.random() < 0.6 ? this.side : 0;
    const move = this.findRoom(self, -1, slant, this.pace * time);
    if (move === null || move.fwd >= 0) {
      this.circle(this.rollPatience());
      return;
    }
    if (move.side !== 0) this.side = move.side;
    this.step = { fwd: move.fwd, side: move.side, time, settle: 0.05 };
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
    if (threat && !this.threatened && this.rest <= 0 && this.flinch < 0
      && LOOSE.has(this.state) && Math.random() < this.species.footwork.wariness) {
      this.flinch = REACT[0] + Math.random() * (REACT[1] - REACT[0]);
    }
    this.threatened = threat;

    if (this.flinch < 0) return;
    this.flinch -= dt;
    if (this.flinch < 0 && LOOSE.has(this.state)) this.evade(self);
  }

  /** Is a swing coming its way: your blade near it, and coming at it? */
  private threat(self: Combatant, foe: Combatant): boolean {
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
    if (gap >= self.fighter.build.hull.radius + DANGER) return false;

    // And how fast the point is coming at its middle. See SWING.
    const v = arm.tipVelocity;
    const carried = foe.fighter.body.linvel();
    const dx = this._self.x - tip.x;
    const dy = this._self.y - tip.y;
    const dz = this._self.z - tip.z;
    const d = Math.hypot(dx, dy, dz);
    const closing = d < 1e-6 ? SWING + 1
      : ((v.x - carried.x) * dx + (v.y - carried.y) * dy + (v.z - carried.z) * dz) / d;
    if (closing <= SWING) return false;
    this._near.set(nearX, 0, nearZ);
    return true;
  }

  /** Step back, and away from the side your blade is on. */
  private evade(self: Combatant): void {
    this.rest = DODGE_REST;
    const yaw = self.fighter.yaw;
    const across = (this._near.x - this._self.x) * Math.cos(yaw)
      - (this._near.z - this._self.z) * Math.sin(yaw);
    const move = this.findRoom(self, -1, across > 0 ? -1 : 1, this.pace * DODGE);
    // Nowhere to go, it stands and takes it.
    if (move === null) return;
    this.stand();
    this.step = { fwd: move.fwd, side: move.side, time: DODGE, settle: 0.06 };
    this.hold(move.fwd, move.side);
    this.begin("evade", 0);
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
  }

  private stride(): number {
    return STRIDE[0] + Math.random() * (STRIDE[1] - STRIDE[0]);
  }

  private rollPatience(): number {
    const [lo, hi] = this.species.footwork.patience;
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

    arm.probeStrike(this.level.yaw, this.level.pitch, 1, this.refRoll, t, this._probe);
    this.strikeReach = Math.max(
      0.2, Math.hypot(this._probe.x - this._self.x, this._probe.z - this._self.z));
  }

  /**
   * Where the part of you a swing is aimed at is, now.
   *
   * Only what it can see of you: your head, the middle of your chest, the
   * forearm your sword is in, and the nearer of your thighs. A part that is no
   * longer there to aim at -- an arm you have lost -- leaves your chest.
   */
  private target(foe: Combatant, aim: Aim, out: THREE.Vector3): THREE.Vector3 {
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
    // The middle of your chest, wherever a crouch has taken it.
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

  /** The resting guard: weapon up, a little across, level with the chest. */
  private guard(lift = 0.15): void {
    this.want = {
      yaw: this.level.yaw + 0.3,
      pitch: this.level.pitch + lift,
      reach: 0.55,
      roll: 0,
    };
  }

  private begin(state: State, seconds: number): void {
    this.state = state;
    this.timer = seconds;
    this.clock = 0;
    this.stall = 0;
  }

  private idle(): void {
    this.keys.forward = false;
    this.keys.back = false;
    this.keys.left = false;
    this.keys.right = false;
    this.keys.turnLeft = false;
    this.keys.turnRight = false;
    this.keys.jump = false;
  }

  /** Turn toward the foe using the same turn keys the player has. */
  private face(self: Combatant, toFoe: THREE.Vector3): void {
    // Torso-forward is -Z, so the yaw that points at a direction d is
    // atan2(-d.x, -d.z).
    const wanted = Math.atan2(-toFoe.x, -toFoe.z);
    let err = wanted - self.fighter.yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;

    const dead = 0.06;
    this.keys.turnLeft = err > dead;
    this.keys.turnRight = err < -dead;
    this.squared = Math.abs(err) < SQUARE;
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
    this.seen = 0;
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
    this.flinch = -1;
    this.rest = 0;
    this.sinceNear = Infinity;
    this.leapRest = 0;
    this.closing = 0;
    this.coming = 0;
    this.idle();
  }
}
