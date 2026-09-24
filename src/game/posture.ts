import * as THREE from "three";
import type { Build } from "./anatomy";
import type { Tuning } from "../tuning";
import { Spring, clamp, smoothstep, soft } from "./motion";

/**
 * How a fighter carries its body around the sword arm.
 *
 * The arm is simulated; the trunk it hangs from used to be a rigid block
 * locked to the facing, so every cross-body cut was an arm swung straight
 * through a chest that had not moved to let it pass. This is the layer that
 * moves it: the chest turns ahead of the swing, the shoulder girdle slides
 * round the ribs to make room, the body leans into a chop and bends with a
 * sweep, the head follows what the blade is doing, and the hips take up a
 * sustained turn more slowly underneath.
 *
 * Three rules keep it from costing the arm anything:
 *
 *  1. What makes room for the arm -- the chest's turn, the hips, the shoulder
 *     sliding round the ribs -- reads INTENT, the followed aim the ghost hand
 *     is built from, and never the physical arm. The intent is always ahead
 *     of the arm, so a body driven by it leads the swing rather than trailing
 *     it. Only the secondary motion also reads the real arm: lean, bend and
 *     shrug react to the hand's measured acceleration and to how hard the
 *     drive is straining. Those terms are clamped (under ten degrees of lean
 *     or bend, a few centimetres of shrug) and pass through springs, so they
 *     can only nudge the shoulder, and nothing here writes back into what the
 *     mouse asked for.
 *
 *  2. The mouse's aim stays in the hull's frame. Turning the chest moves the
 *     SHOULDER the arm hangs from, and nothing else: the hand still goes where
 *     you pointed, from a root that has stepped out of its way.
 *
 *  3. It is deterministic in the aim. `steady` gives the posture a held aim
 *     settles into, which is what the arm's probes solve with, so an opponent
 *     asking "where would my blade be" gets the answer its body will give.
 *
 * Every length here is at human scale and multiplied by the build's.
 */

/** The guard the body is built around: where the sword arm rests, hull-relative. */
export const GUARD = { yaw: 0.30, pitch: -0.30 } as const;

/** What the arm tells the body, once a step. Angles are hull-relative. */
export interface PostureDrive {
  /** The followed aim, radians. */
  yaw: number;
  pitch: number;
  /** How fast it is moving, rad/s. This is the "mouse velocity" of the swing. */
  yawRate: number;
  pitchRate: number;
  /** The hand's acceleration in the hull's frame, m/s^2, smoothed. */
  accel: THREE.Vector3;
  /** How saturated the arm's drive is, 0..1. A bound blade makes a tense body. */
  strain: number;
  /** A world point worth looking at: where the blade is meant to be. */
  look: THREE.Vector3 | null;
}

// --- torso lead ---------------------------------------------------------------

/**
 * Seconds of the swing's velocity folded into where the chest aims.
 *
 * The chest is a spring and springs lag; aiming it this far ahead of the
 * intent is what makes it turn BEFORE the arm crosses in front of it rather
 * than as it does.
 */
const LEAD_TIME = 0.07;
/** Chest radians per radian of arm yaw away from the guard. */
const TWIST_GAIN = 0.5;
/** The most the chest turns toward a cross-body swing, and away on a backswing. */
const TWIST_CROSS = 0.8;
const TWIST_BACK = 0.6;
/** Fast: this is the part that has to beat the arm across the chest. */
const TWIST_OMEGA = 20;
/** The spine's share of a turn. Past this the hips have to come round too. */
export const SPINE_MAX = 0.55;
/** Slow: the hips settle into a sustained turn, they do not chase a flick. */
const PELVIS_OMEGA = 6;

// --- shoulder girdle, metres at human scale -----------------------------------

/** Reaching across, the shoulder blade slides forward round the ribs. */
const PROTRACT_CROSS = 0.06;
/** Reaching back, it pulls in toward the spine. */
const RETRACT_BACK = 0.035;
/** How much of a protraction is inward as well as forward: the ribs are round. */
const PROTRACT_INWARD = 0.35;
/** A raised arm lifts the shoulder with it; a low one lets it drop a little. */
const ELEVATE_HIGH = 0.045;
const DEPRESS_LOW = 0.015;
/** Straining against a bind, the shoulders come up. */
const SHRUG_STRAIN = 0.022;
/** Metres of shrug per m/s^2 of the hand's vertical acceleration. */
const SHRUG_ACCEL = 0.00025;
const CLAVICLE_OMEGA = 16;
const CLAVICLE_ZETA = 0.8;

// --- lean and side bend, radians ----------------------------------------------

/** A low hand draws the chest over it; a high one straightens it back. */
const LEAN_LOW = 0.12;
const LEAN_HIGH = 0.07;
/** Leaning into a chop: radians per rad/s of downward swing. */
const LEAN_CHOP = 0.012;
/** And into a thrust: radians per m/s^2 of forward hand acceleration. */
const LEAN_THRUST = 0.0012;
/** Under-damped on purpose -- a lean that swings slightly past is weight. */
const LEAN_OMEGA = 11;
const LEAN_ZETA = 0.65;
/** Bending with a sweep: radians per rad/s of sideways swing. */
const BEND_RATE = 0.01;
/**
 * And against the hand's own acceleration, which is the arm's reaction on the
 * body: a sweep getting going pulls the chest back the other way for a moment,
 * and one being stopped throws it after the blade. That little counter-sway
 * and follow-through is most of what separates a swung sword from a posed one.
 */
const BEND_ACCEL = 0.0011;
const BEND_MAX = 0.14;
const BEND_OMEGA = 10;
const BEND_ZETA = 0.6;

// --- crouch -------------------------------------------------------------------

/**
 * How far a crouch sinks the hips, metres at human scale: knees bent past a
 * right angle, low enough to go under a cut at the head with room to spare.
 */
export const CROUCH_DROP = 0.38;
/** And how far it tips the chest forward over them, at the bottom. */
const CROUCH_LEAN = 0.22;
/** Quick, but a body's weight still has to go down and come back up. */
const CROUCH_OMEGA = 13;
/**
 * A stoop, all the way: how far further it bows the chest over the crouch it
 * goes down into, radians, and how far it lets the sword shoulder down and
 * forward, metres at human scale -- a hand going to the floor takes the
 * shoulder blade with it.
 */
const STOOP_LEAN = 0.9;
const STOOP_DROP = 0.06;
const STOOP_REACH = 0.05;

// --- gaze ---------------------------------------------------------------------

/** Neck range relative to the chest. */
const GAZE_YAW = 1.0;
const GAZE_UP = 0.45;
const GAZE_DOWN = 0.7;
/** The head goes most of the way; the eyes -- which nobody can see -- do the rest. */
const GAZE_SHARE = 0.7;
const GAZE_OMEGA = 9;
const GAZE_ZETA = 0.9;
/** How much of a side bend the neck undoes to keep the eyes level. */
const HEAD_LEVEL = 0.6;

/** One posture, as numbers. Everything the body needs to be placed from. */
export class Pose {
  /** Hips, about the hull's vertical, radians. Positive turns left. */
  pelvis = 0;
  /** Spine twist on top of the hips. */
  spine = 0;
  /** Forward lean, radians. */
  lean = 0;
  /** Side bend, radians. Positive bends to the left. */
  bend = 0;
  /** Sword shoulder forward of its rest, metres. Negative pulls it back. */
  protract = 0;
  /** Sword shoulder above its rest, metres. */
  elevate = 0;
  /** How far the hips have sunk into a crouch, metres. Everything above them goes with them. */
  sink = 0;

  /** Where the chest actually faces, relative to the hull. */
  get chestYaw(): number {
    return this.pelvis + this.spine;
  }

  copy(o: Pose): this {
    this.pelvis = o.pelvis;
    this.spine = o.spine;
    this.lean = o.lean;
    this.bend = o.bend;
    this.protract = o.protract;
    this.elevate = o.elevate;
    this.sink = o.sink;
    return this;
  }

  lerpPoses(a: Pose, b: Pose, t: number): this {
    this.pelvis = a.pelvis + (b.pelvis - a.pelvis) * t;
    this.spine = a.spine + (b.spine - a.spine) * t;
    this.lean = a.lean + (b.lean - a.lean) * t;
    this.bend = a.bend + (b.bend - a.bend) * t;
    this.protract = a.protract + (b.protract - a.protract) * t;
    this.elevate = a.elevate + (b.elevate - a.elevate) * t;
    this.sink = a.sink + (b.sink - a.sink) * t;
    return this;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();

export class Posture {
  /** This step's posture, and the last one, for render interpolation. */
  readonly pose = new Pose();
  readonly prev = new Pose();

  /** Where the head is turned relative to the chest, radians. */
  gazeYaw = 0;
  gazePitch = 0;
  gazeRoll = 0;

  private readonly twist = new Spring(TWIST_OMEGA);
  private readonly hips = new Spring(PELVIS_OMEGA);
  private readonly leanS = new Spring(LEAN_OMEGA, LEAN_ZETA);
  private readonly bendS = new Spring(BEND_OMEGA, BEND_ZETA);
  private readonly protractS = new Spring(CLAVICLE_OMEGA, CLAVICLE_ZETA);
  private readonly elevateS = new Spring(CLAVICLE_OMEGA, CLAVICLE_ZETA);
  private readonly gazeYawS = new Spring(GAZE_OMEGA, GAZE_ZETA);
  private readonly gazePitchS = new Spring(GAZE_OMEGA, GAZE_ZETA);
  private readonly sinkS = new Spring(CROUCH_OMEGA);
  /** How far over the body is bowed this step, 0..1: see `update`. */
  private stoop = 0;

  /** Hull-local height of the waist: the pivot the chest turns and bends about. */
  readonly waistY: number;
  /** The sword shoulder at rest, relative to the waist pivot. */
  private readonly restShoulder: THREE.Vector3;
  private readonly neckY: number;
  private readonly headHalf: number;

  constructor(private readonly build: Build) {
    this.waistY = build.local(build.standing.waist);
    this.restShoulder = build.shoulderLocal.clone().sub(new THREE.Vector3(0, this.waistY, 0));
    this.neckY = build.local(build.standing.neck) - this.waistY;
    this.headHalf = build.segment.head.length / 2;
  }

  // ---------------------------------------------------------------------------
  // What a given aim asks of the body
  // ---------------------------------------------------------------------------

  /** Where the chest wants to face for an arm leading at `lead` radians. */
  private twistFor(lead: number, t: Tuning): number {
    const x = (lead - GUARD.yaw) * TWIST_GAIN * t.torsoLead;
    return x >= 0 ? soft(x, TWIST_CROSS) : soft(x, TWIST_BACK);
  }

  /**
   * The hips' share of a turn.
   *
   * `stanceShare` of it always, and all of whatever the spine cannot take, so
   * the chest can face the swing even when the spine has run out of twist.
   */
  private hipsFor(twist: number, t: Tuning): number {
    const share = twist * t.stanceShare;
    const overflow = Math.sign(twist) * Math.max(0, Math.abs(twist) - SPINE_MAX);
    return Math.abs(overflow) > Math.abs(share) ? overflow : share;
  }

  /** Shoulder blade forward (+) or back (-), for the arm's yaw off the chest. */
  private protractFor(armOffChest: number, t: Tuning): number {
    const s = this.build.scale * t.torsoLead;
    const across = smoothstep(GUARD.yaw, 1.5, armOffChest);
    const behind = smoothstep(GUARD.yaw - 0.2, -1.6, armOffChest);
    return s * (PROTRACT_CROSS * across - RETRACT_BACK * behind);
  }

  private elevateFor(pitch: number, t: Tuning): number {
    const s = this.build.scale * t.torsoLead;
    return s * (ELEVATE_HIGH * smoothstep(0.2, 1.3, pitch)
      - DEPRESS_LOW * smoothstep(-0.6, -1.3, pitch));
  }

  private leanFor(pitch: number, t: Tuning): number {
    return t.secondaryMotion * (LEAN_LOW * smoothstep(-0.6, -1.3, pitch)
      - LEAN_HIGH * smoothstep(0.6, 1.4, pitch));
  }

  /**
   * The posture a held aim settles into, with nothing moving.
   *
   * No velocity, no acceleration, no strain: exactly what `update` arrives at
   * once the swing has stopped. The arm's probes solve with this.
   */
  steady(yaw: number, pitch: number, t: Tuning, out: Pose): Pose {
    const twist = this.twistFor(yaw, t);
    out.pelvis = this.hipsFor(twist, t);
    out.spine = clamp(twist - out.pelvis, -SPINE_MAX, SPINE_MAX);
    out.lean = this.leanFor(pitch, t);
    out.bend = 0;
    out.protract = this.protractFor(yaw - out.chestYaw, t);
    out.elevate = this.elevateFor(pitch, t);
    // A crouch is the legs', not the aim's: a held aim settles at whatever
    // height the body is at now, with the lean the crouch gives it.
    out.sink = this.pose.sink;
    out.lean += this.crouchLean(out.sink) + STOOP_LEAN * this.stoop;
    return out;
  }

  /**
   * Stand square, with nothing moving.
   *
   * Square is also exactly the steady posture for the guard -- every term
   * above is measured from it -- so a fighter reset with its arm at rest
   * starts already settled, rather than twisting into place on the first
   * steps and dragging the arm's shoulder with it.
   */
  reset(): void {
    for (const pose of [this.pose, this.prev]) {
      pose.pelvis = pose.spine = pose.lean = pose.bend = 0;
      pose.protract = pose.elevate = 0;
      pose.sink = 0;
    }
    for (const s of [this.twist, this.hips, this.leanS, this.bendS,
      this.protractS, this.elevateS, this.gazeYawS, this.gazePitchS, this.sinkS]) s.reset(0);
    this.stoop = 0;
    this.gazeYaw = this.gazePitch = this.gazeRoll = 0;
  }

  // ---------------------------------------------------------------------------
  // Per step
  // ---------------------------------------------------------------------------

  /**
   * Advance one fixed step.
   *
   * `drive` is null when there is no sword arm to carry -- it has been cut off
   * -- and the body relaxes back to square. `focus` overrides what the head
   * looks at; `hullYaw` and `hullPos` place the hull, for turning world points
   * into the body's own frame. `crouch` is how far down the legs want to be,
   * 0 standing and 1 an ordinary crouch -- a stoop goes further -- and `stoop`
   * how far over the body bows to get a hand to the floor, 0..1.
   */
  update(
    drive: PostureDrive | null, focus: THREE.Vector3 | null,
    hullYaw: number, hullPos: { x: number; y: number; z: number },
    t: Tuning, dt: number, crouch = 0, stoop = 0,
  ): void {
    this.prev.copy(this.pose);
    const k = t.secondaryMotion;

    // First, so the lean below can go with it: the crouch.
    this.pose.sink = Math.max(0, this.sinkS.step(crouch * CROUCH_DROP * this.build.scale, dt));

    let twistT = 0;
    let leanT = 0;
    let bendT = 0;
    if (drive) {
      twistT = this.twistFor(drive.yaw + LEAD_TIME * drive.yawRate, t);
      leanT = this.leanFor(drive.pitch, t) + k * (
        clamp(-LEAN_CHOP * drive.pitchRate, -0.06, 0.12)
        + clamp(-LEAN_THRUST * drive.accel.z, -0.05, 0.08));
      bendT = k * clamp(
        BEND_RATE * drive.yawRate + BEND_ACCEL * drive.accel.x, -BEND_MAX, BEND_MAX);
    }

    // The chest follows the fast spring, the hips the slow one, and the spine
    // is whatever is left between them. So the hips can take their time
    // without the chest -- and so the shoulder, and so the arm -- ever
    // waiting for them.
    const chest = this.twist.step(twistT, dt);
    const pose = this.pose;
    pose.pelvis = this.hips.step(this.hipsFor(twistT, t), dt);
    pose.spine = clamp(chest - pose.pelvis, -SPINE_MAX, SPINE_MAX);
    this.stoop = stoop;
    pose.lean = this.leanS.step(leanT + this.crouchLean(pose.sink) + STOOP_LEAN * stoop, dt);
    pose.bend = this.bendS.step(bendT, dt);

    let protractT = 0;
    let elevateT = 0;
    if (drive) {
      protractT = this.protractFor(drive.yaw - pose.chestYaw, t);
      elevateT = this.elevateFor(drive.pitch, t) + k * this.build.scale * (
        SHRUG_STRAIN * drive.strain * drive.strain
        + clamp(SHRUG_ACCEL * drive.accel.y, -0.012, 0.018));
    }
    const s = this.build.scale;
    pose.protract = this.protractS.step(protractT + STOOP_REACH * s * stoop, dt);
    pose.elevate = this.elevateS.step(elevateT - STOOP_DROP * s * stoop, dt);

    this.updateGaze(focus ?? drive?.look ?? null, hullYaw, hullPos, t, dt);
  }

  /** The forward tip of the chest that goes with sinking this far. */
  private crouchLean(sink: number): number {
    return CROUCH_LEAN * Math.min(1, sink / (CROUCH_DROP * this.build.scale));
  }

  /**
   * A blow landing: the chest is thrown away from it, and the same lean and
   * bend springs that carry a swing's follow-through bring it back -- a
   * little past, as they do everything.
   *
   * `x` and `z` are the way the blow drives, in the chest's own frame, and
   * `rate` how fast it throws the top of the chest, rad/s. A kick to the
   * springs' velocity rather than to where they are, so the flinch is
   * motion like everything else here and never a pose snapped into place.
   */
  recoil(x: number, z: number, rate: number): void {
    // Forward is -Z and a positive lean is forward; a positive bend is to the
    // left, which is -X.
    this.leanS.v -= z * rate;
    this.bendS.v -= x * rate;
  }

  /**
   * Turn the head toward something worth watching.
   *
   * The target is taken into the chest's own frame, so the neck does only
   * what the trunk has not already done, and is limited to what a neck can.
   * Anything behind the fighter fades the gaze back to front rather than
   * letting it whip from one shoulder to the other as the bearing crosses
   * straight back.
   */
  private updateGaze(
    target: THREE.Vector3 | null, hullYaw: number,
    hullPos: { x: number; y: number; z: number }, t: Tuning, dt: number,
  ): void {
    const k = t.secondaryMotion;
    let yawT = 0;
    let pitchT = 0;
    if (target && k > 0) {
      const eye = this.chestPoint(this.pose,
        _eye.set(0, this.neckY + this.headHalf, 0), _eye);
      // World -> hull-local -> relative to the eye -> chest-local.
      const v = _v.set(target.x - hullPos.x, target.y - hullPos.y, target.z - hullPos.z)
        .applyAxisAngle(UP, -hullYaw)
        .sub(eye)
        .applyQuaternion(this.chestQuat(this.pose, _q).invert());
      const bearing = Math.atan2(-v.x, -v.z);
      const elevation = Math.atan2(v.y, Math.hypot(v.x, v.z));
      const weight = GAZE_SHARE * Math.min(1, k) * smoothstep(2.6, 1.8, Math.abs(bearing));
      yawT = clamp(bearing, -GAZE_YAW, GAZE_YAW) * weight;
      pitchT = clamp(elevation, -GAZE_DOWN, GAZE_UP) * weight;
    }
    this.gazeYaw = this.gazeYawS.step(yawT, dt);
    this.gazePitch = this.gazePitchS.step(pitchT, dt);
    this.gazeRoll = -HEAD_LEVEL * Math.min(1, k) * this.pose.bend;
  }

  // ---------------------------------------------------------------------------
  // Placing things on the posed body
  // ---------------------------------------------------------------------------

  /** The chest's rotation in the hull's frame. */
  chestQuat(pose: Pose, out: THREE.Quaternion): THREE.Quaternion {
    return out.setFromEuler(_e.set(-pose.lean, pose.chestYaw, pose.bend, "YXZ"));
  }

  /**
   * A point on the chest, given relative to the waist pivot at rest, in the
   * hull's frame as the posture has moved it. Safe to alias `local` and `out`.
   */
  chestPoint(pose: Pose, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const q = this.chestQuat(pose, _q);
    return out.copy(local).applyQuaternion(q).setY(out.y + this.waistY - pose.sink);
  }

  /** How far the girdle has carried the sword shoulder, in the chest's frame. */
  clavicle(pose: Pose, out: THREE.Vector3): THREE.Vector3 {
    return out.set(-PROTRACT_INWARD * pose.protract, pose.elevate, -pose.protract);
  }

  /** The sword shoulder, hull-local: the arm's joint anchor. */
  swordShoulder(pose: Pose, out: THREE.Vector3): THREE.Vector3 {
    this.clavicle(pose, out).add(this.restShoulder);
    return this.chestPoint(pose, out, out);
  }

}
