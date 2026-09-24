import * as THREE from "three";
import { ALL_COMBATANTS, GROUP, groups, type PhysicsWorld } from "../core/physics";
import type { Targets } from "./targets";
import type { ItemLayout } from "./items";

/**
 * Three rooms and the doors between them.
 *
 * Everything here still exists to be hit -- stone that stops a blade dead,
 * pillars you can catch mid-swing, a beam that punishes a big overhead -- but
 * it is no longer one room with everything in it. A testing area wants its
 * subjects apart:
 *
 *   the training room   where you start. The practice dummy and four pillars,
 *                       and nothing else in the room to confuse what you are
 *                       measuring.
 *   the hall            through the north door. The orc, and the scenery a
 *                       big swing gets caught on.
 *   the cell            through the east door of the hall. The goblin, in a
 *                       small bare room where its reach is the whole story.
 *
 * Walls are what make that work, and they cost something: an opponent that
 * cannot see you no longer comes for you (see `Fighter.sees`), which is what
 * stops the orc spending the fight pressing into the far side of a wall.
 *
 * Geometry is static -- nothing here moves. The point is what the *arm* does
 * when it meets something immovable.
 */

const WALL_H = 4.2;
const WALL_T = 0.4;
/** Clear width and height of a doorway. Wide enough for an orc and its axe. */
const DOOR_W = 2.2;
const DOOR_H = 3.0;

export interface Room {
  readonly name: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * The three rooms, as rectangles of clear floor.
 *
 * Exported because they are the one description of the level anything else
 * should be reading: where a fighter belongs, where a test may look for it.
 */
export const ROOMS = {
  training: { name: "the training room", minX: -6.5, maxX: 6.5, minZ: 0, maxZ: 13 },
  hall: { name: "the hall", minX: -7.5, maxX: 7.5, minZ: -14, maxZ: 0 },
  cell: { name: "the cell", minX: 7.5, maxX: 17, minZ: -12.5, maxZ: -3.5 },
} as const satisfies Record<string, Room>;

/** Is this point inside that room's clear floor? */
export function inRoom(room: Room, x: number, z: number): boolean {
  return x >= room.minX && x <= room.maxX && z >= room.minZ && z <= room.maxZ;
}

/** Where the fighter spawns: the training room, facing the north door. */
export const SPAWN = new THREE.Vector3(0, 0.95, 10.4);

/** Where the practice dummy hangs — clear of the pillars and the door line. */
export const DUMMY_AT = new THREE.Vector3(2.9, 0, 5.4);

/** Each opponent's post, at floor level. Spawn heights are their own hulls'. */
export const ORC_POST = new THREE.Vector3(-1.8, 0, -9.8);
export const GOBLIN_POST = new THREE.Vector3(12.4, 0, -8.2);

/**
 * A waist-high wall along the training room's west side, end on to the wall
 * so it can be vaulted north or south: the one thing in that room to practise
 * going over. Out of the way of the dummy, the pillars and the middle of the
 * floor. The hall's block is the other thing low enough to vault.
 */
export const LOW_WALL = { at: new THREE.Vector3(-5.4, 0, 6.6), half: new THREE.Vector3(0.9, 0.43, 0.2) };

/**
 * Where the things lying about are put down.
 *
 * A potion by the rack in the training room, to learn on; two in the hall,
 * one behind the block; one at the back of the cell. The shield lies in the
 * hall's far corner, past the orc -- it has to be earned there -- and the
 * rack stands against the training room's east wall, with a shield on it to
 * take down and hang back up whenever you like.
 */
export const ITEM_LAYOUT: ItemLayout = {
  potions: [
    new THREE.Vector3(5.2, 0, 12.2),
    new THREE.Vector3(-6.6, 0, -12.9),
    new THREE.Vector3(6.6, 0, -1.0),
    new THREE.Vector3(16.3, 0, -11.8),
  ],
  shield: new THREE.Vector3(6.6, 0, -13.1),
  // Its face toward the room, which is -X from the east wall: a quarter turn.
  rack: { at: new THREE.Vector3(6.05, 0, 11.4), facing: Math.PI / 2 },
};

/**
 * The thin post: the tunnelling test case. If CCD is off, you cut air.
 *
 * Exported so the headless harness aims at the real one rather than at a
 * remembered pair of coordinates.
 */
export const THIN_POST = new THREE.Vector3(4.7, 0, -3.2);

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

  /** Scenery with no collider. A door frame must not be something to snag on. */
  const trim = (
    material: THREE.Material,
    hx: number, hy: number, hz: number,
    x: number, y: number, z: number,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    scene.add(mesh);
  };

  /**
   * A run of wall along one axis, with doorways cut out of it.
   *
   * A door is a gap in the run plus a lintel over it, so the wall still reads
   * as a wall from either side and the hole is exactly as wide as it looks.
   * Runs overhang their ends by half a thickness, which is what closes the
   * corners without a separate corner piece.
   */
  const wall = (
    label: string,
    axis: "x" | "z",
    at: number,
    from: number,
    to: number,
    doors: readonly number[] = [],
  ) => {
    const half = WALL_T / 2;
    const edges: number[] = [from - half];
    for (const door of doors) {
      edges.push(door - DOOR_W / 2, door + DOOR_W / 2);
    }
    edges.push(to + half);

    const place = (a: number, b: number, y: number, hy: number) => {
      const mid = (a + b) / 2;
      const long = Math.max(0.01, (b - a) / 2);
      if (axis === "x") box(label, stone, long, hy, half, mid, y, at);
      else box(label, stone, half, hy, long, at, y, mid);
    };

    for (let i = 0; i < edges.length; i += 2) {
      place(edges[i], edges[i + 1], WALL_H / 2, WALL_H / 2);
    }
    for (const door of doors) {
      // The lintel: everything above the opening.
      place(door - DOOR_W / 2, door + DOOR_W / 2,
        (DOOR_H + WALL_H) / 2, (WALL_H - DOOR_H) / 2);

      // Timber lining, so a doorway reads as a door rather than as a hole.
      // Scenery only: a frame with a collider is one more thing for an axe to
      // hook on at exactly the height an axe is carried.
      const jamb = 0.09;
      const side = DOOR_W / 2 - jamb * 0.4;
      if (axis === "x") {
        trim(timber, jamb, DOOR_H / 2, half + 0.02, door - side, DOOR_H / 2, at);
        trim(timber, jamb, DOOR_H / 2, half + 0.02, door + side, DOOR_H / 2, at);
        trim(timber, DOOR_W / 2 + jamb, 0.1, half + 0.02, door, DOOR_H + 0.1, at);
      } else {
        trim(timber, half + 0.02, DOOR_H / 2, jamb, at, DOOR_H / 2, door - side);
        trim(timber, half + 0.02, DOOR_H / 2, jamb, at, DOOR_H / 2, door + side);
        trim(timber, half + 0.02, 0.1, DOOR_W / 2 + jamb, at, DOOR_H + 0.1, door);
      }
    }
  };

  /** A room's floor, run out under its walls so no seam shows at the skirting. */
  const floor = (room: Room) => {
    const hx = (room.maxX - room.minX) / 2 + WALL_T;
    const hz = (room.maxZ - room.minZ) / 2 + WALL_T;
    box("floor", darker, hx, 0.5, hz,
      (room.minX + room.maxX) / 2, -0.5, (room.minZ + room.maxZ) / 2);
    scene.add(floorGrid(room));
  };

  floor(ROOMS.training);
  floor(ROOMS.hall);
  floor(ROOMS.cell);

  // --- the training room: the dummy, four pillars, and nothing else ---
  wall("south wall", "x", ROOMS.training.maxZ, ROOMS.training.minX, ROOMS.training.maxX);
  wall("west wall", "z", ROOMS.training.minX, ROOMS.training.minZ, ROOMS.training.maxZ);
  wall("east wall", "z", ROOMS.training.maxX, ROOMS.training.minZ, ROOMS.training.maxZ);

  for (const [px, pz] of [[-3.9, 3.4], [3.9, 3.4], [-3.9, 9.9], [3.9, 9.9]] as const) {
    box("pillar", stone, 0.38, 2.1, 0.38, px, 2.1, pz);
  }

  // Something to vault.
  box("low wall", stone, LOW_WALL.half.x, LOW_WALL.half.y, LOW_WALL.half.z,
    LOW_WALL.at.x, LOW_WALL.half.y, LOW_WALL.at.z);

  // --- the north door, and the hall behind it ---
  //
  // The partition spans the full width of the hall, so it closes the wider
  // room as well as the narrower one. The door is on the centre line, which
  // is where you are already walking.
  wall("north wall", "x", 0, ROOMS.hall.minX, ROOMS.hall.maxX, [0]);
  wall("hall west wall", "z", ROOMS.hall.minX, ROOMS.hall.minZ, ROOMS.hall.maxZ);
  wall("hall north wall", "x", ROOMS.hall.minZ, ROOMS.hall.minX, ROOMS.hall.maxX);
  wall("hall east wall", "z", ROOMS.hall.maxX, ROOMS.hall.minZ, ROOMS.hall.maxZ, [-8]);

  // The low beam: punishes a big overhead, which is exactly the lesson. It
  // sits well off the line the orc walks to reach the door, so it catches a
  // swing rather than a passer-by -- at 2.05m and spanning the room it used
  // to hook the axe of any orc that simply walked under it, and the fight was
  // over before it started.
  box("low beam", timber, 1.9, 0.16, 0.16, -5.0, 2.5, -5.4);

  // A waist-high block, good for testing a flat-of-the-blade slap.
  box("block", stone, 0.55, 0.45, 0.55, -5.6, 0.45, -11.4);

  // A thin post: the tunnelling test case. If CCD is off, you cut air.
  box("thin post", timber, 0.05, 1.0, 0.05, THIN_POST.x, 1.0, THIN_POST.z);

  // --- the cell: bare, because the goblin's reach is the whole argument ---
  wall("cell south wall", "x", ROOMS.cell.maxZ, ROOMS.cell.minX, ROOMS.cell.maxX);
  wall("cell north wall", "x", ROOMS.cell.minZ, ROOMS.cell.minX, ROOMS.cell.maxX);
  wall("cell east wall", "z", ROOMS.cell.maxX, ROOMS.cell.minZ, ROOMS.cell.maxZ);
}

/** A faint grid, so movement and the blade's arc read against something. */
function floorGrid(room: Room): THREE.LineSegments {
  const pts: number[] = [];
  const y = 0.002;
  for (let x = Math.ceil(room.minX); x <= room.maxX; x++) {
    pts.push(x, y, room.minZ, x, y, room.maxZ);
  }
  for (let z = Math.ceil(room.minZ); z <= room.maxZ; z++) {
    pts.push(room.minX, y, z, room.maxX, y, z);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
    color: 0x5a5650, transparent: true, opacity: 0.35,
  }));
}
