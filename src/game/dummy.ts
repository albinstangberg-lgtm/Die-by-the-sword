import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { ALL_COMBATANTS, GROUP, groups, type PhysicsWorld } from "../core/physics";
import { cutDamage, JOINT_INTEGRITY } from "./damage";
import type { Impact } from "./impacts";
import type { Targets } from "./targets";

/**
 * A practice dummy that comes apart.
 *
 * It hangs from a gallows by a rope at the chest, so gravity holds the pose and
 * there is no balance controller to fight — cut the waist and everything below
 * simply falls. Each limb is a rigid body jointed to its parent, and every
 * joint keeps an integrity value that good cuts deplete. At zero the joint is
 * removed from the world and the limb, with everything hanging off it, becomes
 * debris.
 *
 * Severing at joints rather than through geometry is the standard trick: real
 * mesh cutting is an order of magnitude more work and this reads the same at
 * speed. The player-facing rule is simple and learnable -- hit a forearm and
 * you take the hand, hit the upper arm and you take the whole arm.
 */

const MAT = {
  canvas: 0xbfae8e,
  rope: 0x6b5a3e,
  frame: 0x5a462f,
  cut: 0x7a2a22,
};

/**
 * The chest is pinned here, at the top of the torso.
 *
 * This started as a rope joint, which only constrains distance -- so the first
 * good hit sent the dummy swinging out of reach and it never drifted back.
 * A spherical joint at the same point still lets it swing and spin freely
 * under a blow, but the mount itself cannot travel, which is what makes it a
 * practice dummy rather than a punchbag.
 */
const ANCHOR_Y = 1.75;

interface LimbSpec {
  name: string;
  label: string;
  parent: string | null;
  jointKind: keyof typeof JOINT_INTEGRITY | null;
  /** Proximal (parent-side) and distal ends, in dummy-local space. */
  from: [number, number, number];
  to: [number, number, number];
  radius: number;
  mass: number;
  hinge?: [number, number, number];
  limits?: [number, number];
}

/**
 * Laid out hanging, in metres from the dummy's origin at ground level.
 *
 * The heights matter: hung any higher and the arms sit above the player's
 * shoulder, where the only way to reach them is a full overhead stretch. At
 * these heights the head, torso, arms and legs all fall inside the arc a
 * standing fighter can actually swing through.
 */
const SKELETON: LimbSpec[] = [
  { name: "torso", label: "torso", parent: null, jointKind: null,
    from: [0, 1.75, 0], to: [0, 1.20, 0], radius: 0.17, mass: 20 },

  { name: "head", label: "head", parent: "torso", jointKind: "neck",
    from: [0, 1.75, 0], to: [0, 1.99, 0], radius: 0.115, mass: 4 },

  { name: "pelvis", label: "hips", parent: "torso", jointKind: "waist",
    from: [0, 1.20, 0], to: [0, 0.96, 0], radius: 0.145, mass: 11 },

  { name: "upperArmR", label: "right arm", parent: "torso", jointKind: "shoulder",
    from: [0.21, 1.65, 0], to: [0.24, 1.36, 0], radius: 0.05, mass: 2.2 },
  { name: "foreArmR", label: "right forearm", parent: "upperArmR", jointKind: "elbow",
    from: [0.24, 1.36, 0], to: [0.26, 1.10, 0], radius: 0.045, mass: 1.6,
    hinge: [1, -0.45, 0], limits: [-2.3, 0.0] },

  { name: "upperArmL", label: "left arm", parent: "torso", jointKind: "shoulder",
    from: [-0.21, 1.65, 0], to: [-0.24, 1.36, 0], radius: 0.05, mass: 2.2 },
  { name: "foreArmL", label: "left forearm", parent: "upperArmL", jointKind: "elbow",
    from: [-0.24, 1.36, 0], to: [-0.26, 1.10, 0], radius: 0.045, mass: 1.6,
    hinge: [1, -0.45, 0], limits: [-2.3, 0.0] },

  { name: "thighR", label: "right thigh", parent: "pelvis", jointKind: "hip",
    from: [0.11, 0.96, 0], to: [0.12, 0.54, 0], radius: 0.075, mass: 7 },
  { name: "shinR", label: "right shin", parent: "thighR", jointKind: "knee",
    from: [0.12, 0.54, 0], to: [0.12, 0.14, 0], radius: 0.06, mass: 4,
    hinge: [1, -0.45, 0], limits: [0.0, 2.3] },

  { name: "thighL", label: "left thigh", parent: "pelvis", jointKind: "hip",
    from: [-0.11, 0.96, 0], to: [-0.12, 0.54, 0], radius: 0.075, mass: 7 },
  { name: "shinL", label: "left shin", parent: "thighL", jointKind: "knee",
    from: [-0.12, 0.54, 0], to: [-0.12, 0.14, 0], radius: 0.06, mass: 4,
    hinge: [1, -0.45, 0], limits: [0.0, 2.3] },
];

export interface Limb {
  spec: LimbSpec;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.Mesh;
  joint: RAPIER.ImpulseJoint | null;
  parent: Limb | null;
  children: Limb[];
  integrity: number;
  maxIntegrity: number;
  severed: boolean;
}

export interface SeverEvent {
  label: string;
  /** Cumulative damage that finally took it off. */
  at: THREE.Vector3;
}

/** Free every geometry and material in a subtree. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export class Dummy {
  readonly limbs = new Map<string, Limb>();
  readonly group = new THREE.Group();

  /** Fired when a joint parts, for the HUD. */
  onSever?: (e: SeverEvent) => void;
  /** Fired on any damaging hit, for the HUD. */
  onDamage?: (limb: Limb, amount: number) => void;

  private byCollider = new Map<number, Limb>();
  private anchor!: RAPIER.RigidBody;
  private ropeJoint: RAPIER.ImpulseJoint | null = null;
  private ropeMesh!: THREE.Mesh;
  private frame = new THREE.Group();

  private readonly _v = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();

  constructor(
    private phys: PhysicsWorld,
    private scene: THREE.Scene,
    private targets: Targets,
    private origin: THREE.Vector3,
  ) {
    this.scene.add(this.group);
    this.buildFrame();
    this.build();
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /** The gallows. Static, and not a valid target — cutting it would be silly. */
  private buildFrame(): void {
    const { rapier, world } = this.phys;
    const mat = new THREE.MeshStandardMaterial({ color: MAT.frame, roughness: 0.85 });

    const post = (x: number, y: number, z: number, hx: number, hy: number, hz: number) => {
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.fixed().setTranslation(
          this.origin.x + x, this.origin.y + y, this.origin.z + z),
      );
      world.createCollider(
        rapier.ColliderDesc.cuboid(hx, hy, hz)
          .setCollisionGroups(groups(GROUP.WORLD, GROUP.PROP | ALL_COMBATANTS)),
        body,
      );
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
      mesh.position.set(this.origin.x + x, this.origin.y + y, this.origin.z + z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.frame.add(mesh);
    };

    post(1.25, 1.12, 0, 0.09, 1.12, 0.09);   // upright
    post(0.6, 2.62, 0, 0.75, 0.08, 0.08);    // crossbeam
    this.scene.add(this.frame);
  }

  private build(): void {
    const { rapier, world } = this.phys;

    // Static point the rope hangs from.
    this.anchor = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(
        this.origin.x, this.origin.y + ANCHOR_Y, this.origin.z),
    );

    for (const spec of SKELETON) {
      const from = this._v.set(...spec.from).add(this.origin).clone();
      const to = new THREE.Vector3(...spec.to).add(this.origin);

      const dir = new THREE.Vector3().subVectors(to, from);
      const length = dir.length();
      dir.normalize();
      const centre = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
      const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(centre.x, centre.y, centre.z)
          .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
          .setLinearDamping(0.35)
          .setAngularDamping(0.8),
      );

      // Capsule half-height excludes the caps; a segment shorter than its own
      // diameter degenerates, so fall back to a sphere.
      const capHalf = Math.max(0.01, length / 2 - spec.radius);
      const collider = world.createCollider(
        rapier.ColliderDesc.capsule(capHalf, spec.radius)
          .setMass(spec.mass)
          .setFriction(0.7)
          .setRestitution(0.02)
          .setCollisionGroups(groups(GROUP.PROP, GROUP.WORLD | ALL_COMBATANTS))
          .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(1.0),
        body,
      );

      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(spec.radius, capHalf * 2, 6, 12),
        new THREE.MeshStandardMaterial({ color: MAT.canvas, roughness: 0.92 }),
      );
      mesh.castShadow = true;
      this.group.add(mesh);

      const maxIntegrity = spec.jointKind ? JOINT_INTEGRITY[spec.jointKind] : Infinity;
      const limb: Limb = {
        spec, body, collider, mesh,
        joint: null, parent: null, children: [],
        integrity: maxIntegrity, maxIntegrity, severed: false,
      };

      this.limbs.set(spec.name, limb);
      this.byCollider.set(collider.handle, limb);
      this.targets.register(collider.handle, spec.label);
    }

    // Second pass: joints, now that every body exists.
    for (const spec of SKELETON) {
      const limb = this.limbs.get(spec.name)!;
      const from = new THREE.Vector3(...spec.from).add(this.origin);

      if (spec.parent === null) {
        // Pinned at the chest: free to swing and spin, unable to wander off.
        this.ropeJoint = this.phys.world.createImpulseJoint(
          this.phys.rapier.JointData.spherical(
            { x: 0, y: 0, z: 0 },
            this.localOf(limb.body, from),
          ),
          this.anchor, limb.body, true,
        );
        continue;
      }

      const parent = this.limbs.get(spec.parent)!;
      limb.parent = parent;
      parent.children.push(limb);

      const a1 = this.localOf(parent.body, from);
      const a2 = this.localOf(limb.body, from);
      const data = spec.hinge
        ? this.phys.rapier.JointData.revolute(a1, a2,
            { x: spec.hinge[0], y: spec.hinge[1], z: spec.hinge[2] })
        : this.phys.rapier.JointData.spherical(a1, a2);

      const joint = this.phys.world.createImpulseJoint(data, parent.body, limb.body, true);
      if (spec.hinge && spec.limits) {
        (joint as RAPIER.RevoluteImpulseJoint).setLimits(spec.limits[0], spec.limits[1]);
      }
      limb.joint = joint;
    }

    const beamUnderside = 2.54;
    const span = beamUnderside - ANCHOR_Y;
    this.ropeMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, span, 6),
      new THREE.MeshStandardMaterial({ color: MAT.rope, roughness: 0.95 }),
    );
    this.ropeMesh.position.set(
      this.origin.x, this.origin.y + ANCHOR_Y + span / 2, this.origin.z);
    this.scene.add(this.ropeMesh);
  }

  /** A world point expressed in a body's local frame. */
  private localOf(body: RAPIER.RigidBody, world: THREE.Vector3): RAPIER.Vector {
    const p = body.translation();
    const r = body.rotation();
    const v = new THREE.Vector3(world.x - p.x, world.y - p.y, world.z - p.z)
      .applyQuaternion(this._q.set(r.x, r.y, r.z, r.w).invert());
    return { x: v.x, y: v.y, z: v.z };
  }

  // ---------------------------------------------------------------------------
  // Taking damage
  // ---------------------------------------------------------------------------

  /**
   * Route an impact. Returns true if it landed on this dummy.
   *
   * Damage goes to the joint holding the struck limb on, so a hit anywhere on
   * a forearm works the elbow and a hit on the upper arm works the shoulder.
   */
  receive(impact: Impact): boolean {
    const limb = this.byCollider.get(impact.colliderHandle);
    if (!limb) return false;

    const amount = cutDamage(impact);
    if (amount <= 0) return true;          // landed, but a slap or a shove

    // The torso hangs from a rope rather than a joint, so there is nothing to
    // cut it off at. Damage still registers -- it just cannot sever.
    if (limb.joint === null || limb.severed) {
      this.onDamage?.(limb, amount);
      return true;
    }

    limb.integrity -= amount;
    this.onDamage?.(limb, amount);
    this.tint(limb);

    if (limb.integrity <= 0) this.sever(limb, impact);
    return true;
  }

  /** Cut a limb free. Everything hanging off it goes with it. */
  private sever(limb: Limb, impact: Impact): void {
    if (limb.severed || limb.joint === null) return;

    this.phys.world.removeImpulseJoint(limb.joint, true);
    limb.joint = null;
    limb.severed = true;
    limb.integrity = 0;

    // The blade's momentum carries through the cut, so the piece flies off the
    // way the swing was going rather than dropping straight down.
    const push = this._v.copy(impact.bladeVelocity).multiplyScalar(0.28);
    limb.body.applyImpulse(
      { x: push.x, y: push.y + 0.4, z: push.z },
      true,
    );
    limb.body.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * 1.6, y: (Math.random() - 0.5) * 1.6, z: (Math.random() - 0.5) * 1.6 },
      true,
    );

    this.capStump(limb);
    this.onSever?.({ label: limb.spec.label, at: impact.at.clone() });
  }

  /** A dark disc over the cut end, so a severed limb reads as cut, not dropped. */
  private capStump(limb: Limb): void {
    const r = limb.spec.radius;
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.96, r * 0.96, 0.012, 12),
      new THREE.MeshStandardMaterial({ color: MAT.cut, roughness: 0.75 }),
    );
    // The proximal end is -Y in the limb's own frame.
    cap.position.y = -(limb.mesh.geometry as THREE.CapsuleGeometry).parameters.length / 2 - r * 0.5;
    limb.mesh.add(cap);

    if (limb.parent) {
      const socket = new THREE.Mesh(
        new THREE.SphereGeometry(r * 0.8, 10, 8),
        new THREE.MeshStandardMaterial({ color: MAT.cut, roughness: 0.75 }),
      );
      const from = new THREE.Vector3(...limb.spec.from).add(this.origin);
      const p = limb.parent.body.translation();
      const rq = limb.parent.body.rotation();
      socket.position.set(from.x - p.x, from.y - p.y, from.z - p.z)
        .applyQuaternion(this._q.set(rq.x, rq.y, rq.z, rq.w).invert());
      limb.parent.mesh.add(socket);
    }
  }

  /** Darken a limb as its joint gives way, so damage is visible before it parts. */
  private tint(limb: Limb): void {
    const frac = Math.max(0, Math.min(1, limb.integrity / limb.maxIntegrity));
    const mat = limb.mesh.material as THREE.MeshStandardMaterial;
    mat.color.setHex(MAT.canvas).lerp(new THREE.Color(MAT.cut), (1 - frac) * 0.8);
  }

  // ---------------------------------------------------------------------------

  /** Remaining (unsevered) limbs, for the HUD. */
  get standing(): Limb[] {
    return [...this.limbs.values()].filter((l) => l.spec.jointKind !== null && !l.severed);
  }

  get severedCount(): number {
    return [...this.limbs.values()].filter((l) => l.severed).length;
  }

  /** Tear the dummy down and build a fresh one. */
  reset(): void {
    const { world } = this.phys;
    if (this.ropeJoint) {
      world.removeImpulseJoint(this.ropeJoint, false);
      this.ropeJoint = null;
    }
    for (const limb of this.limbs.values()) {
      this.targets.forget(limb.collider.handle);
      world.removeRigidBody(limb.body);   // removes its colliders and joints too
      limb.mesh.removeFromParent();
      // Stump caps and sockets are children of the limb meshes, so disposing
      // only the limb itself would leak one geometry per cut, every reset.
      disposeTree(limb.mesh);
    }
    if (this.ropeMesh) {
      this.ropeMesh.removeFromParent();
      disposeTree(this.ropeMesh);
    }
    world.removeRigidBody(this.anchor);

    this.limbs.clear();
    this.byCollider.clear();
    this.build();
  }

  /** Every body, so the render interpolator can drive the meshes. */
  get bodies(): [RAPIER.RigidBody, THREE.Object3D][] {
    return [...this.limbs.values()].map((l) => [l.body, l.mesh] as [RAPIER.RigidBody, THREE.Object3D]);
  }
}
