import RAPIER from "@dimforge/rapier3d-compat";
import { STEP } from "./loop";

export type Rapier = typeof RAPIER;

/** Collision groups. Rapier packs membership in the high 16 bits, filter in the low 16. */
export const GROUP = {
  WORLD: 0x0001,
  PROP: 0x0002,
  BODY_A: 0x0004,
  BLADE_A: 0x0008,
  BODY_B: 0x0010,
  BLADE_B: 0x0020,
  // The locomotion hulls get their own groups. Sharing a group with the
  // hittable parts meant a blade's swept cut struck the hull first — it
  // encloses the whole figure — and the hit was thrown away for not belonging
  // to any named body part, so nobody could wound anybody.
  HULL_A: 0x0040,
  HULL_B: 0x0080,
} as const;

export function groups(membership: number, filter: number): number {
  return (membership << 16) | filter;
}

/**
 * Which groups a combatant's body and blade belong to, and what each collides
 * with.
 *
 * Two combatants need separate groups because a single shared FIGHTER group
 * cannot express "everyone's blade but my own" -- a fighter must be cut by the
 * other blade while its own sweeps through its shoulder untouched. Splitting by
 * side makes that a filter, not a special case.
 *
 * Note that the two blades DO collide with each other. Parrying is not a
 * scripted move here; it is just two swords occupying the same space.
 */
export interface Side {
  readonly name: "a" | "b";
  /** For every hittable body part. */
  readonly bodyFilter: number;
  /**
   * For the blade.
   *
   * Deliberately excludes everything soft. A sword that physically collides
   * with a body is stopped by it, and a stopped blade cannot cut: the swing
   * arrives at 3 m/s having been braked from first contact. Blades meet stone
   * and they meet each other; flesh they pass through, and the hit is found by
   * sweeping the blade's line (see cutting.ts).
   */
  readonly bladeFilter: number;
  /** What a blade's swept cut may find: soft targets only. */
  readonly cuttableFilter: number;
  /**
   * For the invisible locomotion hull.
   *
   * Identical to `bodyFilter` except that blades pass straight through. The
   * hull spans the whole figure, so if it stopped a sword every cut would
   * land on a nondescript capsule instead of on a head or an arm.
   */
  readonly hullFilter: number;
  /**
   * For parts that exist only to be hit — the kinematic legs.
   *
   * A kinematic body is immovable by anything it touches, so if the legs
   * collided with the world or the other fighter they would shove rather than
   * be shoved. Restricting them to the opposing blade makes them cuttable
   * without letting them bulldoze the room.
   */
  readonly hitOnlyFilter: number;
  readonly body: number;
  readonly blade: number;
}

function makeSide(name: "a" | "b", body: number, blade: number, hull: number,
                  foeBody: number, foeBlade: number, foeHull: number): Side {
  return {
    name, body, blade,
    // A fighter is hit by the other blade and bumps into the other fighter,
    // but is transparent to the sword in its own hand.
    bodyFilter: groups(body, GROUP.WORLD | GROUP.PROP | foeBody | foeBlade),
    bladeFilter: groups(blade, GROUP.WORLD | foeBlade),
    cuttableFilter: groups(blade, GROUP.PROP | foeBody),
    hullFilter: groups(hull, GROUP.WORLD | GROUP.PROP | foeHull),
    hitOnlyFilter: groups(body, foeBlade),
  };
}

export const SIDE_A = makeSide("a", GROUP.BODY_A, GROUP.BLADE_A, GROUP.HULL_A,
  GROUP.BODY_B, GROUP.BLADE_B, GROUP.HULL_B);
export const SIDE_B = makeSide("b", GROUP.BODY_B, GROUP.BLADE_B, GROUP.HULL_B,
  GROUP.BODY_A, GROUP.BLADE_A, GROUP.HULL_A);

/** Everything a blade or body can touch, for static scenery and loose props. */
export const ALL_COMBATANTS =
  GROUP.BODY_A | GROUP.BLADE_A | GROUP.HULL_A |
  GROUP.BODY_B | GROUP.BLADE_B | GROUP.HULL_B;

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
