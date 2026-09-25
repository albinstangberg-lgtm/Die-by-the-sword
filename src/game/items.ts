import * as THREE from "three";
import type { Combatant } from "./combatant";
import { buildShieldMesh, SHIELD } from "./shield";
import { Piece, piecesOf } from "./remains";

/**
 * Things lying about that a hand can take.
 *
 * None of them is physical. A potion on the floor is not something a blade
 * should skid on or an opponent should step round, so these are scenery with
 * a place, and taking one is a question of reach and of a free hand -- the
 * sword hand, which means the sword has to be put away first. That is the one
 * rule, and it is the point: picking something up in the middle of a fight
 * costs you your sword for as long as it takes.
 *
 *   a potion     goes in your pack (see inventory.ts); drinking one takes a
 *                free hand (see `Combatant.drink`) and gives health back over
 *                a couple of seconds rather than all at once
 *   a shield     straps onto the off forearm (see offarm.ts). One lies in the
 *                hall, past the orc: it is earned
 *   the rack     in the training room, with a shield on it. Take it down to
 *                practise with, hang it back to fight without: a toggle, and
 *                the one place a shield comes free
 *   remains      whatever you have cut off an opponent: a head, an arm, a
 *                forearm with the axe still in it (see remains.ts). Unlike
 *                the rest these are physical -- they fell there, and they lie
 *                where they came to rest -- so where one is is asked of its
 *                bodies each step. Into the pack, and out again in front of
 *                you, with `drop`
 */

export type ItemKind = "potion" | "shield" | "rack" | "remains";

export interface Item {
  readonly kind: ItemKind;
  /** What the prompt calls it. */
  readonly name: string;
  /** Where it lies, world, on the floor. Kept up to date for remains, which move. */
  readonly at: THREE.Vector3;
  readonly mesh: THREE.Object3D;
  /** Where on it a hand takes hold, world. */
  readonly grip: THREE.Vector3;
  /**
   * Which way a body has to face to take it, as a yaw, or null if any way
   * will do: a rack is taken from in front, a potion from wherever you are.
   */
  readonly face: number | null;
  /**
   * Gone from where it lay -- until a reset puts it back. For the rack: its
   * shield is off it. For remains: in someone's pack.
   */
  taken: boolean;
  /** For remains: the bodies it is made of, and whose they were. */
  readonly piece?: Piece;
}

/** How far from the middle of a body a hand can take something off the floor, metres at human scale. */
export const PICKUP_REACH = 1.25;
/**
 * How far away something may be and still be gone and got, metres at human
 * scale: F walks over to it. Further than that, and it is not "this".
 */
export const PICKUP_RANGE = 2.4;

/** What a potion gives back, as a share of a body's full health, over how long. */
export const POTION_HEAL = 0.4;
export const POTION_TIME = 2;

/** Where things are put down, and which way the rack faces (a yaw, world). */
export interface ItemLayout {
  potions: readonly THREE.Vector3[];
  shield: THREE.Vector3;
  rack: { at: THREE.Vector3; facing: number };
}

export class Items {
  readonly items: Item[] = [];
  private readonly rackShield: THREE.Object3D;
  /**
   * Where each mesh that can be carried off belongs, so a hand that took it
   * can put it back: its parent and its place there.
   */
  private readonly homes = new Map<THREE.Object3D, {
    parent: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion;
  }>();
  /**
   * In a hand right now: the mesh, and how far it is still to go to the palm
   * -- and, for remains, which, since what is in the hand is only a copy.
   */
  private carried: { mesh: THREE.Object3D; from: THREE.Vector3; piece: Piece | null } | null = null;
  /** Whose severed parts become things to pick up. */
  private owners: readonly Combatant[] = [];
  /** And the remains found so far, by owner and cut. */
  private readonly known = new Map<string, Item>();

  constructor(scene: THREE.Scene, layout: ItemLayout) {
    for (const at of layout.potions) {
      const mesh = potionMesh();
      mesh.position.copy(at);
      scene.add(mesh);
      this.items.push({
        kind: "potion", name: "a health potion", at: at.clone(), mesh, taken: false,
        // By the neck.
        grip: at.clone().setY(0.15), face: null,
      });
      this.home(mesh);
    }

    // A shield lying on its back, boss up.
    const shield = buildShieldMesh();
    glow(shield);
    shield.position.copy(layout.shield).setY(SHIELD.thick / 2 + 0.01);
    scene.add(shield);
    this.items.push({
      kind: "shield", name: "the shield", at: layout.shield.clone(), mesh: shield, taken: false,
      // By the boss.
      grip: layout.shield.clone().setY(0.08), face: null,
    });
    this.home(shield);

    const rack = rackMesh();
    rack.position.copy(layout.rack.at);
    rack.rotation.y = layout.rack.facing;
    // Hung on its peg, face out.
    this.rackShield = buildShieldMesh();
    this.rackShield.rotation.x = -Math.PI / 2;
    this.rackShield.position.set(0, 1.28, -0.07);
    rack.add(this.rackShield);
    scene.add(rack);
    rack.updateMatrixWorld(true);
    this.items.push({
      kind: "rack", name: "the shield rack", at: layout.rack.at.clone(), mesh: rack, taken: false,
      // The shield's rim, from in front: the rack's front is its own -Z.
      grip: this.rackShield.localToWorld(new THREE.Vector3(0, 0.03, 0.12)),
      face: layout.rack.facing + Math.PI,
    });
    this.home(this.rackShield);
  }

  private home(mesh: THREE.Object3D): void {
    this.homes.set(mesh, {
      parent: mesh.parent!, position: mesh.position.clone(), quaternion: mesh.quaternion.clone(),
    });
  }

  /**
   * Take something's mesh into a hand -- `palm`, which has to be a node of
   * even scale -- from wherever it lies, and ease it into the palm over the
   * next few steps. What it IS is not decided here: see `take`.
   */
  lift(item: Item, palm: THREE.Object3D): void {
    this.putBack();
    const piece = item.piece ?? null;
    let mesh: THREE.Object3D;
    if (piece) {
      // Out of the world while it is in the hand, or the body bowed over it
      // kicks it about: a copy goes up in its place.
      mesh = piece.standIn(item.grip);
      piece.setPresent(false);
    } else {
      mesh = item.kind === "rack" ? this.rackShield : item.mesh;
      mesh.visible = true;
    }
    palm.attach(mesh);
    this.carried = { mesh, from: mesh.position.clone(), piece };
  }

  /** A step of whatever is in a hand settling into it, `k` of the way from where it was picked up. */
  settle(k: number): void {
    if (!this.carried) return;
    this.carried.mesh.position.copy(this.carried.from).multiplyScalar(1 - Math.min(1, k));
  }

  /** Whatever is in a hand back where it belongs, shown or not as it is taken or not. */
  putBack(): void {
    const c = this.carried;
    if (!c) return;
    this.carried = null;
    if (c.piece) {
      // Only a copy: the piece itself never left the floor.
      c.mesh.removeFromParent();
    } else {
      const home = this.homes.get(c.mesh)!;
      home.parent.add(c.mesh);
      c.mesh.position.copy(home.position);
      c.mesh.quaternion.copy(home.quaternion);
    }
    for (const item of this.items) this.setTaken(item, item.taken);
  }

  /**
   * Watch these bodies: whatever is cut off them from now on is something to
   * pick up. Not your own -- nobody goes back for their own arm.
   */
  watch(owners: readonly Combatant[]): void {
    this.owners = owners;
  }

  /**
   * Once a step, after the world has: remains newly cut off join the things
   * lying about, and everything already lying about is found where its
   * bodies have got to.
   */
  update(): void {
    this.owners.forEach((who, i) => {
      for (const p of piecesOf(who)) {
        const key = `${i}:${p.key}`;
        if (this.known.has(key)) continue;
        const piece = new Piece(p.name, who, p.bits);
        const at = new THREE.Vector3();
        const grip = new THREE.Vector3();
        piece.locate(at, grip);
        const item: Item = {
          kind: "remains", name: p.name, at, mesh: p.bits[0].mesh, grip, face: null,
          taken: false, piece,
        };
        this.known.set(key, item);
        this.items.push(item);
      }
    });
    for (const item of this.items) {
      if (item.piece && !item.taken && this.carried?.piece !== item.piece) {
        item.piece.locate(item.at, item.grip);
      }
    }
  }

  /**
   * Put a piece from `who`'s pack back into the world: in front of them, at
   * knee height and short of any wall, lying away from them, to fall to the
   * floor. What goes back in is the bodies themselves, so anything that was
   * following one -- a weapon's sweep, most of all -- has to be told it moved:
   * see `Impacts.resetSweeps`.
   */
  drop(who: Combatant, item: Item): Outcome {
    const piece = item.piece;
    if (!piece || !item.taken || !who.inventory.remains.includes(item)) return { ok: false, text: "" };
    if (who.dead) return { ok: false, text: "" };
    const f = who.fighter;
    const s = f.build.scale;
    const sin = Math.sin(f.yaw);
    const cos = Math.cos(f.yaw);
    // As far out as it will go, up to a pace, with room past it for the rest
    // of it and a little more. Where there is not -- a wall in front, and an
    // arm with an axe in it -- it lies across the front instead, toward
    // whichever side has more floor.
    const reach = piece.reach;
    const margin = DROP_CLEAR * s;
    const want = DROP_AHEAD * s;
    const clear = f.clearAlong(-sin, -cos, want + reach + margin);
    let ahead = clear - reach - margin;
    let lie = f.yaw;
    if (ahead < DROP_NEAR * s) {
      ahead = clear - margin;
      const right = f.clearAlong(cos, -sin, reach + margin);
      const left = f.clearAlong(-cos, sin, reach + margin);
      lie = right >= left ? f.yaw - Math.PI / 2 : f.yaw + Math.PI / 2;
    }
    ahead = Math.max(DROP_NEAR * s, Math.min(want, ahead));
    const p = f.body.translation();
    const at = _drop.set(p.x - sin * ahead, p.y - f.build.hullCentreY + DROP_UP * s, p.z - cos * ahead);
    piece.place(at, lie);
    who.inventory.unstow(item);
    this.setTaken(item, false);
    piece.locate(item.at, item.grip);
    return { ok: true, text: `dropped ${item.name}` };
  }

  /** The nearest thing a body standing at `p` could reach, or null. */
  nearest(p: THREE.Vector3, reach: number, seen: (item: Item) => boolean = () => true): Item | null {
    let best: Item | null = null;
    let bestD = reach;
    for (const item of this.items) {
      if (item.taken && item.kind !== "rack") continue;
      if (!seen(item)) continue;
      const d = Math.hypot(item.at.x - p.x, item.at.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best;
  }

  /**
   * Mark something taken, or -- for the rack -- whether its shield is on it.
   * Remains taken leave the world; put down, they come back into it.
   */
  setTaken(item: Item, taken: boolean): void {
    item.taken = taken;
    if (item.piece) {
      if (this.carried?.piece !== item.piece) item.piece.setPresent(!taken);
    } else if (item.kind === "rack") this.rackShield.visible = !taken;
    else item.mesh.visible = !taken;
  }

  /**
   * Everything back where it was. Remains go back into the world, wherever
   * they are, for the reset that follows to put back on whoever lost them --
   * so this goes first -- and are not lying about any more.
   */
  reset(): void {
    for (const item of this.items) item.taken = false;
    this.putBack();
    for (const item of this.items) this.setTaken(item, false);
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].piece) this.items.splice(i, 1);
    }
    this.known.clear();
  }
}

/**
 * Where a piece put down goes, metres at human scale: this far ahead of the
 * middle of the body putting it down, no nearer than this whatever is in the
 * way, this far short of a wall, and from this high.
 */
const DROP_AHEAD = 0.6;
const DROP_NEAR = 0.3;
const DROP_CLEAR = 0.12;
const DROP_UP = 0.45;
const _drop = new THREE.Vector3();

/** What trying to take something did, in words the HUD can show. */
export interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * Why this body cannot take that, in words the HUD can show -- or null if it
 * can. The sword has to be away: the hand that takes things is the sword hand.
 */
export function refusal(who: Combatant, item: Item): string | null {
  if (who.dead || who.fighter.down) return "";
  if (who.arm.disarmed) return "no hand to take it with";
  if (!who.arm.sheathed || who.arm.stowing) return "sheathe your sword first — X";
  const l = who.fighter.offLimb;
  const arm = l.shoulderOn && l.elbowOn;
  switch (item.kind) {
    case "potion":
    case "remains":
      return null;
    case "shield":
      if (who.carriesShield) return "you already carry a shield";
      return arm ? null : "no arm to strap it to";
    case "rack":
      if (!item.taken) {
        if (who.carriesShield) return "you already carry a shield";
        return arm ? null : "no arm to strap it to";
      }
      return who.carriesShield ? null : "the rack is empty";
  }
}

/**
 * What taking it does, once a hand has it: a potion or a piece of somebody in
 * the pack, a shield on the arm, a shield off the arm -- or the back -- and
 * back on the rack.
 */
export function take(who: Combatant, items: Items, item: Item): Outcome {
  const no = refusal(who, item);
  if (no !== null) return { ok: false, text: no };
  switch (item.kind) {
    case "potion":
      items.setTaken(item, true);
      who.potions++;
      return { ok: true, text: `took ${item.name}` };
    case "remains":
      items.setTaken(item, true);
      who.inventory.stow(item);
      return { ok: true, text: `took ${item.name}` };
    case "shield":
      if (!who.equipShield()) return { ok: false, text: "no arm to strap it to" };
      items.setTaken(item, true);
      return { ok: true, text: "took up the shield" };
    case "rack":
      if (!item.taken) {
        if (!who.equipShield()) return { ok: false, text: "no arm to strap it to" };
        items.setTaken(item, true);
        return { ok: true, text: "took the shield from the rack" };
      }
      who.unequipShield();
      items.setTaken(item, false);
      return { ok: true, text: "hung the shield on the rack" };
  }
}

/**
 * Take whatever is nearest, within an arm's reach, at once: the rules, with
 * nothing walked to or reached for. What F does is `Pickup`, which goes and
 * gets it and then asks `take` exactly this.
 */
export function interact(who: Combatant, items: Items): Outcome {
  if (who.dead || who.fighter.down) return { ok: false, text: "" };
  const item = items.nearest(who.position(_p), PICKUP_REACH * who.fighter.build.scale);
  if (!item) return { ok: false, text: "nothing in reach" };
  return take(who, items, item);
}

/**
 * The nearest thing this body could go and get: within a few paces, and in
 * sight -- a potion on the far side of a wall is not in front of you.
 */
export function inRange(who: Combatant, items: Items): Item | null {
  if (who.dead || who.fighter.down) return null;
  return items.nearest(who.position(_p), PICKUP_RANGE * who.fighter.build.scale,
    (item) => who.fighter.sees(_seen.copy(item.grip).setY(item.grip.y + 0.1)));
}

/** What F would do here, for the prompt, or null if there is nothing to go and get. */
export function promptFor(who: Combatant, items: Items): string | null {
  const item = inRange(who, items);
  if (!item) return null;
  const verb = item.kind === "rack" && item.taken ? "hang your shield on the rack"
    : item.kind === "rack" ? "take the shield" : `take ${item.name}`;
  const no = refusal(who, item);
  if (no === null) return `F — ${verb}`;
  // Only the one refusal that says what to do about it.
  return who.arm.sheathed || who.arm.disarmed || !canHold(who, item) ? null : `X then F — ${verb}`;
}

/** Could it be taken, sword aside? */
function canHold(who: Combatant, item: Item): boolean {
  const l = who.fighter.offLimb;
  const arm = l.shoulderOn && l.elbowOn;
  if (item.kind === "potion" || item.kind === "remains") return true;
  if (item.kind === "rack" && item.taken) return who.carriesShield;
  return arm && !who.carriesShield;
}

const _p = new THREE.Vector3();
const _seen = new THREE.Vector3();

// -----------------------------------------------------------------------------

/** A little emissive lift, so a thing on the floor can be found in the gloom. */
function glow(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && "emissive" in m) {
      m.emissive = m.color.clone();
      m.emissiveIntensity = 0.18;
    }
  });
}

/** A round flask of something red, corked. */
function potionMesh(): THREE.Group {
  const g = new THREE.Group();
  const glass = new THREE.MeshStandardMaterial({
    color: 0xc9d6de, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.35,
  });
  const liquid = new THREE.MeshStandardMaterial({
    color: 0xb0161a, emissive: 0x7a0c10, emissiveIntensity: 0.7, roughness: 0.3,
  });
  const cork = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 });

  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), glass);
  bulb.position.y = 0.06;
  const fill = new THREE.Mesh(new THREE.SphereGeometry(0.052, 16, 12), liquid);
  fill.position.y = 0.058;
  fill.castShadow = true;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.06, 10), glass);
  neck.position.y = 0.135;
  const stopper = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.017, 0.028, 10), cork);
  stopper.position.y = 0.175;
  g.add(bulb, fill, neck, stopper);
  return g;
}

/** Two posts and a bar with a peg: a thing to hang a shield on. Scenery -- nothing to snag a blade. */
function rackMesh(): THREE.Group {
  const g = new THREE.Group();
  const timber = new THREE.MeshStandardMaterial({ color: 0x654c34, roughness: 0.82 });
  for (const x of [-0.42, 0.42]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.7, 0.07), timber);
    post.position.set(x, 0.85, 0.05);
    post.castShadow = true;
    g.add(post);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.08, 0.07), timber);
  bar.position.set(0, 1.62, 0.05);
  bar.castShadow = true;
  g.add(bar);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.34), timber);
  foot.position.set(0, 0.03, 0.02);
  g.add(foot);
  const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8), timber);
  peg.rotation.x = Math.PI / 2;
  peg.position.set(0, 1.5, -0.02);
  g.add(peg);
  return g;
}
