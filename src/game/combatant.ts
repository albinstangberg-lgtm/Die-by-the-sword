import * as THREE from "three";
import type { PhysicsWorld, Side } from "../core/physics";
import { Arm, type ArmInput } from "./arm";
import { Fighter, type Palette } from "./fighter";
import { cutDamage, JOINT_INTEGRITY } from "./damage";
import type { Impact } from "./impacts";
import type { Targets } from "./targets";
import type { Tuning } from "../tuning";
import type { Keys } from "../input/input";

/**
 * A fighter, their sword arm, and what happens when someone cuts them.
 *
 * Player and opponent are the same class. The only difference between them is
 * who supplies the input, which is what keeps the fight honest: the AI is bound
 * by the same arm physics, the same reach, the same force clamp and the same
 * damage rules, and has no move the player cannot make.
 */

const MAX_HEALTH = 100;

/** Cutting either of these disarms the fighter — the sword is welded to the hand. */
type ArmJoint = "shoulder" | "elbow";

export interface CombatantState {
  health: number;
  maxHealth: number;
  disarmed: boolean;
  dead: boolean;
  shoulder: number;
  elbow: number;
}

export class Combatant {
  readonly fighter: Fighter;
  readonly arm: Arm;

  health = MAX_HEALTH;
  dead = false;

  /** Integrity of the two joints holding the sword arm on. */
  private joints: Record<ArmJoint, number> = {
    shoulder: JOINT_INTEGRITY.shoulder,
    elbow: JOINT_INTEGRITY.elbow,
  };

  onHurt?: (amount: number, part: string) => void;
  onDisarm?: (where: ArmJoint) => void;
  onDeath?: () => void;

  private handles = new Map<number, ArmJoint | "torso">();

  constructor(
    readonly name: string,
    /** How the impact readout refers to this fighter's parts: "your", "his". */
    possessive: string,
    phys: PhysicsWorld,
    scene: THREE.Scene,
    private spawn: THREE.Vector3,
    side: Side,
    palette: Palette,
    tuning: Tuning,
    targets: Targets,
  ) {
    this.fighter = new Fighter(phys, scene, spawn, side, palette);
    this.arm = new Arm(phys, scene, this.fighter, tuning, side);

    // A hit on the upper arm works the shoulder, a hit on the forearm works the
    // elbow — the same proximal-joint rule the dummy uses, so what the player
    // learns cutting practice transfers directly to cutting a person.
    this.register(targets, this.fighter.collider.handle, "torso", `${possessive} body`);
    this.register(targets, this.arm.upper.collider(0)!.handle, "shoulder", `${possessive} sword arm`);
    this.register(targets, this.arm.fore.collider(0)!.handle, "elbow", `${possessive} forearm`);
  }

  private register(targets: Targets, handle: number, part: ArmJoint | "torso", label: string): void {
    this.handles.set(handle, part);
    targets.register(handle, label);
  }

  /**
   * Read input and drive body and arm for one fixed step.
   *
   * A dead fighter is driven by nothing. `Fighter.update` pins the torso's
   * rotation upright and overwrites its horizontal velocity every step, so
   * calling it on a corpse held the body standing to attention with zero
   * health — the collapse has to be a matter of stopping, not of a new force.
   */
  act(input: ArmInput, keys: Keys, tuning: Tuning, dt: number): void {
    if (this.dead) {
      this.arm.drive(tuning);          // limp: snapshots motion, applies nothing
      return;
    }
    this.arm.readInput(input, tuning);
    this.fighter.update(keys, tuning, dt);
    this.arm.drive(tuning);
  }

  /** Route an impact. Returns true if it landed on this fighter. */
  receive(impact: Impact): boolean {
    const part = this.handles.get(impact.colliderHandle);
    if (part === undefined) return false;
    if (this.dead) return true;

    const amount = cutDamage(impact);
    if (amount <= 0) return true;              // a slap or a shove

    this.health = Math.max(0, this.health - amount);
    this.onHurt?.(amount, part);

    if (part !== "torso" && !this.arm.disarmed) {
      this.joints[part] -= amount;
      if (this.joints[part] <= 0) {
        this.arm.sever(part);
        this.onDisarm?.(part);
      }
    }

    if (this.health <= 0) this.collapse();
    return true;
  }

  /**
   * Drop. The torso's rotation locks come off and nothing drives it any more,
   * so it falls the way its momentum was already taking it.
   */
  private collapse(): void {
    if (this.dead) return;
    this.dead = true;
    this.arm.limp = true;
    this.fighter.body.setEnabledRotations(true, true, true, true);
    this.fighter.body.setAngularDamping(0.4);
    this.onDeath?.();
  }

  get state(): CombatantState {
    return {
      health: this.health,
      maxHealth: MAX_HEALTH,
      disarmed: this.arm.disarmed,
      dead: this.dead,
      shoulder: Math.max(0, this.joints.shoulder / JOINT_INTEGRITY.shoulder),
      elbow: Math.max(0, this.joints.elbow / JOINT_INTEGRITY.elbow),
    };
  }

  position(out: THREE.Vector3): THREE.Vector3 {
    return this.fighter.position(out);
  }

  reset(tuning: Tuning, at = this.spawn): void {
    this.health = MAX_HEALTH;
    this.dead = false;
    this.joints.shoulder = JOINT_INTEGRITY.shoulder;
    this.joints.elbow = JOINT_INTEGRITY.elbow;
    this.fighter.body.setEnabledRotations(false, true, false, true);
    this.fighter.body.setAngularDamping(6);
    this.fighter.reset(at);
    this.arm.reset(tuning);
  }

  syncMeshes(tuning: Tuning): void {
    this.fighter.syncMesh();
    this.arm.syncMeshes(tuning);
  }
}
