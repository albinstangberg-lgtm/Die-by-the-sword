import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";
import { HULL, SEGMENT, STANDING, local } from "./anatomy";

/**
 * A fighter: one locomotion hull carrying a human-shaped skeleton.
 *
 * The hull is an invisible capsule spanning feet to shoulders. It is the only
 * thing that walks, bumps into walls and holds the figure up, and blades pass
 * straight through it. Everything you can see or cut hangs off it:
 *
 *   torso, pelvis   colliders on the hull itself — they move with it rigidly
 *   head, off-arm   real jointed bodies, held in place by weak PD controllers,
 *                   severable exactly as the practice dummy's limbs are
 *   legs            kinematic: posed by a walk cycle, hittable, never simulated
 *
 * That split is the whole trick. A skeleton made of jointed limbs that has to
 * hold itself upright is a research project; a skeleton hung off something that
 * cannot fall over is an afternoon. The sword arm is the exception and lives in
 * arm.ts, because it is the one limb a player actually drives.
 */

export interface Palette {
  cloth: number;
  skin: number;
  mark: number;
}

export const PLAYER_PALETTE: Palette = { cloth: 0x6b4a3a, skin: 0xa8826a, mark: 0xd8cbb4 };
export const FOE_PALETTE: Palette = { cloth: 0x3f4a5c, skin: 0x9c8570, mark: 0xc44a2f };

/** Right shoulder, in hull-local space. The sword arm hangs from here. */
export const SHOULDER_LOCAL = new THREE.Vector3(
  STANDING.shoulderX, local(STANDING.shoulder), 0);

/** How hard the head and off-arm are held in their pose. */
const HEAD_KP = 26, HEAD_KD = 3.2;
const OFF_ARM_KP = 9, OFF_ARM_KD = 1.4;
/** Clamped like the sword arm's drive: no controller here gets unbounded authority. */
const POSE_MAX_TORQUE = 40;

/** Stride timing: radians of hip swing per metre travelled. */
const STRIDE = 2.6;
const STRIDE_SWING = 0.55;

export interface FighterPart {
  name: string;
  label: string;
  collider: RAPIER.Collider;
  /** Present only for the severable jointed parts. */
  body?: RAPIER.RigidBody;
  joint?: RAPIER.ImpulseJoint | null;
  severed?: boolean;
  mesh: THREE.Object3D;
}

export class Fighter {
  readonly body: RAPIER.RigidBody;
  /** The chest. Named `collider` still because it is the main hit target. */
  readonly collider: RAPIER.Collider;
  readonly mesh = new THREE.Group();

  /** Facing, radians. Driven by the turn keys, not the mouse — the mouse is the arm. */
  yaw = 0;

  readonly parts: FighterPart[] = [];

  private head!: RAPIER.RigidBody;
  private headJoint: RAPIER.ImpulseJoint | null = null;
  private offUpper!: RAPIER.RigidBody;
  private offFore!: RAPIER.RigidBody;
  private offShoulderJoint: RAPIER.ImpulseJoint | null = null;
  private offElbowJoint: RAPIER.ImpulseJoint | null = null;

  /** Kinematic lower body, posed rather than simulated. */
  private legs: {
    thigh: RAPIER.RigidBody; shin: RAPIER.RigidBody;
    hipPivot: THREE.Object3D; kneePivot: THREE.Object3D;
    thighMesh: THREE.Object3D; shinMesh: THREE.Object3D;
    sign: number;
  }[] = [];

  private stridePhase = 0;
  private headMesh!: THREE.Object3D;
  private offUpperMesh!: THREE.Object3D;
  private offForeMesh!: THREE.Object3D;

  private readonly tmpVec = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();

  constructor(
    private phys: PhysicsWorld,
    private scene: THREE.Scene,
    spawn: THREE.Vector3,
    readonly side: Side,
    private palette: Palette = PLAYER_PALETTE,
  ) {
    const { rapier, world } = phys;

    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setLinearDamping(0.2)
        .setAngularDamping(6)
        .setCanSleep(false),
    );
    // Only yaw. Letting the hull pitch or roll turns every wall hit into a
    // pratfall, and the sword arm's reaction torque would topple it constantly.
    this.body.setEnabledRotations(false, true, false, true);

    // The hull: what stands and walks. Blades ignore it, so a hit always lands
    // on a named body part instead of a nondescript capsule.
    world.createCollider(
      rapier.ColliderDesc.capsule(HULL.height / 2 - HULL.radius, HULL.radius)
        .setMass(HULL.mass)
        .setFriction(0.4)
        .setCollisionGroups(side.hullFilter),
      this.body,
    );

    this.collider = this.rigidPart("torso", "body", SEGMENT.torso,
      local((STANDING.waist + STANDING.neck) / 2), 0, palette.cloth);
    this.rigidPart("pelvis", "hips", SEGMENT.pelvis,
      local((STANDING.hip + STANDING.waist) / 2), 0, palette.cloth);

    this.buildHead();
    this.buildOffArm();
    this.buildLegs();

    this.scene.add(this.mesh);
    // Kinematic bodies are born at the origin. Reaching their real position
    // through setNextKinematicTranslation would imply crossing the room in one
    // step, at a couple of hundred metres per second.
    this.poseLegs(true);
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /** A collider mounted straight onto the hull — moves with it, cannot come off. */
  private rigidPart(
    name: string, label: string, seg: { radius: number; length: number; mass: number },
    y: number, x: number, colour: number,
  ): RAPIER.Collider {
    const { rapier, world } = this.phys;
    const half = Math.max(0.01, seg.length / 2 - seg.radius);
    const collider = world.createCollider(
      rapier.ColliderDesc.capsule(half, seg.radius)
        .setTranslation(x, y, 0)
        .setMass(seg.mass)
        .setCollisionGroups(this.side.bodyFilter)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1.0),
      this.body,
    );

    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(seg.radius, half * 2, 6, 14),
      new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 }),
    );
    mesh.position.set(x, y, 0);
    mesh.castShadow = true;
    this.mesh.add(mesh);

    this.parts.push({ name, label, collider, mesh });
    return collider;
  }

  private buildHead(): void {
    const { rapier, world } = this.phys;
    const p = this.body.translation();
    const seg = SEGMENT.head;
    const y = local(STANDING.neck + seg.length / 2);

    this.head = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y + y, p.z)
        .setLinearDamping(0.5).setAngularDamping(2).setCanSleep(false),
    );
    const collider = world.createCollider(
      rapier.ColliderDesc.ball(seg.radius)
        .setMass(seg.mass)
        .setCollisionGroups(this.side.bodyFilter)
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1.0),
      this.head,
    );

    this.headJoint = world.createImpulseJoint(
      rapier.JointData.spherical(
        { x: 0, y: local(STANDING.neck), z: 0 },
        { x: 0, y: -seg.length / 2, z: 0 },
      ),
      this.body, this.head, true,
    );

    this.headMesh = buildHeadMesh(this.palette);
    this.scene.add(this.headMesh);
    this.parts.push({
      name: "head", label: "head", collider, body: this.head,
      joint: this.headJoint, severed: false, mesh: this.headMesh,
    });
  }

  /** The left arm: present, jointed, severable — but never driven by anyone. */
  private buildOffArm(): void {
    const { rapier, world } = this.phys;
    const p = this.body.translation();
    const sx = -STANDING.shoulderX;

    const make = (seg: typeof SEGMENT.upperArm, topY: number) => {
      const centre = topY - seg.length / 2;
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(p.x + sx, p.y + local(centre), p.z)
          // Rotated so local +Y runs from the joint down the limb, matching
          // the sword arm's convention.
          .setRotation({ x: 1, y: 0, z: 0, w: 0 })
          .setLinearDamping(0.7).setAngularDamping(1.6).setCanSleep(false),
      );
      const half = Math.max(0.01, seg.length / 2 - seg.radius);
      const collider = world.createCollider(
        rapier.ColliderDesc.capsule(half, seg.radius)
          .setMass(seg.mass)
          .setCollisionGroups(this.side.bodyFilter)
          .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(1.0),
        body,
      );
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(seg.radius, half * 2, 6, 12),
        new THREE.MeshStandardMaterial({ color: this.palette.skin, roughness: 0.7 }),
      );
      mesh.castShadow = true;
      return { body, collider, mesh, seg };
    };

    const upper = make(SEGMENT.upperArm, STANDING.shoulder);
    const elbowY = STANDING.shoulder - SEGMENT.upperArm.length;
    const fore = make(SEGMENT.foreArm, elbowY);

    this.offUpper = upper.body;
    this.offFore = fore.body;
    this.offUpperMesh = upper.mesh;
    this.offForeMesh = fore.mesh;

    this.offShoulderJoint = world.createImpulseJoint(
      rapier.JointData.spherical(
        { x: sx, y: local(STANDING.shoulder), z: 0 },
        { x: 0, y: -SEGMENT.upperArm.length / 2, z: 0 },
      ),
      this.body, upper.body, true,
    );
    this.offElbowJoint = world.createImpulseJoint(
      rapier.JointData.revolute(
        { x: 0, y: SEGMENT.upperArm.length / 2, z: 0 },
        { x: 0, y: -SEGMENT.foreArm.length / 2, z: 0 },
        { x: 1, y: 0, z: 0 },
      ),
      upper.body, fore.body, true,
    );
    (this.offElbowJoint as RAPIER.RevoluteImpulseJoint).setLimits(-2.3, -0.05);

    this.scene.add(upper.mesh, fore.mesh);

    this.parts.push({
      name: "offShoulder", label: "off arm", collider: upper.collider,
      body: upper.body, joint: this.offShoulderJoint, severed: false, mesh: upper.mesh,
    });
    this.parts.push({
      name: "offElbow", label: "off forearm", collider: fore.collider,
      body: fore.body, joint: this.offElbowJoint, severed: false, mesh: fore.mesh,
    });
  }

  /**
   * Legs: kinematic bodies that follow a posed hierarchy.
   *
   * They collide with blades so you can cut at someone's legs and have it
   * register, but they are never simulated — a kinematic body is unmoved by
   * anything it hits, so no amount of flailing can trip the figure up.
   */
  private buildLegs(): void {
    const { rapier, world } = this.phys;

    for (const sign of [-1, 1]) {
      const hipPivot = new THREE.Object3D();
      hipPivot.position.set(sign * STANDING.hipX, local(STANDING.hip), 0);
      this.mesh.add(hipPivot);

      const thighMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(SEGMENT.thigh.radius,
          SEGMENT.thigh.length - SEGMENT.thigh.radius * 2, 6, 12),
        new THREE.MeshStandardMaterial({ color: this.palette.cloth, roughness: 0.85 }),
      );
      thighMesh.position.y = -SEGMENT.thigh.length / 2;
      thighMesh.castShadow = true;
      hipPivot.add(thighMesh);

      const kneePivot = new THREE.Object3D();
      kneePivot.position.y = -SEGMENT.thigh.length;
      hipPivot.add(kneePivot);

      const shinMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(SEGMENT.shin.radius,
          SEGMENT.shin.length - SEGMENT.shin.radius * 2, 6, 12),
        new THREE.MeshStandardMaterial({ color: this.palette.cloth, roughness: 0.85 }),
      );
      shinMesh.position.y = -SEGMENT.shin.length / 2;
      shinMesh.castShadow = true;
      kneePivot.add(shinMesh);

      const kinematic = (seg: typeof SEGMENT.thigh, label: string, mesh: THREE.Object3D) => {
        const bodyR = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased());
        const half = Math.max(0.01, seg.length / 2 - seg.radius);
        const collider = world.createCollider(
          rapier.ColliderDesc.capsule(half, seg.radius)
            .setCollisionGroups(this.side.hitOnlyFilter)
            .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
            .setContactForceEventThreshold(1.0),
          bodyR,
        );
        this.parts.push({ name: label, label, collider, mesh });
        return bodyR;
      };

      const side = sign < 0 ? "left" : "right";
      this.legs.push({
        thigh: kinematic(SEGMENT.thigh, `${side} thigh`, thighMesh),
        shin: kinematic(SEGMENT.shin, `${side} shin`, shinMesh),
        hipPivot, kneePivot, thighMesh, shinMesh, sign,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Per-step
  // ---------------------------------------------------------------------------

  /** Called once per fixed step, before the physics step. */
  update(keys: Keys, t: Tuning, dt: number): void {
    let turn = 0;
    if (keys.turnLeft) turn += 1;
    if (keys.turnRight) turn -= 1;
    this.yaw += turn * t.turnSpeed * dt;
    this.body.setRotation(
      { x: 0, y: Math.sin(this.yaw / 2), z: 0, w: Math.cos(this.yaw / 2) }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);

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
      v.set((ix * cos + iz * sin) / len, 0, (-ix * sin + iz * cos) / len)
        .multiplyScalar(t.moveSpeed);
    }

    const current = this.body.linvel();
    this.body.setLinvel({ x: v.x, y: current.y, z: v.z }, true);

    // Stride advances with distance covered, so the legs never skate.
    this.stridePhase += Math.hypot(v.x, v.z) * dt * STRIDE;
    this.poseLegs();
    this.holdPose(dt);
  }

  /** Weak PD keeping head and off-arm in a living posture rather than limp. */
  private holdPose(_dt: number): void {
    const hullRot = this.body.rotation();
    this._q2.set(hullRot.x, hullRot.y, hullRot.z, hullRot.w);

    if (!this.severed("head")) {
      this.alignTo(this.head, this._q.copy(this._q2), HEAD_KP, HEAD_KD);
    }
    // The off arm rests slightly forward and across, the way a free hand sits
    // when the other one is holding a sword.
    if (!this.severed("offShoulder")) {
      this._q.copy(this._q2).multiply(
        this._qFromEuler(-0.35, 0, 0.22));
      this.alignTo(this.offUpper, this._q, OFF_ARM_KP, OFF_ARM_KD);
    }
    if (!this.severed("offElbow") && !this.severed("offShoulder")) {
      this._q.copy(this._q2).multiply(this._qFromEuler(-0.95, 0, 0.1));
      this.alignTo(this.offFore, this._q, OFF_ARM_KP, OFF_ARM_KD);
    }
  }

  private readonly _euler = new THREE.Euler();
  private readonly _qe = new THREE.Quaternion();
  private _qFromEuler(x: number, y: number, z: number): THREE.Quaternion {
    // The limbs' local +Y points down the limb, so the rest pose is a half
    // turn about X with the posture applied on top.
    return this._qe.setFromEuler(this._euler.set(Math.PI + x, y, z));
  }

  /** Clamped angular PD pulling a body toward a world orientation. */
  private alignTo(body: RAPIER.RigidBody, target: THREE.Quaternion,
                  kp: number, kd: number): void {
    body.resetTorques(false);
    const r = body.rotation();
    const err = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert().premultiply(target);
    if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w);
    const sinHalf = Math.hypot(err.x, err.y, err.z);
    const torque = this._v.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      const angle = 2 * Math.atan2(sinHalf, err.w);
      torque.set(err.x, err.y, err.z).multiplyScalar((angle / sinHalf) * kp);
    }
    const av = body.angvel();
    torque.x -= av.x * kd;
    torque.y -= av.y * kd;
    torque.z -= av.z * kd;
    const mag = torque.length();
    if (mag > POSE_MAX_TORQUE) torque.multiplyScalar(POSE_MAX_TORQUE / mag);
    body.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
  }

  /** Swing the legs and push the kinematic colliders to match. */
  private poseLegs(teleport = false): void {
    const p = this.body.translation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.rotation.set(0, this.yaw, 0);
    this.mesh.updateMatrixWorld(true);

    for (const leg of this.legs) {
      const phase = this.stridePhase + (leg.sign > 0 ? Math.PI : 0);
      leg.hipPivot.rotation.x = Math.sin(phase) * STRIDE_SWING;
      // A knee only bends one way, so the back half of the cycle is flattened.
      leg.kneePivot.rotation.x = Math.max(0, -Math.sin(phase - 0.6)) * 0.9;
    }
    this.mesh.updateMatrixWorld(true);

    for (const leg of this.legs) {
      pushKinematic(leg.thigh, leg.thighMesh, teleport);
      pushKinematic(leg.shin, leg.shinMesh, teleport);
    }
  }

  private severed(name: string): boolean {
    return this.parts.find((p) => p.name === name)?.severed === true;
  }

  /** Cut a jointed part free. Children go with it. */
  sever(name: string): boolean {
    const part = this.parts.find((p) => p.name === name);
    if (!part || !part.joint || part.severed) return false;
    this.phys.world.removeImpulseJoint(part.joint, true);
    part.joint = null;
    part.severed = true;
    part.body?.resetTorques(true);
    part.body?.resetForces(true);
    // Cutting the shoulder takes the forearm with it — its elbow is intact, it
    // is just no longer attached to anything that is attached to anything.
    if (name === "offShoulder") {
      const fore = this.parts.find((p) => p.name === "offElbow");
      if (fore) fore.severed = true;
    }
    return true;
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
    copyTransform(this.head, this.headMesh);
    copyTransform(this.offUpper, this.offUpperMesh);
    copyTransform(this.offFore, this.offForeMesh);
  }

  reset(spawn: THREE.Vector3): void {
    this.yaw = 0;
    this.stridePhase = 0;
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

    // Severed parts stay severed until the whole fighter is rebuilt; what a
    // reset can do is put the still-attached ones back where they belong.
    const place = (body: RAPIER.RigidBody, y: number, x = 0) => {
      body.setTranslation({ x: spawn.x + x, y: spawn.y + y, z: spawn.z }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    };
    place(this.head, local(STANDING.neck + SEGMENT.head.length / 2));
    place(this.offUpper, local(STANDING.shoulder - SEGMENT.upperArm.length / 2),
      -STANDING.shoulderX);
    place(this.offFore,
      local(STANDING.shoulder - SEGMENT.upperArm.length - SEGMENT.foreArm.length / 2),
      -STANDING.shoulderX);
  }
}

// -----------------------------------------------------------------------------

function copyTransform(body: RAPIER.RigidBody, obj: THREE.Object3D): void {
  const p = body.translation();
  const r = body.rotation();
  obj.position.set(p.x, p.y, p.z);
  obj.quaternion.set(r.x, r.y, r.z, r.w);
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/** Drive a kinematic body from wherever its mesh has been posed to. */
function pushKinematic(body: RAPIER.RigidBody, mesh: THREE.Object3D, teleport = false): void {
  mesh.matrixWorld.decompose(_p, _q, _s);
  if (teleport) {
    body.setTranslation({ x: _p.x, y: _p.y, z: _p.z }, false);
    body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, false);
    return;
  }
  body.setNextKinematicTranslation({ x: _p.x, y: _p.y, z: _p.z });
  body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
}

function buildHeadMesh(p: Palette): THREE.Object3D {
  const g = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(SEGMENT.head.radius, 16, 12),
    new THREE.MeshStandardMaterial({ color: p.skin, roughness: 0.7 }),
  );
  head.castShadow = true;
  g.add(head);

  // Marks the facing direction — without it you cannot tell which way anyone
  // is looking, which matters a lot once someone is trying to kill you.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.038, 0.1, 8),
    new THREE.MeshStandardMaterial({ color: p.mark, roughness: 0.6 }),
  );
  nose.position.set(0, 0, -SEGMENT.head.radius);
  nose.rotation.x = -Math.PI / 2;
  g.add(nose);
  return g;
}
