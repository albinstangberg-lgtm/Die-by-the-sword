import * as THREE from "three";
import { ALL_COMBATANTS, GROUP, groups, type PhysicsWorld } from "../core/physics";
import type { Targets } from "./targets";
import type { ItemLayout } from "./items";
import { Gate, Lever, LEVER_STANDOFF, type LeverSpec } from "./gate";

/**
 * A hall, and four rooms off it behind gates.
 *
 * Everything here still exists to be hit -- stone that stops a blade dead,
 * pillars you can catch mid-swing, a beam that punishes a big overhead -- and
 * the subjects are kept apart:
 *
 *   the entrance   where you start: a passage south of the hall, with the
 *                  rack and its shield, and a potion to learn on.
 *   the hall       the practice dummy and four pillars in its west half, and
 *                  a ledge to climb in its south-west corner, with a crate to
 *                  go up it by. In its east half, things to learn your feet
 *                  on: a rail to jump, a low wall and a block to vault, and
 *                  stones behind them to jump from one to the next.
 *   the pen        west, behind a gate: two orcs.
 *   the warren     north-west, behind a gate: two kobolds.
 *   the cell       north-east, behind a gate: three goblins.
 *   the den        east, behind a gate: the ogre.
 *
 * Every gate has a lever on the hall's side of its wall, a pace along from
 * the doorway, and nothing comes out until one is pulled (see gate.ts): which
 * of them you let out, and when, is yours. Walls are what make that work, and
 * they cost something: an opponent that cannot see you does not come for you
 * (see `Fighter.sees`), which is what keeps everything behind a shut gate
 * where it is.
 *
 * Geometry is static -- nothing here moves but the gates and their levers.
 * The point is what the *arm* does when it meets something immovable.
 */

const WALL_H = 4.2;
const WALL_T = 0.4;
/** Clear width and height of a doorway. Wide enough for an orc and its axe, and tall enough for the ogre. */
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
 * The rooms, as rectangles of clear floor.
 *
 * Exported because they are the one description of the level anything else
 * should be reading: where a fighter belongs, where a test may look for it.
 * North is -Z. The hall's west half is where the training room was, walls
 * and all, so the dummy, the ledge and three of the four pillars are where
 * they were.
 */
export const ROOMS = {
  hall: { name: "the hall", minX: -6.5, maxX: 15.5, minZ: 0, maxZ: 13 },
  entrance: { name: "the entrance", minX: 2, maxX: 7, minZ: 13, maxZ: 22 },
  pen: { name: "the pen", minX: -17, maxX: -6.5, minZ: 0, maxZ: 13 },
  warren: { name: "the warren", minX: -6.5, maxX: 4.5, minZ: -10.5, maxZ: 0 },
  cell: { name: "the cell", minX: 4.5, maxX: 15.5, minZ: -10.5, maxZ: 0 },
  den: { name: "the den", minX: 15.5, maxX: 26, minZ: 0, maxZ: 13 },
} as const satisfies Record<string, Room>;

/** The rooms behind gates. */
export type GatedRoom = "pen" | "warren" | "cell" | "den";

/** Is this point inside that room's clear floor? */
export function inRoom(room: Room, x: number, z: number): boolean {
  return x >= room.minX && x <= room.maxX && z >= room.minZ && z <= room.maxZ;
}

/**
 * Where the fighter spawns: down the entrance, facing up it into the hall,
 * far enough from its end wall for the camera to fit behind.
 */
export const SPAWN = new THREE.Vector3(4.5, 0.95, 18.5);

/** Where the practice dummy hangs — in the hall's west half, clear of the pillars. */
export const DUMMY_AT = new THREE.Vector3(2.9, 0, 5.4);

/** How far out of its wall a lever's pin stands, and how high. */
const LEVER_OUT = WALL_T / 2 + LEVER_STANDOFF;
const LEVER_Y = 1.35;
/** How far along the wall from the middle of its doorway a lever is: a pace. */
const LEVER_PACE = 2.3;

export interface GatewaySpec {
  /** The room behind it. */
  readonly room: GatedRoom;
  /** The middle of the doorway, on the floor. */
  readonly at: THREE.Vector3;
  /** Which way the wall it is in runs. */
  readonly along: "x" | "z";
  /**
   * The lever that opens it, on the hall's face of the same wall, a pace
   * along from the doorway: its pin, a hand's height below the shoulder and
   * standing out of the wall on its bracket, and the way its front faces --
   * into the hall.
   */
  readonly lever: LeverSpec;
}

/**
 * The four gates, each in the wall between the hall and its room.
 *
 * The pen's and the den's are across the hall from each other, in its west
 * and east walls, with their levers a pace north of the doorway. The
 * warren's and the cell's are in its north wall, with their levers on the
 * sides of the doorways toward each other. Stood at a lever you are out of
 * sight of anything behind the gate; once it is up, you are three paces off
 * and in plain view.
 */
export const GATEWAYS: Readonly<Record<GatedRoom, GatewaySpec>> = {
  pen: {
    room: "pen", at: new THREE.Vector3(ROOMS.hall.minX, 0, 6), along: "z",
    lever: { at: new THREE.Vector3(ROOMS.hall.minX + LEVER_OUT, LEVER_Y, 6 - LEVER_PACE), facing: -Math.PI / 2 },
  },
  warren: {
    room: "warren", at: new THREE.Vector3(-1, 0, ROOMS.hall.minZ), along: "x",
    lever: { at: new THREE.Vector3(-1 + LEVER_PACE, LEVER_Y, ROOMS.hall.minZ + LEVER_OUT), facing: Math.PI },
  },
  cell: {
    room: "cell", at: new THREE.Vector3(10, 0, ROOMS.hall.minZ), along: "x",
    lever: { at: new THREE.Vector3(10 - LEVER_PACE, LEVER_Y, ROOMS.hall.minZ + LEVER_OUT), facing: Math.PI },
  },
  den: {
    room: "den", at: new THREE.Vector3(ROOMS.hall.maxX, 0, 6), along: "z",
    lever: { at: new THREE.Vector3(ROOMS.hall.maxX - LEVER_OUT, LEVER_Y, 6 - LEVER_PACE), facing: Math.PI / 2 },
  },
};

export interface Post {
  /** Where it waits, on the floor. */
  readonly at: THREE.Vector3;
  /** Which way it faces there, as a yaw: at its gate. */
  readonly facing: number;
}

/**
 * Where the things behind the gates wait, and the way each faces: at its
 * gate. Apart, so that none is behind another from the doorway, and far
 * enough in that the doorway is the whole of what they can see. Their spawn
 * heights are their own hulls' centres; see roster.ts for who stands where.
 */
export const POSTS: Readonly<Record<GatedRoom, readonly Post[]>> = {
  pen: [
    { at: new THREE.Vector3(-10.4, 0, 7.8), facing: -Math.PI / 2 },
    { at: new THREE.Vector3(-12.3, 0, 3.9), facing: -Math.PI / 2 },
  ],
  warren: [
    { at: new THREE.Vector3(-2.8, 0, -3.9), facing: Math.PI },
    { at: new THREE.Vector3(1.1, 0, -5.8), facing: Math.PI },
  ],
  cell: [
    { at: new THREE.Vector3(7.8, 0, -4.0), facing: Math.PI },
    { at: new THREE.Vector3(12.1, 0, -4.6), facing: Math.PI },
    { at: new THREE.Vector3(9.9, 0, -7.6), facing: Math.PI },
  ],
  den: [
    { at: new THREE.Vector3(20.0, 0, 6.8), facing: Math.PI / 2 },
  ],
};

/**
 * A waist-high wall in the hall's east half, standing free, so it can be
 * vaulted north or south: between the rail and the block, in a row across
 * the hall -- a thing to jump, then two to vault. The block is the other
 * thing low enough to vault.
 */
export const LOW_WALL = { at: new THREE.Vector3(11.4, 0, 9.2), half: new THREE.Vector3(0.9, 0.43, 0.2) };

/**
 * A waist-high stone block at the east end of the same row as the low wall,
 * with floor all round it to come down on.
 */
export const BLOCK = { at: new THREE.Vector3(14.0, 0, 9.2), half: new THREE.Vector3(0.55, 0.45, 0.55) };

/**
 * Stones to jump from one to the next: knee-high, a stride apart, in a row
 * along the hall's south wall behind the low wall. Too low to climb and far
 * enough apart that a step will not do.
 */
export const STONES = [8.6, 10.4, 12.2, 14.0].map((x) => ({
  at: new THREE.Vector3(x, 0, 11.9), half: new THREE.Vector3(0.4, 0.225, 0.4),
}));

/**
 * A rail to jump over, at the west end of the row: under a knee, so there is
 * nothing to vault, and too long to go round in a stride.
 */
export const RAIL = { at: new THREE.Vector3(8.6, 0, 9.2), half: new THREE.Vector3(1.0, 0.15, 0.08) };

/**
 * Something to climb: a stone ledge in the hall's south-west corner, a metre
 * and a half up -- over a head, under a reach -- with a crate against its
 * east face to go up by in two. `at` is the middle of each footprint, on the
 * floor.
 */
export const LEDGE = { at: new THREE.Vector3(-5.4, 0, 11.9), half: new THREE.Vector3(0.9, 0.75, 0.9) };
export const CRATE = { at: new THREE.Vector3(-4.1, 0, 12.35), half: new THREE.Vector3(0.4, 0.45, 0.45) };

/**
 * Where the things lying about are put down.
 *
 * A potion by the rack in the entrance, to learn on, and one at the back of
 * each room behind a gate; the rack stands against the entrance's east wall,
 * with a shield on it to take down and hang back up whenever you like, and
 * another shield lies at the back of the pen, past its two orcs -- it has to
 * be earned there.
 */
export const ITEM_LAYOUT: ItemLayout = {
  potions: [
    new THREE.Vector3(6.2, 0, 15.6),
    new THREE.Vector3(-5.9, 0, -9.9),
    new THREE.Vector3(14.9, 0, -9.9),
    new THREE.Vector3(25.4, 0, 12.4),
  ],
  shield: new THREE.Vector3(-16.3, 0, 12.3),
  // Its face toward the passage, which is -X from the east wall: a quarter turn.
  rack: { at: new THREE.Vector3(6.55, 0, 17.0), facing: Math.PI / 2 },
};

/**
 * The thin post: the tunnelling test case. If CCD is off, you cut air.
 *
 * Exported so the headless harness aims at the real one rather than at a
 * remembered pair of coordinates.
 */
export const THIN_POST = new THREE.Vector3(13.4, 0, 2.0);

/** One of the gates, the lever that opens it, and the room behind it. */
export interface Gateway {
  readonly spec: GatewaySpec;
  readonly room: Room;
  readonly gate: Gate;
  readonly lever: Lever;
}

/** What of the arena moves: the gates, and the levers that open them. */
export interface Arena {
  readonly gateways: Readonly<Record<GatedRoom, Gateway>>;
}

/**
 * How far a gate goes up, metres: clear of its doorway and a little over,
 * into the gatehouse built over the doorway to take it -- the walls have no
 * roof, and a gate winched up out of one would stand in the air over it.
 */
const GATE_LIFT = DOOR_H + 0.1;
const GATEHOUSE_TOP = DOOR_H + GATE_LIFT + 0.3;
const GATEHOUSE_HALF = DOOR_W / 2 + 0.4;

export function buildArena(phys: PhysicsWorld, scene: THREE.Scene, targets: Targets): Arena {
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

  for (const room of Object.values(ROOMS)) floor(room);

  const hall = ROOMS.hall;
  const door = (key: GatedRoom) => {
    const g = GATEWAYS[key];
    return g.along === "x" ? g.at.x : g.at.z;
  };

  // --- the hall: its gates in three walls, and the entrance through the fourth ---
  wall("hall north wall", "x", hall.minZ, hall.minX, hall.maxX, [door("warren"), door("cell")]);
  wall("hall west wall", "z", hall.minX, hall.minZ, hall.maxZ, [door("pen")]);
  wall("hall east wall", "z", hall.maxX, hall.minZ, hall.maxZ, [door("den")]);
  // The south wall stops either side of the entrance, which opens into the
  // hall across the whole of its width.
  wall("hall south wall", "x", hall.maxZ, hall.minX, ROOMS.entrance.minX);
  wall("hall south wall", "x", hall.maxZ, ROOMS.entrance.maxX, hall.maxX);

  const entrance = ROOMS.entrance;
  wall("entrance west wall", "z", entrance.minX, entrance.minZ, entrance.maxZ);
  wall("entrance east wall", "z", entrance.maxX, entrance.minZ, entrance.maxZ);
  wall("entrance south wall", "x", entrance.maxZ, entrance.minX, entrance.maxX);

  // --- the rooms behind the gates: bare, because what is in them is the whole of it ---
  const pen = ROOMS.pen;
  wall("pen north wall", "x", pen.minZ, pen.minX, pen.maxX);
  wall("pen south wall", "x", pen.maxZ, pen.minX, pen.maxX);
  wall("pen west wall", "z", pen.minX, pen.minZ, pen.maxZ);

  const den = ROOMS.den;
  wall("den north wall", "x", den.minZ, den.minX, den.maxX);
  wall("den south wall", "x", den.maxZ, den.minX, den.maxX);
  wall("den east wall", "z", den.maxX, den.minZ, den.maxZ);

  // The warren and the cell side by side, a wall between them.
  const warren = ROOMS.warren;
  const cell = ROOMS.cell;
  wall("warren north wall", "x", warren.minZ, warren.minX, warren.maxX);
  wall("warren west wall", "z", warren.minX, warren.minZ, warren.maxZ);
  wall("warren east wall", "z", warren.maxX, warren.minZ, warren.maxZ);
  wall("cell north wall", "x", cell.minZ, cell.minX, cell.maxX);
  wall("cell east wall", "z", cell.maxX, cell.minZ, cell.maxZ);

  // --- the hall's west half: the dummy's, and four pillars round it ---
  // The south-east one a little in from the others, out of the way of
  // whatever walks up the entrance and straight on into the hall.
  for (const [px, pz] of [[-3.9, 3.4], [3.9, 3.4], [-3.9, 9.9], [3.0, 9.9]] as const) {
    box("pillar", stone, 0.38, 2.1, 0.38, px, 2.1, pz);
  }

  // Something to climb, and something to climb it by.
  box("ledge", stone, LEDGE.half.x, LEDGE.half.y, LEDGE.half.z,
    LEDGE.at.x, LEDGE.half.y, LEDGE.at.z);
  box("crate", timber, CRATE.half.x, CRATE.half.y, CRATE.half.z,
    CRATE.at.x, CRATE.half.y, CRATE.at.z);

  // The low beam: punishes a big overhead, which is exactly the lesson. Up
  // over the hall's north-west corner, off every line anything walks out of
  // a gate along, and high enough that the ogre goes under it: at 2.05m and
  // spanning the room it used to hook the axe of any orc that simply walked
  // under it, and the fight was over before it started.
  box("low beam", timber, 1.6, 0.16, 0.16, -4.3, 2.9, 1.5);

  // --- the hall's east half: jumping and vaulting ---
  box("low wall", stone, LOW_WALL.half.x, LOW_WALL.half.y, LOW_WALL.half.z,
    LOW_WALL.at.x, LOW_WALL.half.y, LOW_WALL.at.z);
  box("block", stone, BLOCK.half.x, BLOCK.half.y, BLOCK.half.z,
    BLOCK.at.x, BLOCK.half.y, BLOCK.at.z);
  for (const s of STONES) {
    box("stepping stone", stone, s.half.x, s.half.y, s.half.z, s.at.x, s.half.y, s.at.z);
  }
  box("rail", timber, RAIL.half.x, RAIL.half.y, RAIL.half.z, RAIL.at.x, RAIL.half.y, RAIL.at.z);

  // A thin post: the tunnelling test case. If CCD is off, you cut air.
  box("thin post", timber, 0.05, 1.0, 0.05, THIN_POST.x, 1.0, THIN_POST.z);

  // --- the gates, and their levers ---
  const gateways = {} as Record<GatedRoom, Gateway>;
  for (const key of Object.keys(GATEWAYS) as GatedRoom[]) {
    const spec = GATEWAYS[key];
    const at = spec.at;
    // The gatehouse: stone over the doorway, up past the top of the wall, for
    // the gate to go up into. Scenery -- nothing reaches that high.
    const houseY = (WALL_H + GATEHOUSE_TOP) / 2;
    const houseHalf = (GATEHOUSE_TOP - WALL_H) / 2;
    const across = (hx: number, hy: number, along: number, y: number, m: THREE.Material) => {
      if (spec.along === "z") trim(m, hx, hy, along, at.x, y, at.z);
      else trim(m, along, hy, hx, at.x, y, at.z);
    };
    across(WALL_T / 2, houseHalf, GATEHOUSE_HALF, houseY, stone);
    across(WALL_T / 2 + 0.06, 0.12, GATEHOUSE_HALF + 0.06, GATEHOUSE_TOP - 0.12, timber);
    across(WALL_T / 2 + 0.06, 0.1, GATEHOUSE_HALF + 0.06, WALL_H + 0.1, timber);

    const gate = new Gate(phys, scene, targets, {
      at, along: spec.along, width: DOOR_W, height: DOOR_H, lift: GATE_LIFT,
    });
    const lever = new Lever(phys, scene, spec.lever);
    lever.onCaught = () => gate.open();

    // And the chain that ties one to the other: up the wall from the lever's
    // bracket, and along it to the gate, over the doorway. Scenery.
    const l = spec.lever.at;
    const out = new THREE.Vector3(0, 0, -1).applyAxisAngle(Y, spec.lever.facing);
    const face = WALL_T / 2 + 0.03;
    const onWall = (x: number, y: number, z: number) => spec.along === "z"
      ? new THREE.Vector3(at.x + out.x * face, y, z)
      : new THREE.Vector3(x, y, at.z + out.z * face);
    scene.add(chain([
      onWall(l.x, l.y + 0.24, l.z),
      onWall(l.x, WALL_H - 0.35, l.z),
      onWall(at.x, WALL_H - 0.35, at.z),
    ]));

    gateways[key] = { spec, room: ROOMS[key], gate, lever };
  }

  return { gateways };
}

/**
 * Iron links along a path, each a quarter turn from the last. One mesh,
 * however many links: they are all one thing.
 */
function chain(path: readonly THREE.Vector3[]): THREE.InstancedMesh {
  const PITCH = 0.045;
  const at: THREE.Vector3[] = [];
  const along: THREE.Vector3[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const d = path[i].clone().sub(a);
    const n = Math.max(1, Math.round(d.length() / PITCH));
    const dir = d.clone().normalize();
    for (let k = 0; k < n; k++) {
      at.push(a.clone().addScaledVector(d, k / n));
      along.push(dir);
    }
  }
  const links = new THREE.InstancedMesh(
    new THREE.TorusGeometry(0.02, 0.006, 5, 10),
    new THREE.MeshStandardMaterial({ color: 0x3b3a38, roughness: 0.55, metalness: 0.7 }),
    at.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < at.length; i++) {
    // A torus lies in its own XY plane: its Y along the chain, and every
    // other link turned a quarter about that.
    q.setFromUnitVectors(Y, along[i]);
    turn.setFromAxisAngle(Y, (i % 2) * Math.PI / 2);
    m.compose(at[i], q.multiply(turn), one);
    links.setMatrixAt(i, m);
  }
  links.castShadow = true;
  return links;
}

const Y = new THREE.Vector3(0, 1, 0);

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
