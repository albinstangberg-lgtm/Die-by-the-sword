import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Combatant } from "./combatant";
import type { Lever } from "./gate";
import { buildShieldMesh, SHIELD } from "./shield";
import { discardStandIn, Piece, piecesOf } from "./remains";

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
 *                forearm (see remains.ts)
 *   a weapon     whatever an opponent's hand still had hold of when it was
 *                cut off or died: the orc's axe. The hand lets go of it as
 *                you take it
 *   the lever    on the hall's wall, beside the pen's gate. Nothing is taken:
 *                the hand takes hold of it and pulls it down (see gate.ts)
 *
 * Remains and weapons are physical, unlike the rest -- they fell there, and
 * they lie where they came to rest -- so where one is is asked of its bodies
 * each step. And they are not put away as they are taken: they stay in the
 * hand that took them, until F puts them in the bag, or G lets go of them --
 * which is a throw, if the hand was swinging: see `letGo`. From the bag they
 * come back out into the hand. A weapon held can be taken up, with X, and
 * fought with: see `wield`. The lever is physical too, and stays where it is.
 */

export type ItemKind = "potion" | "shield" | "rack" | "remains" | "weapon" | "lever";

/** Kept in the hand once taken, rather than put away: a piece of somebody, or their weapon. */
export function holds(item: Item): boolean {
  return item.kind === "remains" || item.kind === "weapon";
}

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
   * shield is off it. For remains and weapons: in a hand, or in a bag. For
   * the lever: pulled down, and caught there.
   */
  taken: boolean;
  /** For remains and weapons: the bodies it is made of, and whose they were. */
  readonly piece?: Piece;
  /** For the lever: the lever. */
  readonly lever?: Lever;
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
   * -- and, for a piece of somebody, which, since what is in the hand is only
   * a copy, and whether the hand is keeping it (see `hold`).
   */
  private carried: {
    mesh: THREE.Object3D; from: THREE.Vector3; piece: Piece | null; held: boolean;
  } | null = null;
  /** Whoever is holding something, if anyone is. */
  private holder: Combatant | null = null;
  /** Whose severed parts become things to pick up. */
  private owners: readonly Combatant[] = [];
  /** And the remains found so far, by owner and cut. */
  private readonly known = new Map<string, Item>();
  /**
   * Pieces just out of a hand, still passing through whoever let go of them:
   * see `clearOf`.
   */
  private readonly leaving: Leaving[] = [];
  /**
   * Told of each body put somewhere new between two steps, so whatever draws
   * it can draw it there at once rather than sliding it in from where it was.
   */
  placed: (body: RAPIER.RigidBody) => void = () => {};

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
   * Something the arena put there that F can go to, which keeps itself up to
   * date: the lever (see gate.ts). Never lifted, never carried off.
   */
  add(item: Item): void {
    if (!this.items.includes(item)) this.items.push(item);
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
      // Parted from whatever still has hold of it, and out of the world while
      // it is in the hand, or the body bowed over it kicks it about: a copy
      // goes up in its place.
      this.arrive(piece);
      piece.release();
      mesh = piece.standIn(item.grip);
      piece.setPresent(false);
    } else {
      mesh = item.kind === "rack" ? this.rackShield : item.mesh;
      mesh.visible = true;
    }
    palm.attach(mesh);
    this.carried = { mesh, from: mesh.position.clone(), piece, held: false };
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
    if (c.held && this.holder) {
      this.holder.held = null;
      this.holder = null;
    }
    if (c.piece) {
      // Only a copy: the piece itself is wherever it was left.
      discardStandIn(c.mesh);
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
        const piece = new Piece(p.kind, p.name, who, p.bits, p.release);
        const at = new THREE.Vector3();
        const grip = new THREE.Vector3();
        piece.locate(at, grip);
        const item: Item = {
          kind: p.kind, name: p.name, at, mesh: p.bits[0].mesh, grip, face: null,
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
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const l = this.leaving[i];
      if (this.clearOf(l)) this.arrive(l.piece);
    }
    // A hand taken away from what it holds -- a blow on the floor, a cut, the
    // sword coming out -- lets go of it. A weapon taken up is held as the
    // arm's own would be: a fall keeps it, and a cut takes it with the arm.
    const h = this.holder;
    if (h?.arm.wieldsTaken) {
      if (h.arm.disarmed) this.forget(h);
    } else if (h && (h.dead || h.fighter.down || h.arm.disarmed || !h.arm.sheathed || h.arm.stowing)) {
      this.letGo(h);
    }
  }

  /** Whatever `who` held is not theirs to hold any more, wherever it is. */
  private forget(who: Combatant): void {
    if (this.holder !== who) return;
    who.held = null;
    this.holder = null;
  }

  /**
   * X with a weapon in the hand: take it up and fight with it (see
   * `Arm.takeUp`). The copy in the hand goes, and the arm's weapon is the
   * real thing from here, with that weapon's own shape and weight; the one it
   * was taken off stays out of the world meanwhile, and comes back into it
   * where the arm's weapon is when the hand lets go.
   */
  wield(who: Combatant): Outcome {
    const item = who.held;
    if (item?.kind !== "weapon" || !item.piece || this.holder !== who) return { ok: false, text: "" };
    if (!who.arm.takeUp(item.piece.owner.arm.weapon)) return { ok: false, text: "" };
    const c = this.carried;
    if (c?.piece === item.piece) {
      this.carried = null;
      discardStandIn(c.mesh);
    }
    return { ok: true, text: `you take up ${item.name}` };
  }

  /** X again: put it up -- a thing held in the hand again, the sword on the back. */
  unwield(who: Combatant): Outcome {
    const item = who.held;
    if (!item || this.holder !== who || !who.arm.putUp()) return { ok: false, text: "" };
    this.hold(who, item);
    return { ok: true, text: `you lower ${item.name}` };
  }

  /**
   * Keep a piece of somebody in `who`'s sword hand: the copy that went up in
   * it on the way from the floor, or -- from the bag, or taken at once -- one
   * put there now. It is theirs from here, out of the world, until they put
   * it in the bag or let go of it.
   */
  hold(who: Combatant, item: Item): Outcome {
    if (!item.piece) return { ok: false, text: "" };
    if (this.carried?.piece !== item.piece) this.lift(item, who.arm.palm);
    this.settle(1);
    this.carried!.held = true;
    this.holder = who;
    who.held = item;
    this.setTaken(item, true);
    return { ok: true, text: `holding ${item.name}` };
  }

  /** F with something in the hand -- taken up, or only held: into the bag with it. */
  bag(who: Combatant): Outcome {
    const item = who.held;
    if (!item || this.holder !== who) return { ok: false, text: "nothing in your hand" };
    if (who.arm.wieldsTaken && !who.arm.putUp()) return { ok: false, text: "" };
    this.putBack();
    this.forget(who);
    who.inventory.stow(item);
    return { ok: true, text: `put ${item.name} in your bag` };
  }

  /** And out of the bag into the hand again, if the hand is free to take it. */
  unbag(who: Combatant, item: Item): Outcome {
    if (!item.piece || !who.inventory.pieces.includes(item)) return { ok: false, text: "" };
    const busy = handBusy(who);
    if (busy !== null) return { ok: false, text: busy };
    who.inventory.unstow(item);
    return this.hold(who, item);
  }

  /**
   * G, or anything that takes the hand away: let go of what is in it. It
   * leaves the hand as it is in the hand -- where it is, turned as it is, and
   * moving as the hand is -- so let go of in the middle of a swing, it is
   * thrown, and let go of from a still hand, it drops. Only where that would
   * put it in the stone -- a wall or the floor that the copy in the hand went
   * into -- is it put down instead, in front of whoever had it, to fall.
   */
  letGo(who: Combatant): Outcome {
    const item = who.held;
    if (!item?.piece || this.holder !== who) return { ok: false, text: "nothing in your hand" };
    const piece = item.piece;
    let flight: Flight[] | null;
    if (who.arm.wieldsTaken) {
      // A weapon taken up leaves the hand as the arm's weapon is: where it
      // is, turned as it is and moving as it is. It was that weapon all along.
      const b = who.arm.blade;
      flight = [{
        body: piece.bits[0].body, p: vec(b.translation()), q: quat(b.rotation()),
        v: vec(b.linvel()), w: vec(b.angvel()),
      }];
      if (!who.arm.putUp()) return { ok: false, text: "" };
      this.forget(who);
    } else {
      const c = this.carried;
      flight = c?.piece === piece ? this.fromHand(who, piece, c.mesh) : null;
      const from = who.arm.handPosition.y;
      this.putBack();
      if (!flight) this.putDown(who, piece, from);
    }
    this.setTaken(item, false);
    if (flight) this.launch(who, piece, flight);
    for (const b of piece.bits) this.placed(b.body);
    piece.locate(item.at, item.grip);
    const speed = flight ? Math.max(...flight.map((f) => f.v.length())) : 0;
    return { ok: true, text: speed >= THROWN ? `threw ${item.name}` : `let go of ${item.name}` };
  }

  /**
   * Where each body of a piece would go, and how it would be moving, if it
   * left `who`'s hand now as the copy in it is: the copy's pose, carried on
   * the forearm where the world has it rather than where it was last drawn.
   * It goes the way the hand was going, as fast, and turning as the hand
   * was: its middle takes the palm's speed, and it spins about that with the
   * forearm's spin. Not the speed the forearm has at its middle, which a
   * rigid thing would -- the copy is held however it lay, and a sword lying
   * back along the arm would go backwards off a swing forwards. Null if any
   * of it would be in the stone.
   */
  private fromHand(who: Combatant, piece: Piece, copy: THREE.Object3D): Flight[] | null {
    const arm = who.arm;
    const fore = arm.fore;
    const t = fore.translation();
    const r = fore.rotation();
    _qa.set(r.x, r.y, r.z, r.w);
    _hand.compose(_a.set(t.x, t.y, t.z), _qa, ONE);
    const palm = arm.palm.position.clone().applyQuaternion(_qa).add(_a);
    arm.palm.updateMatrix();
    copy.updateMatrix();
    _hand.multiply(arm.palm.matrix).multiply(copy.matrix);
    const spin = vec(fore.angvel());
    const com = fore.worldCom();
    _a.set(palm.x - com.x, palm.y - com.y, palm.z - com.z);
    const speed = vec(fore.linvel()).add(_b.crossVectors(spin, _a));
    const stone = who.fighter.side.sightFilter;
    const out: Flight[] = [];
    const middle = new THREE.Vector3();
    let mass = 0;
    for (let i = 0; i < piece.bits.length; i++) {
      const body = piece.bits[i].body;
      const m = copy.children[i];
      m.updateMatrix();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      _m.multiplyMatrices(_hand, m.matrix).decompose(p, q, _s);
      // Each of its colliders, carried from where they sit on the body now
      // to where that pose puts them.
      const bp = body.translation();
      const bq = body.rotation();
      _qb.set(bq.x, bq.y, bq.z, bq.w).invert();
      for (let k = 0; k < body.numColliders(); k++) {
        const col = body.collider(k);
        const ct = col.translation();
        const cr = col.rotation();
        _a.set(ct.x - bp.x, ct.y - bp.y, ct.z - bp.z).applyQuaternion(_qb).applyQuaternion(q).add(p);
        _qa.set(cr.x, cr.y, cr.z, cr.w).premultiply(_qb).premultiply(q);
        if (who.fighter.overlaps(col.shape, _a, _qa, stone)) return null;
      }
      // For now its own middle, in the velocity's place.
      const lc = body.localCom();
      const v = new THREE.Vector3(lc.x, lc.y, lc.z).applyQuaternion(q).add(p);
      middle.addScaledVector(v, body.mass());
      mass += body.mass();
      out.push({ body, p, q, v, w: spin.clone() });
    }
    middle.multiplyScalar(1 / mass);
    for (const f of out) f.v.sub(middle).crossVectors(spin, f.v).add(speed);
    return out;
  }

  /**
   * A piece, back in the world, sent on its way: every body where it goes
   * and moving as it goes. It passes through whoever let go of it until it
   * is clear of them -- it starts inside their hand -- and meets them after
   * that like anybody else.
   */
  private launch(who: Combatant, piece: Piece, flight: readonly Flight[]): void {
    for (const f of flight) {
      f.body.setTranslation(f.p, true);
      f.body.setRotation(f.q, true);
      f.body.setLinvel(f.v, true);
      f.body.setAngvel(f.w, true);
      f.body.resetForces(true);
      f.body.resetTorques(true);
    }
    this.arrive(piece);
    const side = who.fighter.side;
    const theirs = side.body | side.blade;
    const colliders: Leaving["colliders"] = [];
    for (const b of piece.bits) {
      for (let k = 0; k < b.body.numColliders(); k++) {
        const c = b.body.collider(k);
        const groups = c.collisionGroups();
        colliders.push({ c, unmet: groups & theirs });
        c.setCollisionGroups(groups & ~theirs);
      }
    }
    this.leaving.push({ piece, from: who, colliders });
  }

  /**
   * Whether a piece on its way out of a hand is clear of whoever let go of
   * it: none of it anywhere in them that it would otherwise meet.
   */
  private clearOf(l: Leaving): boolean {
    return l.colliders.every(({ c, unmet }) => unmet === 0
      || !l.from.fighter.overlaps(c.shape, c.translation(), c.rotation(), (c.collisionGroups() & ~0xffff) | unmet, c));
  }

  /**
   * A piece done leaving a hand, however it got there: it meets whoever it
   * would again. Only what was taken off is put back, so anything else that
   * changed what it meets meanwhile -- the arm it fell from going limp --
   * stands.
   */
  private arrive(piece: Piece): void {
    const i = this.leaving.findIndex((l) => l.piece === piece);
    if (i < 0) return;
    for (const { c, unmet } of this.leaving[i].colliders) c.setCollisionGroups(c.collisionGroups() | unmet);
    this.leaving.splice(i, 1);
  }

  /**
   * A piece back into the world in front of `who`: from `height`, or knee
   * height if that is higher, short of any wall and lying away from them, to
   * fall to the floor. It goes in as it lay when it was taken, turned to
   * their facing, rather than as the copy in the hand was hanging: the copy
   * went through walls and floors on the way, and the bodies cannot.
   */
  private putDown(who: Combatant, piece: Piece, height: number): void {
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
    const soles = p.y - f.build.hullCentreY;
    const y = Math.max(soles + DROP_UP * s, Math.min(height, soles + DROP_TOP * s));
    piece.place(_drop.set(p.x - sin * ahead, y, p.z - cos * ahead), lie);
  }

  /**
   * The nearest thing a body standing at `p` could reach, or null. A weapon
   * counts as a little nearer than it is: one still in a fist lies where the
   * fist does, and of the two it is the one worth having first.
   */
  nearest(p: THREE.Vector3, reach: number, seen: (item: Item) => boolean = () => true): Item | null {
    let best: Item | null = null;
    let bestD = reach;
    for (const item of this.items) {
      if (item.taken && item.kind !== "rack") continue;
      if (!seen(item)) continue;
      const d = Math.hypot(item.at.x - p.x, item.at.z - p.z) - (item.kind === "weapon" ? WEAPON_FIRST : 0);
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
    // A lever says for itself whether it is down: see `Lever.reset`.
    if (item.lever) return;
    item.taken = taken;
    if (item.piece) {
      if (this.carried?.piece !== item.piece) item.piece.setPresent(!taken);
    } else if (item.kind === "rack") this.rackShield.visible = !taken;
    else item.mesh.visible = !taken;
  }

  /**
   * Everything back where it was. Remains go back into the world, wherever
   * they are, for the reset that follows to put back on whoever lost them --
   * so this goes first -- and are not lying about any more. The lever is the
   * arena's to put back up, with its gate.
   */
  reset(): void {
    while (this.leaving.length) this.arrive(this.leaving[0].piece);
    for (const item of this.items) if (!item.lever) item.taken = false;
    this.putBack();
    this.holder = null;
    for (const item of this.items) this.setTaken(item, false);
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].piece) this.items.splice(i, 1);
    }
    this.known.clear();
  }
}

/** How much nearer a weapon counts than it is, metres: see `Items.nearest`. */
const WEAPON_FIRST = 0.3;

/** How fast something has to leave a hand, m/s, to have been thrown rather than let go of. */
const THROWN = 2.5;

/** A body of a piece leaving a hand: where it goes, and how it is moving, world. */
interface Flight {
  body: RAPIER.RigidBody;
  p: THREE.Vector3;
  q: THREE.Quaternion;
  v: THREE.Vector3;
  w: THREE.Vector3;
}

/**
 * A piece just out of a hand, and whose: its colliders, and which of that
 * body's groups each would meet but is passing through for now.
 */
interface Leaving {
  piece: Piece;
  from: Combatant;
  colliders: { c: RAPIER.Collider; unmet: number }[];
}

function vec(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function quat(q: { x: number; y: number; z: number; w: number }): THREE.Quaternion {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
}

const ONE = new THREE.Vector3(1, 1, 1);
const _hand = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/**
 * Where a piece let go of goes, metres at human scale: this far ahead of the
 * middle of the body putting it down, no nearer than this whatever is in the
 * way, this far short of a wall, and from no lower than this and no higher
 * than that.
 */
const DROP_AHEAD = 0.6;
const DROP_NEAR = 0.3;
const DROP_CLEAR = 0.12;
const DROP_UP = 0.45;
const DROP_TOP = 1.3;
const _drop = new THREE.Vector3();

/** What trying to take something did, in words the HUD can show. */
export interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * Why the sword hand cannot take anything right now, or null if it can: it
 * is the hand that takes things, so the sword has to be away, and it has to
 * be empty.
 */
export function handBusy(who: Combatant): string | null {
  if (who.dead || who.fighter.down) return "";
  if (who.arm.disarmed) return "no hand to take it with";
  if (who.held) return `your hand is full — F puts ${who.held.name} in your bag`;
  if (!who.arm.sheathed || who.arm.stowing) return "sheathe your sword first — X";
  return null;
}

/**
 * Why this body cannot take that, in words the HUD can show -- or null if it
 * can. The sword has to be away: the hand that takes things is the sword hand.
 */
export function refusal(who: Combatant, item: Item): string | null {
  const busy = handBusy(who);
  if (busy !== null) return busy;
  const l = who.fighter.offLimb;
  const arm = l.shoulderOn && l.elbowOn;
  switch (item.kind) {
    case "potion":
    case "remains":
    case "weapon":
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
    case "lever":
      return item.taken ? "the lever is down" : null;
  }
}

/**
 * What taking it does, once a hand has it: a potion in the bag, a piece of
 * somebody or their weapon kept in the hand, a shield on the arm, a shield
 * off the arm -- or the back -- and back on the rack. A lever is not taken
 * but pulled, and a hand pulling one is `Pickup`'s: asked here, with no hand
 * on it, it is thrown over outright, and swings down on its own spring.
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
    case "weapon":
      return items.hold(who, item);
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
    case "lever":
      item.lever?.throwOver();
      return { ok: true, text: PULLED };
  }
}

/** What pulling the lever down did, in the HUD's words. */
export const PULLED = "you pull the lever down";

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
  if (who.held) {
    // Taken up, it is a weapon like any other: nothing to prompt.
    if (who.arm.wieldsTaken) return null;
    const name = who.held.name;
    return who.held.kind === "weapon"
      ? `X — wield ${name} · F — put it in your bag · G — let go, or swing and throw`
      : `F — put ${name} in your bag · G — let go, or swing and throw`;
  }
  const item = inRange(who, items);
  if (!item) return null;
  const verb = item.kind === "rack" && item.taken ? "hang your shield on the rack"
    : item.kind === "rack" ? "take the shield"
      : item.kind === "lever" ? `pull ${item.name}` : `take ${item.name}`;
  const no = refusal(who, item);
  if (no === null) return `F — ${verb}`;
  // Only the one refusal that says what to do about it.
  return who.arm.sheathed || who.arm.disarmed || !canHold(who, item) ? null : `X then F — ${verb}`;
}

/** Could it be taken, sword aside? */
function canHold(who: Combatant, item: Item): boolean {
  const l = who.fighter.offLimb;
  const arm = l.shoulderOn && l.elbowOn;
  if (item.kind === "potion" || item.kind === "lever" || holds(item)) return true;
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
