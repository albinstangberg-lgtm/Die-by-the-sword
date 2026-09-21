import * as THREE from "three";
import type { ArmInput } from "./arm";
import type { Combatant } from "./combatant";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";

/**
 * A dumb opponent.
 *
 * It does not get to cheat. It drives its sword arm by emitting MOUSE DELTAS
 * through the same `ArmInput` surface the player's pointer feeds, so its blade
 * is subject to the same force clamp, the same reach limits, the same
 * saturating PD controller. It cannot teleport its sword, it cannot swing
 * faster than an arm can be moved, and if it buries its blade in a pillar it is
 * stuck there exactly as long as you would be.
 *
 * Everything it "decides" is which way to point and when to commit. Making that
 * smarter is stage 5's problem; making it fair is this file's whole job.
 */

/** How fast the AI is allowed to move its hand, in pixels of mouse per second. */
const HAND_SPEED = 1100;

/**
 * Measured centre-to-centre between torsos.
 *
 * The blade reaches about 1.46m from the shoulder, but during a SWEEP it is
 * side-on rather than pointing at the target, so the distance it can actually
 * cut at is well under that. An earlier version wanted to strike from 1.65m,
 * where its swings looked right and passed through empty air every time.
 */
const RANGE = {
  /** Closer than this and it backs off — it has over-committed. */
  tooClose: 0.78,
  /** The distance it wants to strike from. */
  strike: 1.15,
  /** Further than this and it closes in. */
  tooFar: 1.45,
};

type State = "close" | "windup" | "strike" | "recover" | "backoff" | "beaten";

interface Stroke {
  /** Where the arm winds up to, and where it sweeps through to. */
  fromYaw: number; fromPitch: number;
  toYaw: number; toPitch: number;
  roll: number;
}

/**
 * A small repertoire, tuned by measurement rather than by eye.
 *
 * Every stroke ends in the band a little below shoulder height, because that
 * is where a standing opponent's chest is and because a vertical torso can
 * only be cut by a blade travelling ACROSS it. An earlier set led with big
 * overhead chops, which look right and are nearly worthless: swung down the
 * side of an upright body the edge is perpendicular to the surface it touches,
 * so it grazes at an edge alignment of essentially zero. The rolls are
 * negative for the same reason — the sign that puts the arm in a plane whose
 * edge leads the travel.
 */
const STROKES: Stroke[] = [
  // Diagonal into the chest — the highest-scoring line by some margin.
  { fromYaw: -1.15, fromPitch: 0.25, toYaw: 0.95, toPitch: -0.35, roll: -1.1 },
  // Steeper descending diagonal, finishing lower.
  { fromYaw: -1.25, fromPitch: 0.1, toYaw: 1.0, toPitch: -0.6, roll: -0.6 },
  // Low sweep at the waist and thighs.
  { fromYaw: -1.3, fromPitch: -0.45, toYaw: 1.05, toPitch: -0.9, roll: 0 },
  // Backhand, returning right to left. Rolled the same way: the blade is
  // symmetric, so which edge leads costs nothing, and this is the arm plane
  // that measured well.
  { fromYaw: 1.05, fromPitch: 0.15, toYaw: -1.2, toPitch: -0.4, roll: -1.0 },
];

export class Ai implements ArmInput {
  readonly keys: Keys = {
    forward: false, back: false, left: false, right: false,
    turnLeft: false, turnRight: false,
  };

  private state: State = "close";
  private timer = 0;
  private stroke = STROKES[0];
  /**
   * Forces a single stroke, so one line's geometry can be measured in
   * isolation. This is how the table above was tuned; leave it null in play.
   */
  strokeOverride: Stroke | null = null;
  private want = { yaw: 0.3, pitch: -0.15, reach: 0.46, roll: 0 };

  private dx = 0;
  private dy = 0;
  private rollDx = 0;

  /** Visible in the HUD, so it is obvious what it is up to. */
  get intent(): string {
    return this.state;
  }

  private readonly _self = new THREE.Vector3();
  private readonly _foe = new THREE.Vector3();

  constructor(private aggression = 1) {}

  /** Run once per fixed step, before the arm reads its input. */
  think(self: Combatant, foe: Combatant, t: Tuning, dt: number): void {
    if (self.dead) { this.state = "beaten"; this.idle(); return; }

    self.position(this._self);
    foe.position(this._foe);
    const toFoe = this._foe.clone().sub(this._self);
    const range = Math.hypot(toFoe.x, toFoe.z);

    this.face(self, toFoe, dt);
    this.timer -= dt;

    // Disarmed: no sword, no plan. It backs away rather than pretending.
    if (self.arm.disarmed) {
      this.state = "beaten";
      this.keys.forward = false;
      this.keys.back = range < 3.0;
      this.steerArm(self, t, dt);
      return;
    }

    switch (this.state) {
      case "close":
        this.want = { yaw: 0.3, pitch: 0.1, reach: 0.44, roll: 0 };
        this.keys.forward = range > RANGE.strike;
        this.keys.back = range < RANGE.tooClose;
        if (range <= RANGE.tooFar && range >= RANGE.tooClose) {
          this.begin("windup", 0.28 / this.aggression);
          this.stroke = this.strokeOverride ?? STROKES[(Math.random() * STROKES.length) | 0];
        }
        break;

      case "windup":
        this.want = {
          yaw: this.stroke.fromYaw, pitch: this.stroke.fromPitch,
          reach: 0.40, roll: this.stroke.roll,
        };
        this.keys.forward = false;
        this.keys.back = false;
        // Commit once the arm has actually got there, or when patience runs
        // out — otherwise a blade caught on scenery would hold it forever.
        if (this.timer <= 0 || this.armIsNear(self, 0.25)) {
          this.begin("strike", 0.42);
        }
        break;

      case "strike":
        // Aim THROUGH the target, not at it. Sweeping to a point short of the
        // foe decelerates into the hit and lands a shove; the whole damage
        // model is built on speed at contact.
        this.want = {
          yaw: this.stroke.toYaw, pitch: this.stroke.toPitch,
          reach: 0.50, roll: this.stroke.roll,
        };
        this.keys.forward = range > RANGE.strike;
        if (this.timer <= 0) this.begin("recover", 0.22);
        break;

      case "recover":
        this.want = { yaw: 0.3, pitch: 0.1, reach: 0.42, roll: 0 };
        this.keys.forward = false;
        this.keys.back = range < RANGE.tooClose;
        if (this.timer <= 0) {
          // After a swing it mostly presses, and occasionally resets so it is
          // not a metronome. Backing off after three swings in four made it
          // spend more of the fight retreating than fighting.
          this.begin(Math.random() < 0.75 * this.aggression ? "close" : "backoff", 0.35);
        }
        break;

      case "backoff":
        this.want = { yaw: 0.35, pitch: 0.2, reach: 0.40, roll: 0.3 };
        this.keys.forward = false;
        this.keys.back = range < RANGE.tooFar;
        if (this.timer <= 0) this.begin("close", 0);
        break;

      case "beaten":
        this.idle();
        break;
    }

    this.steerArm(self, t, dt);
  }

  private begin(state: State, seconds: number): void {
    this.state = state;
    this.timer = seconds;
  }

  private idle(): void {
    this.keys.forward = false;
    this.keys.back = false;
    this.keys.left = false;
    this.keys.right = false;
    this.keys.turnLeft = false;
    this.keys.turnRight = false;
  }

  /** Turn toward the foe using the same turn keys the player has. */
  private face(self: Combatant, toFoe: THREE.Vector3, _dt: number): void {
    // Torso-forward is -Z, so the yaw that points at a direction d is
    // atan2(-d.x, -d.z).
    const wanted = Math.atan2(-toFoe.x, -toFoe.z);
    let err = wanted - self.fighter.yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;

    const dead = 0.06;
    this.keys.turnLeft = err > dead;
    this.keys.turnRight = err < -dead;
  }

  private armIsNear(self: Combatant, tolerance: number): boolean {
    const aim = self.arm.aim;
    return Math.abs(aim.yaw - this.want.yaw) < tolerance
      && Math.abs(aim.pitch - this.want.pitch) < tolerance;
  }

  /**
   * Convert "where I want the arm" into mouse travel, capped at a human hand
   * speed. This is the only channel the AI has to its own sword.
   */
  private steerArm(self: Combatant, t: Tuning, dt: number): void {
    const aim = self.arm.aim;
    const budget = HAND_SPEED * dt;

    const need = (delta: number) => {
      const px = delta / t.sensitivity;
      return Math.max(-budget, Math.min(budget, px));
    };

    // readInput does `armYaw -= dx * sensitivity`, so closing a positive yaw
    // gap needs a negative dx.
    this.dx += -need(this.want.yaw - aim.yaw);
    // and `armPitch += dy * sensitivity * -1` when invertY is off.
    this.dy += -need(this.want.pitch - aim.pitch) * (t.invertY ? -1 : 1);
    this.rollDx += Math.max(-budget, Math.min(budget,
      (this.want.roll - aim.roll) / t.rollSensitivity));
  }

  // --- ArmInput ---
  consumeMouse(): { dx: number; dy: number; wheel: number; rollDx: number } {
    const out = { dx: this.dx, dy: this.dy, wheel: 0, rollDx: this.rollDx };
    this.dx = 0;
    this.dy = 0;
    this.rollDx = 0;
    return out;
  }

  reset(): void {
    this.state = "close";
    this.timer = 0;
    this.dx = 0;
    this.dy = 0;
    this.rollDx = 0;
    this.idle();
  }
}
