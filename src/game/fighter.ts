import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld, Side } from "../core/physics";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";
import { HUMAN, type Build, type Segment } from "./anatomy";
import {
  disposeTree, footMesh, handMesh, headMesh as headShape, jointBall, shellMesh,
  stumpCap,
} from "./skin";
import type { WoundEnd } from "./blood";
import { Pose, Posture, type PostureDrive } from "./posture";
import { wrap, type Capsule } from "./clearance";
import { smoothstep } from "./motion";

/**
 * A fighter: one locomotion hull carrying a human-shaped skeleton.
 *
 * The hull is an invisible capsule spanning feet to shoulders. It is the only
 * thing that walks, bumps into walls and holds the figure up, and blades pass
 * straight through it. Everything you can see or cut hangs off it:
 *
 *   torso, pelvis   colliders on the hull itself, posed by the posture layer:
 *                   the hips turn and the chest turns, leans and bends on top
 *   head, off-arm   real jointed bodies, held in place by weak PD controllers,
 *                   severable exactly as the practice dummy's limbs are
 *   legs            kinematic: posed by a walk cycle, hittable, never simulated
 *
 * That split is the whole trick. A skeleton made of jointed limbs that has to
 * hold itself upright is a research project; a skeleton hung off something that
 * cannot fall over is an afternoon. The sword arm is the exception and lives in
 * arm.ts, because it is the one limb a player actually drives.
 *
 * What you SEE is a second thing laid over that, and only that: skin.ts draws
 * each capsule as a tapered shell and fills the joints between them, so the
 * figure reads as a body rather than as the pile of parts it is underneath.
 * No collider, mass or joint changes for it, and every shell is a child of a
 * mesh the Interpolator already places.
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

/**
 * The trunk as the sword arm keeps out of it: the body you can see, not the
 * rounder collider a blade hits.
 *
 * The drawn chest is an oval shell a little inside the collider -- its top
 * cap is 14cm where the collider's is 17 -- and shallower front to back than
 * it is wide. Fitted by eye against the shells in skin.ts, erring toward
 * letting an elbow brush the ribs rather than toward holding it off them.
 */
const TRUNK_FIT = 0.92;
const CHEST_FLAT = 1.2;
const HIPS_FLAT = 1.1 / 0.92;
const UP = new THREE.Vector3(0, 1, 0);

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

// --- planted feet -------------------------------------------------------------
//
// Standing still, the feet stay where they are while the hips turn over them
// -- the thighs rotating in their sockets, as they do -- and only when the
// hips have wound too far round does a foot pick up and step. Walking,
// turning on the spot or in the air, every stride replants them anyway and
// they simply follow the hips. None of this is physical and none of it is on
// the arm's side of anything: the feet can never hold the body back.

/** How far the hips may turn over a planted foot before it has to step. */
const PLANT_SLACK = 0.18;
/** Beyond this the foot slides rather than let the leg wind up any further. */
const PLANT_MAX = 0.7;
/** How long one step takes, seconds. */
const STEP_TIME = 0.22;
/** A stepping foot lands a little past square: the feet lead a turn. */
const STEP_LEAD = 0.25;
/** A step's knee lift and hip flex at its height, radians. */
const STEP_KNEE = 0.5;
const STEP_HIP = 0.28;
/** How fast feet that are being replanted anyway catch up with the hips. */
const FOLLOW_RATE = 12;

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

  /**
   * How the trunk is carried around the sword arm: see posture.ts.
   *
   * The hull stays the one thing that faces, walks and collides. The posture
   * turns what hangs on it -- hips, then chest -- and moves the anchors the
   * shoulder, the neck and the off arm are jointed to.
   */
  readonly posture: Posture;
  /** Everything that turns with the hips: pelvis, belt, legs. */
  readonly pelvis = new THREE.Object3D();
  /** Everything above the waist: chest, shoulders, neck. A child of the hips. */
  readonly chest = new THREE.Object3D();
  /**
   * The sword shoulder this step, hull-local. The sword arm's joint anchor
   * and the root its ghost hand is solved from -- the two must be one point.
   */
  readonly shoulderAnchor = new THREE.Vector3();
  /**
   * A world point to look at instead of the blade, or null. An opponent
   * watches the one it is fighting; the player watches their own sword.
   */
  focus: THREE.Vector3 | null = null;
  /** The ball the sword arm hangs from, carried by the shoulder girdle. */
  shoulderBall!: THREE.Object3D;
  private readonly swordShoulderRest = new THREE.Vector3();
  private offShoulderBall!: THREE.Object3D;
  /** The torso collider's centre at rest, hull-local height. */
  private torsoY = 0;
  private pelvisY = 0;
  private readonly renderPose = new Pose();
  /** Chest and hips as capsules, world space, rebuilt on request. */
  private readonly trunk: Capsule[] = [
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0, forward: new THREE.Vector3(), flat: 1 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0, forward: new THREE.Vector3(), flat: 1 },
  ];

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
    /** Which way the foot points, WORLD yaw: planted means this holds still. */
    foot: number;
    /** The leg's turn in the hip socket, relative to the pelvis, and last step's. */
    turn: number; prevTurn: number;
    /** Progress through a step, 0..1, or -1 when the foot is planted. */
    step: number;
    stepFrom: number; stepTo: number;
  }[] = [];
  /** Commanded ground speed and turn rate, for whether the feet are planted. */
  private gait = 0;
  private turning = 0;

  private stridePhase = 0;
  private headMesh!: THREE.Object3D;

  /** One set of materials for the whole figure, from its palette. */
  private clothMat!: THREE.MeshStandardMaterial;
  private skinMat!: THREE.MeshStandardMaterial;
  private markMat!: THREE.MeshStandardMaterial;
  private beltMat!: THREE.MeshStandardMaterial;

  /** Dark caps added to cut faces, cleared when a reset puts the limb back. */
  private readonly caps: THREE.Object3D[] = [];

  /** Whether the ground probe found anything to push off. */
  grounded = true;
  private coyote = COYOTE;
  private jumpLock = 0;
  /** 0 standing, 1 fully folded up. Blended so the legs do not pop. */
  private tuck = 0;
  private readonly groundRay: RAPIER.Ray;
  private readonly groundReach: number;
  private readonly sightRay: RAPIER.Ray;
  private readonly _eye = new THREE.Vector3();

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
    this.sightRay = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });

    this.posture = new Posture(build);
    this.mesh.add(this.pelvis);
    this.pelvis.add(this.chest);
    this.chest.position.y = this.posture.waistY;

    this.clothMat = new THREE.MeshStandardMaterial({ color: palette.cloth, roughness: 0.85 });
    this.skinMat = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.68 });
    this.markMat = new THREE.MeshStandardMaterial({ color: palette.mark, roughness: 0.6 });
    this.beltMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.cloth).multiplyScalar(0.55), roughness: 0.7,
    });

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

    // The trunk. A chest that tapers to a waist and hips that flare out of it,
    // drawn a little wider than they are deep, because a body is.
    const chest = shellMesh(this.clothMat, {
      from: SEGMENT.torso.radius * 0.82,
      to: SEGMENT.torso.radius * 0.84,
      length: SEGMENT.torso.length,
      belly: 1.12,
    });
    chest.scale.set(1.16, 1, 0.86);
    this.torsoY = local((STANDING.waist + STANDING.neck) / 2);
    this.collider = this.rigidPart("torso", "body", SEGMENT.torso,
      this.torsoY, 0, chest, this.chest, this.posture.waistY);

    const hips = shellMesh(this.clothMat, {
      from: SEGMENT.pelvis.radius * 0.98,
      to: SEGMENT.pelvis.radius * 0.86,
      length: SEGMENT.pelvis.length,
      belly: 1.06,
    });
    hips.scale.set(1.1, 1, 0.92);
    this.pelvisY = local((STANDING.hip + STANDING.waist) / 2);
    this.rigidPart("pelvis", "hips", SEGMENT.pelvis,
      this.pelvisY, 0, hips, this.pelvis, 0);

    this.buildTrunkFill();
    this.buildHead();
    this.buildOffArm();
    this.buildLegs();

    this.scene.add(this.mesh);
    // The anchors the arm is about to be jointed to have to exist first.
    this.applyPosture();
    // Kinematic bodies are born at the origin. Reaching their real position
    // through setNextKinematicTranslation would imply crossing the room in one
    // step, at a couple of hundred metres per second.
    this.poseLegs(true);
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /**
   * A collider mounted straight onto the hull — moves with it, cannot come off.
   *
   * `y` is hull-local, where the collider goes. The mesh goes on `parent`,
   * which sits `parentY` up the hull, so it rides whatever that part of the
   * body is doing.
   */
  private rigidPart(
    name: string, label: string, seg: { radius: number; length: number; mass: number },
    y: number, x: number, mesh: THREE.Object3D,
    parent: THREE.Object3D, parentY: number,
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

    mesh.position.set(x, y - parentY, 0);
    parent.add(mesh);

    this.parts.push({ name, label, collider, mesh });
    return collider;
  }

  /**
   * The lumps that make a trunk continuous: shoulders, hips, a neck, a belt.
   *
   * They hang off the chest and hip groups rather than off the torso mesh,
   * because that mesh is scaled to an oval cross-section and a ball inherited
   * into that scale comes out an egg.
   */
  private buildTrunkFill(): void {
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;
    const waist = this.posture.waistY;

    for (const sx of [-1, 1]) {
      const shoulder = jointBall(SEGMENT.upperArm.radius * 1.5, this.clothMat, 0.8);
      shoulder.position.set(sx * STANDING.shoulderX, local(STANDING.shoulder) - waist, 0);
      this.chest.add(shoulder);
      // The sword side is +X: it is the one the shoulder girdle carries about.
      if (sx > 0) {
        this.shoulderBall = shoulder;
        this.swordShoulderRest.copy(shoulder.position);
      } else {
        this.offShoulderBall = shoulder;
      }

      const hip = jointBall(SEGMENT.thigh.radius * 1.08, this.clothMat, 0.92);
      hip.position.set(sx * STANDING.hipX, local(STANDING.hip), 0);
      this.pelvis.add(hip);
    }

    // A neck, and it has to be long enough to see: shoulders sit a hand's
    // width below the skull, and without a column between them the head reads
    // as sitting straight on the chest.
    const neck = shellMesh(this.skinMat, {
      from: SEGMENT.head.radius * 0.66,
      to: SEGMENT.head.radius * 0.56,
      length: SEGMENT.head.radius * 2.0,
    });
    neck.position.y = local(STANDING.neck) - SEGMENT.head.radius * 0.35 - waist;
    this.chest.add(neck);

    const belt = new THREE.Mesh(
      new THREE.CylinderGeometry(
        SEGMENT.pelvis.radius * 1.03, SEGMENT.pelvis.radius * 1.03,
        0.055 * this.build.scale, 20),
      this.beltMat,
    );
    belt.scale.set(1.1, 1, 0.92);
    belt.position.y = local(STANDING.waist);
    belt.castShadow = true;
    this.pelvis.add(belt);
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

    this.headMesh = headShape(seg.radius, this.skinMat, this.markMat);
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

    // Both of these ride on the chest, so they are built where the posture
    // has the chest right now; `applyPosture` keeps them there after.
    if (name === "head") {
      const a = this.onChest(0, local(STANDING.neck), _anchor);
      return world.createImpulseJoint(
        rapier.JointData.spherical(
          { x: a.x, y: a.y, z: a.z },
          { x: 0, y: -SEGMENT.head.length / 2, z: 0 },
        ),
        this.body, this.head, true,
      );
    }
    if (name === "offShoulder") {
      const a = this.onChest(-STANDING.shoulderX, local(STANDING.shoulder), _anchor);
      return world.createImpulseJoint(
        rapier.JointData.spherical(
          { x: a.x, y: a.y, z: a.z },
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

    const make = (seg: Segment, topY: number, wide: number, narrow: number) => {
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
      // Local +Y runs from the joint DOWN the limb, so -Y is the shoulder end
      // and the taper runs thick to thin in that order.
      const mesh = shellMesh(this.skinMat, {
        from: seg.radius * wide,
        to: seg.radius * narrow,
        length: seg.length,
        belly: 1.05,
      });
      return { body, collider, mesh, seg };
    };

    const upper = make(SEGMENT.upperArm, STANDING.shoulder, 1.06, 0.84);
    const elbowY = STANDING.shoulder - SEGMENT.upperArm.length;
    const fore = make(SEGMENT.foreArm, elbowY, 1.0, 0.68);

    // The elbow belongs to the upper arm and the hand to the forearm, so a cut
    // at either joint leaves a rounded joint on the body and a flat cut face
    // on the piece that fell.
    const elbow = jointBall(SEGMENT.foreArm.radius * 1.15, this.skinMat);
    elbow.position.y = SEGMENT.upperArm.length / 2;
    upper.mesh.add(elbow);

    const hand = handMesh(SEGMENT.foreArm.radius * 1.22, this.skinMat);
    hand.position.y = SEGMENT.foreArm.length / 2;
    fore.mesh.add(hand);

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
      this.pelvis.add(hipPivot);

      // A leg hangs off its pivot, so here +Y is the joint end and -Y the far
      // one -- the opposite way round from an arm, and worth stating twice.
      const thighMesh = shellMesh(this.clothMat, {
        from: SEGMENT.thigh.radius * 0.8,
        to: SEGMENT.thigh.radius * 1.02,
        length: SEGMENT.thigh.length,
        belly: 1.06,
      });
      thighMesh.position.y = -SEGMENT.thigh.length / 2;
      hipPivot.add(thighMesh);

      const knee = jointBall(SEGMENT.shin.radius * 1.12, this.clothMat);
      knee.position.y = -SEGMENT.thigh.length / 2;
      thighMesh.add(knee);

      const kneePivot = new THREE.Object3D();
      kneePivot.position.y = -SEGMENT.thigh.length;
      hipPivot.add(kneePivot);

      const shinMesh = shellMesh(this.clothMat, {
        from: SEGMENT.shin.radius * 0.62,
        to: SEGMENT.shin.radius * 1.0,
        length: SEGMENT.shin.length,
        belly: 1.04,
      });
      shinMesh.position.y = -SEGMENT.shin.length / 2;
      kneePivot.add(shinMesh);

      // Forward is -Z, so the foot lies out ahead of the ankle rather than
      // down from it. Scenery: the collider is the shin and stops at the sole.
      const foot = footMesh(SEGMENT.shin.radius * 0.72,
        SEGMENT.shin.length * 0.52, this.beltMat);
      foot.position.set(0, -SEGMENT.shin.length / 2 + SEGMENT.shin.radius * 0.3,
        -SEGMENT.shin.length * 0.12);
      shinMesh.add(foot);

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
      // Turn in the socket first, then swing: the leg bends along the way
      // its foot points, not the way the hips do.
      hipPivot.rotation.order = "YXZ";

      this.legs.push({
        thigh: kinematic(SEGMENT.thigh, `${side} thigh`, thighMesh),
        shin: kinematic(SEGMENT.shin, `${side} shin`, shinMesh),
        hipPivot, kneePivot, thighMesh, shinMesh, sign,
        hip: 0, knee: 0, prevHip: 0, prevKnee: 0,
        foot: this.yaw, turn: 0, prevTurn: 0,
        step: -1, stepFrom: 0, stepTo: 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Per-step
  // ---------------------------------------------------------------------------

  /**
   * Called once per fixed step, before the physics step.
   *
   * `drive` is what the sword arm wants of the body this step -- null when
   * there is no arm to carry, and the trunk relaxes back to square.
   */
  update(keys: Keys, t: Tuning, dt: number, drive: PostureDrive | null = null): void {
    let turn = 0;
    if (keys.turnLeft) turn += 1;
    if (keys.turnRight) turn -= 1;
    this.yaw += turn * t.turnSpeed * dt;
    this.turning = Math.abs(turn) * t.turnSpeed;
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
    this.gait = Math.hypot(v.x, v.z);

    this.posture.update(drive, this.focus, this.yaw, this.body.translation(), t, dt);
    this.applyPosture();
    this.poseLegs(false, dt);
    this.holdPose(dt);
  }

  /**
   * A point on the chest, given where it would be on a square-standing body
   * (hull-local), placed where the posture has the chest now.
   */
  private onChest(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    return this.posture.chestPoint(this.posture.pose,
      out.set(x, y - this.posture.waistY, 0), out);
  }

  /**
   * Move everything physical that rides on the chest to where the posture
   * has put it: the torso's collider, and the anchors the neck, the off arm
   * and -- through `shoulderAnchor` -- the sword arm are jointed to.
   *
   * Moving a joint anchor is how a shoulder girdle moves here. The limb is
   * not placed; its joint is, and the solver carries the limb after it at
   * whatever the joint can do, the same as every other constraint in the
   * body. The posture's springs keep each step's move to a few millimetres.
   */
  private applyPosture(): void {
    const pose = this.posture.pose;
    const { standing: STANDING } = this.build;
    const local = this.build.local;

    this.posture.swordShoulder(pose, this.shoulderAnchor);

    const centre = this.onChest(0, this.torsoY, _anchor);
    this.collider.setTranslationWrtParent({ x: centre.x, y: centre.y, z: centre.z });
    const q = this.posture.chestQuat(pose, this._q);
    this.collider.setRotationWrtParent({ x: q.x, y: q.y, z: q.z, w: q.w });

    const head = this.parts.find((p) => p.name === "head");
    if (head?.joint) {
      head.joint.setAnchor1(this.onChest(0, local(STANDING.neck), _anchor));
    }
    const off = this.parts.find((p) => p.name === "offShoulder");
    if (off?.joint) {
      off.joint.setAnchor1(
        this.onChest(-STANDING.shoulderX, local(STANDING.shoulder), _anchor));
    }
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

  /** Eye point in world space, near enough: the top of the head. */
  eyeWorld(out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    const { standing: STANDING, segment: SEGMENT } = this.build;
    return out.set(
      p.x, p.y + this.build.local(STANDING.crown) - SEGMENT.head.radius, p.z);
  }

  /**
   * Is there a clear line from this fighter's eyes to that point?
   *
   * One ray against the architecture and nothing else. It is what an opponent
   * uses to decide whether you are its problem yet, and the whole reason the
   * orc waits in its hall instead of walking into the far side of a wall for
   * the length of the fight.
   *
   * The last few centimetres are not tested: a target standing with its back
   * to a wall is not hidden by that wall.
   */
  sees(point: THREE.Vector3): boolean {
    this.eyeWorld(this._eye);
    const dx = point.x - this._eye.x;
    const dy = point.y - this._eye.y;
    const dz = point.z - this._eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.2) return true;

    this.sightRay.origin = { x: this._eye.x, y: this._eye.y, z: this._eye.z };
    this.sightRay.dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    return this.phys.world.castRay(
      this.sightRay, dist - 0.15, true,
      undefined, this.side.sightFilter, undefined, this.body,
    ) === null;
  }

  /**
   * Weak PD keeping head and off-arm in a living posture rather than limp.
   *
   * Both are held relative to the CHEST, not the hull, so they turn and lean
   * with it; the head then turns on top of that toward whatever the posture's
   * gaze has found. Being PD targets rather than placements, both arrive a
   * little late and a little past -- which is the secondary motion.
   */
  private holdPose(_dt: number): void {
    const hullRot = this.body.rotation();
    this._q2.set(hullRot.x, hullRot.y, hullRot.z, hullRot.w)
      .multiply(this.posture.chestQuat(this.posture.pose, this._q));

    if (!this.severed("head")) {
      const p = this.posture;
      this._q.copy(this._q2).multiply(
        this._qe.setFromEuler(this._euler.set(p.gazePitch, p.gazeYaw, p.gazeRoll, "YXZ")));
      this.alignTo(this.head, this._q, HEAD_KP, HEAD_KD);
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

  /**
   * Keep the feet where they are while the hips turn over them, and step
   * when they have turned too far.
   *
   * Each foot holds a WORLD heading. Standing, it holds still, and the leg
   * turns in its hip socket by however far the hips have come round. Past
   * `PLANT_SLACK` the more wound-up foot -- the one on the side of the turn,
   * if they are level -- picks up and steps to a little past square, then
   * the other; only one is ever off the floor. Walking, turning, or in the
   * air, the feet are being replanted every stride regardless and just
   * follow the hips.
   */
  private plantFeet(teleport: boolean, dt: number): void {
    const facing = this.yaw + this.posture.pose.pelvis;
    const moving = this.gait > 0.05 || this.turning > 0.1 || this.tuck > 0.3;
    let busy = false;

    for (const leg of this.legs) {
      leg.prevTurn = leg.turn;
      if (teleport) {
        leg.foot = facing;
        leg.step = -1;
      } else if (moving) {
        leg.step = -1;
        leg.foot += wrap(facing - leg.foot) * Math.min(1, FOLLOW_RATE * dt);
      } else if (leg.step >= 0) {
        leg.step = Math.min(1, leg.step + dt / STEP_TIME);
        leg.foot = leg.stepFrom
          + (leg.stepTo - leg.stepFrom) * smoothstep(0, 1, leg.step);
        if (leg.step >= 1) leg.step = -1; else busy = true;
      }
      // However it got here, a leg does not wind up past what a hip allows:
      // the foot slides instead.
      const off = wrap(facing - leg.foot);
      if (Math.abs(off) > PLANT_MAX) leg.foot = facing - Math.sign(off) * PLANT_MAX;
    }

    if (!teleport && !moving && !busy) {
      let pick: (typeof this.legs)[number] | null = null;
      let most = PLANT_SLACK;
      for (const leg of this.legs) {
        const off = wrap(facing - leg.foot);
        // A turn to the left is led by the left foot, which is sign -1.
        const leads = Math.sign(off) === -leg.sign ? 1e-3 : 0;
        if (Math.abs(off) + leads > most) {
          most = Math.abs(off) + leads;
          pick = leg;
        }
      }
      if (pick) {
        const off = wrap(facing - pick.foot);
        pick.step = 0;
        pick.stepFrom = pick.foot;
        pick.stepTo = pick.foot + off * (1 + STEP_LEAD);
      }
    }

    for (const leg of this.legs) leg.turn = wrap(leg.foot - facing);
  }

  /** Swing the legs and push the kinematic colliders to match. */
  private poseLegs(teleport = false, dt = 0): void {
    const p = this.body.translation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.rotation.set(0, this.yaw, 0);
    // This step's posture, not an interpolated one: the leg colliders are
    // pushed from these matrices, and the hips carry the legs.
    this.placeTrunk(this.posture.pose);
    this.mesh.updateMatrixWorld(true);

    this.plantFeet(teleport, dt);

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

      // A foot in the middle of a step comes up off the floor and goes down
      // again: the same bend the stride uses, on a half-sine.
      const lift = leg.step >= 0 ? Math.sin(Math.PI * leg.step) : 0;

      leg.prevHip = leg.hip;
      leg.prevKnee = leg.knee;
      leg.hip = swing + (tuckHip - swing) * this.tuck + STEP_HIP * lift;
      leg.knee = bend + (tuckKnee - bend) * this.tuck + STEP_KNEE * lift;
      // A teleport has no previous pose worth easing out of.
      if (teleport) {
        leg.prevHip = leg.hip;
        leg.prevKnee = leg.knee;
        leg.prevTurn = leg.turn;
      }

      // The colliders are pushed from these matrices below, so the pose used
      // here has to be this step's, not a fraction of the way into it.
      leg.hipPivot.rotation.x = leg.hip;
      leg.hipPivot.rotation.y = leg.turn;
      // `knee` is flexion, positive when bent. The hip's +x swings the thigh
      // forward, and the knee folds the other way -- the foot goes back -- so
      // the same number turns the shin through minus it. Forward here would
      // bend the leg like a horse's hind leg.
      leg.kneePivot.rotation.x = -leg.knee;
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

  /**
   * Fade the whole figure out, 1 solid and 0 gone.
   *
   * For the camera, which in three rooms with doorways is forever being backed
   * into a wall. Pulling it in to the stone is the only way to keep the room
   * in view, and pulling it in that far puts it inside the body -- so the body
   * gets out of the way. The sword arm has materials of its own and is
   * deliberately not touched: the one thing you must never lose sight of is
   * the thing you are swinging.
   */
  setFade(amount: number): void {
    const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    if (Math.abs(a - this.fade) < 0.01) return;
    this.fade = a;

    for (const m of [this.clothMat, this.skinMat, this.markMat, this.beltMat]) {
      m.transparent = a < 1;
      m.opacity = a;
      m.depthWrite = a > 0.6;
    }
    // A material at zero opacity still casts a shadow, so the figure has to
    // leave the scene rather than merely turn invisible.
    const shown = a > 0.02;
    this.mesh.visible = shown;
    for (const part of this.parts) {
      if (part.body !== undefined) part.mesh.visible = shown;
    }
  }

  private fade = 1;

  /**
   * Cut a jointed part free. Children go with it.
   *
   * Returns the two faces the cut left -- the piece and the stump -- or null
   * if there was nothing there to cut. They are local points on meshes the
   * Interpolator places, so blood drawn from them follows both ends about.
   */
  sever(name: string): WoundEnd[] | null {
    const part = this.parts.find((p) => p.name === name);
    if (!part || !part.joint || part.severed) return null;
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
    return this.capCut(part);
  }

  /**
   * A dark dome over the cut face, so a severed part reads as cut rather than
   * dropped. Every part here is built with its joint end at -Y.
   */
  private capCut(part: FighterPart): WoundEnd[] {
    const { segment: SEGMENT, standing: STANDING } = this.build;
    const local = this.build.local;

    const shape = part.name === "head"
      ? { half: SEGMENT.head.radius * 1.04, end: SEGMENT.head.radius * 0.74 }
      : part.name === "offShoulder"
        ? { half: SEGMENT.upperArm.length / 2, end: SEGMENT.upperArm.radius * 1.06 }
        : { half: SEGMENT.foreArm.length / 2, end: SEGMENT.foreArm.radius };

    const cap = stumpCap(shape.end);
    cap.position.y = -(shape.half - shape.end * 0.5);
    cap.rotation.x = Math.PI;
    part.mesh.add(cap);
    this.caps.push(cap);

    // The other face: whatever the piece came off. A neck and a shoulder are
    // on the body group; an off forearm comes off the upper arm above it.
    const upper = this.parts.find((p) => p.name === "offShoulder");
    const socket: WoundEnd = part.name === "head"
      ? {
          object: this.chest,
          local: new THREE.Vector3(0, local(STANDING.neck) - this.posture.waistY, 0),
        }
      : part.name === "offShoulder"
        ? { object: this.offShoulderBall, local: new THREE.Vector3() }
        : {
            object: upper?.mesh ?? this.mesh,
            local: new THREE.Vector3(0, SEGMENT.upperArm.length / 2, 0),
          };

    return [{ object: part.mesh, local: cap.position.clone() }, socket];
  }

  position(out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    return out.set(p.x, p.y, p.z);
  }

  /** Set the hips, the chest and the sword shoulder's ball to a posture. */
  private placeTrunk(pose: Pose): void {
    this.pelvis.rotation.y = pose.pelvis;
    this.chest.rotation.set(-pose.lean, pose.spine, pose.bend, "YXZ");
    this.posture.clavicle(pose, this.shoulderBall.position).add(this.swordShoulderRest);
  }

  /**
   * Sword shoulder in world space: the arm's joint anchor, where the posture
   * has put it this step.
   */
  shoulderWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.hullToWorld(this.shoulderAnchor, out);
  }

  /**
   * Where the sword shoulder would be for a given posture, in world space.
   * For the arm's probes, which ask about a held aim rather than this step.
   */
  shoulderWorldFor(pose: Pose, out: THREE.Vector3): THREE.Vector3 {
    return this.hullToWorld(this.posture.swordShoulder(pose, out), out);
  }

  /**
   * The trunk, as the sword arm has to keep out of it: the chest and the hips
   * as capsules in world space, for a given posture.
   *
   * The same capsules the torso and pelvis colliders are, placed the same
   * way -- the chest turned, leant and bent about the waist, the hips upright
   * -- so what the arm keeps clear of is exactly what a blade would hit.
   * Returns an array this fighter reuses; read it before asking again.
   */
  trunkCapsules(pose: Pose): readonly Capsule[] {
    const { segment: SEGMENT } = this.build;
    const [chest, hips] = this.trunk;

    const half = Math.max(0.01, SEGMENT.torso.length / 2 - SEGMENT.torso.radius);
    const centre = this.posture.chestPoint(pose,
      _anchor.set(0, this.torsoY - this.posture.waistY, 0), _anchor);
    const chestQ = this.posture.chestQuat(pose, _q);
    const axis = _axis.set(0, half, 0).applyQuaternion(chestQ);
    this.hullToWorld(_end.copy(centre).sub(axis), chest.a);
    this.hullToWorld(_end.copy(centre).add(axis), chest.b);
    chest.radius = SEGMENT.torso.radius * TRUNK_FIT;
    chest.flat = CHEST_FLAT;
    chest.forward.set(0, 0, -1).applyQuaternion(chestQ).applyAxisAngle(UP, this.yaw);

    const hipHalf = Math.max(0.01, SEGMENT.pelvis.length / 2 - SEGMENT.pelvis.radius);
    this.hullToWorld(_end.set(0, this.pelvisY - hipHalf, 0), hips.a);
    this.hullToWorld(_end.set(0, this.pelvisY + hipHalf, 0), hips.b);
    hips.radius = SEGMENT.pelvis.radius * TRUNK_FIT;
    hips.flat = HIPS_FLAT;
    hips.forward.set(0, 0, -1).applyAxisAngle(UP, this.yaw + pose.pelvis);
    return this.trunk;
  }

  /** A hull-local point in world space. Safe to alias. */
  private hullToWorld(l: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const x = l.x, y = l.y, z = l.z;
    return out.set(
      p.x + x * cos + z * sin,
      p.y + y,
      p.z + -x * sin + z * cos,
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
    this.placeTrunk(this.renderPose.lerpPoses(this.posture.prev, this.posture.pose, a));
    for (const leg of this.legs) {
      leg.hipPivot.rotation.x = leg.prevHip + (leg.hip - leg.prevHip) * a;
      leg.hipPivot.rotation.y = leg.prevTurn + wrap(leg.turn - leg.prevTurn) * a;
      leg.kneePivot.rotation.x = -(leg.prevKnee + (leg.knee - leg.prevKnee) * a);
    }
  }

  /**
   * Where each foot points (world yaw) and whether it is mid-step, left then
   * right. For the harness and the HUD: allocates, so not for the step loop.
   */
  get feet(): { yaw: number; stepping: boolean }[] {
    return this.legs.map((l) => ({ yaw: l.foot, stepping: l.step >= 0 }));
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
    this.gait = 0;
    this.turning = 0;
    for (const leg of this.legs) {
      leg.foot = 0;
      leg.turn = leg.prevTurn = 0;
      leg.step = -1;
    }
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

    // Square again before anything is jointed back on to it: a rebuilt joint
    // takes its anchor from wherever the chest is.
    this.posture.reset();
    this.focus = null;
    this.applyPosture();
    this.placeTrunk(this.posture.pose);

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
    for (const cap of this.caps) {
      cap.removeFromParent();
      disposeTree(cap);
    }
    this.caps.length = 0;

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
const _anchor = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _end = new THREE.Vector3();

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

