import RAPIER from "@dimforge/rapier3d-compat";
import { STEP } from "./loop";

export type Rapier = typeof RAPIER;

/**
 * Collision groups. Rapier packs membership in the high 16 bits, filter in the
 * low 16, so there are sixteen bits to spend.
 *
 * Two go to the scenery. The rest are handed out three at a time -- body,
 * weapon, hull -- to each fighter in the arena, which is what lets more than
 * two of them share a room without a blade cutting the wrong person.
 */
export const GROUP = {
  WORLD: 0x0001,
  PROP: 0x0002,
} as const;

/** Three bits each, after the two scenery bits: sixteen bits, four fighters. */
export const MAX_FIGHTERS = 4;

function slotBits(i: number): { body: number; blade: number; hull: number } {
  const base = 2 + i * 3;
  return { body: 1 << base, blade: 1 << (base + 1), hull: 1 << (base + 2) };
}

export function groups(membership: number, filter: number): number {
  return (membership << 16) | filter;
}

/**
 * Which groups one fighter's body, weapon and hull belong to, and what each
 * collides with.
 *
 * Every fighter gets its own slot because a single shared FIGHTER group cannot
 * express "everyone's blade but my own" -- a fighter must be cut by other
 * blades while its own sweeps through its shoulder untouched. Per-slot groups
 * make that a filter rather than a special case, and teams decide who is
 * hostile to whom.
 *
 * Note that weapons DO collide with each other. Parrying is not a scripted
 * move here; it is just two blades occupying the same space.
 */
export interface Side {
  /** Which of the arena's fighter slots this is. */
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
 */
export function makeSides(teams: readonly number[]): Side[] {
  if (teams.length > MAX_FIGHTERS) {
    throw new Error(`${teams.length} fighters; only ${MAX_FIGHTERS} collision slots exist`);
  }
  const bits = teams.map((_, i) => slotBits(i));

  return teams.map((team, i) => {
    const mine = bits[i];
    let otherBodies = 0, otherHulls = 0, otherBlades = 0, foeBodies = 0, foeBlades = 0;
    teams.forEach((t, j) => {
      if (j === i) return;
      otherBodies |= bits[j].body;
      otherHulls |= bits[j].hull;
      otherBlades |= bits[j].blade;
      if (t !== team) {
        foeBodies |= bits[j].body;
        foeBlades |= bits[j].blade;
      }
    });

    return {
      index: i,
      team,
      body: mine.body,
      blade: mine.blade,
      bodyFilter: groups(mine.body, GROUP.WORLD | GROUP.PROP | otherBodies | foeBlades),
      bladeFilter: groups(mine.blade, GROUP.WORLD | GROUP.PROP | otherBlades | foeBodies),
      cuttableFilter: groups(mine.blade, GROUP.PROP | foeBodies),
      shieldFilter: groups(mine.blade, GROUP.WORLD | otherBlades),
      hullFilter: groups(mine.hull, GROUP.WORLD | GROUP.PROP | otherHulls),
      hitOnlyFilter: groups(mine.body, foeBlades),
      groundFilter: groups(mine.hull, GROUP.WORLD | GROUP.PROP),
      sightFilter: groups(mine.hull, GROUP.WORLD),
    };
  });
}

/** Everything a blade or body can touch, for static scenery and loose props. */
export const ALL_COMBATANTS = (() => {
  let all = 0;
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    const b = slotBits(i);
    all |= b.body | b.blade | b.hull;
  }
  return all;
})();

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
