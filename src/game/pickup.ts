import * as THREE from "three";
import type { Keys } from "../input/input";
import type { Combatant } from "./combatant";
import { wrap } from "./clearance";
import { smoothstep } from "./motion";
import { holds, inRange, PULLED, refusal, take, type Item, type Items, type Outcome } from "./items";

/**
 * Picking something up, as a thing a body does.
 *
 * It walks over, turns so the thing is under its sword hand, gets down to it
 * if it is on the floor -- a crouch taken further, bowed over (see
 * `Fighter.stoop`) -- and reaches for it. The hand is guided there under the
 * arm's own clamped drive, so it gets as close as that arm does and no
 * closer; what it has hold of eases the last of the way into it. Then it
 * straightens up, and only then is the thing its: a potion in the bag, a
 * shield strapped to the other arm, a piece of somebody -- or their weapon --
 * kept in the hand.
 *
 * A lever is gone to the same way, and the hand takes hold of its handle --
 * jointed to it, where the hand got to -- and pulls it down: the hand's own
 * ghost is taken down the arc the handle goes round, and the arm follows it
 * under the same clamped drive as ever, the lever's spring pulling back on
 * the hand through the joint the whole way. The body leans into it. Down far
 * enough, the lever catches (see gate.ts), and the hand lets go of it.
 *
 * The body is walked the way a player walks it, through the same keys, so the
 * same feet and the same walls apply -- and a key the player presses that was
 * not already down takes the body straight back, and the pick-up is off.
 *
 *   approach   to where the thing is under the sword hand, facing it
 *   reach      down to it, the hand going for it
 *   pull       a lever: the hand on it, bringing it down
 *   rise       back up with it
 */

type Phase = "approach" | "reach" | "pull" | "rise";

/**
 * Where a body stands to take something, metres at human scale: how far
 * ahead of its middle, and how far to the sword side, the thing is. Further
 * ahead for the floor, which a stoop bows the shoulder out over.
 */
const STAND_FLOOR = { ahead: 0.55, side: 0.24 };
const STAND_HIGH = { ahead: 0.42, side: 0.22 };
/** Below this, metres at human scale, a thing is on the floor and needs a stoop. */
const LOW = 0.7;
/** Near enough to where it means to stand, metres at human scale, and square enough, radians. */
const THERE = 0.1;
const SQUARE = 0.07;
/** And how long it may take getting there before it gives up, seconds. */
const APPROACH_TIME = 4;
/** Reaching down, and straightening up again: seconds at human scale. */
const REACH_TIME = 0.4;
const RISE_TIME = 0.35;
/** Close enough to take hold, metres at human scale. */
const GRAB = 0.08;
/** How much longer than its time a reach waits for a hand still on its way. */
const REACH_GRACE = 2.2;
/** How fast a stoop goes down and comes back up, per second. */
const STOOP_RATE = 7;

/**
 * Close enough to a lever's handle to take hold of it, metres at human scale:
 * nearer than for anything picked up. The hand is jointed on where it has got
 * to, and a hand held off the bar would be pulling on air.
 */
const GRAB_LEVER = 0.03;
/** Bringing a lever down, seconds at human scale, and how much longer than that it may take. */
const PULL_TIME = 0.75;
const PULL_GRACE = 2.5;
/**
 * How far past its bottom stop the hand's ghost is taken, radians: a hand
 * holding a spring back lags its ghost by as much as the spring pulls, and
 * sent only to the stop it would stop short of the catch.
 */
const PULL_PAST = 0.4;
/** How far a body leans into a pull by the end of it: a share of a stoop. */
const PULL_LEAN = 0.2;

/** Every key the player could be holding, to know when they press a new one. */
const KEYS: readonly (keyof Keys)[] = [
  "forward", "back", "left", "right", "turnLeft", "turnRight", "jump", "vault", "crouch",
];

export class Pickup {
  private item: Item | null = null;
  private phase: Phase = "approach";
  private time = 0;
  /** Where to stand, world, and which way to face. */
  private readonly stand = new THREE.Vector3();
  private face = 0;
  /** It is on the floor. */
  private low = false;
  /** What the hand has hold of, once it has. */
  private holding = false;
  /** A lever: the angle the hand took hold of it at, and whether it came down and caught. */
  private pullFrom = 0;
  private pulled = false;
  /** Where the hand was last sent, pulling: where it lets go of the lever from. */
  private readonly pullTo = new THREE.Vector3();
  /** Keys that were already down when it started, until they come up. */
  private readonly held = new Set<keyof Keys>();
  private readonly keys: Keys = {
    forward: false, back: false, left: false, right: false,
    turnLeft: false, turnRight: false, jump: false, vault: false, crouch: false, pivot: false,
    dash: false,
  };
  private readonly _e = new THREE.Vector3();

  constructor(private readonly who: Combatant, private readonly items: Items) {}

  /** Going to get something. */
  get active(): boolean {
    return this.item !== null;
  }

  /** What it is going to get, or null. */
  get target(): Item | null {
    return this.item;
  }

  /**
   * Go and get whatever is nearest and in sight. Says why not, or what it is
   * going for; what it comes to goes to `step`'s `done`.
   */
  start(held: Keys): Outcome {
    const who = this.who;
    if (this.item) return { ok: false, text: "" };
    const f = who.fighter;
    if (!f.grounded || f.vaulting || f.climbing) return { ok: false, text: "" };
    const item = inRange(who, this.items);
    if (!item) return { ok: false, text: "nothing to pick up" };
    const no = refusal(who, item);
    if (no !== null) return { ok: false, text: no };

    const s = f.build.scale;
    this.low = item.grip.y < LOW * s;
    const at = f.body.translation();
    const where = this.low ? STAND_FLOOR : STAND_HIGH;
    // Face so the thing sits ahead and to the sword side: turned that much
    // away from looking straight at it, unless it has its own way to be faced.
    this.face = item.face ?? (Math.atan2(-(item.grip.x - at.x), -(item.grip.z - at.z))
      + Math.atan2(where.side, where.ahead));
    const sin = Math.sin(this.face);
    const cos = Math.cos(this.face);
    const x = where.side * s;
    const z = -where.ahead * s;
    this.stand.set(item.grip.x - (x * cos + z * sin), 0, item.grip.z - (-x * sin + z * cos));

    this.item = item;
    this.phase = "approach";
    this.time = 0;
    this.holding = false;
    this.pulled = false;
    this.held.clear();
    for (const k of KEYS) if (held[k]) this.held.add(k);
    return { ok: true, text: `going for ${item.kind === "rack" ? "the rack" : item.name}` };
  }

  /**
   * A step of it, before the body is driven. Returns the keys to drive the
   * body with in place of the player's, or null when it is not under way --
   * and `done` hears what came of it, once it is over.
   */
  step(player: Keys, dt: number, done: (o: Outcome) => void): Keys | null {
    const item = this.item;
    if (!item) return null;
    const who = this.who;
    const f = who.fighter;

    // Anything that takes the body or the hand away calls it off: a blow, a
    // fall, the sword drawn, the hand cut off, or a key that was not already
    // down.
    for (const k of KEYS) if (!player[k]) this.held.delete(k);
    const pressed = KEYS.some((k) => player[k] && !this.held.has(k));
    if (pressed || who.dead || f.down || f.reeling || !who.arm.sheathed || who.arm.stowing
      || who.arm.disarmed) {
      this.cancel();
      if (!pressed && !who.dead && !f.down) done({ ok: false, text: "" });
      return null;
    }

    this.time += dt;
    const s = f.build.scale;
    const keys = this.keys;
    for (const k of KEYS) keys[k] = false;

    switch (this.phase) {
      case "approach": {
        const p = f.body.translation();
        const e = this._e.set(this.stand.x - p.x, 0, this.stand.z - p.z)
          .applyAxisAngle(UP, -f.yaw);
        const turn = wrap(this.face - f.yaw);
        // Letting go early by as far as the feet will carry it once the key
        // comes up: holding on to the last centimetre, a body eased to a
        // stop went past the spot, back, and past it again until it gave up.
        const sin = Math.sin(f.yaw);
        const cos = Math.cos(f.yaw);
        const ahead = f.coast(-sin, -cos);
        const behind = f.coast(sin, cos);
        const right = f.coast(cos, -sin);
        const left = f.coast(-cos, sin);
        keys.forward = -e.z - ahead > THERE * s;
        keys.back = e.z - behind > THERE * s;
        keys.right = e.x - right > THERE * s;
        keys.left = -e.x - left > THERE * s;
        keys.turnLeft = turn > SQUARE;
        keys.turnRight = turn < -SQUARE;
        const there = Math.hypot(e.x, e.z) < THERE * 1.5 * s && Math.abs(turn) < SQUARE * 1.5;
        if (there) this.next("reach");
        else if (this.time > APPROACH_TIME) {
          this.cancel();
          done({ ok: false, text: `can't get to ${item.kind === "rack" ? "the rack" : item.name}` });
          return null;
        }
        break;
      }
      case "reach": {
        const span = REACH_TIME * Math.sqrt(s);
        const u = Math.min(1, this.time / span);
        if (this.low) f.stoop += (1 - f.stoop) * Math.min(1, STOOP_RATE * dt);
        who.arm.guide(item.grip, smoothstep(0, 1, u));
        const lever = item.lever;
        const near = who.arm.handPosition.distanceTo(item.grip) < (lever ? GRAB_LEVER : GRAB) * s;
        if ((u >= 1 && near) || this.time > span * REACH_GRACE) {
          // A lever the hand got to, it takes hold of, and pulls. One it
          // could not get a hand on -- or that has come down meanwhile -- it
          // leaves be.
          if (lever) {
            if (!near || !lever.takeHold(who.arm)) {
              this.cancel();
              done({ ok: false, text: lever.caught ? "the lever is down" : "can't get a hand on the lever" });
              return null;
            }
            this.pullFrom = lever.angle;
            this.next("pull");
            break;
          }
          // Hanging a shield back up: it goes onto the rack as the hand gets
          // there. Anything else comes away in the hand.
          if (item.kind === "rack" && item.taken) {
            done(take(who, this.items, item));
          } else {
            this.items.lift(item, who.arm.palm);
            this.holding = true;
          }
          this.next("rise");
        }
        break;
      }
      case "pull": {
        // Down the handle's arc, and on past the stop, as fast as a hand
        // brings a lever down; the lever comes as far as the arm can make it.
        const lever = item.lever!;
        const span = PULL_TIME * Math.sqrt(s);
        const u = Math.min(1, this.time / span);
        const to = lever.bottom - PULL_PAST;
        lever.gripAt(this.pullFrom + (to - this.pullFrom) * smoothstep(0, 1, u), this.pullTo);
        who.arm.guide(this.pullTo, 1);
        f.stoop += (PULL_LEAN * smoothstep(0, 1, u) - f.stoop) * Math.min(1, STOOP_RATE * dt);
        if (lever.caught || this.time > span * PULL_GRACE) {
          this.pulled = lever.caught;
          lever.letGo();
          this.pullTo.copy(who.arm.handPosition);
          this.next("rise");
        }
        break;
      }
      case "rise": {
        const u = Math.min(1, this.time / (RISE_TIME * Math.sqrt(s)));
        f.stoop += (0 - f.stoop) * Math.min(1, STOOP_RATE * dt);
        // Off a lever, from wherever the hand let go of it.
        who.arm.guide(item.lever ? this.pullTo : item.grip, 1 - smoothstep(0, 1, u));
        if (this.holding) this.items.settle(smoothstep(0, 0.5, u));
        if (u >= 1) {
          if (item.lever) {
            const caught = this.pulled;
            this.finish();
            done(caught ? { ok: true, text: PULLED } : { ok: false, text: "the lever springs back up" });
            return null;
          }
          const held = this.holding;
          // A piece of somebody stays in the hand that has it.
          this.finish(held && holds(item));
          if (held) done(take(who, this.items, item));
          return null;
        }
        break;
      }
    }
    return keys;
  }

  /**
   * Off: the hand goes back to the aim, the body straightens, and anything in
   * the hand goes back where it was -- or, a lever, is let go of.
   */
  cancel(): void {
    this.finish();
  }

  /** Done: the hand and the body back to themselves -- and what the hand has, unless it `keep`s it. */
  private finish(keep = false): void {
    const item = this.item;
    if (!item) return;
    this.item = null;
    this.holding = false;
    item.lever?.letGo();
    this.who.arm.guide(null);
    this.who.fighter.stoop = 0;
    if (!keep) this.items.putBack();
  }

  private next(phase: Phase): void {
    this.phase = phase;
    this.time = 0;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
