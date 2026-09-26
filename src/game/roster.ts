import * as THREE from "three";
import { GATEWAYS, inRoom, POSTS, ROOMS, type GatedRoom } from "./arena";
import { noise, type Ai } from "./ai";
import type { Combatant } from "./combatant";
import { GOBLIN, KOBOLD, OGRE, ORC, type Species } from "./species";

/**
 * Who waits behind which gate.
 *
 * Two orcs in the pen, two kobolds in the warren, three goblins in the cell,
 * and the ogre on its own in the den. Those that share a room are told apart
 * on the fight panel by name, and by what they wear -- nothing else about
 * them differs.
 *
 * The game and the headless harness both read it, so the harness fights the
 * line-up the game has rather than a copy of it.
 */
export interface Occupant {
  readonly species: Species;
  /** The room it waits in. */
  readonly room: GatedRoom;
  /** Where it waits, on the floor, and which way it faces there: at its gate. */
  readonly at: THREE.Vector3;
  readonly facing: number;
  /** How the fight panel names it. */
  readonly name: string;
}

/** The same species in another colour of cloth. */
function dressed(species: Species, cloth: number): Species {
  return { ...species, palette: { ...species.palette, cloth } };
}

const ORDINAL = ["", "second ", "third "];

/** Everyone in one room: the same species at each of its posts, in the cloths given. */
function room(key: GatedRoom, species: Species, cloths: readonly number[]): Occupant[] {
  const noun = species.name.replace(/^the /, "");
  return POSTS[key].map((post, i) => ({
    species: dressed(species, cloths[i]),
    room: key,
    at: post.at,
    facing: post.facing,
    name: `the ${ORDINAL[i]}${noun}`,
  }));
}

export const ROSTER: readonly Occupant[] = [
  ...room("pen", ORC, [ORC.palette.cloth, 0x5c3d29]),
  ...room("warren", KOBOLD, [KOBOLD.palette.cloth, 0x4f5b3a]),
  ...room("cell", GOBLIN, [GOBLIN.palette.cloth, 0x3f4a4f, 0x6a3f2c]),
  ...room("den", OGRE, [OGRE.palette.cloth]),
];

/** Where an occupant is put down: its post, at its own hull's centre, so nothing starts sunk into the floor. */
export function spawnOf(o: Occupant): THREE.Vector3 {
  return new THREE.Vector3(o.at.x, o.species.build.hullCentreY + 0.11, o.at.z);
}

/**
 * How far off a gate going up is heard, metres: from anywhere in the room
 * behind it, and across the hall.
 */
export const EARSHOT = 10;

/**
 * Whether something standing at `x, z` is where a gate into `behind` can be
 * heard from: the room behind it, or out in the hall or the entrance -- not
 * through another room's walls, however near the gate that room's far side
 * happens to be.
 */
export function inEarshotOf(behind: GatedRoom, x: number, z: number): boolean {
  return inRoom(ROOMS[behind], x, z) || inRoom(ROOMS.hall, x, z) || inRoom(ROOMS.entrance, x, z);
}

/**
 * A gate going up is a noise, and anything that can hear it (see
 * `inEarshotOf`) and is not already after you goes to see: through the
 * gateway, and on out the far side of it. It knows nothing more than that; if
 * you are not where it can see you once it gets there, it looks round and
 * goes home. How many heard it.
 */
export function gateHeard(
  behind: GatedRoom, listeners: readonly { readonly combatant: Combatant; readonly ai: Ai }[],
): number {
  const g = GATEWAYS[behind].at;
  const near = listeners.filter(({ combatant }) => {
    combatant.position(_p);
    return inEarshotOf(behind, _p.x, _p.z);
  });
  return noise(new THREE.Vector3(g.x, 1.6, g.z), EARSHOT, near);
}

const _p = new THREE.Vector3();
