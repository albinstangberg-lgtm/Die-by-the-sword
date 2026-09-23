import * as THREE from "three";
import type { PhysicsWorld, Side } from "../core/physics";
import { Arm, type ArmInput } from "./arm";
import { Fighter } from "./fighter";
import { cutDamage, JOINT_INTEGRITY } from "./damage";
import { jointScaleFor, maxHealthFor, SWORDSMAN, type Species } from "./species";
import type { Impact } from "./impacts";
import type { Wound, WoundEnd } from "./blood";
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

/** Which non-weapon-arm joints can be cut, and which integrity each costs. */
const SEVERABLE: Record<string, keyof typeof JOINT_INTEGRITY> = {
  head: "neck",
  offShoulder: "shoulder",
  offElbow: "elbow",
};

/** Cutting either of these disarms the fighter — the sword goes with the hand. */
type ArmJoint = "shoulder" | "elbow";

export interface CombatantState {
  health: number;
  maxHealth: number;
  disarmed: boolean;
  dead: boolean;
  shoulder: number;
  elbow: number;
}

const _eye = new THREE.Vector3();

export class Combatant {
  readonly fighter: Fighter;
  readonly arm: Arm;
  readonly maxHealth: number;
  /** How much more punishment this body's joints take than a human's. */
  private readonly jointScale: number;

  health: number;
  dead = false;

  /** Integrity of the two joints holding the weapon arm on. */
  private joints: Record<ArmJoint, number>;

  onHurt?: (amount: number, part: string) => void;
  /** Both carry the cut, so whatever draws blood knows where it happened. */
  onDisarm?: (where: ArmJoint, wound: Wound) => void;
  onLoseLimb?: (part: string, wound: Wound) => void;
  onDeath?: () => void;

  /**
   * Collider -> what a hit on it does.
   *
   * `shoulder` and `elbow` are the sword arm, and cutting them disarms. The
   * rest of the body — head, off arm, pelvis, legs — takes damage and can be
   * cut apart where it has a joint to cut, but losing it does not stop you
   * fighting.
   */
  private handles = new Map<number, { joint: ArmJoint | null; part: string }>();

  constructor(
    phys: PhysicsWorld,
    scene: THREE.Scene,
    private spawn: THREE.Vector3,
    side: Side,
    tuning: Tuning,
    targets: Targets,
    /** What this fighter is. Defaults to a human with a sword: the reference. */
    readonly species: Species = SWORDSMAN,
    /** How the fight panel names it -- "you" for the player. */
    readonly name: string = species.name,
    /** How an impact readout refers to its parts: "your", "the orc's". */
    possessive: string = species.possessive,
  ) {
    this.fighter = new Fighter(phys, scene, spawn, side, species.palette, species.build);
    this.arm = new Arm(phys, scene, this.fighter, tuning, species.weapon, side);
    this.arm.power = species.power;

    // Health and joints both scale with the body, but at different rates --
    // health with mass, joints with cross-section. That gap is why cutting a
    // big thing's arm off beats trying to out-damage it.
    this.maxHealth = maxHealthFor(species.build);
    this.health = this.maxHealth;
    this.jointScale = jointScaleFor(species.build);
    this.joints = {
      shoulder: JOINT_INTEGRITY.shoulder * this.jointScale,
      elbow: JOINT_INTEGRITY.elbow * this.jointScale,
    };

    // A hit on the upper arm works the shoulder, a hit on the forearm works the
    // elbow — the same proximal-joint rule the dummy uses, so what the player
    // learns cutting practice transfers directly to cutting a person.
    this.register(targets, this.arm.upper.collider(0)!.handle, "shoulder", `${possessive} weapon arm`);
    this.register(targets, this.arm.fore.collider(0)!.handle, "elbow", `${possessive} forearm`);

    // And every part of the body proper. Without this the head, off arm and
    // legs were scenery: a blade went through them and nothing happened.
    for (const part of this.fighter.parts) {
      this.handles.set(part.collider.handle, { joint: null, part: part.name });
      targets.register(part.collider.handle, `${possessive} ${part.label}`);
    }
  }

  private register(targets: Targets, handle: number, joint: ArmJoint, label: string): void {
    this.handles.set(handle, { joint, part: joint });
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
    this.arm.readInput(input, tuning, dt);
    // The body first, from the arm's intent, so the shoulder is where this
    // step's posture has it before the arm solves its ghost from it.
    this.fighter.update(keys, tuning, dt, this.arm.postureDrive());
    this.arm.drive(tuning);
  }

  /** Route an impact. Returns true if it landed on this fighter. */
  receive(impact: Impact): boolean {
    const target = this.handles.get(impact.colliderHandle);
    if (target === undefined) return false;
    if (this.dead) return true;

    const amount = cutDamage(impact);
    if (amount <= 0) return true;              // a slap or a shove

    this.health = Math.max(0, this.health - amount);
    this.onHurt?.(amount, target.part);

    if (target.joint !== null && !this.arm.disarmed) {
      this.joints[target.joint] -= amount;
      if (this.joints[target.joint] <= 0) {
        const ends = this.arm.sever(target.joint);
        this.onDisarm?.(target.joint, woundFrom(impact, ends));
      }
    } else if (target.joint === null) {
      // Heads and off arms come off the same way the dummy's do.
      this.severBodyPart(target.part, amount, impact);
    }

    if (this.health <= 0) this.collapse();
    return true;
  }

  /** Body parts other than the sword arm, cut free once they have taken enough. */
  private bodyDamage = new Map<string, number>();

  private severBodyPart(name: string, amount: number, impact: Impact): void {
    const joint = SEVERABLE[name];
    if (joint === undefined) return;
    const cost = JOINT_INTEGRITY[joint] * this.jointScale;
    const done = (this.bodyDamage.get(name) ?? 0) + amount;
    this.bodyDamage.set(name, done);
    if (done < cost) return;

    const ends = this.fighter.sever(name);
    if (!ends) return;
    this.onLoseLimb?.(name, woundFrom(impact, ends));
    // Losing your head is losing the fight.
    if (name === "head") { this.health = 0; this.collapse(); }
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
    const full = JOINT_INTEGRITY.shoulder * this.jointScale;
    const fullElbow = JOINT_INTEGRITY.elbow * this.jointScale;
    return {
      health: this.health,
      maxHealth: this.maxHealth,
      disarmed: this.arm.disarmed,
      dead: this.dead,
      shoulder: Math.max(0, this.joints.shoulder / full),
      elbow: Math.max(0, this.joints.elbow / fullElbow),
    };
  }

  position(out: THREE.Vector3): THREE.Vector3 {
    return this.fighter.position(out);
  }

  /**
   * Can this one see that one?
   *
   * Eye to eye, against the architecture and nothing else. It is how an
   * opponent decides whether you are its problem yet, and it is the same
   * question for both of them -- nobody here gets to know where you are
   * through a wall.
   */
  sees(other: Combatant): boolean {
    return this.fighter.sees(other.fighter.eyeWorld(_eye));
  }

  reset(tuning: Tuning, at = this.spawn): void {
    this.health = this.maxHealth;
    this.dead = false;
    this.joints.shoulder = JOINT_INTEGRITY.shoulder * this.jointScale;
    this.joints.elbow = JOINT_INTEGRITY.elbow * this.jointScale;
    this.bodyDamage.clear();
    this.fighter.body.setEnabledRotations(false, true, false, true);
    this.fighter.body.setAngularDamping(6);
    this.fighter.reset(at);
    this.arm.reset(tuning);
  }

  /**
   * Per frame. `alpha` is how far through the current physics step the frame
   * falls, which is what the posed legs need to ease between their last two
   * poses; every rigid body is placed by the Interpolator instead.
   */
  syncMeshes(tuning: Tuning, alpha: number): void {
    this.fighter.applyPose(alpha);
    this.arm.syncMeshes(tuning);
  }
}

/** A cut, as the blood system wants it. */
function woundFrom(impact: Impact, ends: WoundEnd[]): Wound {
  return {
    at: impact.at.clone(),
    along: impact.bladeVelocity.clone(),
    ends,
  };
}
