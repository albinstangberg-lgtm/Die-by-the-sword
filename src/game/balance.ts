import * as THREE from "three";
import type { Build } from "./anatomy";
import type { Impact } from "./impacts";

/**
 * What a blow does to a body that has to stay on its feet.
 *
 * Damage asks how well a blow was thrown. This asks how HARD it was, and the
 * answer depends as much on what it landed on as on what threw it. There is no
 * poise bar or stagger resistance here: it is momentum going into a body of a
 * given weight, and whether that body can step out of what it was given.
 *
 *   the blow     the weapon and the arm swinging it, arriving at the closing
 *                speed. It meets the whole body the way two masses meet when
 *                they stick, so the body's share of the speed is
 *
 *                    dv = closing speed x m_blow / (m_blow + M)
 *
 *                and the same cut that moves a 38kg goblin at 1.3 m/s moves a
 *                173kg orc at 0.3. The weight of the thing is the whole of it.
 *   footing      planted feet soak up the first of that. Friction can hold
 *                u*M*g for as long as the blade is in contact, which comes out
 *                as a speed, u*g*t, the same for everything that stands -- and
 *                enough that most blows on an orc go nowhere at all.
 *   leverage     a blow off the middle of a body turns it as well as pushing
 *                it, and a turn is harder to step out of than a slide. High,
 *                it goes over its feet; low, the feet go out from under it.
 *   balance      what is left is set against the speed that body can step
 *                out of. That goes as the square root of gravity times leg
 *                length -- the Froude number every walking animal shares --
 *                so a goblin cannot simply be sturdier for its size: it is
 *                shorter, and it weighs a fifth of the orc.
 *
 * Past a fraction of its balance a body staggers: its feet have to scramble,
 * and whatever it was winding up is gone. Past all of it, it goes down.
 *
 * Only the sideways part of a blow counts against balance. A blow straight
 * down drives a body into the floor, and the floor pushes back.
 *
 * All of that is a blade's blow, which goes in and stops. A club's does not
 * (see `Weapon.rebound`): its head comes back off the body it lands on,
 * which hands over up to twice the momentum along the line it drove in on,
 * and rough oak that hard against a body does not slide off it either, so
 * most of the club's speed across the body goes with the body too. The body
 * goes the way the club was going -- and if that was up, up: the floor
 * pushes back on a blow driving a body down into it, but nothing holds a
 * body down on it. That is what being sent flying is.
 */

/** A boot on stone. */
const GRIP = 0.8;
/** How long a blade takes to cross a body, seconds: the time friction has to hold. */
const CONTACT = 0.03;
/** Past this share of its balance a body has to step to stay up: it staggers. */
const STAGGER = 0.4;
/**
 * Below this, m/s, what is left after the feet slides a body less than a
 * centimetre before they catch it. It still happens; it just does not budge.
 */
const BUDGE = 0.15;
/**
 * How much of a blow a body takes, against the speed its momentum hands it.
 * Everything in here -- what the feet soak up, what budges a body, how far a
 * shove carries it, a body's balance, and what a club throws it up with --
 * was set against a weapon's speed measured about its grip, half as fast
 * again as it goes (see `Arm.velocityAt`). Measured honestly, with only
 * `Tuning.balance` and the ogre's heave fitted again, the feet soaked up half
 * as much again of every blade's blow -- the orc's axe rocked you a quarter
 * less often and the swordsman's sword hardly ever -- while the ogre, fitted
 * by how high it lifts you, put you down two fifths more often. As
 * `DAMAGE_PER_MS` puts back what a cut does, this puts back what a blow does.
 */
const REACTION = 1.5;
/**
 * How much harder a blow is to stand up to, per body-centre-height it lands
 * off the middle. A rigid body says far more than this -- people are not
 * rigid, and a neck and a pair of knees give.
 */
const LEVER = 0.5;
/**
 * How much of a club's speed across a body goes with the body, against the
 * rebound's along the line it drove in on: rough wood and iron studs, and
 * enough force behind them that they do not slide -- up to what friction
 * lets them, `GRIP_OAK` times what the blow drives in along the line. A
 * glancing club cannot drag a body along any faster than it presses on it.
 */
const CARRY = 0.85;
const GRIP_OAK = 0.6;
/**
 * A body thrown upward has nothing under it to step out of the blow with:
 * this much of the lift counts against its balance as a shove along the
 * floor would.
 */
const LIFT_TOPPLE = 1;

/** What a blow did, weakest first. */
export type Knock = "none" | "shove" | "stagger" | "down";

export interface Blow {
  effect: Knock;
  /** Everything still attached to the body it landed on, kg. */
  mass: number;
  /** The whole body's change of speed, before its feet take any of it, m/s. */
  speed: number;
  /** What is left once they have: horizontal, world, m/s. */
  knock: THREE.Vector3;
  /**
   * The whole body's change of velocity, world, m/s, before its feet take
   * any of it: `speed` of it, and which way. What shoves a body lying on
   * the floor, where there are no feet to take anything.
   */
  push: THREE.Vector3;
  /**
   * How fast it throws the body up off the floor, m/s: the upward part of
   * a club's blow (see `Weapon.rebound`). A blade's never does.
   */
  lift: number;
  /** Which way along the ground it drives: a horizontal unit vector, world. */
  dir: THREE.Vector3;
  /** How hard it tried to put the body over, as a speed to step out of, m/s. */
  topple: number;
  /** That, against what this body can step out of: 1 or more and it is down. */
  severity: number;
  /**
   * Which way it goes over: +1 if the blow landed above the body's middle, so
   * the top goes along it, -1 if below, where it takes the feet and the body
   * falls back across it.
   */
  over: number;
}

export function emptyBlow(): Blow {
  return {
    effect: "none", mass: 0, speed: 0, knock: new THREE.Vector3(), push: new THREE.Vector3(), lift: 0,
    dir: new THREE.Vector3(), topple: 0, severity: 0, over: 1,
  };
}

/** What the body is doing when the blow lands. */
export interface Footing {
  /** Everything still attached to it, kg. */
  mass: number;
  build: Build;
  /** World height of the soles of its feet. */
  soles: number;
  /** Feet on something to push against. */
  grounded: boolean;
}

/**
 * How much faster a body of mass `bodyMass` is moving once a blow of mass
 * `blowMass` has arrived at `closing` m/s and gone no further: an inelastic
 * collision's share. It can never exceed the speed of the blow itself.
 */
export function blowSpeed(blowMass: number, bodyMass: number, closing: number): number {
  const total = blowMass + bodyMass;
  return total > 0 ? (closing * blowMass) / total : 0;
}

/** The speed planted feet absorb outright, m/s. */
export function footing(gravity: number): number {
  return GRIP * Math.abs(gravity) * CONTACT;
}

/**
 * The fastest shove a body of this build can step out of, m/s: a Froude
 * number times the square root of gravity times its leg length.
 */
export function balanceSpeed(build: Build, gravity: number, froude: number): number {
  return froude * Math.sqrt(Math.abs(gravity) * build.standing.hip);
}

/**
 * Judge a blow against the body it landed on. Pure: nothing is moved, which
 * is the body's business. Writes into `out` and returns it.
 */
export function judgeBlow(
  impact: Impact, body: Footing, gravity: number, froude: number, out: Blow,
): Blow {
  out.mass = body.mass;
  out.lift = 0;
  const rebound = impact.weapon.rebound ?? 0;
  if (rebound > 0) return carried(impact, body, gravity, froude, rebound, out);
  out.speed = blowSpeed(impact.blowMass, body.mass, impact.closingSpeed * REACTION);
  out.push.copy(impact.into).multiplyScalar(out.speed);

  // Along the ground: the line the blow drives in on, or failing that -- a
  // chop from straight above -- the way the blade was travelling.
  const into = impact.into;
  let flat = Math.hypot(into.x, into.z);
  if (flat > 1e-6) {
    out.dir.set(into.x / flat, 0, into.z / flat);
  } else {
    const v = impact.bladeVelocity;
    const vFlat = Math.hypot(v.x, v.z);
    if (vFlat > 1e-6) out.dir.set(v.x / vFlat, 0, v.z / vFlat); else out.dir.set(0, 0, 0);
    flat = 0;
  }

  return settle(impact, body, gravity, froude, out.speed * flat, 0, out);
}

/**
 * A club's blow: it comes back off the body along the line it drove in on,
 * handing over up to twice the momentum there, and carries the body with it
 * across that line -- so the body goes the way the club was going, and up
 * if it was coming up. See `Weapon.rebound`.
 */
function carried(
  impact: Impact, body: Footing, gravity: number, froude: number, rebound: number, out: Blow,
): Blow {
  const v = impact.bladeVelocity;
  const into = impact.into;
  const along = v.x * into.x + v.y * into.y + v.z * into.z;
  const share = blowSpeed(impact.blowMass, body.mass, REACTION);
  // Along the line it drove in on, bounced; across it, carried, as far as
  // friction will.
  const n = Math.max(0, along) * (1 + rebound) * share;
  const ax = v.x - into.x * along;
  const ay = v.y - into.y * along;
  const az = v.z - into.z * along;
  const across = Math.hypot(ax, ay, az);
  const t = across > 1e-6 ? Math.min(CARRY * share * across, GRIP_OAK * n) / across : 0;
  const dx = into.x * n + ax * t;
  const dy = into.y * n + ay * t;
  const dz = into.z * n + az * t;
  out.push.set(dx, dy, dz);
  out.speed = Math.hypot(dx, dy, dz);
  const flat = Math.hypot(dx, dz);
  if (flat > 1e-6) out.dir.set(dx / flat, 0, dz / flat); else out.dir.set(0, 0, 0);
  // The floor holds up a body driven down into it; nothing holds one down.
  out.lift = Math.max(0, dy);
  return settle(impact, body, gravity, froude, flat, out.lift, out);
}

/**
 * The rest of judging a blow, once it is known how fast it sends the body
 * along the floor and up off it: what the feet take, what is left, and
 * whether that staggers the body or puts it down.
 */
function settle(
  impact: Impact, body: Footing, gravity: number, froude: number,
  sideways: number, lift: number, out: Blow,
): Blow {
  const net = body.grounded ? Math.max(0, sideways - footing(gravity)) : sideways;
  out.knock.copy(out.dir).multiplyScalar(net);

  // Where it landed, against the body's own middle.
  const centre = body.build.hullCentreY;
  const height = clamp(impact.at.y - body.soles, 0, body.build.standing.crown);
  const off = (height - centre) / centre;
  out.over = off >= 0 ? 1 : -1;
  out.topple = net * (1 + LEVER * Math.abs(off));

  const balance = balanceSpeed(body.build, gravity, froude);
  out.severity = balance > 0 ? (out.topple + LIFT_TOPPLE * lift) / balance : 0;
  out.effect = out.severity >= 1 ? "down"
    : out.severity >= STAGGER ? "stagger"
      : net >= BUDGE ? "shove" : "none";
  return out;
}

/**
 * Two weapons meeting along a line: `m1` arriving at `a1` m/s, `m2` at `a2`,
 * both measured along the line from the first into the second. They meet and
 * stick, the way a blow meets a body, and the speed they share afterwards says
 * which one carried on and which was sent back: 1 if the first was knocked, 2
 * if the second, 0 if neither -- and how much the knocked one's speed along
 * the line was changed, m/s. A weapon's mass here is the blow's: the weapon and
 * as much of the arm as lands with it.
 */
export function judgeClash(
  m1: number, a1: number, m2: number, a2: number,
): { knocked: 0 | 1 | 2; speed: number } {
  if (m1 + m2 <= 0) return { knocked: 0, speed: 0 };
  const shared = (m1 * a1 + m2 * a2) / (m1 + m2);
  if (shared > 0) return { knocked: 2, speed: shared - a2 };
  if (shared < 0) return { knocked: 1, speed: a1 - shared };
  return { knocked: 0, speed: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
