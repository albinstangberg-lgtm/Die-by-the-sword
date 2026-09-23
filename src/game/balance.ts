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
 * How much harder a blow is to stand up to, per body-centre-height it lands
 * off the middle. A rigid body says far more than this -- people are not
 * rigid, and a neck and a pair of knees give.
 */
const LEVER = 0.5;

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
    effect: "none", mass: 0, speed: 0, knock: new THREE.Vector3(),
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
  out.speed = blowSpeed(impact.blowMass, body.mass, impact.closingSpeed);

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

  const sideways = out.speed * flat;
  const net = body.grounded ? Math.max(0, sideways - footing(gravity)) : sideways;
  out.knock.copy(out.dir).multiplyScalar(net);

  // Where it landed, against the body's own middle.
  const centre = body.build.hullCentreY;
  const height = clamp(impact.at.y - body.soles, 0, body.build.standing.crown);
  const off = (height - centre) / centre;
  out.over = off >= 0 ? 1 : -1;
  out.topple = net * (1 + LEVER * Math.abs(off));

  const balance = balanceSpeed(body.build, gravity, froude);
  out.severity = balance > 0 ? out.topple / balance : 0;
  out.effect = out.severity >= 1 ? "down"
    : out.severity >= STAGGER ? "stagger"
      : net >= BUDGE ? "shove" : "none";
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
