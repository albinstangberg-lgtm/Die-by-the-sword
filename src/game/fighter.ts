import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";
import { HUMAN, type Build, type Segment } from "./anatomy";

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

/** How hard the head and off-arm are held in their pose. */
const HEAD_KP = 26, HEAD_KD = 3.2;
const OFF_ARM_KP = 9, OFF_ARM_KD = 1.4;
/** Clamped like the sword arm's drive: no controller here gets unbounded authority. */
const POSE_MAX_TORQUE = 40;

/** Stride timing: radians of hip swing per metre travelled. */
const STRIDE = 2.6;
const STRIDE_SWING = 0.55;

/**
 * How long after the feet leave the ground a jump still counts, seconds.
 *
 * Small, but not zero: the probe below is a single ray and it flickers off for
 * a step or two crossing anything uneven, and a jump that silently does
 * nothing reads as a broken key rather than a missed input.
 */
const COYOTE = 0.09;
/** After a take-off, how long before the feet can push again. */
const JUMP_LOCK = 0.14;
/** How far past the soles the ground probe looks, at human scale. */
const GROUND_PROBE = 0.1;
/** How fast the legs fold up once there is nothing to stand on. */
const TUCK_RATE = 9;

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
  private offUpper!: RAPIER.RigidBody;
  private offFore!: RAPIER.RigidBody;

  /**
   * Kinematic lower body, posed rather than simulated.
   *
   * The swing angles are kept for two steps so render can interpolate them.
   * Every other mesh in the fight is placed by the Interpolator from a rigid
   * body's transform; these are the one thing with no body to read, so they
   * would otherwise step at 60Hz inside a body that does not.
   */
  private legs: {
    thigh: RAPIER.RigidBody; shin: RAPIER.RigidBody;
    hipPivot: THREE.Object3D; kneePivot: THREE.Object3D;
    thighMesh: THREE.Object3D; shinMesh: THREE.Object3D;
    sign: number;
    hip: number; knee: number;
    prevHip: number; prevKnee: number;
  }[] = [];

  private stridePhase = 0;
  private headMesh!: THREE.Object3D;

  /** Whether the ground probe found anything to push off. */
  grounded = true;
  private coyote = COYOTE;
  private jumpLock = 0;
  /** 0 standing, 1 fully folded up. Blended so the legs do not pop. */
  private tuck = 0;
  private readonly groundRay: RAPIER.Ray;
  private readonly groundReach: number;

  private readonly tmpVec = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();

  constructor(
    private phys: PhysicsWorld,
    private scene: THREE.Scene,
    spawn: THREE.Vector3,
    readonly side: Side,
    readonly palette: Palette = PLAYER_PALETTE,
    /** Proportions. A goblin and an orc are this same class at other sizes. */
    readonly build: Build = HUMAN,
  ) {
    const { rapier, world } = phys;
    // Local aliases so every measurement below reads as anatomy rather than
    // as a chain of property lookups.
    const { segment: SEGMENT, standing: STANDING, hull: HULL } = build;
    const local = build.local;

    this.groundRay = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.groundReach = HULL.height / 2 + GROUND_PROBE * build.scale;

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
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
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

    this.headMesh = buildHeadMesh(this.palette, seg.radius);
    this.scene.add(this.headMesh);
    this.parts.push({
      name: "head", label: "head", collider, body: this.head,
      joint: this.jointFor("head"), severed: false, mesh: this.headMesh,
    });
  }

  /**
   * Build one of the severable joints from scratch.
   *
   * A factory rather than three inline calls in the constructor, because a
   * reset has to be able to put a limb back ON. Severing removes the joint
   * from the world outright — there is no "disabled" state to flip back — so
   * the only way to reattach anything is to make the joint again, and the only
   * way to be sure the new one matches the old is for both to come from here.
   */
  private jointFor(name: string): RAPIER.ImpulseJoint {
    const { rapier, world } = this.phys;
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;

    if (name === "head") {
      return world.createImpulseJoint(
        rapier.JointData.spherical(
          { x: 0, y: local(STANDING.neck), z: 0 },
          { x: 0, y: -SEGMENT.head.length / 2, z: 0 },
        ),
        this.body, this.head, true,
      );
    }
    if (name === "offShoulder") {
      return world.createImpulseJoint(
        rapier.JointData.spherical(
          { x: -STANDING.shoulderX, y: local(STANDING.shoulder), z: 0 },
          { x: 0, y: -SEGMENT.upperArm.length / 2, z: 0 },
        ),
        this.body, this.offUpper, true,
      );
    }
    if (name !== "offElbow") {
      // Only three parts have a joint to rebuild. Anything else reaching here
      // means a new severable part was added without teaching this about it,
      // and silently handing back an elbow would be far harder to spot.
      throw new Error(`no joint recipe for "${name}"`);
    }
    const elbow = world.createImpulseJoint(
      rapier.JointData.revolute(
        { x: 0, y: SEGMENT.upperArm.length / 2, z: 0 },
        { x: 0, y: -SEGMENT.foreArm.length / 2, z: 0 },
        { x: 1, y: 0, z: 0 },
      ),
      this.offUpper, this.offFore, true,
    );
    (elbow as RAPIER.RevoluteImpulseJoint).setLimits(-2.3, -0.05);
    return elbow;
  }

  /** The left arm: present, jointed, severable — but never driven by anyone. */
  private buildOffArm(): void {
    const { rapier, world } = this.phys;
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
    const p = this.body.translation();
    const sx = -STANDING.shoulderX;

    const make = (seg: Segment, topY: number) => {
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

    this.scene.add(upper.mesh, fore.mesh);

    this.parts.push({
      name: "offShoulder", label: "off arm", collider: upper.collider,
      body: upper.body, joint: this.jointFor("offShoulder"),
      severed: false, mesh: upper.mesh,
    });
    this.parts.push({
      name: "offElbow", label: "off forearm", collider: fore.collider,
      body: fore.body, joint: this.jointFor("offElbow"),
      severed: false, mesh: fore.mesh,
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
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;

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

      const kinematic = (seg: Segment, label: string, mesh: THREE.Object3D) => {
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
        hip: 0, knee: 0, prevHip: 0, prevKnee: 0,
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

    this.grounded = this.probeGround();
    this.coyote = this.grounded ? COYOTE : Math.max(0, this.coyote - dt);
    this.jumpLock = Math.max(0, this.jumpLock - dt);

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
        .multiplyScalar(t.moveSpeed * this.build.scale);
    }

    const current = this.body.linvel();
    let vy = current.y;

    // The take-off speed that clears `jumpHeight` under the world's gravity,
    // rather than a hand-picked impulse: turning gravity down then floats the
    // same jump instead of firing you into the ceiling.
    if (keys.jump && this.coyote > 0 && this.jumpLock <= 0) {
      vy = Math.sqrt(2 * Math.abs(t.gravity) * t.jumpHeight * this.build.scale);
      this.coyote = 0;
      this.jumpLock = JUMP_LOCK;
      this.grounded = false;
    }

    if (this.grounded) {
      // On the ground the fighter simply IS its input velocity, which is what
      // lets it shove lighter things aside rather than be stopped by them.
      this.body.setLinvel({ x: v.x, y: vy, z: v.z }, true);
    } else {
      // In the air there is nothing to push against, so intent only nudges the
      // line you left the ground on. This is also why a hard swing in mid-air
      // visibly shoves you sideways: the arm's reaction has nowhere to go.
      const a = Math.min(1, t.airControl);
      this.body.setLinvel({
        x: current.x + (v.x - current.x) * a,
        y: vy,
        z: current.z + (v.z - current.z) * a,
      }, true);
    }

    // Stride advances with distance covered, so the legs never skate. Airborne
    // there is no ground to measure against, so it holds and the legs fold up.
    const target = this.grounded ? 0 : 1;
    this.tuck += (target - this.tuck) * Math.min(1, TUCK_RATE * dt);
    if (this.grounded) this.stridePhase += Math.hypot(v.x, v.z) * dt * STRIDE;
    this.poseLegs();
    this.holdPose(dt);
  }

  /**
   * Is there anything under the feet?
   *
   * One ray straight down from the hull's centre, as long as the hull's own
   * half-height plus a little. It deliberately looks for the world and for
   * props only: a fighter should be able to jump onto the block or the
   * gallows, but not off another fighter's shoulders.
   */
  private probeGround(): boolean {
    const p = this.body.translation();
    this.groundRay.origin = { x: p.x, y: p.y, z: p.z };
    return this.phys.world.castRay(
      this.groundRay, this.groundReach, true,
      undefined, this.side.groundFilter, undefined, this.body,
    ) !== null;
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
      const swing = Math.sin(phase) * STRIDE_SWING;
      // A knee only bends one way, so the back half of the cycle is flattened.
      const bend = Math.max(0, -Math.sin(phase - 0.6)) * 0.9;

      // Airborne: one knee up, the other trailing. Purely cosmetic -- the legs
      // are kinematic and never carry the jump -- but a figure that keeps
      // walking in mid-air reads as a bug.
      const tuckHip = leg.sign > 0 ? 0.85 : -0.3;
      const tuckKnee = leg.sign > 0 ? 1.25 : 0.55;

      leg.prevHip = leg.hip;
      leg.prevKnee = leg.knee;
      leg.hip = swing + (tuckHip - swing) * this.tuck;
      leg.knee = bend + (tuckKnee - bend) * this.tuck;
      // A teleport has no previous pose worth easing out of.
      if (teleport) {
        leg.prevHip = leg.hip;
        leg.prevKnee = leg.knee;
      }

      // The colliders are pushed from these matrices below, so the pose used
      // here has to be this step's, not a fraction of the way into it.
      leg.hipPivot.rotation.x = leg.hip;
      leg.kneePivot.rotation.x = leg.knee;
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
    const l = this.build.shoulderLocal;
    return out.set(
      p.x + l.x * cos + l.z * sin,
      p.y + l.y,
      p.z + -l.x * sin + l.z * cos,
    );
  }

  /**
   * Per FRAME, not per step: ease the legs between the last two poses.
   *
   * Everything else the fighter shows -- the body group, the head, the off
   * arm -- is a rigid body, and the Interpolator places those from the physics
   * state either side of the frame. The legs are the exception: they are posed
   * by a walk cycle rather than simulated, so there is no pair of transforms
   * to read and they have to carry their own.
   *
   * This method used to place the body group and the jointed limbs as well,
   * straight from the live physics state. It ran AFTER the Interpolator in the
   * same frame, so it overwrote smoothed transforms with hard ones and threw
   * the interpolation away: on anything faster than 60Hz the torso stepped
   * while the sword it was holding did not. It also pinned the body mesh's
   * rotation to yaw, which meant a corpse tumbled in the physics world and
   * stayed bolt upright on screen.
   */
  applyPose(alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    for (const leg of this.legs) {
      leg.hipPivot.rotation.x = leg.prevHip + (leg.hip - leg.prevHip) * a;
      leg.kneePivot.rotation.x = leg.prevKnee + (leg.knee - leg.prevKnee) * a;
    }
  }

  /**
   * Every part with a body of its own, for the render interpolator.
   *
   * The head and both off-arm segments are jointed rigid bodies; the torso and
   * pelvis are colliders on the hull and ride with the body group, and the
   * legs are posed rather than simulated.
   */
  get jointedParts(): [RAPIER.RigidBody, THREE.Object3D][] {
    return this.parts
      .filter((p) => p.body !== undefined)
      .map((p) => [p.body!, p.mesh] as [RAPIER.RigidBody, THREE.Object3D]);
  }

  reset(spawn: THREE.Vector3): void {
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
    this.yaw = 0;
    this.stridePhase = 0;
    this.tuck = 0;
    this.coyote = COYOTE;
    this.jumpLock = 0;
    this.grounded = true;
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

    // Put the pieces back where they belong BEFORE reattaching them. A joint
    // created across a metre of gap is a metre of constraint violation, and
    // the solver resolves it by firing the limb at its anchor.
    //
    // The rotations matter as much as the positions. A severed forearm comes
    // to rest at whatever angle it fell at, and the elbow is a hinge: build it
    // around a forearm lying on its side and the joint has to unwind the whole
    // error on the first step.
    const place = (body: RAPIER.RigidBody, y: number, x: number, upright: boolean) => {
      body.setTranslation({ x: spawn.x + x, y: spawn.y + y, z: spawn.z }, true);
      // Limbs are built with local +Y running DOWN the limb, which is a half
      // turn about X from the identity the head sits at.
      body.setRotation(upright ? { x: 0, y: 0, z: 0, w: 1 } : { x: 1, y: 0, z: 0, w: 0 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.resetForces(true);
      body.resetTorques(true);
    };
    place(this.head, local(STANDING.neck + SEGMENT.head.length / 2), 0, true);
    place(this.offUpper, local(STANDING.shoulder - SEGMENT.upperArm.length / 2),
      -STANDING.shoulderX, false);
    place(this.offFore,
      local(STANDING.shoulder - SEGMENT.upperArm.length - SEGMENT.foreArm.length / 2),
      -STANDING.shoulderX, false);

    this.reattach();
  }

  /**
   * Put every severed part back on.
   *
   * Severing removes the joint from the world, so a reset that only clears the
   * flags leaves a head lying where it fell and a fighter that believes it
   * still has one. The parts list owns the joint, so the rule is simply: if a
   * part has no joint, make it one.
   *
   * Cutting a shoulder marks the forearm severed without touching its elbow —
   * the elbow was fine, the thing it hung from was not — so that one only
   * needs its flag cleared, and asking for a second elbow joint would leave
   * two constraints fighting over the same pair of bodies.
   */
  private reattach(): void {
    for (const part of this.parts) {
      if (!part.severed) continue;
      if (part.joint === null || part.joint === undefined) {
        part.joint = this.jointFor(part.name);
      }
      part.severed = false;
    }
  }
}

// -----------------------------------------------------------------------------

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

function buildHeadMesh(p: Palette, radius: number): THREE.Object3D {
  const g = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshStandardMaterial({ color: p.skin, roughness: 0.7 }),
  );
  head.castShadow = true;
  g.add(head);

  // Marks the facing direction — without it you cannot tell which way anyone
  // is looking, which matters a lot once someone is trying to kill you.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 0.33, radius * 0.87, 8),
    new THREE.MeshStandardMaterial({ color: p.mark, roughness: 0.6 }),
  );
  nose.position.set(0, 0, -radius);
  nose.rotation.x = -Math.PI / 2;
  g.add(nose);
  return g;
}
