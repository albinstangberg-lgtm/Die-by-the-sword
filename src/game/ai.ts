import * as THREE from "three";
import type { ArmInput } from "./arm";
import type { Combatant } from "./combatant";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";
import type { Attack, Species } from "./species";

/**
 * An opponent that tells you what it is about to do.
 *
 * It does not get to cheat. It drives its weapon arm by emitting MOUSE DELTAS
 * through the same `ArmInput` surface the player's pointer feeds, so its blade
 * is subject to the same force clamp, the same reach limits, the same
 * saturating PD controller. It cannot teleport its weapon, it cannot swing
 * faster than an arm can be moved, and if it buries its axe in a pillar it is
 * stuck there exactly as long as you would be.
 *
 * What it has that stage 4's opponent did not is a REPERTOIRE. Its swings come
 * from a short list of named attacks, each with a windup long enough to read,
 * and while one is winding the weapon lights up and the HUD says which it is
 * and how to beat it. That is the contract: the enemy commits out loud, and
 * the fight is about whether you can do something with the three quarters of a
 * second it just gave you.
 *
 * None of that makes an attack scripted. Once it commits, the arm is still
 * being dragged toward a target pose under a clamped force. It overswings, it
 * catches the low beam, it plants the axe in the floor, and the damage it does
 * comes out of how fast the weapon happened to be travelling when it arrived.
 *
 * The attack table is written in offsets from LEVEL -- the arm pitch at which
 * this creature's own weapon would cross its target's chest -- which is solved
 * from its own kinematics when it winds up. One table therefore describes the
 * same swing for a goblin and for an orc twice its height.
 *
 * And between attacks it has FOOTWORK. It used to walk up to you, stop, and
 * swing, and swing again: nine tenths of a fight went on winding up, striking
 * and recovering, and in forty seconds of it an opponent moved twenty
 * centimetres sideways. Now it circles you in short steps at the edge of its
 * own reach, drifting in or out to stay there; it gives ground after a swing
 * about as often as it presses; now and then it darts in and straight back
 * out; and it gets out of the way of a blade it sees coming. Every step goes
 * through the same four keys yours do -- its sidestep is Q and E too -- so it
 * has no way of moving that you have not.
 */

/** How fast the AI is allowed to move its hand, in pixels of mouse per second. */
const HAND_SPEED = 1100;

/** Where on a body an attack is aimed, 0 at the feet and 1 at the crown. */
const AIM_AT = 0.72;

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
 * barely in reach, and swung nearly nine in ten attacks from the last hand's
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

type State =
  | "close" | "circle" | "backoff" | "evade"
  | "windup" | "strike" | "recover" | "free" | "beaten"
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
    turnLeft: false, turnRight: false, jump: false,
  };

  private state: State = "waiting";
  private timer = 0;
  private attack: Attack;
  /**
   * Where "level" is for this creature, at the wound-up reach and at the
   * extended one.
   *
   * Two of them, because a thrust needs both. Extending the arm swings the
   * elbow through a large angle, and the weapon held along the forearm swings
   * with it -- so a thrust that only aims its end pose comes in rotating about
   * the hand, which puts the point's whole velocity at right angles to the
   * shaft. Aiming BOTH ends at the target leaves the shaft pointing the same
   * way in each, and the only thing left between them is the hand travelling
   * up its own line. That is a thrust.
   *
   * `yaw` is zero for anything that swings: an edge's table is written against
   * torso-forward and was tuned that way.
   */
  private levelFrom = { yaw: 0, pitch: 0 };
  private levelTo = { yaw: 0, pitch: 0 };
  /** Measured horizontal distance its percussion point covers, metres. */
  private strikeReach = 1;
  private windupLength = 1;

  /**
   * Forces a single attack, so one line's geometry can be measured in
   * isolation. This is how the tables are tuned; leave it null in play.
   */
  attackOverride: Attack | null = null;

  private want = { yaw: 0.3, pitch: -0.15, reach: 0.6, roll: 0 };

  private dx = 0;
  private wheel = 0;
  private dy = 0;
  private rollDx = 0;

  private readonly _self = new THREE.Vector3();
  private readonly _foe = new THREE.Vector3();
  /** Where it is looking: the eyes of whatever it has seen. */
  private readonly _gaze = new THREE.Vector3();
  private readonly _probe = new THREE.Vector3();
  private readonly _mark = new THREE.Vector3();
  private readonly _was = new THREE.Vector3();
  /** The nearest your swinging blade came to it, flat: the side to step away from. */
  private readonly _near = new THREE.Vector3();
  private snag = 0;
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

  constructor(readonly species: Species) {
    this.attack = species.attacks[0];
  }

  /** Visible in the HUD, so it is obvious what it is up to. */
  get intent(): string {
    return this.state;
  }

  /** The attack it is currently committed to, or null if it is not. */
  get committed(): Attack | null {
    return this.state === "windup" || this.state === "strike" ? this.attack : null;
  }

  /** 0..1 through the windup. What the weapon's glow is showing. */
  get tell(): number {
    if (this.state === "windup") {
      return 1 - Math.max(0, Math.min(1, this.timer / this.windupLength));
    }
    return this.state === "strike" ? 1 : 0;
  }

  /** Run once per fixed step, before the arm reads its input. */
  think(self: Combatant, foe: Combatant, t: Tuning, dt: number): void {
    if (self.dead) {
      this.state = "beaten";
      this.idle();
      this.showTell(self);
      self.fighter.focus = null;
      return;
    }

    // On the floor. There is nothing to decide: the body gets itself up, and
    // whatever it was winding up when it went over is gone.
    if (self.fighter.down) {
      if (this.state !== "down") this.begin("down", 0);
      this.idle();
      this.showTell(self);
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
      this.showTell(self);
      this._was.copy(this._self);
      return;
    }
    if (this.state === "waiting") this.engage();

    this.face(self, toFoe);
    this.timer -= dt;

    // Disarmed: no weapon, no plan. It backs away rather than pretending.
    if (self.arm.disarmed) {
      this.state = "beaten";
      this.hold(range < 3.0 && this.roomFor(self, -1, 0, 0.3) ? -1 : 0, 0);
      this.keys.jump = false;
      this.steerArm(self, t, dt);
      this.showTell(self);
      return;
    }

    // Rocked back on its heels. Its feet are busy keeping it up, and whatever
    // it was doing -- a windup, a strike half thrown -- it is not doing now.
    // This is the only way to take an attack off something once it has
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

      case "windup":
        // The tell. It stands still and shows you the weapon, and the longer
        // the attack the longer it stands there.
        this.want = {
          yaw: this.levelFrom.yaw + this.attack.from.yaw,
          pitch: this.levelFrom.pitch + this.attack.from.pitch,
          reach: this.attack.from.reach,
          roll: this.attack.roll,
        };
        this.hold(0, 0);
        // The windup runs its DECLARED length, every time.
        //
        // It used to commit early the moment the arm reached the wound-up
        // pose, which on a fast arm cut the orc's three-quarter-second cleave
        // in half. That is not a telegraph, it is a threat that sometimes
        // lies; a player cannot learn a tell whose length depends on how
        // cleanly the last swing finished. The timer alone also covers the
        // case this was guarding against -- a weapon caught on scenery no
        // longer holds the windup open forever, because the clock does not
        // care whether the arm got there.
        if (this.timer <= 0) this.begin("strike", this.attack.strike);
        break;

      case "strike":
        // Aim THROUGH the target, not at it. Sweeping to a point short of the
        // foe decelerates into the hit and lands a shove; the whole damage
        // model is built on speed at contact.
        this.want = {
          yaw: this.levelTo.yaw + this.attack.to.yaw,
          pitch: this.levelTo.pitch + this.attack.to.pitch,
          reach: this.attack.to.reach,
          roll: this.attack.roll,
        };
        // Stepping in closes to where the weapon works, not to contact. An
        // attack that walks all the way in ends up swinging its arc past the
        // target and connecting with whatever is left -- which for an axe
        // meant landing every single blow on a shin.
        this.hold(
          this.attack.step > 0 && range > strike ? 1
            : this.attack.step < 0 && this.roomFor(self, -1, 0, 0.3) ? -1 : 0,
          0);
        if (this.timer <= 0) this.begin("recover", this.attack.recover);
        break;

      case "recover":
        // Open. This is the window the windup bought you.
        this.guard();
        this.hold(range < close && this.roomFor(self, -1, 0, 0.3) ? -1 : 0, 0);
        if (this.timer <= 0) this.afterSwing(self);
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
          yaw: this.levelTo.yaw + 0.2, pitch: this.levelTo.pitch - 0.9, reach: 0, roll: 0,
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

    this.steerArm(self, t, dt);
    this.showTell(self);
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
   * Pick the next attack and start winding it.
   *
   * The level pitch is solved once, here, and held for the whole swing. Chasing
   * a moving target through the strike would make every attack home, which is
   * precisely what a telegraph is supposed to rule out: you should be able to
   * step out of the line it committed to.
   */
  private commit(range: number): void {
    const usable = this.species.attacks.filter((a) => {
      if (!a.at) return true;
      const f = range / this.strikeReach;
      return f >= (a.at.min ?? 0) && f <= (a.at.max ?? Infinity);
    });
    const list = usable.length > 0 ? usable : this.species.attacks;
    this.attack = this.attackOverride ?? list[(Math.random() * list.length) | 0];
    this.windupLength = this.attack.windup;
    this.flinch = -1;
    this.begin("windup", this.attack.windup);
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
   * it fighting: it would only ever step back, and every attack wanted room it
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
    if (foe.dead || foe.fighter.down || foe.arm.disarmed) return false;
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
   * Re-measure what this body can reach and where level is.
   *
   * Both come from the arm's own kinematics, so a goblin measures a goblin's
   * spear and an orc measures an orc's axe, and neither needs to be told a
   * number in metres.
   */
  private measure(self: Combatant, foe: Combatant, t: Tuning): void {
    const chest = this._foe.y
      - foe.fighter.build.hullCentreY
      + foe.fighter.build.standing.crown * AIM_AT;

    if (this.state !== "strike") {
      // An edge wants its arc to cross the chest; a point wants to be aimed at
      // it, which takes both angles rather than just the pitch. Same table of
      // offsets either way -- only what "level" means changes, and it changes
      // with what is in the hand.
      const roll = this.attack.roll;
      if (self.arm.weapon.bite === "point") {
        this._mark.set(this._foe.x, chest, this._foe.z);
        self.arm.aimPointAt(this._mark, this.attack.from.reach, roll, t, this.levelFrom);
        self.arm.aimPointAt(this._mark, this.attack.to.reach, roll, t, this.levelTo);
      } else {
        this.levelFrom.yaw = 0;
        this.levelTo.yaw = 0;
        this.levelFrom.pitch = self.arm.solvePitchForHeight(chest, 0, 1, roll, t);
        this.levelTo.pitch = this.levelFrom.pitch;
      }
    }
    self.arm.probeStrike(
      this.levelTo.yaw, this.levelTo.pitch, 1, this.attack.roll, t, this._probe);
    this.strikeReach = Math.max(
      0.2, Math.hypot(this._probe.x - this._self.x, this._probe.z - this._self.z));
  }

  /** The resting guard: weapon up, a little across, level with the chest. */
  private guard(lift = 0.15): void {
    this.want = {
      yaw: this.levelTo.yaw + 0.3,
      pitch: this.levelTo.pitch + lift,
      reach: 0.55,
      roll: 0,
    };
  }

  private begin(state: State, seconds: number): void {
    this.state = state;
    this.timer = seconds;
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

  /** Light the weapon in proportion to how far through the windup it is. */
  private showTell(self: Combatant): void {
    self.arm.setTell(this.tell);
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

    const need = (delta: number) => {
      const px = delta / t.sensitivity;
      return Math.max(-budget, Math.min(budget, px));
    };

    // readInput does `armYaw -= dx * sensitivity`, so closing a positive yaw
    // gap needs a negative dx.
    this.dx += -need(this.want.yaw - aim.yaw);
    // and `armPitch += dy * sensitivity * -1` when invertY is off.
    this.dy += -need(this.want.pitch - aim.pitch) * (t.invertY ? -1 : 1);
    this.rollDx += Math.max(-budget, Math.min(budget,
      (this.want.roll - aim.roll) / t.rollSensitivity));

    // Reach is a fraction of its own arm, turned back into wheel notches.
    const wantReach = self.arm.reachAt(this.want.reach);
    this.wheel += Math.max(-4, Math.min(4, (wantReach - aim.reach) / t.reachRate));
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
    this.levelFrom = { yaw: 0, pitch: 0 };
    this.levelTo = { yaw: 0, pitch: 0 };
    this.snag = 0;
    this.attack = this.species.attacks[0];
    this.stand();
    this.patience = 0;
    this.crowd = 0;
    this.squared = false;
    this.sighted = false;
    this.threatened = false;
    this.flinch = -1;
    this.rest = 0;
    this.idle();
  }
}
