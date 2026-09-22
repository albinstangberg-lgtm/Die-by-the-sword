import * as THREE from "three";
import { ALL_COMBATANTS, GROUP, groups, type PhysicsWorld } from "../core/physics";
import type { Targets } from "./targets";

/**
 * A room to swing in. Everything here exists to be hit: a stone floor, walls
 * that stop the blade dead, pillars you can catch mid-swing, and a low beam
 * that punishes a big overhead.
 *
 * Geometry is static (fixed bodies) — nothing here moves. The point of stage 2
 * is what the *arm* does when it meets something immovable.
 */

const HALF = 9;       // room half-extent, metres
const WALL_H = 4.2;
const WALL_T = 0.4;

export function buildArena(phys: PhysicsWorld, scene: THREE.Scene, targets: Targets): void {
  const { rapier, world } = phys;

  const filter = groups(GROUP.WORLD, GROUP.WORLD | GROUP.PROP | ALL_COMBATANTS);

  const stone = new THREE.MeshStandardMaterial({ color: 0x565249, roughness: 0.92, metalness: 0.0 });
  const darker = new THREE.MeshStandardMaterial({ color: 0x3c3934, roughness: 0.95, metalness: 0.0 });
  const timber = new THREE.MeshStandardMaterial({ color: 0x654c34, roughness: 0.82, metalness: 0.0 });

  /** Add a static box to both the physics world and the scene. */
  const box = (
    label: string,
    material: THREE.Material,
    hx: number, hy: number, hz: number,
    x: number, y: number, z: number,
  ) => {
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const col = world.createCollider(
      rapier.ColliderDesc.cuboid(hx, hy, hz)
        .setFriction(0.9)
        .setRestitution(0.03)
        .setCollisionGroups(filter)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1.0),
      body,
    );
    targets.register(col.handle, label);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return col;
  };

  // --- floor ---
  box("floor", darker, HALF, 0.5, HALF, 0, -0.5, 0);

  // A faint grid so movement and the blade's arc read against something.
  const grid = new THREE.GridHelper(HALF * 2, HALF * 2, 0x5a5650, 0x3a3833);
  (grid.material as THREE.Material).opacity = 0.35;
  (grid.material as THREE.Material).transparent = true;
  grid.position.y = 0.002;
  scene.add(grid);

  // --- walls ---
  box("north wall", stone, HALF, WALL_H / 2, WALL_T, 0, WALL_H / 2, -HALF);
  box("south wall", stone, HALF, WALL_H / 2, WALL_T, 0, WALL_H / 2, HALF);
  box("east wall", stone, WALL_T, WALL_H / 2, HALF, HALF, WALL_H / 2, 0);
  box("west wall", stone, WALL_T, WALL_H / 2, HALF, -HALF, WALL_H / 2, 0);

  // --- pillars: the thing you clip on a wide horizontal swing ---
  for (const [px, pz] of [[-4.5, -4.5], [4.5, -4.5], [-4.5, 4.5], [4.5, 4.5]] as const) {
    box("pillar", stone, 0.38, 2.1, 0.38, px, 2.1, pz);
  }

  // --- low beam: punishes a big overhead, which is exactly the lesson ---
  //
  // Raised and shortened since the bestiary grew. At 2.05m it punished a
  // two-metre orc simply for walking under it: the axe head rides at beam
  // height, a 660N arm anchors the whole body to the timber, and the fight is
  // over before it starts. And spanning the full width it reached over the
  // practice dummy, so a raised sword caught it before it ever caught a swing.
  // It now covers the middle of the room, where fights happen, at a height
  // that catches an overhead rather than a passer-by.
  box("low beam", timber, 2.2, 0.16, 0.16, -1.0, 2.5, -2.6);

  // --- a waist-high block, good for testing a flat-of-the-blade slap ---
  box("block", stone, 0.55, 0.45, 0.55, 2.4, 0.45, 1.6);

  // --- a thin post: the tunnelling test case. If CCD is off, you cut air. ---
  box("thin post", timber, 0.05, 1.0, 0.05, -2.2, 1.0, 1.8);

}

/** Where the fighter spawns, clear of everything. */
export const SPAWN = new THREE.Vector3(0, 0.95, 3.2);
