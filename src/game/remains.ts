import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Combatant } from "./combatant";

/**
 * What comes off a body: a head, an arm, a forearm with the axe still in its
 * fist. Lying on the floor it is only more rigid bodies, jointed to each
 * other where the cut did not part them; picked up, it goes in the pack (see
 * inventory.ts), and put down again it comes back into the world in front of
 * whoever had it and falls to the floor like anything else.
 *
 * Nothing about a piece is copied or rebuilt to do this. It is the bodies the
 * fighter was made of, taken out of the world -- disabled, and hidden -- and
 * put back, so a reset that puts a limb back on finds the very bodies it
 * expects, where it expects them.
 */

/** One body of a piece, and the mesh it drives. */
export interface Bit {
  readonly body: RAPIER.RigidBody;
  readonly mesh: THREE.Object3D;
}

/** How far above a piece's middle a hand takes hold of it, metres at human scale. */
const HOLD_ABOVE = 0.05;

export class Piece {
  constructor(
    /** What it is called, whole: "the orc's head". */
    readonly name: string,
    readonly owner: Combatant,
    /** Its bodies, the one a hand takes it by first. */
    readonly bits: readonly Bit[],
  ) {}

  /** Where it lies, and where on it a hand takes hold. */
  locate(at: THREE.Vector3, grip: THREE.Vector3): void {
    const p = this.bits[0].body.translation();
    at.set(p.x, p.y, p.z);
    grip.copy(at);
    grip.y += HOLD_ABOVE * this.owner.fighter.build.scale;
  }

  /**
   * In the world, or out of it. Out, its bodies are disabled -- they touch
   * nothing, nothing touches them, and they stay where they were -- and
   * nothing of it is drawn.
   */
  setPresent(on: boolean): void {
    for (const b of this.bits) {
      b.body.setEnabled(on);
      b.mesh.visible = on;
    }
  }

  /**
   * A copy of it to be carried in a hand, placed where it lies and centred
   * on `grip`, world: the same meshes, sharing their geometry and materials,
   * posed as its bodies are. What is in a hand is not in the world, so it is
   * not the piece itself.
   */
  standIn(grip: THREE.Vector3): THREE.Group {
    const g = new THREE.Group();
    g.position.copy(grip);
    for (const b of this.bits) {
      const copy = b.mesh.clone();
      copy.visible = true;
      const p = b.body.translation();
      const r = b.body.rotation();
      copy.position.set(p.x - grip.x, p.y - grip.y, p.z - grip.z);
      copy.quaternion.set(r.x, r.y, r.z, r.w);
      g.add(copy);
    }
    return g;
  }

  /**
   * Put it back in the world with its first body at `at`, turned about the
   * vertical so the rest of it lies along `yaw`'s facing, still: every body
   * moved and turned together, so whatever holds its bodies to each other --
   * an elbow, a fist round a haft -- is as satisfied as it was.
   */
  place(at: THREE.Vector3, yaw: number): void {
    const root = this.bits[0].body.translation();
    const o = _o.set(root.x, root.y, root.z);
    const turn = _turn.setFromAxisAngle(UP, yaw - this.heading(o));
    for (const b of this.bits) {
      const p = b.body.translation();
      const r = b.body.rotation();
      const to = _p.set(p.x, p.y, p.z).sub(o).applyQuaternion(turn).add(at);
      const q = _q.set(r.x, r.y, r.z, r.w).premultiply(turn);
      b.body.setTranslation({ x: to.x, y: to.y, z: to.z }, true);
      b.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.body.resetForces(true);
      b.body.resetTorques(true);
    }
  }

  /**
   * How far the rest of it reaches from its first body along the floor,
   * metres: nothing for a head, an arm's length for an arm, and the haft as
   * well for one still holding a spear.
   */
  get reach(): number {
    const root = this.bits[0].body.translation();
    let far = 0;
    for (const b of this.bits) {
      const p = b.body.translation();
      far = Math.max(far, Math.hypot(p.x - root.x, p.z - root.z));
    }
    return far + this.bits.length * 0.1 * this.owner.fighter.build.scale;
  }

  /** Which way the far end of it lies from `root`, as a yaw. */
  private heading(root: THREE.Vector3): number {
    let best = 0;
    let dx = 0;
    let dz = -1;
    for (const b of this.bits) {
      const p = b.body.translation();
      const d = Math.hypot(p.x - root.x, p.z - root.z);
      if (d > best) {
        best = d;
        dx = p.x - root.x;
        dz = p.z - root.z;
      }
    }
    // Forward is -Z, and a yaw turns it toward -X.
    return Math.atan2(-dx, -dz);
  }
}

/**
 * Every piece of this body lying off it right now, as what it is and which
 * bodies it is made of -- whether it is still on the floor or in somebody's
 * pack. The same cut always gives the same key: which cut it came off at.
 *
 *   head         the head
 *   offShoulder  the other arm, whole if its elbow still holds, or what is
 *                left of it above an elbow cut first
 *   offElbow     the other forearm, cut at the elbow
 *   shoulder     the sword arm, whole
 *   elbow        the sword forearm
 *
 * A sword arm keeps hold of its weapon: it comes too, unless it was on the
 * back when the arm came off.
 */
export function piecesOf(who: Combatant): { key: string; name: string; bits: Bit[] }[] {
  const out: { key: string; name: string; bits: Bit[] }[] = [];
  const whose = `${who.name}'s`;
  const f = who.fighter;
  const part = (name: string) => f.parts.find((p) => p.name === name);
  const bit = (name: string): Bit | null => {
    const p = part(name);
    return p?.body ? { body: p.body, mesh: p.mesh } : null;
  };

  const head = part("head");
  const headBit = bit("head");
  if (head?.severed && headBit) out.push({ key: "head", name: `${whose} head`, bits: [headBit] });

  // Cutting the shoulder marks the forearm severed too, with its elbow still
  // jointed: an arm comes off whole unless its elbow was cut first.
  const upper = part("offShoulder");
  const fore = part("offElbow");
  const upperBit = bit("offShoulder");
  const foreBit = bit("offElbow");
  if (fore && foreBit && fore.joint === null) {
    out.push({ key: "offElbow", name: `${whose} off forearm`, bits: [foreBit] });
  }
  if (upper?.severed && upperBit) {
    const whole = fore !== undefined && foreBit !== null && fore.joint !== null;
    out.push({
      key: "offShoulder", name: whole ? `${whose} off arm` : `${whose} off upper arm`,
      bits: whole ? [upperBit, foreBit!] : [upperBit],
    });
  }

  const arm = who.arm;
  if (arm.severedAt !== null) {
    const bits: Bit[] = arm.severedAt === "shoulder"
      ? [{ body: arm.upper, mesh: arm.upperMesh }, { body: arm.fore, mesh: arm.foreMesh }]
      : [{ body: arm.fore, mesh: arm.foreMesh }];
    const armed = !arm.stowed;
    if (armed) bits.push({ body: arm.blade, mesh: arm.bladeMesh });
    const what = arm.severedAt === "shoulder" ? "arm" : "forearm";
    out.push({
      key: arm.severedAt, name: `${whose} ${what}${armed ? ` and ${arm.weapon.name}` : ""}`, bits,
    });
  }
  return out;
}

const UP = new THREE.Vector3(0, 1, 0);
const _o = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
