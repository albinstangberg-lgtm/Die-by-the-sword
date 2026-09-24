import * as THREE from "three";
import type { PhysicsWorld, Side } from "../core/physics";
import { Arm, type ArmInput } from "./arm";
import { Fighter } from "./fighter";
import { OffArm, type OffArmInput } from "./offarm";
import { cutDamage, JOINT_INTEGRITY } from "./damage";
import { jointScaleFor, maxHealthFor, SWORDSMAN, type Species } from "./species";
import type { Impact } from "./impacts";
import type { Blow } from "./balance";
import type { Wound, WoundEnd } from "./blood";
import type { Targets } from "./targets";
import type { Tuning } from "../tuning";
import type { Keys } from "../input/input";
import { POTION_HEAL, POTION_TIME, type Outcome } from "./items";

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
  /** On the floor, or getting up off it -- alive. */
  knockedDown: boolean;
  /** On its feet, but its feet are busy keeping it there. */
  reeling: boolean;
  shoulder: number;
  elbow: number;
}

const _eye = new THREE.Vector3();

/** The other hand, not being steered. */
const NO_OFF = { dx: 0, dy: 0, wheel: 0, active: false } as const;

export class Combatant {
  readonly fighter: Fighter;
  readonly arm: Arm;
  /** The other arm: loose at the side, or behind a shield. */
  readonly offArm: OffArm;
  readonly maxHealth: number;
  /** How much more punishment this body's joints take than a human's. */
  private readonly jointScale: number;

  health: number;
  dead = false;
  /** Potions on the belt. */
  potions = 0;
  /** Health still to come back from the one being drunk, and how fast. */
  private healLeft = 0;
  private healRate = 0;
  /**
   * What the last blow to land did to this body, for the HUD. The fighter
   * reuses the object, so read it straight after `receive`.
   */
  lastBlow: Blow | null = null;

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
    /** Kept, and read live: gravity and balance decide what a blow does. */
    private readonly tuning: Tuning,
    private readonly targets: Targets,
    /** What this fighter is. Defaults to a human with a sword: the reference. */
    readonly species: Species = SWORDSMAN,
    /** How the fight panel names it -- "you" for the player. */
    readonly name: string = species.name,
    /** How an impact readout refers to its parts: "your", "the orc's". */
    private readonly possessive: string = species.possessive,
  ) {
    this.fighter = new Fighter(phys, scene, spawn, side, species.palette, species.build);
    this.arm = new Arm(phys, scene, this.fighter, tuning, species.weapon, side);
    this.arm.power = species.power;
    this.offArm = new OffArm(phys, this.fighter, side, tuning);
    this.offArm.power = species.power;

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
  act(input: ArmInput & Partial<OffArmInput>, keys: Keys, tuning: Tuning, dt: number): void {
    // Whatever the other hand was told this step. Only a player steers it;
    // an opponent's hangs at rest, or holds its guard.
    const off = input.consumeOff?.() ?? NO_OFF;
    this.mend(dt);
    if (this.dead) {
      this.arm.drive(tuning);          // limp: snapshots motion, applies nothing
      this.offArm.limp = true;
      this.offArm.drive(tuning, dt);
      return;
    }
    if (this.fighter.down) {
      // Knocked down. Whatever the hand asks for is thrown away rather than
      // saved up for when it is back on its feet, the arm hangs, and the body
      // gets itself up on its own. The arm takes the weapon back up once it is.
      input.consumeMouse();
      this.arm.limp = true;
      this.offArm.limp = true;
      this.fighter.update(keys, tuning, dt, null);
      if (!this.fighter.down) {
        this.arm.regain(tuning);
        this.offArm.regain();
      }
      this.arm.drive(tuning);
      this.offArm.drive(tuning, dt);
      return;
    }
    this.arm.readInput(input, tuning, dt);
    this.offArm.steer(off, tuning);
    // The body first, from the arm's intent, so the shoulder is where this
    // step's posture has it before the arm solves its ghost from it.
    this.fighter.update(keys, tuning, dt, this.arm.postureDrive());
    this.arm.drive(tuning);
    this.offArm.drive(tuning, dt);
  }

  /**
   * Route an impact. Returns true if it landed on this fighter.
   *
   * The push comes first and comes regardless: a blow that fails to cut --
   * too slow, on the flat, on the haft -- still arrives with all its weight.
   * A slap with the flat of a sword will not open a goblin, but it will put
   * one on the floor.
   */
  receive(impact: Impact): boolean {
    const target = this.handles.get(impact.colliderHandle);
    if (target === undefined) return false;

    this.lastBlow = this.fighter.takeBlow(impact, this.mass, this.tuning);
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

  // --- potions -----------------------------------------------------------------

  /**
   * A hand with nothing in it: the sword hand with the sword away, or the
   * other hand with no shield on its arm. Drinking takes one.
   */
  get freeHand(): boolean {
    const sword = this.arm.severedAt === null && this.arm.sheathed;
    const l = this.fighter.offLimb;
    const other = l.shoulderOn && l.elbowOn && !this.offArm.hasShield;
    return sword || other;
  }

  /** Health still to come back from a potion. */
  get healing(): number {
    return this.healLeft;
  }

  /**
   * Drink a potion off the belt. It takes a free hand -- with a shield on
   * the other arm that means putting the sword away -- and it gives its
   * health back over a couple of seconds rather than at once, so drinking
   * in the middle of a fight is a bet on those seconds.
   */
  drink(): Outcome {
    if (this.dead || this.fighter.down) return { ok: false, text: "" };
    if (this.potions <= 0) return { ok: false, text: "no potions" };
    if (!this.freeHand) return { ok: false, text: "no free hand — sheathe your sword first" };
    if (this.health >= this.maxHealth && this.healLeft <= 0) {
      return { ok: false, text: "you are not hurt" };
    }
    this.potions--;
    const amount = POTION_HEAL * this.maxHealth;
    this.healLeft += amount;
    this.healRate = this.healLeft / POTION_TIME;
    return { ok: true, text: `you drink — +${Math.round(amount)}` };
  }

  /** A step of whatever is being drunk. Nothing heals the dead. */
  private mend(dt: number): void {
    if (this.healLeft <= 0) return;
    if (this.dead) {
      this.healLeft = 0;
      return;
    }
    const step = Math.min(this.healLeft, this.healRate * dt);
    this.healLeft -= step;
    this.health = Math.min(this.maxHealth, this.health + step);
  }

  // --- the shield ------------------------------------------------------------

  get hasShield(): boolean {
    return this.offArm.hasShield;
  }

  /**
   * Strap a shield to the off forearm. False if there is no forearm to strap
   * it to, or a shield is already there.
   */
  equipShield(): boolean {
    if (this.dead || !this.offArm.equipShield(this.tuning)) return false;
    const c = this.offArm.shieldCollider;
    if (c) this.targets.register(c.handle, `${this.possessive} shield`);
    return true;
  }

  /** Take it off again. */
  unequipShield(): void {
    const c = this.offArm.shieldCollider;
    if (c) this.targets.forget(c.handle);
    this.offArm.dropShield();
  }

  /**
   * A blade has met this fighter's shield. True if it did.
   *
   * The solver has already stopped it -- a shield meets blades the way another
   * blade does -- so there is no cut to weigh. But a blow that fails to cut
   * still arrives with all its weight, whatever it failed on: an axe caught on
   * a shield still staggers you, it just leaves you whole.
   */
  block(impact: Impact): boolean {
    const shield = this.offArm.shieldCollider;
    if (!shield || impact.colliderHandle !== shield.handle) return false;
    if (!this.dead) this.lastBlow = this.fighter.takeBlow(impact, this.mass, this.tuning);
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
    this.offArm.limp = true;
    this.fighter.collapse();
    this.onDeath?.();
  }

  /**
   * Everything still attached to this body, kg: what a blow has to move.
   * The hull with its chest and hips, the head and off arm while they are on,
   * and the sword arm and weapon for as much of them as is left.
   */
  get mass(): number {
    let m = this.fighter.body.mass();
    for (const part of this.fighter.parts) {
      if (part.body !== undefined && part.severed !== true) m += part.body.mass();
    }
    const arm = this.arm;
    if (arm.severedAt === null) m += arm.upper.mass() + arm.fore.mass() + arm.liveWeaponMass;
    else if (arm.severedAt === "elbow") m += arm.upper.mass();
    return m;
  }

  get state(): CombatantState {
    const full = JOINT_INTEGRITY.shoulder * this.jointScale;
    const fullElbow = JOINT_INTEGRITY.elbow * this.jointScale;
    return {
      health: this.health,
      maxHealth: this.maxHealth,
      disarmed: this.arm.disarmed,
      dead: this.dead,
      knockedDown: !this.dead && this.fighter.down,
      reeling: !this.dead && this.fighter.reeling,
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
    this.lastBlow = null;
    this.potions = 0;
    this.healLeft = 0;
    this.healRate = 0;
    // Puts the rotation locks back on, too: a body that died or was knocked
    // down had them off.
    this.fighter.reset(at);
    this.arm.reset(tuning);
    this.unequipShield();
    this.offArm.reset(tuning);
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
