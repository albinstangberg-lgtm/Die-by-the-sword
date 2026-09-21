import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";

/**
 * The torso: a dynamic capsule that can only rotate about Y.
 *
 * Deliberately NOT physically simulated below the waist. Full-body physical
 * locomotion is a research project; a kinematic-ish torso carrying a physical
 * arm is what makes the mechanic playable. The torso is *dynamic* rather than
 * kinematic so it still collides with walls and props properly — we just
 * overwrite its velocity every step instead of pushing it with forces.
 */

const TORSO_HALF_HEIGHT = 0.36;
const TORSO_RADIUS = 0.24;
const TORSO_MASS = 68;

export interface Palette {
  cloth: number;
  skin: number;
  mark: number;
}

export const PLAYER_PALETTE: Palette = { cloth: 0x6b4a3a, skin: 0xa8826a, mark: 0xd8cbb4 };
export const FOE_PALETTE: Palette = { cloth: 0x3f4a5c, skin: 0x9c8570, mark: 0xc44a2f };

/** Right shoulder, in torso-local space. The arm hangs from here. */
export const SHOULDER_LOCAL = new THREE.Vector3(0.28, 0.3, 0);

export class Fighter {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mesh: THREE.Group;

  /** Facing, radians. Driven by the turn keys, not the mouse — the mouse is the arm. */
  yaw = 0;

  private readonly tmpVec = new THREE.Vector3();

  constructor(
    phys: PhysicsWorld,
    scene: THREE.Scene,
    spawn: THREE.Vector3,
    readonly side: Side,
    palette: Palette = PLAYER_PALETTE,
  ) {
    const { rapier, world } = phys;

    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setLinearDamping(0.2)
        .setAngularDamping(6)
        .setCanSleep(false),
    );
    // Only yaw. Letting the torso pitch or roll turns every wall hit into a
    // pratfall, and the arm's reaction torque would topple it constantly.
    this.body.setEnabledRotations(false, true, false, true);

    this.collider = world.createCollider(
      rapier.ColliderDesc.capsule(TORSO_HALF_HEIGHT, TORSO_RADIUS)
        .setMass(TORSO_MASS)
        .setFriction(0.4)
        .setCollisionGroups(side.bodyFilter),
      this.body,
    );

    this.mesh = buildTorsoMesh(palette);
    scene.add(this.mesh);
  }

  /** Called once per fixed step, before the physics step. */
  update(keys: Keys, t: Tuning, dt: number): void {
    // --- turning ---
    let turn = 0;
    if (keys.turnLeft) turn += 1;
    if (keys.turnRight) turn -= 1;
    this.yaw += turn * t.turnSpeed * dt;
    this.body.setRotation(
      { x: 0, y: Math.sin(this.yaw / 2), z: 0, w: Math.cos(this.yaw / 2) },
      true,
    );
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);

    // --- walking ---
    let ix = 0;
    let iz = 0;
    if (keys.forward) iz -= 1;
    if (keys.back) iz += 1;
    if (keys.left) ix -= 1;
    if (keys.right) ix += 1;

    const len = Math.hypot(ix, iz);
    const v = this.tmpVec.set(0, 0, 0);
    if (len > 0) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Rotate the input vector into world space by the torso's yaw.
      v.set((ix * cos + iz * sin) / len, 0, (-ix * sin + iz * cos) / len)
        .multiplyScalar(t.moveSpeed);
    }

    // Preserve Y so gravity still applies and the capsule settles on the floor.
    const current = this.body.linvel();
    this.body.setLinvel({ x: v.x, y: current.y, z: v.z }, true);
  }

  position(out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    return out.set(p.x, p.y, p.z);
  }

  /** Shoulder anchor in world space. */
  shoulderWorld(out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const l = SHOULDER_LOCAL;
    return out.set(
      p.x + l.x * cos + l.z * sin,
      p.y + l.y,
      p.z + -l.x * sin + l.z * cos,
    );
  }

  syncMesh(): void {
    const p = this.body.translation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.rotation.set(0, this.yaw, 0);
  }

  reset(spawn: THREE.Vector3): void {
    this.yaw = 0;
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  }
}

function buildTorsoMesh(p: Palette): THREE.Group {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: p.cloth, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: p.skin, roughness: 0.7 });

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(TORSO_RADIUS, TORSO_HALF_HEIGHT * 2, 8, 16),
    cloth,
  );
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), skin);
  head.position.y = TORSO_HALF_HEIGHT + TORSO_RADIUS + 0.08;
  head.castShadow = true;
  g.add(head);

  // A stub left arm, purely so the silhouette reads as a person. It has no
  // physics — only the right arm is simulated.
  const stub = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.42, 4, 8), cloth);
  stub.position.set(-0.3, 0.02, 0);
  stub.rotation.z = 0.18;
  stub.castShadow = true;
  g.add(stub);

  // Legs: static visual stubs. Stage 2 has no gait.
  for (const x of [-0.11, 0.11]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 4, 8), cloth);
    leg.position.set(x, -TORSO_HALF_HEIGHT - 0.28, 0);
    leg.castShadow = true;
    g.add(leg);
  }

  // Marks the facing direction — without it you can't tell which way you point.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.14, 8),
    new THREE.MeshStandardMaterial({ color: p.mark, roughness: 0.6 }),
  );
  nose.position.set(0, TORSO_HALF_HEIGHT + TORSO_RADIUS + 0.08, -0.15);
  nose.rotation.x = -Math.PI / 2;
  g.add(nose);

  return g;
}
