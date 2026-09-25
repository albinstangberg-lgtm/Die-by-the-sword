import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
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
import { POTION_HEAL, POTION_TIME, type Item, type Outcome } from "./items";
import { Inventory } from "./inventory";

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

/** The parts of a body that are its legs: what a cut to lames it. */
const LEGS = /(thigh|shin)$/;

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
const _up = new THREE.Vector3();

/**
 * Where a sword hand goes while its body climbs, from the shoulder, metres at
 * human scale: out to its side, up, and a little back, the blade upright and
 * clear of whatever is being climbed.
 */
const CLEAR_OUT = 0.22;
const CLEAR_UP = 0.3;
const CLEAR_BACK = 0.08;

/** The other hand, not being steered. */
const NO_OFF = { dx: 0, dy: 0, wheel: 0, active: false } as const;

/**
 * Where the other hand holds a lost arm's wound, metres at human scale: in
 * front of it, and a little toward the middle -- a palm over the socket or
 * round the stump, not inside it.
 */
const CLUTCH_FRONT = 0.09;
const CLUTCH_IN = 0.03;
/** How far down the stump of an arm cut at the elbow the hand holds it. */
const STUMP_HOLD = 0.65;
/** The furthest from its own shoulder the other hand is sent, in arm's lengths. */
const CLUTCH_REACH = 0.85;
const _wound = new THREE.Vector3();
const _offShoulder = new THREE.Vector3();

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
  /** Its bag: potions, and whatever of other people it has put in there. */
  readonly inventory = new Inventory();
  /**
   * What the sword hand is holding, with the sword away: a piece of somebody,
   * or their weapon, picked up and not yet put in the bag. See `Items.hold`.
   */
  held: Item | null = null;
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
    this.arm.heave = (species.heave ?? 0) * this.fighter.body.mass();
    // Thrown off its feet, the sword arm goes with the body it hangs from.
    this.fighter.onThrown = (dv) => {
      if (this.arm.severedAt === "shoulder") return;
      const bodies = this.arm.severedAt === "elbow"
        ? [this.arm.upper] : [this.arm.upper, this.arm.fore, this.arm.blade];
      for (const b of bodies) {
        const v = b.linvel();
        b.setLinvel({ x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, true);
      }
    };
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
    // Limp, the hips are a body of their own with a collider of their own:
    // it is hit as the hips it stands in for.
    this.fighter.onStandIn = (handle, part) => {
      if (part === null) {
        this.handles.delete(handle);
        targets.forget(handle);
        return;
      }
      const label = this.fighter.parts.find((p) => p.name === part)?.label ?? part;
      this.handles.set(handle, { joint: null, part });
      targets.register(handle, `${possessive} ${label}`);
    };
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
      this.fighter.lie();
      this.arm.drive(tuning);          // limp: snapshots motion, applies nothing
      this.offArm.limp = true;
      this.offArm.drive(tuning, dt);
      this.nameShield();
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
      this.nameShield();
      return;
    }
    this.arm.readInput(input, tuning, dt);
    this.offArm.steer(off, tuning);
    // The body first, from the arm's intent, so the shoulder is where this
    // step's posture has it before the arm solves its ghost from it.
    this.fighter.hurt = this.arm.disarmed ? 1 : 0;
    this.fighter.update(keys, tuning, dt, this.arm.postureDrive());
    this.holdOn();
    this.tendWound(off.active);
    this.arm.drive(tuning);
    this.offArm.drive(tuning, dt);
    this.nameShield();
  }

  /**
   * Going over or up something, the hands take hold of it: the other hand
   * always, and the sword hand if the sword is away. A hand with a sword in
   * it cannot -- the blade would go into the stone -- so it holds the sword
   * up and out of the way instead: held at its guard, a body driven up a
   * face at a climb's speed swung the blade into the edge, and one sinking
   * over a wall as it vaults (see traverse.ts) put it into the top.
   */
  private holdOn(): void {
    const hold = this.fighter.handhold;
    if (hold) {
      // A shield on its way to the back or off it goes where it was going.
      this.offArm.stopSling();
      this.offArm.guide(hold.left, hold.weight);
      if (this.arm.sheathed && !this.arm.stowing) this.arm.guide(hold.right, hold.weight);
      else if (this.arm.wielding) {
        const f = this.fighter;
        const s = f.build.scale;
        f.shoulderWorld(_up);
        _up.x += Math.cos(f.yaw) * CLEAR_OUT * s + Math.sin(f.yaw) * CLEAR_BACK * s;
        _up.y += CLEAR_UP * s;
        _up.z += -Math.sin(f.yaw) * CLEAR_OUT * s + Math.cos(f.yaw) * CLEAR_BACK * s;
        this.arm.guide(_up, hold.weight);
      }
      this.holding = true;
    } else if (this.holding) {
      this.offArm.guide(null);
      this.arm.guide(null);
      this.holding = false;
    }
  }

  /** The hands were on a hold last step. */
  private holding = false;

  /**
   * A sword arm cut off: the other hand goes to the wound and holds it, while
   * the body curls round it (see `Fighter.hurt`). Not while that hand is on a
   * ledge, has a shield on its arm or is busy with one, or is being steered
   * by a player -- and only while it has a hand, and an arm to bring it.
   */
  private tendWound(steered: boolean): void {
    const cut = this.arm.severedAt;
    const l = this.fighter.offLimb;
    const free = cut !== null && !this.holding && !steered && !this.offArm.hasShield
      && !this.offArm.slinging && l.shoulderOn && l.elbowOn;
    if (free) {
      const f = this.fighter;
      // The socket, or most of the way down the stump of the upper arm -- or
      // as far down it as the other arm reaches across the body. A goblin's
      // arms are short for its shoulders, and a hand sent further hung in the
      // air in front of it, held out at arm's length.
      const reach = CLUTCH_REACH * f.build.armLength;
      f.offShoulderWorld(_offShoulder);
      let down = cut === "elbow" ? STUMP_HOLD * f.build.segment.upperArm.length : 0;
      let at = this.clutchAt(down, _wound);
      for (let k = 0; k < 4 && down > 0 && at.distanceTo(_offShoulder) > reach; k++) {
        down = k < 3 ? down * 0.6 : 0;
        at = this.clutchAt(down, _wound);
      }
      this.offArm.guide(at, 1, true);
      this.clutching = true;
    } else if (this.clutching) {
      this.offArm.guide(null);
      this.clutching = false;
    }
  }

  /** The other hand was on a wound last step. */
  private clutching = false;

  /** Where the palm goes for a wound `down` metres down the sword side: in front of it, toward the middle. */
  private clutchAt(down: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.fighter;
    const s = f.build.scale;
    f.woundWorld(down, out);
    const a = f.yaw + f.posture.pose.chestYaw;
    // Forward is -Z, and the middle of the body is -X of the sword side.
    out.x += -Math.sin(a) * CLUTCH_FRONT * s - Math.cos(a) * CLUTCH_IN * s;
    out.z += -Math.cos(a) * CLUTCH_FRONT * s + Math.sin(a) * CLUTCH_IN * s;
    return out;
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
    if (LEGS.test(target.part)) {
      this.legWound += amount;
      this.fighter.lame = Math.min(1, this.legWound / (JOINT_INTEGRITY.knee * this.jointScale));
    }

    // A club breaks what it lands on and takes nothing off: it hurts, it
    // lames a leg, it kills, but there is no edge to part a joint with.
    if (impact.weapon.bite === "blunt") {
      if (this.health <= 0) this.collapse();
      return true;
    }

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

  /** Potions carried: the inventory's. */
  get potions(): number {
    return this.inventory.potions;
  }
  set potions(n: number) {
    this.inventory.potions = n;
  }

  /**
   * A hand with nothing in it: the sword hand with the sword away and nothing
   * picked up in it, or the other hand with no shield on its arm -- on the
   * back will do -- and not busy putting one there. Drinking takes one.
   */
  get freeHand(): boolean {
    const sword = this.arm.severedAt === null && this.arm.sheathed && !this.arm.stowing
      && this.held === null;
    const l = this.fighter.offLimb;
    const other = l.shoulderOn && l.elbowOn && !this.offArm.hasShield && !this.offArm.slinging;
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
    // A cut leg mends with the rest of it.
    if (this.legWound > 0) {
      this.legWound = Math.max(0, this.legWound - step);
      this.fighter.lame = Math.min(1, this.legWound / (JOINT_INTEGRITY.knee * this.jointScale));
    }
  }

  // --- the shield ------------------------------------------------------------

  /** A shield on the off arm. */
  get hasShield(): boolean {
    return this.offArm.hasShield;
  }

  /** A shield slung on the back. */
  get shieldOnBack(): boolean {
    return this.offArm.slung;
  }

  /** A shield at all: on the arm, on the back, or on its way between them. */
  get carriesShield(): boolean {
    return this.offArm.hasShield || this.offArm.slung;
  }

  /**
   * Strap a shield to the off forearm. False if there is no forearm to strap
   * it to, or a shield is already there or on the back.
   */
  equipShield(): boolean {
    if (this.dead || this.carriesShield || !this.offArm.equipShield(this.tuning)) return false;
    this.nameShield();
    return true;
  }

  /** Take it off again, wherever it is. */
  unequipShield(): void {
    this.offArm.dropShield();
    this.nameShield();
  }

  /**
   * Z: the shield onto the back, or off it onto the arm -- by the other hand,
   * over its own shoulder (see `OffArm.slingShield`). On the back it guards
   * what is behind you, and the hand is free.
   */
  sling(): Outcome {
    if (this.dead || this.fighter.down) return { ok: false, text: "" };
    const off = this.offArm;
    if (off.slinging) return { ok: false, text: "" };
    if (!this.carriesShield) return { ok: false, text: "no shield" };
    const l = this.fighter.offLimb;
    if (!l.shoulderOn || !l.elbowOn) {
      return { ok: false, text: off.slung ? "no arm to take it down with" : "" };
    }
    // Both hands are on the stone.
    if (this.fighter.handhold) return { ok: false, text: "" };
    if (off.slung) {
      return off.unslingShield()
        ? { ok: true, text: "shield off your back" } : { ok: false, text: "" };
    }
    return off.slingShield()
      ? { ok: true, text: "shield onto your back" } : { ok: false, text: "" };
  }

  /**
   * The shield's colliders, on the arm and on the back, as the impact readout
   * names them, as they come and go.
   */
  private nameShield(): void {
    const now = [this.offArm.shieldCollider, this.offArm.slungCollider];
    for (let i = 0; i < now.length; i++) {
      const handle = now[i]?.handle ?? null;
      const was = this.shieldHandles[i];
      if (handle === was) continue;
      if (was !== null) this.targets.forget(was);
      if (handle !== null) this.targets.register(handle, `${this.possessive} shield`);
      this.shieldHandles[i] = handle;
    }
  }

  private readonly shieldHandles: (number | null)[] = [null, null];

  /**
   * A blade has met this fighter's shield -- on the arm, or on the back.
   * True if it did.
   *
   * The solver has already stopped it -- a shield meets blades the way another
   * blade does -- so there is no cut to weigh. But a blow that fails to cut
   * still arrives with all its weight, whatever it failed on: an axe caught on
   * a shield still staggers you, it just leaves you whole.
   */
  block(impact: Impact): boolean {
    const hit = (c: { handle: number } | null) => c !== null && c.handle === impact.colliderHandle;
    const back = this.offArm.slungCollider;
    const onBack = back !== null && hit(back) && !fromInside(impact, back);
    if (!hit(this.offArm.shieldCollider) && !onBack) return false;
    if (!this.dead) this.lastBlow = this.fighter.takeBlow(impact, this.mass, this.tuning);
    return true;
  }

  /** Body parts other than the sword arm, cut free once they have taken enough. */
  private bodyDamage = new Map<string, number>();
  /**
   * What has landed on its legs, health. A knee's worth of it -- what it would
   * take to cut through one, if a leg could be cut off -- and it is as lame as
   * it gets. See `Fighter.lame`.
   */
  private legWound = 0;

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
   * The hull with its chest and hips, the head and off arm while they are on
   * -- with a shield, if one is strapped there -- the sword arm and weapon for
   * as much of them as is left, and a shield on the back.
   */
  get mass(): number {
    let m = this.fighter.body.mass() + this.offArm.slungMass;
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
    this.clutching = false;
    this.joints.shoulder = JOINT_INTEGRITY.shoulder * this.jointScale;
    this.joints.elbow = JOINT_INTEGRITY.elbow * this.jointScale;
    this.bodyDamage.clear();
    this.legWound = 0;
    this.lastBlow = null;
    this.inventory.clear();
    this.held = null;
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
   * poses; every rigid body is placed by the Interpolator instead. Only the
   * player's arm ever shows its ghost: see `Arm.syncMeshes`.
   */
  syncMeshes(alpha: number, showGhost = false): void {
    this.fighter.applyPose(alpha);
    this.arm.syncMeshes(showGhost);
  }
}

const _faceOut = new THREE.Vector3();
const _faceQ = new THREE.Quaternion();

/**
 * A blade touching a shield on the back from between it and the back: the
 * point of a cut to the front, reaching round the hips after it and clipping
 * the inside of the rim. The solver stops it there as anywhere, but that is a
 * blade tangled behind a body, not a blow the shield caught -- a slung shield
 * guards what comes at its face. Which side of the boards the contact is on
 * says which it was; the way the blow drove does not, since at the rim the
 * normal runs across the corner.
 */
function fromInside(impact: Impact, shield: RAPIER.Collider): boolean {
  const r = shield.rotation();
  const c = shield.translation();
  _faceOut.set(0, 1, 0).applyQuaternion(_faceQ.set(r.x, r.y, r.z, r.w));
  return (impact.at.x - c.x) * _faceOut.x + (impact.at.y - c.y) * _faceOut.y
    + (impact.at.z - c.z) * _faceOut.z < 0;
}

/** A cut, as the blood system wants it. */
function woundFrom(impact: Impact, ends: WoundEnd[]): Wound {
  return {
    at: impact.at.clone(),
    along: impact.bladeVelocity.clone(),
    ends,
  };
}
