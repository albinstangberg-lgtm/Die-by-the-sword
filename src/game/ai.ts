import * as THREE from "three";
import type { ArmInput } from "./arm";
import type { Combatant } from "./combatant";
import type { Keys } from "../input/input";
import type { Tuning } from "../tuning";
import type { Attack, Species } from "./species";

/**
 * An opponent that tells you what it is about to do.
 *
 * It does not get to cheat. It drives its weapon arm by emitting MOUSE DELTAS
 * through the same `ArmInput` surface the player's pointer feeds, so its blade
 * is subject to the same force clamp, the same reach limits, the same
 * saturating PD controller. It cannot teleport its weapon, it cannot swing
 * faster than an arm can be moved, and if it buries its axe in a pillar it is
 * stuck there exactly as long as you would be.
 *
 * What it has that stage 4's opponent did not is a REPERTOIRE. Its swings come
 * from a short list of named attacks, each with a windup long enough to read,
 * and while one is winding the weapon lights up and the HUD says which it is
 * and how to beat it. That is the contract: the enemy commits out loud, and
 * the fight is about whether you can do something with the three quarters of a
 * second it just gave you.
 *
 * None of that makes an attack scripted. Once it commits, the arm is still
 * being dragged toward a target pose under a clamped force. It overswings, it
 * catches the low beam, it plants the axe in the floor, and the damage it does
 * comes out of how fast the weapon happened to be travelling when it arrived.
 *
 * The attack table is written in offsets from LEVEL -- the arm pitch at which
 * this creature's own weapon would cross its target's chest -- which is solved
 * from its own kinematics when it winds up. One table therefore describes the
 * same swing for a goblin and for an orc twice its height.
 */

/** How fast the AI is allowed to move its hand, in pixels of mouse per second. */
const HAND_SPEED = 1100;

/** Where on a body an attack is aimed, 0 at the feet and 1 at the crown. */
const AIM_AT = 0.72;

/**
 * How long it may want to walk, and not walk, before it concludes it is stuck.
 *
 * Something always eventually is. A hull's velocity is merely SET each step,
 * while the arm holding a caught weapon drives at hundreds of newtons through
 * a joint chain, and that is no contest: the body gets dragged straight back
 * to wherever the weapon is snagged. The case that found this was an orc
 * hooking its axe over the low beam on the way across the room and then
 * standing there for the rest of the fight, still dutifully pressing forward
 * at zero metres per second. The beam is higher now; pillars, walls and the
 * floor are all still there.
 */
const SNAG_TIME = 0.5;

/**
 * How long it keeps coming after losing sight of you, seconds.
 *
 * Not zero, and the reason is the pillars: stepping behind one mid-fight
 * breaks the line for a few frames, and an opponent that downed tools every
 * time that happened would be trivial to beat and absurd to watch. Long
 * enough to cover a pillar, short enough that leaving the room ends it.
 */
const MEMORY = 2.5;

/**
 * How near you have to be before it takes an interest, metres.
 *
 * Sight alone is not enough, and a doorway is why: a door is a hole you can
 * see a long way through, so a bare line-of-sight test had the orc set off
 * across its hall the moment you lined up with the door eighteen metres away
 * on the far side of another room. Notice is close range; once it HAS noticed
 * you, the line of sight alone keeps it coming, and it will follow you as far
 * as it can see you.
 */
const NOTICE = 9;

type State =
  | "close" | "windup" | "strike" | "recover" | "backoff" | "free" | "beaten"
  | "waiting" | "reeling" | "down";

export class Ai implements ArmInput {
  readonly keys: Keys = {
    forward: false, back: false, left: false, right: false,
    turnLeft: false, turnRight: false, jump: false,
  };

  private state: State = "close";
  private timer = 0;
  private attack: Attack;
  /**
   * Where "level" is for this creature, at the wound-up reach and at the
   * extended one.
   *
   * Two of them, because a thrust needs both. Extending the arm swings the
   * elbow through a large angle, and the weapon held along the forearm swings
   * with it -- so a thrust that only aims its end pose comes in rotating about
   * the hand, which puts the point's whole velocity at right angles to the
   * shaft. Aiming BOTH ends at the target leaves the shaft pointing the same
   * way in each, and the only thing left between them is the hand travelling
   * up its own line. That is a thrust.
   *
   * `yaw` is zero for anything that swings: an edge's table is written against
   * torso-forward and was tuned that way.
   */
  private levelFrom = { yaw: 0, pitch: 0 };
  private levelTo = { yaw: 0, pitch: 0 };
  /** Measured horizontal distance its percussion point covers, metres. */
  private strikeReach = 1;
  private windupLength = 1;

  /**
   * Forces a single attack, so one line's geometry can be measured in
   * isolation. This is how the tables are tuned; leave it null in play.
   */
  attackOverride: Attack | null = null;

  private want = { yaw: 0.3, pitch: -0.15, reach: 0.6, roll: 0 };

  private dx = 0;
  private wheel = 0;
  private dy = 0;
  private rollDx = 0;

  private readonly _self = new THREE.Vector3();
  private readonly _foe = new THREE.Vector3();
  /** Where it is looking: the eyes of whatever it has seen. */
  private readonly _gaze = new THREE.Vector3();
  private readonly _probe = new THREE.Vector3();
  private readonly _mark = new THREE.Vector3();
  private readonly _was = new THREE.Vector3();
  private snag = 0;
  /** Seconds of "I know where you are" left. Zero means it holds its post. */
  private seen = 0;

  constructor(readonly species: Species) {
    this.attack = species.attacks[0];
  }

  /** Visible in the HUD, so it is obvious what it is up to. */
  get intent(): string {
    return this.state;
  }

  /** The attack it is currently committed to, or null if it is not. */
  get committed(): Attack | null {
    return this.state === "windup" || this.state === "strike" ? this.attack : null;
  }

  /** 0..1 through the windup. What the weapon's glow is showing. */
  get tell(): number {
    if (this.state === "windup") {
      return 1 - Math.max(0, Math.min(1, this.timer / this.windupLength));
    }
    return this.state === "strike" ? 1 : 0;
  }

  /** Run once per fixed step, before the arm reads its input. */
  think(self: Combatant, foe: Combatant, t: Tuning, dt: number): void {
    if (self.dead) {
      this.state = "beaten";
      this.idle();
      this.showTell(self);
      self.fighter.focus = null;
      return;
    }

    // On the floor. There is nothing to decide: the body gets itself up, and
    // whatever it was winding up when it went over is gone.
    if (self.fighter.down) {
      if (this.state !== "down") this.begin("down", 0);
      this.idle();
      this.showTell(self);
      self.fighter.focus = null;
      self.position(this._was);
      this.snag = 0;
      return;
    }
    if (this.state === "down") this.begin("close", 0);

    self.position(this._self);
    foe.position(this._foe);
    const toFoe = this._foe.clone().sub(this._self);
    const range = Math.hypot(toFoe.x, toFoe.z);

    // An animal that cannot see you does not come for you.
    //
    // The rooms are walled off from each other, and without this the orc
    // would spend the fight walking into the far side of a wall because it
    // knew, through the stone, exactly where you were standing. One ray, the
    // same one either of them could cast, and it is also what makes a doorway
    // worth something: step into the light and the thing in the next room
    // starts moving.
    const sighted = self.sees(foe);
    if (sighted && (this.seen > 0 || range < NOTICE)) this.seen = MEMORY;
    else this.seen = Math.max(0, this.seen - dt);

    // Once it has seen you it watches you -- not its own blade, which is what
    // the player's fighter watches. A head turned toward you is the first
    // thing that says it has noticed, from further off than any weapon tell.
    self.fighter.focus = this.seen > 0 ? foe.fighter.eyeWorld(this._gaze) : null;

    if (this.seen <= 0) {
      // Holding its post. It does not track you, it does not turn, and it
      // keeps its weapon where a waiting animal keeps it.
      if (this.state !== "waiting") this.begin("waiting", 0);
      this.idle();
      this.want = { yaw: 0.3, pitch: -0.12, reach: 0.55, roll: 0 };
      this.steerArm(self, t, dt);
      this.showTell(self);
      this._was.copy(this._self);
      return;
    }
    if (this.state === "waiting") this.begin("close", 0);

    this.face(self, toFoe);
    this.timer -= dt;

    // Disarmed: no weapon, no plan. It backs away rather than pretending.
    if (self.arm.disarmed) {
      this.state = "beaten";
      this.keys.forward = false;
      this.keys.back = range < 3.0;
      this.keys.jump = false;
      this.steerArm(self, t, dt);
      this.showTell(self);
      return;
    }

    // Rocked back on its heels. Its feet are busy keeping it up, and whatever
    // it was doing -- a windup, a strike half thrown -- it is not doing now.
    // This is the only way to take an attack off something once it has
    // started, and it only works on something light enough to rock: nothing
    // you can swing moves the orc that far, which is what "committed to
    // everything it starts" means.
    if (self.fighter.reeling && this.state !== "reeling") {
      this.begin("reeling", self.fighter.reelLeft);
    }

    this.measure(self, foe, t);
    const close = this.strikeReach * this.species.range.close;
    const strike = this.strikeReach * this.species.range.strike;
    const far = this.strikeReach * this.species.range.far;

    this.checkSnag(t, dt);

    switch (this.state) {
      case "close":
        this.guard();
        this.keys.forward = range > strike;
        this.keys.back = range < close;
        if (range <= far && range >= close) this.commit(range);
        break;

      case "windup":
        // The tell. It stands still and shows you the weapon, and the longer
        // the attack the longer it stands there.
        this.want = {
          yaw: this.levelFrom.yaw + this.attack.from.yaw,
          pitch: this.levelFrom.pitch + this.attack.from.pitch,
          reach: this.attack.from.reach,
          roll: this.attack.roll,
        };
        this.keys.forward = false;
        this.keys.back = false;
        // The windup runs its DECLARED length, every time.
        //
        // It used to commit early the moment the arm reached the wound-up
        // pose, which on a fast arm cut the orc's three-quarter-second cleave
        // in half. That is not a telegraph, it is a threat that sometimes
        // lies; a player cannot learn a tell whose length depends on how
        // cleanly the last swing finished. The timer alone also covers the
        // case this was guarding against -- a weapon caught on scenery no
        // longer holds the windup open forever, because the clock does not
        // care whether the arm got there.
        if (this.timer <= 0) this.begin("strike", this.attack.strike);
        break;

      case "strike":
        // Aim THROUGH the target, not at it. Sweeping to a point short of the
        // foe decelerates into the hit and lands a shove; the whole damage
        // model is built on speed at contact.
        this.want = {
          yaw: this.levelTo.yaw + this.attack.to.yaw,
          pitch: this.levelTo.pitch + this.attack.to.pitch,
          reach: this.attack.to.reach,
          roll: this.attack.roll,
        };
        // Stepping in closes to where the weapon works, not to contact. An
        // attack that walks all the way in ends up swinging its arc past the
        // target and connecting with whatever is left -- which for an axe
        // meant landing every single blow on a shin.
        this.keys.forward = this.attack.step > 0 && range > strike;
        this.keys.back = this.attack.step < 0;
        if (this.timer <= 0) this.begin("recover", this.attack.recover);
        break;

      case "recover":
        // Open. This is the window the windup bought you.
        this.guard();
        this.keys.forward = false;
        this.keys.back = range < close;
        if (this.timer <= 0) {
          // After a swing it mostly presses, and occasionally resets so it is
          // not a metronome. Backing off after three swings in four made it
          // spend more of the fight retreating than fighting.
          const press = Math.random() < 0.75 * this.species.aggression;
          this.begin(press ? "close" : "backoff", 0.35);
        }
        break;

      case "backoff":
        this.guard(0.25);
        this.keys.forward = false;
        this.keys.back = range < far;
        if (this.timer <= 0) this.begin("close", 0);
        break;

      case "reeling":
        // Guard up, feet under it. It carries on only once they are.
        this.guard();
        this.keys.forward = false;
        this.keys.back = false;
        if (this.timer <= 0 && !self.fighter.reeling) this.begin("close", 0);
        break;

      case "free":
        // Caught on something. Pull the hand in and low and give ground --
        // which is exactly what a player does with a blade planted in a wall,
        // and works for the same reason: a folded arm has leverage a straight
        // one does not.
        this.want = {
          yaw: this.levelTo.yaw + 0.2, pitch: this.levelTo.pitch - 0.9, reach: 0, roll: 0,
        };
        this.keys.forward = false;
        this.keys.back = true;
        if (this.timer <= 0) this.begin("close", 0);
        break;

      case "beaten":
      case "waiting":
      case "down":
        this.idle();
        break;
    }

    this.steerArm(self, t, dt);
    this.showTell(self);
  }

  /**
   * Notice when the feet are turning and the body is not going anywhere.
   *
   * Measured rather than inferred: it compares where it wanted to be with
   * where it got, which needs nothing the creature does not already have. A
   * weapon planted in stone is a real state the player gets into too, and the
   * way out of it is the same for both of them.
   */
  private checkSnag(t: Tuning, dt: number): void {
    const moved = this._self.distanceTo(this._was);
    this._was.copy(this._self);
    if (this.state === "free" || this.state === "beaten"
      || this.state === "waiting" || this.state === "reeling") { this.snag = 0; return; }

    const trying = this.keys.forward || this.keys.back;
    const expected = t.moveSpeed * this.species.build.scale * dt;
    if (trying && moved < expected * 0.3) this.snag += dt;
    else this.snag = 0;

    if (this.snag > SNAG_TIME) {
      this.snag = 0;
      this.begin("free", 0.6);
    }
  }

  /**
   * Pick the next attack and start winding it.
   *
   * The level pitch is solved once, here, and held for the whole swing. Chasing
   * a moving target through the strike would make every attack home, which is
   * precisely what a telegraph is supposed to rule out: you should be able to
   * step out of the line it committed to.
   */
  private commit(range: number): void {
    const usable = this.species.attacks.filter((a) => {
      if (!a.at) return true;
      const f = range / this.strikeReach;
      return f >= (a.at.min ?? 0) && f <= (a.at.max ?? Infinity);
    });
    const list = usable.length > 0 ? usable : this.species.attacks;
    this.attack = this.attackOverride ?? list[(Math.random() * list.length) | 0];
    this.windupLength = this.attack.windup;
    this.begin("windup", this.attack.windup);
  }

  /**
   * Re-measure what this body can reach and where level is.
   *
   * Both come from the arm's own kinematics, so a goblin measures a goblin's
   * spear and an orc measures an orc's axe, and neither needs to be told a
   * number in metres.
   */
  private measure(self: Combatant, foe: Combatant, t: Tuning): void {
    const chest = this._foe.y
      - foe.fighter.build.hullCentreY
      + foe.fighter.build.standing.crown * AIM_AT;

    if (this.state !== "strike") {
      // An edge wants its arc to cross the chest; a point wants to be aimed at
      // it, which takes both angles rather than just the pitch. Same table of
      // offsets either way -- only what "level" means changes, and it changes
      // with what is in the hand.
      const roll = this.attack.roll;
      if (self.arm.weapon.bite === "point") {
        this._mark.set(this._foe.x, chest, this._foe.z);
        self.arm.aimPointAt(this._mark, this.attack.from.reach, roll, t, this.levelFrom);
        self.arm.aimPointAt(this._mark, this.attack.to.reach, roll, t, this.levelTo);
      } else {
        this.levelFrom.yaw = 0;
        this.levelTo.yaw = 0;
        this.levelFrom.pitch = self.arm.solvePitchForHeight(chest, 0, 1, roll, t);
        this.levelTo.pitch = this.levelFrom.pitch;
      }
    }
    self.arm.probeStrike(
      this.levelTo.yaw, this.levelTo.pitch, 1, this.attack.roll, t, this._probe);
    this.strikeReach = Math.max(
      0.2, Math.hypot(this._probe.x - this._self.x, this._probe.z - this._self.z));
  }

  /** The resting guard: weapon up, a little across, level with the chest. */
  private guard(lift = 0.15): void {
    this.want = {
      yaw: this.levelTo.yaw + 0.3,
      pitch: this.levelTo.pitch + lift,
      reach: 0.55,
      roll: 0,
    };
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
    this.keys.jump = false;
  }

  /** Light the weapon in proportion to how far through the windup it is. */
  private showTell(self: Combatant): void {
    self.arm.setTell(this.tell);
  }

  /** Turn toward the foe using the same turn keys the player has. */
  private face(self: Combatant, toFoe: THREE.Vector3): void {
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

  /**
   * Convert "where I want the arm" into mouse travel, capped at a human hand
   * speed. This is the only channel the AI has to its own weapon.
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

    // Reach is a fraction of its own arm, turned back into wheel notches.
    const wantReach = self.arm.reachAt(this.want.reach);
    this.wheel += Math.max(-4, Math.min(4, (wantReach - aim.reach) / t.reachRate));
  }

  // --- ArmInput ---
  consumeMouse(): { dx: number; dy: number; wheel: number; rollDx: number } {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel, rollDx: this.rollDx };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.rollDx = 0;
    return out;
  }

  reset(): void {
    this.state = "waiting";
    this.timer = 0;
    this.seen = 0;
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.rollDx = 0;
    this.levelFrom = { yaw: 0, pitch: 0 };
    this.levelTo = { yaw: 0, pitch: 0 };
    this.snag = 0;
    this.attack = this.species.attacks[0];
    this.idle();
  }
}
