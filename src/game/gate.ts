import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { ALL_COMBATANTS, GROUP, groups, type PhysicsWorld } from "../core/physics";
import type { Arm } from "./arm";
import type { Item } from "./items";
import type { Targets } from "./targets";
import { smoothstep } from "./motion";

/**
 * A gate, and the lever on the wall beside it that opens it.
 *
 * The gate is architecture while it is shut: stone to a blade, a wall to a
 * body, and a wall to a line of sight -- so whatever is behind it neither
 * sees you nor comes for you, as a thing in another room does not (see
 * `Fighter.sees`). Opened, it is winched up into the gatehouse over its
 * doorway, on its own, and the doorway is a doorway like any other. It does
 * not come down again until a reset.
 *
 * The lever is a body: an iron bar on a pin, sprung up against its stop.
 * Nothing throws it but a hand. F goes to it as it goes to anything (see
 * pickup.ts): the body walks over and turns to it, the hand reaches for the
 * handle and takes hold of it -- a joint between the hand and the bar -- and
 * then pulls it down, under the arm's own clamped drive and against the
 * spring. Pulled far enough, it catches at the bottom, and the gate goes up.
 * Let go of short of that, it springs back.
 *
 * Of the two, only the gate is anything a blade meets. A lever an axe could
 * hook, or knock over in the middle of a fight, is one more thing to go wrong
 * at exactly the height a weapon is carried -- the reason the door frames are
 * scenery too.
 */

// --- the lever -------------------------------------------------------------------
//
// Angles are the bar's, about its pin: 0 sticks straight out of the wall, and
// positive is up. The pin runs along the wall.

/** Pin to the middle of the handle, metres. */
const LEVER_LENGTH = 0.42;
/** Where it rests, up against its stop, and where the bottom stop is, radians. */
const LEVER_UP = 0.87;
const LEVER_DOWN = -0.61;
/** Pulled past this, it catches, and stays down. */
const LEVER_CATCH = -0.5;
/**
 * The spring that holds it up, N·m per radian, and how far past its stop the
 * spring is wound, radians, so that it rests on the stop rather than sagging
 * off it under its own weight. Taken down to the catch, it wants about
 * thirty newtons at the handle: something a hand has to lean on, not a
 * thing that falls. And its damping, N·m·s per radian, so it comes back up
 * without clattering on the stop.
 */
const LEVER_SPRING = 9;
const LEVER_WOUND = 0.8;
const LEVER_DAMP = 1.8;
/**
 * Iron bar and handle: kilograms, where along the bar it balances, and how
 * hard it is to turn about that point, kg·m² -- a bar of a kilo and a bit
 * with most of a kilo of handle and caps across its end. About its pin that
 * is a quarter of a kg·m², a kilo and a half to a hand on the handle.
 */
const LEVER_MASS = 2.2;
const LEVER_BALANCE = 0.305;
const LEVER_INERTIA = { x: 0.042, y: 0.044, z: 0.003 };
/** How far out of the wall the pin stands, metres: see `LEVER` in arena.ts. */
export const LEVER_STANDOFF = 0.1;

export interface LeverSpec {
  /** The pin, world. */
  readonly at: THREE.Vector3;
  /** Which way its front faces, as a yaw -- out of the wall it is on. */
  readonly facing: number;
}

export class Lever {
  /** The bar, on its pin. */
  readonly body: RAPIER.RigidBody;
  /** What draws it: placed by the Interpolator, from `body`. */
  readonly mesh = new THREE.Group();
  /** What F finds: see `Items`. `taken` is whether it has caught. */
  readonly item: Item;
  /** Told once, the step it catches. */
  onCaught?: () => void;

  /** The bracket the pin is in: a fixed body, turned to the wall. */
  private readonly base: RAPIER.RigidBody;
  private readonly pin: RAPIER.RevoluteImpulseJoint;
  /** Whose hand is on it, and where on the bar, bar-local. */
  private hand: RAPIER.ImpulseJoint | null = null;
  private readonly held = new THREE.Vector3();
  private caughtNow = false;
  /** The wall's frame: -Z out of it, +Y up, +X along it. */
  private readonly mount = new THREE.Quaternion();
  private readonly pinAt = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();

  constructor(private readonly phys: PhysicsWorld, scene: THREE.Scene, spec: LeverSpec) {
    const { rapier, world } = phys;
    this.pinAt.copy(spec.at);
    this.mount.setFromAxisAngle(UP, spec.facing);

    const m = this.mount;
    this.base = world.createRigidBody(rapier.RigidBodyDesc.fixed()
      .setTranslation(spec.at.x, spec.at.y, spec.at.z)
      .setRotation({ x: m.x, y: m.y, z: m.z, w: m.w }));
    const q = this.poseAt(LEVER_UP, this._q);
    // Mass and nothing else: it meets nothing (see above), so it has no
    // collider at all, only a weight -- out along -Z, toward the handle.
    this.body = world.createRigidBody(rapier.RigidBodyDesc.dynamic()
      .setTranslation(spec.at.x, spec.at.y, spec.at.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setAdditionalMassProperties(LEVER_MASS, { x: 0, y: 0, z: -LEVER_BALANCE }, LEVER_INERTIA,
        { x: 0, y: 0, z: 0, w: 1 })
      .setAngularDamping(0.5)
      .setCanSleep(false));

    this.pin = world.createImpulseJoint(
      rapier.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
      this.base, this.body, true,
    ) as RAPIER.RevoluteImpulseJoint;
    this.pin.setLimits(LEVER_DOWN, LEVER_UP);
    this.pin.configureMotorModel(rapier.MotorModel.ForceBased);
    this.spring();

    buildLeverMesh(this.mesh);
    const bracket = buildBracket();
    bracket.position.copy(spec.at);
    bracket.quaternion.copy(m);
    scene.add(bracket, this.mesh);
    this.mesh.position.copy(spec.at);
    this.mesh.quaternion.copy(q);

    // Faced square on, from in front: the wall's front is its -Z.
    const front = new THREE.Vector3(0, 0, -1).applyQuaternion(m);
    this.item = {
      kind: "lever", name: "the lever",
      at: new THREE.Vector3(spec.at.x + front.x * 0.35, 0, spec.at.z + front.z * 0.35),
      mesh: this.mesh, grip: new THREE.Vector3(), face: spec.facing + Math.PI, taken: false,
      lever: this,
    };
    this.gripAt(LEVER_UP, this.item.grip, LEVER_LENGTH);
  }

  /** The bar's angle about its pin now, radians: 0 straight out of the wall, up positive. */
  get angle(): number {
    const r = this.body.rotation();
    const d = this._v.set(0, 0, -1)
      .applyQuaternion(this._q.set(r.x, r.y, r.z, r.w).premultiply(_inv.copy(this.mount).invert()));
    return Math.atan2(d.y, -d.z);
  }

  /** The bottom stop, radians. */
  get bottom(): number {
    return LEVER_DOWN;
  }

  /** It has been pulled down and caught there. */
  get caught(): boolean {
    return this.caughtNow;
  }

  /** A hand has hold of it. */
  get gripped(): boolean {
    return this.hand !== null;
  }

  /**
   * Where a point on the bar would be at `angle`, world: the one a hand has
   * hold of, or the middle of the handle -- or `along` metres out from the
   * pin, if given.
   */
  gripAt(angle: number, out: THREE.Vector3, along?: number): THREE.Vector3 {
    if (along !== undefined) out.set(0, 0, -along); else out.copy(this.held);
    return out.applyQuaternion(this.poseAt(angle, this._q)).add(this.pinAt);
  }

  /**
   * A hand takes hold, wherever on the bar it has got to: jointed there as it
   * is, so the joint has nothing to pull together. False if something
   * already has hold of it, or it has caught.
   */
  takeHold(arm: Arm): boolean {
    if (this.hand || this.caughtNow) return false;
    const fore = arm.fore;
    const reach = arm.build.segment.foreArm.length / 2;
    const r = fore.rotation();
    const t = fore.translation();
    const at = this._v.set(0, reach, 0).applyQuaternion(this._q.set(r.x, r.y, r.z, r.w))
      .add(_p.set(t.x, t.y, t.z));
    // Into the bar's own frame.
    const b = this.body.translation();
    const br = this.body.rotation();
    this.held.copy(at).sub(_p.set(b.x, b.y, b.z))
      .applyQuaternion(this._q.set(br.x, br.y, br.z, br.w).invert());
    const { rapier, world } = this.phys;
    this.hand = world.createImpulseJoint(
      rapier.JointData.spherical({ x: 0, y: reach, z: 0 }, { x: this.held.x, y: this.held.y, z: this.held.z }),
      fore, this.body, true,
    );
    return true;
  }

  /** The hand lets go of it. */
  letGo(): void {
    if (!this.hand) return;
    this.phys.world.removeImpulseJoint(this.hand, true);
    this.hand = null;
  }

  /**
   * After a step of the world: caught, if it has been pulled far enough, and
   * the handle found where the bar has taken it.
   */
  update(): void {
    if (!this.caughtNow && this.angle <= LEVER_CATCH) this.catch();
    this.gripAt(this.angle, this.item.grip, LEVER_LENGTH);
  }

  /**
   * Down it goes, and stays: what a hand pulling it far enough does, or --
   * for whatever asks without a hand (see `take`) -- the catch let go of
   * outright, and the bar swung down on its spring. Nothing is placed.
   */
  throwOver(): void {
    if (!this.caughtNow) this.catch();
  }

  private catch(): void {
    this.caughtNow = true;
    this.item.taken = true;
    // The catch holds it at the bottom, as the spring held it at the top.
    this.pin.configureMotorPosition(LEVER_DOWN - LEVER_WOUND, LEVER_SPRING * 2, LEVER_DAMP);
    this.body.wakeUp();
    this.onCaught?.();
  }

  /** Up again, on its stop, with nobody's hand on it. */
  reset(): void {
    this.letGo();
    this.caughtNow = false;
    this.item.taken = false;
    this.spring();
    const q = this.poseAt(LEVER_UP, this._q);
    this.body.setTranslation({ x: this.pinAt.x, y: this.pinAt.y, z: this.pinAt.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gripAt(LEVER_UP, this.item.grip, LEVER_LENGTH);
  }

  private spring(): void {
    this.pin.configureMotorPosition(LEVER_UP + LEVER_WOUND, LEVER_SPRING, LEVER_DAMP);
  }

  /** The bar's rotation at `angle`, world. */
  private poseAt(angle: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.setFromAxisAngle(ACROSS, angle).premultiply(this.mount);
  }
}

// --- the gate --------------------------------------------------------------------

/** How long after the lever catches the gate starts to move, and how long it takes to go up, seconds. */
const GATE_DELAY = 0.45;
const GATE_RISE = 2.8;
/** How thick it is, metres: planks and the iron over them, in a wall 0.4 thick. */
const GATE_THICK = 0.14;

export interface GateSpec {
  /** The middle of the doorway, on the floor. */
  readonly at: THREE.Vector3;
  /** Which way the wall it is in runs. */
  readonly along: "x" | "z";
  /** The doorway it closes, metres. */
  readonly width: number;
  readonly height: number;
  /** How far it goes up, metres: clear of the doorway, into the gatehouse over it. */
  readonly lift: number;
}

export class Gate {
  /** Kinematic: nothing it meets moves it. */
  readonly body: RAPIER.RigidBody;
  /** What draws it: placed by the Interpolator, from `body`. */
  readonly mesh = new THREE.Group();
  /** Told once, as it starts to move -- the noise it makes starts with it. */
  onStart?: () => void;
  /** Told once, when it is all the way up. */
  onOpen?: () => void;

  /** Seconds since it was set going, or -1 while it is shut and staying shut. */
  private time = -1;
  private raised = 0;
  private readonly shut = new THREE.Vector3();

  constructor(phys: PhysicsWorld, scene: THREE.Scene, targets: Targets,
    private readonly spec: GateSpec) {
    const { rapier, world } = phys;
    const half = spec.height / 2;
    this.shut.set(spec.at.x, half, spec.at.z);
    // Built across Z, and turned a quarter for a wall along X.
    const turn = spec.along === "x" ? new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2)
      : new THREE.Quaternion();
    this.body = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(this.shut.x, this.shut.y, this.shut.z)
      .setRotation({ x: turn.x, y: turn.y, z: turn.z, w: turn.w }));
    // The walls' own groups and events: shut, it is a wall.
    const col = world.createCollider(
      rapier.ColliderDesc.cuboid(GATE_THICK / 2, half, spec.width / 2)
        .setFriction(0.9)
        .setRestitution(0.03)
        .setCollisionGroups(groups(GROUP.WORLD, GROUP.WORLD | GROUP.PROP | ALL_COMBATANTS))
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1.0),
      this.body,
    );
    targets.register(col.handle, "gate");

    buildGateMesh(this.mesh, spec.width, spec.height);
    this.mesh.position.copy(this.shut);
    this.mesh.quaternion.copy(turn);
    scene.add(this.mesh);
  }

  /** Set it going up. Nothing, if it already is, or is up. */
  open(): void {
    if (this.time < 0) this.time = 0;
  }

  /** It has been set going, whether or not it has got anywhere yet. */
  get opening(): boolean {
    return this.time >= 0;
  }

  /** All the way up, the doorway clear. */
  get isOpen(): boolean {
    return this.raised >= this.spec.lift;
  }

  /** How far up it is, metres. */
  get lift(): number {
    return this.raised;
  }

  /** Before a step of the world: where it goes up to by the end of it. */
  step(dt: number): void {
    if (this.time < 0 || this.isOpen) return;
    const was = this.time;
    this.time += dt;
    if (was < GATE_DELAY && this.time >= GATE_DELAY) this.onStart?.();
    // Slow off the bottom as the weight comes onto the chain, and slow into
    // the top.
    this.raised = this.spec.lift * smoothstep(0, 1, (this.time - GATE_DELAY) / GATE_RISE);
    this.body.setNextKinematicTranslation({ x: this.shut.x, y: this.shut.y + this.raised, z: this.shut.z });
    if (this.isOpen) this.onOpen?.();
  }

  /** Shut again, at once: a reset has cleared the doorway first. */
  reset(): void {
    this.time = -1;
    this.raised = 0;
    this.body.setTranslation({ x: this.shut.x, y: this.shut.y, z: this.shut.z }, true);
    this.body.setNextKinematicTranslation({ x: this.shut.x, y: this.shut.y, z: this.shut.z });
  }
}

const UP = new THREE.Vector3(0, 1, 0);
/** The pin, in the wall's frame. */
const ACROSS = new THREE.Vector3(1, 0, 0);
const _inv = new THREE.Quaternion();
const _p = new THREE.Vector3();

// --- what they look like -----------------------------------------------------------

const iron = () => new THREE.MeshStandardMaterial({ color: 0x3b3a38, roughness: 0.55, metalness: 0.7 });

/**
 * The bar, out along -Z from the pin, and the handle across its end: all of
 * it one body's children, so the Interpolator places it whole.
 */
function buildLeverMesh(g: THREE.Group): void {
  const metal = iron();
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, LEVER_LENGTH, 10), metal);
  bar.rotation.x = Math.PI / 2;
  bar.position.z = -LEVER_LENGTH / 2;
  bar.castShadow = true;
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.05, 14), metal);
  boss.rotation.z = Math.PI / 2;
  // A worn grip, lifted a little so it can be found in the gloom.
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.15, 10),
    new THREE.MeshStandardMaterial({
      color: 0x6b4d31, roughness: 0.8, emissive: 0x6b4d31, emissiveIntensity: 0.22,
    }));
  grip.rotation.z = Math.PI / 2;
  grip.position.z = -LEVER_LENGTH;
  grip.castShadow = true;
  const ends = [-1, 1].map((side) => {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), metal);
    cap.position.set(side * 0.085, 0, -LEVER_LENGTH);
    return cap;
  });
  g.add(bar, boss, grip, ...ends);
}

/** A plate on the wall and the two cheeks the pin runs through. Scenery: it does not move. */
function buildBracket(): THREE.Group {
  const g = new THREE.Group();
  const metal = iron();
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.42, 0.03), metal);
  plate.position.z = LEVER_STANDOFF - 0.015;
  plate.castShadow = true;
  plate.receiveShadow = true;
  g.add(plate);
  for (const side of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, LEVER_STANDOFF + 0.03), metal);
    cheek.position.set(side * 0.042, 0, (LEVER_STANDOFF - 0.03) / 2);
    cheek.castShadow = true;
    g.add(cheek);
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 8), metal);
    bolt.rotation.z = Math.PI / 2;
    bolt.position.set(side * 0.056, 0, 0);
    g.add(bolt);
  }
  // Rivets in the plate's corners.
  for (const [x, y] of [[-0.1, 0.17], [0.1, 0.17], [-0.1, -0.17], [0.1, -0.17]]) {
    const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), metal);
    rivet.position.set(x, y, LEVER_STANDOFF - 0.032);
    g.add(rivet);
  }
  return g;
}

/**
 * Upright planks with iron bands across both faces, and an iron shoe along
 * the bottom: built across Z, `thick` in X, centred on the body.
 */
function buildGateMesh(g: THREE.Group, width: number, height: number): void {
  const planks = 7;
  const gap = 0.012;
  const each = width / planks;
  const woods = [0x5d4630, 0x654c34, 0x584229].map((c) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.86 }));
  for (let i = 0; i < planks; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(GATE_THICK - 0.04, height, each - gap),
      woods[i % woods.length]);
    plank.position.z = -width / 2 + each * (i + 0.5);
    plank.castShadow = true;
    plank.receiveShadow = true;
    g.add(plank);
  }
  const metal = iron();
  for (const y of [0.18, 0.5, 0.82]) {
    for (const side of [-1, 1]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.13, width + 0.02), metal);
      band.position.set(side * (GATE_THICK / 2 - 0.01), (y - 0.5) * height, 0);
      band.castShadow = true;
      g.add(band);
      for (let i = 0; i < planks; i++) {
        const stud = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), metal);
        stud.position.set(side * (GATE_THICK / 2), (y - 0.5) * height, -width / 2 + each * (i + 0.5));
        g.add(stud);
      }
    }
  }
  const shoe = new THREE.Mesh(new THREE.BoxGeometry(GATE_THICK, 0.08, width), metal);
  shoe.position.y = -height / 2 + 0.04;
  g.add(shoe);
}
