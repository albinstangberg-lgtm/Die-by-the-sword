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
 * its own make that a filter rather than a special case. Whose side anyone is
 * on does not come into it: a blade cuts whoever it lands on, ally or not.
 *
 * Note that weapons DO collide with each other. Parrying is not a scripted
 * move here; it is just two blades occupying the same space.
 */
export interface Side {
  /** Which fighter of the line-up this is. */
  readonly index: number;
  /**
   * Whose side it is on: who it fights and who it fights beside. Not what its
   * weapon meets -- an ally caught by a blade is cut like anyone else.
   */
  readonly team: number;
  /** For every hittable body part. */
  readonly bodyFilter: number;
  /**
   * For the weapon.
   *
   * A blade meets stone, other blades, and every body but its owner's --
   * the practice dummy's too. It used to pass through flesh, because a blade
   * the solver stops arrives having been braked, and a braked blade cannot
   * cut. It no longer needs to: a hit is measured from the blade's motion as
   * it was BEFORE the step that stopped it (see `Arm.snapshotBlade`), so the
   * blow scores the speed it arrived at, and the blade stops where it landed,
   * as it does on a wall. An ally's body it used to pass through; it stops in
   * it now, and cuts it.
   */
  readonly bladeFilter: number;
  /** What a weapon's swept cut may find, and what counts as flesh: every body but its owner's. */
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
   * be shoved. Restricting them to other blades makes them cuttable without
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
 * Build one consistent set of sides from a team per fighter: `makeSides([0,
 * 1, 1])` is a player against two allies.
 *
 * Each fighter's body is a different three of the six body bits, and its
 * weapon a different three of the six weapon bits, which is what "everyone
 * but me" asks: bodies meet every other body, weapons every other weapon and
 * every other body, and none of mine meets mine. A filter of the three bits I
 * do not have does that, since any other three shares at least one bit with
 * it -- no three of six sits inside another three -- and mine shares none.
 *
 * Teams used to decide what a weapon met as well, and an ally's body let
 * every ally's blade through it. That asked more of the bits -- every fighter
 * a bit nobody on any other team had -- and gave out at three teams. A blade
 * cuts whoever it lands on now, and twenty threes are twenty fighters, on as
 * many sides as they like.
 */
export function makeSides(teams: readonly number[]): Side[] {
  if (teams.length > THREES.length) {
    throw new Error(`${teams.length} fighters, where the bits give ${THREES.length} a body and weapon of their own`);
  }
  const body = THREES.map((m) => m << 3);
  const blade = THREES.map((m) => m << (3 + POOL));

  return teams.map((t, i) => {
    // Everyone's but mine.
    const otherBodies = BODY_POOL & ~body[i];
    const otherBlades = BLADE_POOL & ~blade[i];
    const otherHulls = teams.length > 1 ? HULL : 0;

    return {
      index: i,
      team: t,
      body: body[i],
      blade: blade[i],
      bodyFilter: groups(body[i], GROUP.WORLD | GROUP.PROP | otherBodies | otherBlades),
      bladeFilter: groups(blade[i], GROUP.WORLD | GROUP.PROP | otherBlades | otherBodies),
      cuttableFilter: groups(blade[i], GROUP.PROP | otherBodies),
      shieldFilter: groups(blade[i], GROUP.WORLD | otherBlades),
      backShieldFilter: groups(blade[i], otherBlades),
      inertBladeFilter: groups(blade[i], GROUP.WORLD | GROUP.PROP | otherBlades),
      hullFilter: groups(HULL, GROUP.WORLD | GROUP.PROP | otherHulls),
      hitOnlyFilter: groups(body[i], otherBlades),
      groundFilter: groups(HULL, GROUP.WORLD | GROUP.PROP),
      sightFilter: groups(HULL, GROUP.WORLD),
    };
  });
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
