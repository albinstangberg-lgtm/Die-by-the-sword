import RAPIER from "@dimforge/rapier3d-compat";
import { STEP } from "./loop";

export type Rapier = typeof RAPIER;

/**
 * Collision groups. Rapier packs membership in the high 16 bits, filter in the
 * low 16, so there are sixteen bits to spend.
 *
 * Two go to the scenery, and one to every walking hull. Six more are for
 * bodies and six for weapons, and those are not handed out a bit to a
 * fighter: each fighter's body is some three of the six body bits, and its
 * weapon some three of the six weapon bits -- a different three from anyone
 * else's. See `makeSides` for why that is enough.
 */
export const GROUP = {
  WORLD: 0x0001,
  PROP: 0x0002,
} as const;

/**
 * The walking hulls' one bit, shared.
 *
 * A hull bumps into every other hull, whoever's side it is on, and a body
 * never meets its own colliders -- so a bit of its own told nothing apart
 * that needed telling. Each fighter used to have one anyway, three bits a
 * fighter, which left room for four: the pen's two orcs made five.
 */
const HULL = 1 << 2;

/** The body bits and the weapon bits: six of each, after the scenery's and the hulls'. */
const POOL = 6;
const BODY_POOL = ((1 << POOL) - 1) << 3;
const BLADE_POOL = ((1 << POOL) - 1) << (3 + POOL);

/**
 * Every way of picking three bits out of six, as masks of the low six: twenty
 * of them, and not one inside another -- which is the whole trick (see
 * `makeSides`).
 */
const THREES: readonly number[] = (() => {
  const out: number[] = [];
  for (let m = 0; m < 1 << POOL; m++) {
    let n = 0;
    for (let b = m; b; b &= b - 1) n++;
    if (n === 3) out.push(m);
  }
  return out;
})();

export function groups(membership: number, filter: number): number {
  return (membership << 16) | filter;
}

/**
 * Which groups one fighter's body, weapon and hull belong to, and what each
 * collides with.
 *
 * Every fighter gets bits of its own because a single shared FIGHTER group
 * cannot express "everyone's blade but my own" -- a fighter must be cut by
 * other blades while its own sweeps through its shoulder untouched. Bits of
 * its own make that a filter rather than a special case, and teams decide who
 * is hostile to whom.
 *
 * Note that weapons DO collide with each other. Parrying is not a scripted
 * move here; it is just two blades occupying the same space.
 */
export interface Side {
  /** Which fighter of the line-up this is. */
  readonly index: number;
  /** Fighters on the same team do not cut each other. */
  readonly team: number;
  /** For every hittable body part. */
  readonly bodyFilter: number;
  /**
   * For the weapon.
   *
   * A blade meets stone, other blades, and the bodies of the other team --
   * the practice dummy's too. It used to pass through flesh, because a blade
   * the solver stops arrives having been braked, and a braked blade cannot
   * cut. It no longer needs to: a hit is measured from the blade's motion as
   * it was BEFORE the step that stopped it (see `Arm.snapshotBlade`), so the
   * blow scores the speed it arrived at, and the blade stops where it landed,
   * as it does on a wall. An ally's body it still passes through.
   */
  readonly bladeFilter: number;
  /** What a weapon's swept cut may find, and what counts as flesh: soft targets on the other team. */
  readonly cuttableFilter: number;
  /**
   * For a shield: a blade's membership, so an enemy's cut is stopped by it
   * like a parry, but it meets only stone and blades. It is not a weapon, and
   * nothing it touches bleeds.
   */
  readonly shieldFilter: number;
  /**
   * For a shield slung on the back: a shield's membership, meeting other
   * blades and nothing else. It rides the walking hull, and a shield that met
   * the world would catch on every door frame the body walks through.
   */
  readonly backShieldFilter: number;
  /**
   * For a weapon nobody is swinging: in a limp hand, or on an arm that has
   * been cut off. It lies on the floor and meets other blades, but no body.
   * Staying out of bodies is also staying out of the way of the legs, which
   * are kinematic and cannot be pushed back: a spear on the floor that a
   * passing foot came down on was kicked across the room at seventeen metres
   * a second, and the corpse still holding it went with it.
   */
  readonly inertBladeFilter: number;
  /**
   * For the invisible locomotion hull.
   *
   * Identical to `bodyFilter` except that blades pass straight through, and
   * that it bumps into every other fighter's hull regardless of team -- allies
   * take up space too.
   */
  readonly hullFilter: number;
  /**
   * For parts that exist only to be hit -- the kinematic legs.
   *
   * A kinematic body is immovable by anything it touches, so if the legs
   * collided with the world or another fighter they would shove rather than
   * be shoved. Restricting them to hostile blades makes them cuttable without
   * letting them bulldoze the room.
   */
  readonly hitOnlyFilter: number;
  /** For the downward probe that decides whether the feet are on something. */
  readonly groundFilter: number;
  /**
   * For the line-of-sight ray.
   *
   * Walls and pillars only. Bodies do not block sight -- an orc can see you
   * past the goblin in front of it -- and neither does the hanging practice
   * dummy, which is a prop rather than architecture.
   */
  readonly sightFilter: number;
  readonly body: number;
  readonly blade: number;
}

/**
 * Build one consistent set of sides from a team per fighter.
 *
 * Taking the whole roster at once is the point: hostility is a property of the
 * line-up, not of a fighter, so the filters can only be correct if they are all
 * derived together. `makeSides([0, 1, 1])` is a player against two allies who
 * will not cut each other.
 *
 * Each fighter's body is a different three of the six body bits, and its
 * weapon a different three of the six weapon bits. Two things are asked of
 * those bits, and three of six answers both:
 *
 * - **everyone but me.** Bodies meet every other body, and weapons every other
 *   weapon, but none of mine meets mine. A filter of the three bits I do not
 *   have does that: any other three share at least one bit with it, since no
 *   three of six sits inside another three, and mine shares none.
 * - **the other side, not mine.** A weapon cuts the bodies of the other team
 *   and not its own team's. A filter of the bits nobody on my team has does
 *   that, provided every one of them has a bit of its own that nobody on mine
 *   has -- which is what the threes are chosen for, below.
 *
 * One bit a fighter made "everyone but me" a filter too, and gave out at six
 * fighters; three of six go to twenty.
 */
export function makeSides(teams: readonly number[]): Side[] {
  const bodies = pickThrees(teams, "body");
  const blades = pickThrees(teams, "weapon");
  const body = bodies.map((m) => m << 3);
  const blade = blades.map((m) => m << (3 + POOL));
  const team = (bits: number[], t: number) =>
    teams.reduce((all, u, j) => (u === t ? all | bits[j] : all), 0);

  return teams.map((t, i) => {
    // Everyone's but mine, and the other side's but none of my side's.
    const otherBodies = BODY_POOL & ~body[i];
    const otherBlades = BLADE_POOL & ~blade[i];
    const foeBodies = BODY_POOL & ~team(body, t);
    const foeBlades = BLADE_POOL & ~team(blade, t);
    const otherHulls = teams.length > 1 ? HULL : 0;

    return {
      index: i,
      team: t,
      body: body[i],
      blade: blade[i],
      bodyFilter: groups(body[i], GROUP.WORLD | GROUP.PROP | otherBodies | foeBlades),
      bladeFilter: groups(blade[i], GROUP.WORLD | GROUP.PROP | otherBlades | foeBodies),
      cuttableFilter: groups(blade[i], GROUP.PROP | foeBodies),
      shieldFilter: groups(blade[i], GROUP.WORLD | otherBlades),
      backShieldFilter: groups(blade[i], otherBlades),
      inertBladeFilter: groups(blade[i], GROUP.WORLD | GROUP.PROP | otherBlades),
      hullFilter: groups(HULL, GROUP.WORLD | GROUP.PROP | otherHulls),
      hitOnlyFilter: groups(body[i], foeBlades),
      groundFilter: groups(HULL, GROUP.WORLD | GROUP.PROP),
      sightFilter: groups(HULL, GROUP.WORLD),
    };
  });
}

/**
 * A different three of six for every fighter, such that each has a bit that
 * nobody on any other team has. The first team -- you -- take threes with the
 * first bit in them and the rest take threes without it, which settles it for
 * two teams whatever their sizes, up to ten against you; anything else is
 * searched for, and a line-up it cannot be found for is refused.
 */
function pickThrees(teams: readonly number[], what: string): number[] {
  const order = [...new Set(teams)];
  const first = order[0];
  const picked: number[] = new Array(teams.length).fill(0);
  const used = new Set<number>();

  // Every fighter's three has a bit outside all of every other team's.
  const fits = (upTo: number): boolean => {
    for (let i = 0; i <= upTo; i++) {
      const theirs = teams.reduce((all, u, j) =>
        (j <= upTo && u !== teams[i] ? all | picked[j] : all), 0);
      if (theirs !== 0 && (picked[i] & ~theirs) === 0) return false;
    }
    return true;
  };
  // Each team's threes in the order it prefers them, and taken in that order
  // -- fighters on one team are interchangeable, so trying them the other
  // way round would only try the same line-up again.
  const tries = new Map(order.map((t) => {
    const mine = t === first;
    const suits = (m: number) => ((m & 1) === 1) === mine;
    return [t, [...THREES].sort((a, b) => Number(suits(b)) - Number(suits(a)))] as const;
  }));
  const next = new Map<number, number>();
  const place = (i: number): boolean => {
    if (i === teams.length) return true;
    const list = tries.get(teams[i])!;
    const from = next.get(teams[i]) ?? 0;
    for (let k = from; k < list.length; k++) {
      if (used.has(list[k])) continue;
      picked[i] = list[k];
      used.add(list[k]);
      next.set(teams[i], k + 1);
      if (fits(i) && place(i + 1)) return true;
      used.delete(list[k]);
    }
    next.set(teams[i], from);
    picked[i] = 0;
    return false;
  };
  if (!place(0)) {
    throw new Error(`no way to give ${teams.length} fighters on ${order.length} teams a ${what} of their own`);
  }
  return picked;
}

/** Everything a blade or body can touch, for static scenery and loose props. */
export const ALL_COMBATANTS = BODY_POOL | BLADE_POOL | HULL;

export interface PhysicsWorld {
  rapier: Rapier;
  world: RAPIER.World;
  events: RAPIER.EventQueue;
  step(): void;
}

export async function createPhysics(gravityY: number): Promise<PhysicsWorld> {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
  world.timestep = STEP;

  // The arm is a stiff constraint chain driven by large forces. The default
  // 4 solver iterations let it stretch visibly at the shoulder under load;
  // more iterations buy rigidity far more cheaply than raising the gains does.
  // 16 rather than 12 since the fighters gained a jointed head and off-arm,
  // which put more constraints on the same body.
  world.numSolverIterations = 16;

  const events = new RAPIER.EventQueue(true);

  return {
    rapier: RAPIER,
    world,
    events,
    step() {
      world.step(events);
    },
  };
}
