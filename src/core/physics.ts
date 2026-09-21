import RAPIER from "@dimforge/rapier3d-compat";
import { STEP } from "./loop";

export type Rapier = typeof RAPIER;

/** Collision groups. Rapier packs membership in the high 16 bits, filter in the low 16. */
export const GROUP = {
  WORLD: 0x0001,
  FIGHTER: 0x0002,
  BLADE: 0x0004,
  PROP: 0x0008,
} as const;

export function groups(membership: number, filter: number): number {
  return (membership << 16) | filter;
}

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
