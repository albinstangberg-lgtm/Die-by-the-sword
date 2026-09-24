import * as THREE from "three";
import type { Combatant } from "./combatant";
import { buildShieldMesh, SHIELD } from "./shield";

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
 *   a potion     goes on your belt; drinking one takes a free hand (see
 *                `Combatant.drink`) and gives health back over a couple of
 *                seconds rather than all at once
 *   a shield     straps onto the off forearm (see offarm.ts). One lies in the
 *                hall, past the orc: it is earned
 *   the rack     in the training room, with a shield on it. Take it down to
 *                practise with, hang it back to fight without: a toggle, and
 *                the one place a shield comes free
 */

export type ItemKind = "potion" | "shield" | "rack";

export interface Item {
  readonly kind: ItemKind;
  /** What the prompt calls it. */
  readonly name: string;
  /** Where it lies, world, on the floor. */
  readonly at: THREE.Vector3;
  readonly mesh: THREE.Object3D;
  /**
   * Gone from where it lay -- until a reset puts it back. For the rack: its
   * shield is off it.
   */
  taken: boolean;
}

/** How far from the middle of a body a hand can take something off the floor, metres at human scale. */
export const PICKUP_REACH = 1.25;

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

  constructor(scene: THREE.Scene, layout: ItemLayout) {
    for (const at of layout.potions) {
      const mesh = potionMesh();
      mesh.position.copy(at);
      scene.add(mesh);
      this.items.push({ kind: "potion", name: "a health potion", at: at.clone(), mesh, taken: false });
    }

    // A shield lying on its back, boss up.
    const shield = buildShieldMesh();
    glow(shield);
    shield.position.copy(layout.shield).setY(SHIELD.thick / 2 + 0.01);
    scene.add(shield);
    this.items.push({
      kind: "shield", name: "the shield", at: layout.shield.clone(), mesh: shield, taken: false,
    });

    const rack = rackMesh();
    rack.position.copy(layout.rack.at);
    rack.rotation.y = layout.rack.facing;
    // Hung on its peg, face out.
    this.rackShield = buildShieldMesh();
    this.rackShield.rotation.x = -Math.PI / 2;
    this.rackShield.position.set(0, 1.28, -0.07);
    rack.add(this.rackShield);
    scene.add(rack);
    this.items.push({
      kind: "rack", name: "the shield rack", at: layout.rack.at.clone(), mesh: rack, taken: false,
    });
  }

  /** The nearest thing a body standing at `p` could reach, or null. */
  nearest(p: THREE.Vector3, reach: number): Item | null {
    let best: Item | null = null;
    let bestD = reach;
    for (const item of this.items) {
      if (item.taken && item.kind !== "rack") continue;
      const d = Math.hypot(item.at.x - p.x, item.at.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best;
  }

  /** Mark something taken, or -- for the rack -- whether its shield is on it. */
  setTaken(item: Item, taken: boolean): void {
    item.taken = taken;
    if (item.kind === "rack") this.rackShield.visible = !taken;
    else item.mesh.visible = !taken;
  }

  /** Everything back where it was. */
  reset(): void {
    for (const item of this.items) this.setTaken(item, false);
  }
}

/** What trying to take something did, in words the HUD can show. */
export interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * Reach for whatever is nearest. The sword has to be away: the hand that
 * takes things is the sword hand.
 */
export function interact(who: Combatant, items: Items): Outcome {
  if (who.dead || who.fighter.down) return { ok: false, text: "" };
  const at = who.position(_p);
  const item = items.nearest(at, PICKUP_REACH * who.fighter.build.scale);
  if (!item) return { ok: false, text: "nothing in reach" };
  if (who.arm.disarmed) return { ok: false, text: "no hand to take it with" };
  if (!who.arm.sheathed) return { ok: false, text: "sheathe your sword first — X" };

  switch (item.kind) {
    case "potion":
      items.setTaken(item, true);
      who.potions++;
      return { ok: true, text: `took ${item.name}` };
    case "shield":
      if (who.hasShield) return { ok: false, text: "you already carry a shield" };
      if (!who.equipShield()) return { ok: false, text: "no arm to strap it to" };
      items.setTaken(item, true);
      return { ok: true, text: "took up the shield" };
    case "rack":
      if (!item.taken) {
        if (who.hasShield) return { ok: false, text: "you already carry a shield" };
        if (!who.equipShield()) return { ok: false, text: "no arm to strap it to" };
        items.setTaken(item, true);
        return { ok: true, text: "took the shield from the rack" };
      }
      if (!who.hasShield) return { ok: false, text: "the rack is empty" };
      who.unequipShield();
      items.setTaken(item, false);
      return { ok: true, text: "hung the shield on the rack" };
  }
}

/** What F would do here, for the prompt, or null if nothing is in reach. */
export function promptFor(who: Combatant, items: Items): string | null {
  if (who.dead || who.fighter.down) return null;
  const item = items.nearest(who.position(_p), PICKUP_REACH * who.fighter.build.scale);
  if (!item) return null;
  const verb = item.kind === "rack"
    ? (item.taken ? (who.hasShield ? "hang your shield on the rack" : null) : "take the shield")
    : `take ${item.name}`;
  if (verb === null) return null;
  return who.arm.sheathed ? `F — ${verb}` : `X then F — ${verb}`;
}

const _p = new THREE.Vector3();

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
