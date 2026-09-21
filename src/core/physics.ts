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
  /** For the torso and the arm's own limbs. */
  readonly bodyFilter: number;
  /** For the blade. */
  readonly bladeFilter: number;
  readonly body: number;
  readonly blade: number;
}

function makeSide(name: "a" | "b", body: number, blade: number,
                  foeBody: number, foeBlade: number): Side {
  return {
    name, body, blade,
    // A fighter is hit by the other blade and bumps into the other fighter,
    // but is transparent to the sword in its own hand.
    bodyFilter: groups(body, GROUP.WORLD | GROUP.PROP | foeBody | foeBlade),
    bladeFilter: groups(blade, GROUP.WORLD | GROUP.PROP | foeBody | foeBlade),
  };
}

export const SIDE_A = makeSide("a", GROUP.BODY_A, GROUP.BLADE_A, GROUP.BODY_B, GROUP.BLADE_B);
export const SIDE_B = makeSide("b", GROUP.BODY_B, GROUP.BLADE_B, GROUP.BODY_A, GROUP.BLADE_A);

/** Everything a blade or body can touch, for static scenery and loose props. */
export const ALL_COMBATANTS =
  GROUP.BODY_A | GROUP.BLADE_A | GROUP.BODY_B | GROUP.BLADE_B;

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
  world.numSolverIterations = 12;

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
