/**
 * Headless physics harness.
 *
 * Runs the *real* Arm/Fighter/Arena modules against Rapier in Node — no WebGL,
 * no browser. three.js scene-graph objects construct fine without a renderer,
 * so this exercises the actual controller rather than a reimplementation.
 *
 * What it asserts is the claim the whole design rests on: the arm tracks the
 * mouse closely when the blade is free, and *fails to* when the blade is
 * blocked. If the second case ever stops failing, the mechanic is gone.
 *
 *   npm run smoke
 */

import * as THREE from "three";
import { createPhysics, makeSides, type PhysicsWorld } from "../src/core/physics";
import {
  BLOCK, buildArena, CRATE, DUMMY_AT, GATEWAYS, inRoom, ITEM_LAYOUT, LEDGE, LOW_WALL, POSTS, RAIL, ROOMS,
  SPAWN as GAME_SPAWN, STONES, THIN_POST, type Arena, type GatedRoom,
} from "../src/game/arena";
import { gateHeard, ROSTER, spawnOf } from "../src/game/roster";
import { interact, Items, promptFor, type Item } from "../src/game/items";
import { OFF_GUARD } from "../src/game/offarm";
import { SLUNG, SLUNG_TURN } from "../src/game/shield";
import { Pickup } from "../src/game/pickup";
import { Targets } from "../src/game/targets";
import { Dummy, type SeverEvent } from "../src/game/dummy";
import { cutDamage, sweetSpot, MIN_CUT_SPEED } from "../src/game/damage";
import { Combatant } from "../src/game/combatant";
import {
  GOBLIN, KOBOLD, OGRE, ORC, SPECIES, SWORDSMAN, jointScaleFor, maxHealthFor, type Cut, type Species,
} from "../src/game/species";
import {
  AXE, CLUB, HATCHET, SPEAR, SWORD, WEAPONS, weaponMassProperties, type Weapon,
} from "../src/game/weapons";
import { Ai, type Swing } from "../src/game/ai";
import { emptyBlow, judgeBlow, judgeClash } from "../src/game/balance";
import { Arm, type ArmInput } from "../src/game/arm";
import { Pose } from "../src/game/posture";
import { QUICK_TIME, type Fighter } from "../src/game/fighter";
import { Impacts, type Impact } from "../src/game/impacts";
import { Blood } from "../src/game/blood";
import { DEFAULTS, type Tuning } from "../src/tuning";
import { intrusion, wrap } from "../src/game/clearance";
import { ACTION_MAP, GAP, KEY_MAP, TAP, Taps, type Keys } from "../src/input/input";

const STEP = 1 / 60;

/**
 * A quick step, from the harness's side: how long after one the arm is still
 * catching the body up, seconds, and the furthest from the shoulder one drags
 * the hand, metres -- whoever's arm it is. See `aDoubleTapIsAQuickStep`.
 */
const QUICK_SETTLE = 0.25;
const QUICK_STRETCH = 0.75;

const NO_KEYS: Keys = {
  forward: false, back: false, left: false, right: false,
  turnLeft: false, turnRight: false, jump: false, vault: false, crouch: false, pivot: false,
  dash: false,
};

/**
 * An opponent's intents between swings: on its feet, and committed to nothing
 * -- its weapon put in the way of yours, or shown to you, included.
 */
const FOOTWORK: ReadonlySet<string> = new Set(["close", "circle", "backoff", "evade", "parry", "taunt"]);
/** And every intent in which it is in the fight at all. */
const FIGHTING: ReadonlySet<string> = new Set([...FOOTWORK, "windup", "leap", "strike", "recover"]);

/** A scriptable stand-in for pointer-lock input. */
class FakeInput implements ArmInput {
  dx = 0; dy = 0; wheel = 0; rollDx = 0;
  /** The left button's share: the other arm. */
  offDx = 0; offDy = 0; offWheel = 0; guarding = false;
  consumeMouse() {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel, rollDx: this.rollDx };
    this.dx = 0; this.dy = 0; this.wheel = 0; this.rollDx = 0;
    return out;
  }
  consumeOff() {
    const out = { dx: this.offDx, dy: this.offDy, wheel: this.offWheel, active: this.guarding };
    this.offDx = 0; this.offDy = 0; this.offWheel = 0;
    return out;
  }
}

/**
 * Where you start, here: in the hall's west half, where the training room
 * was, with its pillars round you and its south wall behind -- not at the
 * game's own spawn, down the entrance.
 */
const HOME = new THREE.Vector3(0, 0.95, 10.4);

/**
 * Where an opponent starts: the hall, across the floor from HOME.
 *
 * The rooms are walled off from each other and an opponent that cannot see
 * you does not come for you, so a foe parked behind a gate would simply stand
 * there. Every fight here is the two of them in one room.
 */
const FOE_X = -1.4;
const FOE_Z = 4.4;
const FOE_HOME = new THREE.Vector3(FOE_X, 0.95, FOE_Z);

/** Spawn height for a body of a given build, so nothing starts in the floor. */
function spawnFor(species: Species, x: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, species.build.hullCentreY + 0.11, z);
}

/** The same spot, at the right height for whatever is standing on it. */
function foeSpawn(species: Species): THREE.Vector3 {
  return spawnFor(species, FOE_X, FOE_Z);
}

interface Rig {
  phys: PhysicsWorld;
  /** What of the arena moves: the gates and their levers, stepped as the game steps them. */
  arena: Arena;
  arm: Arm;
  fighter: Fighter;
  input: FakeInput;
  impacts: Impacts;
  dummy: Dummy;
  player: Combatant;
  foe: Combatant;
  ai: Ai;
  tuning: Tuning;
  /** Advance with the AI driving the opponent. */
  fight(n?: number, keys?: Keys): void;
  /**
   * Advance with the opponent standing its ground and doing nothing: a target
   * whose body still reacts to what hits it -- a knock, a fall, getting up --
   * but which never fights back. Without this it is not stepped at all, and a
   * body that is not stepped cannot be knocked anywhere.
   */
  hold(n?: number): void;
  /**
   * From now on the opponent stands its ground through every step, the aiming
   * helpers' included, not only in `hold`. An opponent nobody steps has no
   * feet: its velocity is never reset, and your arm -- which is solid to it --
   * shoves it about the room while you line up a swing.
   */
  holdFoe(): void;
  /**
   * Hold the player at a fixed spot.
   *
   * Driving the sword arm pushes the fighter around — a 420N drive against an
   * 82kg body, resolved inside the step before the next one zeroes its
   * velocity. That is correct behaviour and quite reasonable in play, but it
   * moved the fighter half a metre during an aiming pass and left the target
   * out of reach, which is not what these tests are trying to measure.
   */
  pin(at: THREE.Vector3 | null): void;
  /**
   * Put the player down somewhere else.
   *
   * Through the same reset the game uses, and not by shoving the hull: a hull
   * moved on its own leaves its head, its off arm and its sword arm where
   * they were, and three violated joints a room's length long drag it back
   * over a metre on the first step. Resetting the sweeps matters as much --
   * a blade whose last known position is across the arena cuts everything in
   * between on its next one.
   */
  place(at: THREE.Vector3): void;
  /** Advance the simulation, optionally holding movement keys. */
  step(n?: number, keys?: Keys): void;
}

async function buildRig(
  overrides: Partial<Tuning> = {},
  foeSpecies: Species = SWORDSMAN,
  foeAt: THREE.Vector3 = FOE_HOME,
): Promise<Rig> {
  const tuning: Tuning = { ...DEFAULTS, ...overrides };
  const scene = new THREE.Scene();
  const phys = await createPhysics(tuning.gravity);
  const targets = new Targets();
  const arena = buildArena(phys, scene, targets);

  const [playerSide, foeSide] = makeSides([0, 1]);
  const player = new Combatant(phys, scene, HOME, playerSide, tuning, targets,
    SWORDSMAN, "you", "your");
  const foe = new Combatant(phys, scene, foeAt, foeSide, tuning, targets, foeSpecies);
  const ai = new Ai(foeSpecies);

  const fighter = player.fighter;
  const arm = player.arm;
  const impacts = new Impacts(phys, scene, targets, tuning);
  const dummy = new Dummy(phys, scene, targets, DUMMY_AT);
  const input = new FakeInput();

  impacts.addBlade(arm, (i) => { if (!dummy.receive(i)) foe.receive(i); });
  impacts.addBlade(foe.arm, (i) => { player.receive(i); });

  let now = 0;
  let pinned: THREE.Vector3 | null = null;
  let holding = false;
  const still: ArmInput = { consumeMouse: () => ({ dx: 0, dy: 0, wheel: 0, rollDx: 0 }) };
  const advance = (keys: Keys, foeMode: "idle" | "ai" | "hold") => {
    if (pinned) {
      fighter.body.setTranslation({ x: pinned.x, y: pinned.y, z: pinned.z }, true);
      fighter.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    player.act(input, keys, tuning, STEP);
    if (foeMode === "ai") {
      ai.think(foe, player, tuning, STEP);
      foe.act(ai, ai.keys, tuning, STEP);
    } else if (foeMode === "hold") {
      foe.act(still, NO_KEYS, tuning, STEP);
    }
    for (const g of Object.values(arena.gateways)) g.gate.step(STEP);
    phys.step();
    for (const g of Object.values(arena.gateways)) g.lever.update();
    arm.updateDerived();
    foe.arm.updateDerived();
    now += STEP * 1000;
    impacts.update(now);
  };

  return {
    phys, arena, arm, fighter, input, impacts, dummy, player, foe, ai, tuning,
    step(n = 1, keys: Keys = NO_KEYS) {
      for (let i = 0; i < n; i++) advance(keys, holding ? "hold" : "idle");
    },
    fight(n = 1, keys: Keys = NO_KEYS) {
      for (let i = 0; i < n; i++) advance(keys, "ai");
    },
    hold(n = 1) {
      for (let i = 0; i < n; i++) advance(NO_KEYS, "hold");
    },
    holdFoe() { holding = true; },
    pin(at: THREE.Vector3 | null) { pinned = at; },
    place(at: THREE.Vector3) {
      player.reset(tuning, at);
      impacts.resetSweeps();
    },
  };
}

/** Drive the arm to a yaw and pitch, the way a hand would. */
function aimAngles(rig: Rig, yaw: number, pitch: number, steps: number): void {
  const [yawMin, yawMax] = Arm.LIMITS.yaw;
  const [pitchMin, pitchMax] = Arm.LIMITS.pitch;
  const wantYaw = Math.max(yawMin, Math.min(yawMax, yaw));
  const wantPitch = Math.max(pitchMin, Math.min(pitchMax, pitch));

  for (let i = 0; i < steps; i++) {
    const aim = rig.arm.aim;
    rig.input.dx = -(wantYaw - aim.yaw) / rig.tuning.sensitivity * 0.25;
    rig.input.dy = -(wantPitch - aim.pitch) / rig.tuning.sensitivity * 0.25;
    rig.step(1);
  }
}

/**
 * Aim so the BLADE crosses a point, not the hand.
 *
 * Pointing the hand at a target misses it: the elbow hangs below the
 * shoulder-to-hand line, so the forearm and the blade welded to it angle
 * upward out of the hand and sail over.
 *
 * The vertical half of that is solved exactly, by the arm's own
 * `solvePitchForHeight` -- the same kinematic probe an opponent uses to aim,
 * so this drives production code rather than a second guess at it. Only the
 * sideways miss is iterated, and that converges in two or three rounds because
 * moving the aim sideways moves the blade sideways very nearly one for one.
 *
 * The earlier version iterated BOTH axes by adding the whole measured error
 * back into the target. Vertically that relation is not monotonic -- past a
 * point, dropping the hand lays the blade flatter and the strike stops
 * following -- so it crept, overshot, and eventually parked the aim on a joint
 * limit with the sword pointing behind its owner. It only ever converged
 * because the low beam happened to hold the blade down; raising the beam for
 * the orc exposed it.
 */
function aimBladeAt(rig: Rig, target: THREE.Vector3, rounds = 4): void {
  const wanted = target.clone();
  const shoulder = new THREE.Vector3();
  const flat = new THREE.Vector3();

  for (let i = 0; i < rounds; i++) {
    rig.fighter.shoulderWorld(shoulder);
    let yaw = Math.atan2(-(wanted.x - shoulder.x), -(wanted.z - shoulder.z))
      - rig.fighter.yaw;
    while (yaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw < -Math.PI) yaw += Math.PI * 2;

    const [minReach, maxReach] = rig.arm.reachLimits;
    const fraction = (rig.arm.aim.reach - minReach) / (maxReach - minReach);
    const pitch = rig.arm.solvePitchForHeight(
      wanted.y, yaw, fraction, rig.arm.aim.roll, rig.tuning);

    aimAngles(rig, yaw, pitch, i === 0 ? 110 : 45);

    // The percussion point, about two thirds along, is what we want on target.
    const strike = rig.arm.handPosition.clone().lerp(rig.arm.tipPosition, 0.7);
    const error = target.clone().sub(strike);

    // Measure only the miss an AIM CAN FIX. The blade reaches as far as it
    // reaches -- against a target inside that, the percussion point ends up a
    // third of a metre PAST it, and that is not an error, it is a sweep going
    // through someone. Counting it as one made the loop walk the aim point
    // back toward the shoulder until the bearing flipped and the sword ended
    // up pointing behind its owner.
    flat.set(target.x - shoulder.x, 0, target.z - shoulder.z).normalize();
    const along = error.x * flat.x + error.z * flat.z;
    const acrossX = error.x - along * flat.x;
    const acrossZ = error.z - along * flat.z;
    if (Math.hypot(acrossX, acrossZ, error.y) < 0.06) return;

    wanted.x += acrossX;
    wanted.z += acrossZ;
    // The solve aims the arm's own percussion point, which is not exactly the
    // 0.7 measured here; damped so that difference is absorbed, not chased.
    wanted.y += error.y * 0.5;
  }
}

/** The swordsman's own forehand: what the player's arm is swung with here. */
const FOREHAND = SWORDSMAN.cuts.find((c) => c.name === "forehand")!;

/** The middle of a band. */
function mid([lo, hi]: readonly [number, number]): number {
  return (lo + hi) / 2;
}

/**
 * A human hand on the mouse, in pixels a step: the budget an opponent drives
 * its own arm under (`HAND_SPEED` in ai.ts).
 */
const HAND_PX = 1100 / 60;

interface ArmPose { yaw: number; pitch: number; reach: number }

/**
 * Take the aim, the edge and the reach toward a pose, each at most `cap`
 * pixels (or wheel notches, four) a step -- the way `Ai.steerArm` does.
 */
function steerTo(
  rig: Rig, want: ArmPose, roll: number, steps: number,
  cap = HAND_PX, each?: () => void,
): void {
  const t = rig.tuning;
  const within = (v: number, c: number) => Math.max(-c, Math.min(c, v));
  for (let i = 0; i < steps; i++) {
    const aim = rig.arm.aim;
    rig.input.dx = -within((want.yaw - aim.yaw) / t.sensitivity, cap);
    rig.input.dy = -within((want.pitch - aim.pitch) / t.sensitivity, cap);
    rig.input.rollDx = within((roll - aim.roll) / t.rollSensitivity, cap);
    rig.input.wheel = within((rig.arm.reachAt(want.reach) - aim.reach) / t.reachRate, 4);
    rig.hold(1);
    each?.();
  }
}

/**
 * The two poses of a forehand through a point, and the roll it cuts at.
 *
 * Solved by the arm's own probe, not driven there. `aimBladeAt` drives the
 * blade TO a point, and against a body that means into it -- which a blade
 * that is stopped by flesh cannot do, and the wind-up from there went back
 * through the body it was resting on.
 *
 * `level` throws it flat across at the target's height rather than down
 * across it: the cut a shield held over the chest is there to stop.
 */
function forehandAt(
  rig: Rig, target: THREE.Vector3, level = false, cut: Cut = FOREHAND,
): { from: ArmPose; to: ArmPose; roll: number } {
  const roll = mid(cut.roll);
  const shoulder = rig.fighter.shoulderWorld(new THREE.Vector3());
  let yaw = Math.atan2(-(target.x - shoulder.x), -(target.z - shoulder.z)) - rig.fighter.yaw;
  while (yaw > Math.PI) yaw -= Math.PI * 2;
  while (yaw < -Math.PI) yaw += Math.PI * 2;
  const pitch = rig.arm.solvePitchForHeight(target.y, yaw, 1, roll, rig.tuning);
  const drop = level ? 0 : 1;
  return {
    from: {
      yaw: yaw + mid(cut.from.yaw),
      pitch: pitch + mid(cut.from.pitch) * drop,
      reach: mid(cut.from.reach),
    },
    to: { yaw: yaw + mid(cut.to.yaw), pitch: pitch + mid(cut.to.pitch) * drop, reach: 1 },
    roll,
  };
}

/**
 * Throw a forehand through a point, as the swordsman throws its own.
 *
 * Swinging at someone is not swinging at air: the blade stops on the first
 * thing of theirs it meets, as it does on a wall. So this does what a player
 * does. The edge is rolled to where the forehand cuts, the weapon is drawn
 * back clear of the target, and it comes through from the same side every
 * time, at a hand's speed, never back through the body it just landed on.
 * The hold stands the foe still, so a knock is felt and nothing swings back.
 */
function throwForehand(
  rig: Rig, target: THREE.Vector3, how: { level?: boolean; each?: () => void; cut?: Cut } = {},
): void {
  const cut = forehandAt(rig, target, how.level, how.cut);
  steerTo(rig, cut.from, cut.roll, 45, HAND_PX, how.each);
  steerTo(rig, cut.to, cut.roll, 30, HAND_PX, how.each);
}

// --- tiny assertion harness ---------------------------------------------------

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail: string): void {
  checks++;
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}  \x1b[90m${detail}\x1b[0m`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}  \x1b[33m${detail}\x1b[0m`);
  }
}

function finite(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// --- the tests ----------------------------------------------------------------

async function freeArmTracks(): Promise<void> {
  console.log("\nfree arm tracks the mouse");
  const rig = await buildRig();
  rig.step(120);                         // settle from the spawn pose

  // Sweep the arm across the body, then let it arrive.
  rig.input.dx = -260;
  rig.step(1);
  rig.step(150);

  const err = rig.arm.state.trackingError;
  check(
    "settles onto the target",
    err < 0.04,
    `tracking error ${err.toFixed(4)} m (want < 0.04)`,
  );
  check(
    "drive is not saturated in free air",
    rig.arm.state.saturation < 0.95,
    `saturation ${(rig.arm.state.saturation * 100).toFixed(0)}% (want < 95%)`,
  );
}

async function reachesAtEveryExtension(): Promise<void> {
  console.log("\narm reaches accurately at every extension");
  // Regression guard. The first version of the angular drive commanded the
  // blade to point along the shoulder->target line, which is only satisfiable
  // with the elbow straight. At bent reaches the two controllers deadlocked and
  // left a permanent error that grew as the arm folded. If this test starts
  // failing at short reach, that mistake is back.
  const rig = await buildRig();
  rig.step(120);

  // Raise the arm first. Swept at rest height the blade grounds out on the
  // floor and props the limb up, which measures floor friction rather than the
  // controller. (That the sword can be planted at all is deliberate -- see the
  // note on MIN_REACH.)
  rig.input.dy = -150;
  rig.step(1);
  rig.step(120);

  let worst = 0;
  let worstAt = 0;
  for (const wheel of [-6, -3, 0, 3, 6]) {
    rig.input.wheel = wheel;
    rig.step(1);
    rig.step(140);
    const err = rig.arm.state.trackingError;
    if (err > worst) { worst = err; worstAt = rig.arm.state.elbow; }
  }
  check(
    "error stays small across the reach range",
    worst < 0.035,
    `worst ${worst.toFixed(4)} m at elbow ${((worstAt * 180) / Math.PI).toFixed(0)}deg (want < 0.035)`,
  );
}

async function blockedBladeDefeatsTheArm(): Promise<void> {
  console.log("\nblocked blade defeats the arm  <- the mechanic");
  const rig = await buildRig();
  rig.step(60);

  // Walk into the west wall rather than teleporting: placing the fighter
  // against it would spawn the blade *inside* the stone on reset, which is an
  // invalid state no player can reach.
  rig.fighter.yaw = Math.PI / 2;               // face west
  rig.step(400, { ...NO_KEYS, forward: true });

  const err = rig.arm.state.trackingError;
  const tipX = rig.arm.tipPosition.x;

  check(
    "hand cannot reach the ghost through stone",
    err > 0.05,
    `tracking error ${err.toFixed(4)} m (want > 0.05)`,
  );
  check(
    "blade did not penetrate the wall",
    tipX >= -8.62,
    `tip x = ${tipX.toFixed(3)} (wall face at -8.600, penetration ${Math.max(0, -8.6 - tipX).toFixed(4)} m)`,
  );
  check(
    "the arm keeps pushing rather than giving up",
    rig.arm.state.saturation > 0.2,
    `saturation ${(rig.arm.state.saturation * 100).toFixed(0)}% (still driving into it)`,
  );
}

async function edgeRollTracks(): Promise<void> {
  console.log("\nedge roll follows a right-drag");
  const rig = await buildRig();
  rig.input.dy = -120;                 // lift clear of the floor
  rig.step(1);
  rig.step(150);

  const edge = new THREE.Vector3();
  rig.arm.biteDirection(edge);
  const before = edge.clone();

  // Roll for less than a quarter turn. A blade is symmetric, so the controller
  // treats 180deg as a no-op and takes the nearer equivalent -- commanding more
  // than 90deg here would fold the measurement back on itself and prove nothing.
  const pixels = 140;                  // as if right-dragging 140px across
  const commanded = pixels * rig.tuning.rollSensitivity * 180 / Math.PI;
  rig.input.rollDx = pixels;
  rig.step(1);
  rig.step(110);

  rig.arm.biteDirection(edge);
  const turned = Math.acos(Math.min(1, Math.abs(before.dot(edge)))) * 180 / Math.PI;

  check(
    "the edge turns by roughly what was asked",
    Math.abs(turned - commanded) < 15,
    `commanded ${commanded.toFixed(0)}deg, edge turned ${turned.toFixed(0)}deg`,
  );
  check(
    "roll control keeps up with the command",
    Math.abs(rig.arm.state.roll) < 0.25,
    `residual roll error ${(rig.arm.state.roll * 180 / Math.PI).toFixed(1)}deg (want < 14deg)`,
  );
  check(
    "rolling does not disturb the hand",
    rig.arm.state.trackingError < 0.04,
    `tracking error ${rig.arm.state.trackingError.toFixed(4)} m during roll`,
  );
}

async function survivesAbuse(): Promise<void> {
  console.log("\nstability under abuse");
  const rig = await buildRig();
  rig.step(60);

  // 20 seconds of violent, random input — the worst thing a player can do.
  let maxReach = 0;
  let rand = 12345;
  const next = () => (rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let i = 0; i < 1200; i++) {
    rig.input.dx = (next() - 0.5) * 600;
    rig.input.dy = (next() - 0.5) * 600;
    rig.input.wheel = next() > 0.9 ? 1 : next() < 0.1 ? -1 : 0;
    rig.input.rollDx = (next() - 0.5) * 220;
    rig.step(1);

    const shoulder = rig.fighter.shoulderWorld(new THREE.Vector3());
    maxReach = Math.max(maxReach, shoulder.distanceTo(rig.arm.handPosition));
  }

  const p = rig.arm.blade.translation();
  check("no NaN in the blade transform", finite(p), `blade at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
  const room = ROOMS.hall;
  check("blade stayed in the room",
    p.x > room.minX - 1 && p.x < room.maxX + 1
    && p.z > room.minZ - 1 && p.z < room.maxZ + 1 && p.y > -1 && p.y < 6,
    `inside ${room.name}`);
  check(
    "arm never stretched off the shoulder",
    maxReach < 0.75,
    `max shoulder->hand ${maxReach.toFixed(3)} m (anatomical max 0.58)`,
  );
  check(
    "tip speed stayed physical",
    rig.arm.state.tipSpeed < 60,
    `final tip speed ${rig.arm.state.tipSpeed.toFixed(1)} m/s`,
  );
}

async function thinPostIsHittable(): Promise<void> {
  console.log("\nCCD: a fast blade does not tunnel through the thin post");
  const rig = await buildRig();
  rig.step(90);

  // The post stands two metres tall in the hall. Stand off it, aim at its middle.
  const post = new THREE.Vector3(THIN_POST.x, 1.3, THIN_POST.z);
  rig.place(new THREE.Vector3(post.x, HOME.y, post.z + 1.0));
  rig.fighter.yaw = 0;                   // facing -Z, post dead ahead
  rig.step(45);
  aimBladeAt(rig, post);

  let hits = 0;
  rig.impacts.addBlade(rig.arm, () => { hits++; });

  // Sweep the blade back and forth across where it is pointing.
  for (let pass = 0; pass < 8; pass++) {
    rig.input.dx = pass % 2 === 0 ? -420 : 420;
    rig.step(1);
    rig.step(40);
  }

  check("registered a contact with the post", hits > 0, `${hits} impact(s) reported`);
}

async function damageCurveIsHonest(): Promise<void> {
  console.log("\ndamage rewards a real cut and nothing else");

  const at = (closingSpeed: number, edgeAlign: number, alongBlade: number) =>
    cutDamage({ closingSpeed, edgeAlign, alongBlade, weapon: SWORD });

  const clean = at(9, 0.95, 0.72);
  const flat = at(9, 0.05, 0.72);
  const slow = at(MIN_CUT_SPEED - 0.1, 1, 0.72);
  const hilt = at(9, 0.95, 0.05);
  const angled = at(9, 0.5, 0.72);

  check("a slow blade does not cut", slow === 0, `${slow.toFixed(2)} damage below the ${MIN_CUT_SPEED} m/s threshold`);
  check("the guard does not cut", hilt === 0, `${hilt.toFixed(2)} damage on the ricasso`);
  check("the flat of the blade barely registers", flat < clean * 0.01,
    `flat ${flat.toFixed(3)} vs clean ${clean.toFixed(2)}`);
  check("edge alignment is punishing, not linear", angled < clean * 0.3,
    `45deg off keeps ${(angled / clean * 100).toFixed(0)}% (linear would keep ~53%)`);
  check("the percussion point beats the tip and the strong",
    sweetSpot(0.72) > sweetSpot(0.3) && sweetSpot(0.72) > sweetSpot(1.0),
    `strong ${sweetSpot(0.3).toFixed(2)} | sweet ${sweetSpot(0.72).toFixed(2)} | tip ${sweetSpot(1.0).toFixed(2)}`);
}

/**
 * Build an Impact by hand, to test the damage -> sever plumbing in isolation.
 *
 * Weightless unless a test says otherwise: these check what a cut does, and a
 * push would move the very thing they are measuring.
 */
function fakeImpact(handle: number, over: Partial<Impact> = {}): Impact {
  return {
    quality: "clean", what: "test", closingSpeed: 9, tangentSpeed: 2,
    edgeAlign: 0.95, alongBlade: 0.72, force: 400,
    at: new THREE.Vector3(), colliderHandle: handle,
    bladeVelocity: new THREE.Vector3(3, 0, 0),
    weapon: SWORD, massKg: SWORD.mass,
    into: new THREE.Vector3(1, 0, 0), blowMass: 0, blade: -1, time: 0,
    ...over,
  };
}

async function limbsComeOff(): Promise<void> {
  console.log("\nclean cuts sever, slaps do not");
  const rig = await buildRig();
  rig.step(60);

  const foreR = rig.dummy.limbs.get("foreArmR")!;
  const foreL = rig.dummy.limbs.get("foreArmL")!;

  // Flat of the blade, over and over: should never take an arm off.
  for (let i = 0; i < 40; i++) {
    rig.dummy.receive(fakeImpact(foreL.collider.handle, { edgeAlign: 0.05 }));
  }
  check("forty flat slaps leave the arm on", !foreL.severed,
    `integrity ${foreL.integrity.toFixed(1)}/${foreL.maxIntegrity} after 40 slaps`);

  // Edge-on cuts on the other arm.
  let cuts = 0;
  while (!foreR.severed && cuts < 10) {
    rig.dummy.receive(fakeImpact(foreR.collider.handle));
    cuts++;
  }
  check("a good cut takes the hand in a couple of strikes",
    foreR.severed && cuts <= 3, `severed after ${cuts} clean cuts`);

  // And it must physically come away, not just lose a joint.
  const before = foreR.body.translation();
  rig.step(90);
  const after = foreR.body.translation();
  const fell = before.y - after.y;
  check("the severed piece falls away", fell > 0.25,
    `dropped ${fell.toFixed(2)} m in 1.5s`);
}

async function severingTakesChildrenWithIt(): Promise<void> {
  console.log("\ncutting high takes everything below it");
  const rig = await buildRig();
  rig.step(60);

  const upper = rig.dummy.limbs.get("upperArmR")!;
  const fore = rig.dummy.limbs.get("foreArmR")!;
  const startY = fore.body.translation().y;

  for (let i = 0; i < 6 && !upper.severed; i++) {
    rig.dummy.receive(fakeImpact(upper.collider.handle, { closingSpeed: 12 }));
  }
  check("the upper arm parts at the shoulder", upper.severed, "shoulder joint removed");

  rig.step(120);
  const drop = startY - fore.body.translation().y;
  check("the forearm goes with it, still attached",
    drop > 0.4 && fore.joint !== null,
    `forearm fell ${drop.toFixed(2)} m with its elbow intact`);
}

async function aRealSwingSevers(): Promise<void> {
  console.log("\nend to end: an actual swing takes a limb off");
  const rig = await buildRig();

  // Approach from +Z, not +X: the dummy's gallows upright stands at
  // DUMMY_AT.x + 1.25, and standing off at +1.3 put the fighter inside it and
  // shoved it a third of a metre sideways before it could swing.
  //
  // At a sword's working distance, a little over a metre. This used to stand
  // close in so the arc swept THROUGH the body, which only a blade that passed
  // through flesh could do. One that is stopped by it meets the near surface,
  // and from close in that is the strong of the blade by the hand, where there
  // is no leverage; from here it is the percussion point.
  // Aim at the dummy's RIGHT UPPER ARM, not its chest. The chest is what the
  // dummy hangs from, so it is the one part with no joint to cut it off at --
  // a swing perfectly aimed there can never satisfy what this test asserts.
  // It passed for a while anyway, because the aiming routine drifted high and
  // kept taking the head off by accident.
  const arm = new THREE.Vector3(DUMMY_AT.x + 0.23, 1.5, DUMMY_AT.z + 0.15);
  const standAt = new THREE.Vector3(DUMMY_AT.x, HOME.y, DUMMY_AT.z + 1.1);
  rig.place(standAt);
  rig.fighter.yaw = 0;                   // facing -Z, dummy dead ahead
  rig.pin(standAt);
  rig.step(90);

  let best = 0;
  let peakClosing = 0;
  const severed: string[] = [];
  rig.dummy.onSever = (e) => severed.push(e.label);
  rig.impacts.addBlade(rig.arm, (i) => {
    if (!rig.dummy.receive(i)) return;
    peakClosing = Math.max(peakClosing, i.closingSpeed);
    best = Math.max(best, cutDamage(i));
  });

  // Swung THROUGH the arm to a pose past it, not at it: driving to the
  // target itself makes the delta shrink as the arm arrives, so the blade
  // decelerates into it and lands a push -- the same "aim through, not at"
  // the opponent's strokes are built on.
  let swings = 0;
  for (; swings < 24 && severed.length === 0; swings++) throwForehand(rig, arm);

  check("a swung blade severs something", severed.length > 0,
    severed.length
      ? `took off ${severed.join(", ")} in ${swings} swings`
      : "nothing came off in 24 swings");
  // What matters is that it clears the 2 m/s floor by a wide margin instead
  // of sitting just under it, which is where every cut landed while a blade
  // that met flesh was measured after the solver had stopped it.
  check("the cut carries real speed", peakClosing > 5,
    `peak closing ${peakClosing.toFixed(1)} m/s, best cut ${best.toFixed(1)} damage`);
}

async function aBladeStopsOnABody(): Promise<void> {
  console.log("\na blade stops on a body as it does on a wall, and lands at the speed it arrived");
  const rig = await buildRig();
  rig.step(60);

  // Blades used to pass through flesh, because a blade the solver stops had
  // been braked by the time anything read it: swings became two dozen grazing
  // contacts at 3 m/s instead of one arriving at twelve. A hit is measured
  // from the blade's motion before the step now, so it can be stopped like
  // any other blow and still be worth what it was swung at.
  const chest = new THREE.Vector3(DUMMY_AT.x, 1.45, DUMMY_AT.z);
  const standAt = new THREE.Vector3(DUMMY_AT.x, HOME.y, DUMMY_AT.z + 1.1);
  rig.place(standAt);
  rig.fighter.yaw = 0;
  rig.pin(standAt);
  rig.step(90);

  const hits: Impact[] = [];
  rig.impacts.addBlade(rig.arm, (i) => {
    if (rig.dummy.receive(i) && i.closingSpeed > 1.2) hits.push(i);
  });
  const cut = forehandAt(rig, chest);
  steerTo(rig, cut.from, cut.roll, 45);

  // The tip's speed the step before the blade landed, and the least it came
  // down to in the three after.
  let before = 0;
  let after = Infinity;
  let landed = -1;
  let redAtHit = 0;
  for (let k = 0; k < 30; k++) {
    const was = rig.arm.state.tipSpeed;
    steerTo(rig, cut.to, cut.roll, 1);
    if (landed < 0 && hits.length > 0) {
      landed = k;
      before = was;
      redAtHit = rig.impacts.streaks.flesh;
    } else if (landed >= 0 && k <= landed + 3) {
      after = Math.min(after, rig.arm.state.tipSpeed);
    }
  }
  const hit = hits[0];
  const red = hits.length > 0 && redAtHit > 0;
  check("a blade that meets a body is stopped by it",
    hit !== undefined && after < before / 3,
    hit ? `tip at ${before.toFixed(1)} m/s into ${hit.what}, ${after.toFixed(1)} m/s after`
      : "the swing never landed");
  check("and the blow is worth the speed it arrived at, not the speed it was left with",
    hit !== undefined && hit.closingSpeed > 5 && hit.bladeVelocity.length() > before * 0.6,
    hit ? `landed at ${hit.bladeVelocity.length().toFixed(1)} m/s, `
      + `${hit.closingSpeed.toFixed(1)} of it into the body` : "no hit");
  check("and it throws red where it landed", red,
    `${redAtHit} red streaks for ${hit ? cutDamage(hit).toFixed(1) : 0} damage`);
}

async function aHitSaysHowHardItWas(): Promise<void> {
  console.log("\na hit says how hard it was: red off flesh, as much as the damage");
  const rig = await buildRig();
  rig.step(30);
  const torso = rig.dummy.limbs.get("torso")!.collider.handle;
  const burst = (i: Impact, flesh: boolean) => {
    const was = { ...rig.impacts.streaks, blood: rig.impacts.blood.live };
    if (flesh) rig.impacts.bleed(i); else rig.impacts.strike(i);
    const now = rig.impacts.streaks;
    return {
      red: now.flesh - was.flesh, gold: now.stone - was.stone,
      blood: rig.impacts.blood.live - was.blood, damage: cutDamage(i),
    };
  };

  const slap = burst(fakeImpact(torso, { edgeAlign: 0.05 }), true);
  const light = burst(fakeImpact(torso, { closingSpeed: 4 }), true);
  const heavy = burst(fakeImpact(torso, {
    closingSpeed: 14, weapon: AXE, massKg: AXE.mass, alongBlade: 0.92,
  }), true);
  const stone = burst(fakeImpact(torso, { closingSpeed: 9 }), false);

  check("a flat slap throws nothing", slap.red === 0 && slap.blood === 0,
    `${slap.damage.toFixed(1)} damage: ${slap.red} red streaks, ${slap.blood} droplets`);
  check("a cut throws red, and a harder one throws more of it and more blood",
    light.red > 0 && heavy.red > light.red * 2 && heavy.blood > light.blood * 2,
    `${light.damage.toFixed(1)} damage: ${light.red} streaks, ${light.blood} droplets; `
      + `${heavy.damage.toFixed(1)}: ${heavy.red} streaks, ${heavy.blood} droplets`);
  check("and stone throws gold, never red", stone.gold > 0 && stone.red === 0,
    `${stone.gold} gold streaks, ${stone.red} red`);
}

async function resetRebuildsCleanly(): Promise<void> {
  console.log("\nreset rebuilds the dummy without touching freed handles");
  const rig = await buildRig();
  rig.step(45);

  // Cut several limbs off, then rebuild — twice, because the first reset is
  // the one that leaves stale collider handles lying around for the second.
  for (const name of ["foreArmR", "upperArmL", "thighR"]) {
    const limb = rig.dummy.limbs.get(name)!;
    for (let i = 0; i < 8 && !limb.severed; i++) {
      rig.dummy.receive(fakeImpact(limb.collider.handle, { closingSpeed: 12 }));
    }
  }
  const before = rig.dummy.severedCount;

  rig.dummy.reset();
  rig.step(60);
  rig.dummy.reset();
  rig.step(60);

  check("limbs were severed before the reset", before >= 3, `${before} severed`);
  check("the rebuilt dummy is whole", rig.dummy.severedCount === 0,
    `${rig.dummy.limbs.size} limbs, none severed`);
  check("the rebuilt dummy is hit-detectable again",
    rig.dummy.receive(fakeImpact(rig.dummy.limbs.get("foreArmR")!.collider.handle)),
    "a fresh collider handle routes to the new limb");

  const torso = rig.dummy.limbs.get("torso")!.body.translation();
  check("the rebuilt dummy still hangs where it should",
    Math.abs(torso.x - DUMMY_AT.x) < 0.3 && torso.y > 1.0,
    `torso at (${torso.x.toFixed(2)}, ${torso.y.toFixed(2)}, ${torso.z.toFixed(2)})`);
}

async function theOpponentClosesAndSwings(): Promise<void> {
  console.log("\nthe opponent closes the distance and swings");
  const rig = await buildRig();

  const gap = () => {
    const a = rig.player.position(new THREE.Vector3());
    const b = rig.foe.position(new THREE.Vector3());
    return Math.hypot(a.x - b.x, a.z - b.z);
  };
  const startGap = gap();

  let peakTip = 0;
  let closest = startGap;
  for (let i = 0; i < 900; i++) {          // 15 seconds
    rig.fight(1);
    peakTip = Math.max(peakTip, rig.foe.arm.state.tipSpeed);
    closest = Math.min(closest, gap());
  }

  check("it starts out of reach", startGap > 3, `${startGap.toFixed(2)} m apart at spawn`);
  check("it closes to striking range", closest < 2.0,
    `closed from ${startGap.toFixed(2)} m to ${closest.toFixed(2)} m`);
  check("it actually swings the sword", peakTip > 6,
    `peak blade tip speed ${peakTip.toFixed(1)} m/s`);
}

async function theOpponentPlaysByTheSameRules(): Promise<void> {
  console.log("\nthe opponent is bound by the same arm physics");
  // This is the one that matters. The AI drives its sword by emitting mouse
  // deltas through the same ArmInput the player's pointer feeds, so it should
  // be impossible for it to do anything anatomically unavailable to a human.
  const rig = await buildRig();

  let maxReach = 0;
  let maxQuick = 0;
  let maxTip = 0;
  let since = Infinity;
  const shoulder = new THREE.Vector3();
  for (let i = 0; i < 900; i++) {
    rig.fight(1);
    rig.foe.fighter.shoulderWorld(shoulder);
    const reach = shoulder.distanceTo(rig.foe.arm.handPosition);
    since = rig.foe.fighter.quickStepping ? 0 : since + STEP;
    if (since < QUICK_SETTLE) maxQuick = Math.max(maxQuick, reach);
    else maxReach = Math.max(maxReach, reach);
    maxTip = Math.max(maxTip, rig.foe.arm.state.tipSpeed);
  }

  // 0.58 is the sum of the two segments; the surplus is the shoulder joint
  // stretching under a clamped 420N drive, which is soft-constraint give
  // rather than the arm going somewhere it should not. It grew from 0.60 to
  // 0.64 when the fighters gained a jointed head and off-arm on the same body;
  // raising the solver from 12 iterations to 16 did not pull it back.
  check("its arm never exceeds anatomical reach", maxReach < 0.68,
    `max shoulder->hand ${maxReach.toFixed(3)} m (segments total 0.58)`);
  // A quick step throws the body at twice walking pace, and the drive damps
  // the hand against its speed through the world, not past the shoulder (see
  // `Ai.raised`): the hand is dragged behind, and the shoulder gives further
  // for as long as it lasts. That is the body's doing, and yours does it the
  // same -- see `aDoubleTapIsAQuickStep`.
  check("nor in a quick step, further than the body's own speed drags it", maxQuick < QUICK_STRETCH,
    `max shoulder->hand ${maxQuick.toFixed(3)} m in a quick step or just after`);
  check("its blade speed stays human", maxTip < 45,
    `peak tip ${maxTip.toFixed(1)} m/s`);
  check("it cannot swing while disarmed", true, "covered below");
}

async function theOpponentCanHurtYou(): Promise<void> {
  console.log("\nthe opponent can actually land a cut");
  const rig = await buildRig();

  // The player stands still and does nothing, so this measures the AI alone.
  // An earlier version stopped the loop at the first point of damage, which
  // made a lethal opponent look like it had managed 1.8 damage in 40 seconds.
  let firstCutAt = -1;
  for (let i = 0; i < 2400; i++) {
    rig.fight(1);
    if (firstCutAt < 0 && rig.player.health < 100) firstCutAt = i;
  }

  // Usually inside six seconds, its first or second swing. Now and then the
  // first few meet your sword where you are holding it, or your forearm in
  // front of you, and stop there -- a guard held still is a guard, since a
  // blade stopped passing through the arm behind it into the body. Over
  // fifty-odd runs one in ten waited past eleven seconds, and one over twenty.
  check("it lands its first cut quickly", firstCutAt >= 0 && firstCutAt < 1500,
    firstCutAt < 0 ? "never landed a cut" : `first blood at ${(firstCutAt / 60).toFixed(1)}s`);
  // Before the fighters were rebuilt this left a passive player on 6/100. A
  // human-shaped target is a far harder one than the barrel it replaced: the
  // torso is 0.17m wide instead of 0.24 and no longer spans knee to head, so
  // the same strokes graze where they used to bite. Some of that drop is the
  // change working as intended; how much is a judgement for someone playing it.
  // Blades stopping on bodies took it from dead in forty seconds to about
  // half: a blow that went through your arm into your body landed twice.
  check("a passive player is worn down", rig.player.health < 85,
    `player at ${rig.player.health.toFixed(1)}/100 after 40s of standing still`);
}

async function cuttingTheArmDisarms(): Promise<void> {
  console.log("\ncutting the sword arm disarms, and the blade stops being driven");
  const rig = await buildRig();
  rig.fight(120);

  const shoulderHandle = rig.foe.arm.upper.collider(0)!.handle;
  for (let i = 0; i < 6 && !rig.foe.arm.disarmed; i++) {
    rig.foe.receive(fakeImpact(shoulderHandle, { closingSpeed: 12 }));
  }
  check("the shoulder parts", rig.foe.arm.disarmed, `severed at ${rig.foe.arm.severedAt}`);

  const bladeY = rig.foe.arm.blade.translation().y;
  for (let i = 0; i < 180; i++) rig.fight(1);
  const after = rig.foe.arm.blade.translation().y;

  check("the sword falls instead of flying itself around",
    bladeY - after > 0.3, `blade dropped ${(bladeY - after).toFixed(2)} m`);
  check("the AI gives up rather than miming a sword",
    rig.ai.intent === "beaten", `intent is "${rig.ai.intent}"`);
}

async function bladesIgnoreTheirOwnerButNotTheFoe(): Promise<void> {
  console.log("\na blade passes through its own body and bites the other");
  const rig = await buildRig();
  rig.fight(60);

  // Wild flailing through its own shoulder must never register a self-hit.
  let selfHits = 0;
  rig.impacts.addBlade(rig.arm, (i) => { if (rig.player.receive(i)) selfHits++; });
  let rand = 999;
  const next = () => (rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 600; i++) {
    rig.input.dx = (next() - 0.5) * 700;
    rig.input.dy = (next() - 0.5) * 700;
    rig.step(1);
  }
  check("your own blade never cuts you", selfHits === 0 && rig.player.health === 100,
    `${selfHits} self-hits, health ${rig.player.health.toFixed(0)}/100`);

  // And the other side's blade is solid against it.
  const foeBlade = rig.foe.arm.bladeCollider.handle;
  const playerTorso = rig.player.fighter.collider.handle;
  check("the two sides are in different collision groups",
    foeBlade !== playerTorso, "distinct colliders on distinct sides");
}

async function deathDropsTheBody(): Promise<void> {
  console.log("\nenough damage puts a fighter down");
  const rig = await buildRig();
  rig.fight(60);

  const torso = rig.foe.fighter.collider.handle;
  for (let i = 0; i < 60 && !rig.foe.dead; i++) {
    rig.foe.receive(fakeImpact(torso, { closingSpeed: 10 }));
  }
  check("health reaches zero", rig.foe.dead, `health ${rig.foe.state.health.toFixed(1)}`);

  const before = rig.foe.fighter.body.translation().y;
  for (let i = 0; i < 180; i++) rig.fight(1);
  const after = rig.foe.fighter.body.translation().y;
  check("the body drops rather than standing there dead",
    before - after > 0.1, `torso fell ${(before - after).toFixed(2)} m`);
}

async function theTrunkWalksWithTheLegs(): Promise<void> {
  console.log("\nwalking, the hips and chest go with the legs; standing, it breathes");
  const rig = await buildRig();
  rig.step(60);
  const f = rig.fighter;
  const pose = f.posture.pose;
  const drawn = new THREE.Vector3();
  const drawnQ = new THREE.Quaternion();
  const real = new THREE.Vector3();
  const realQ = new THREE.Quaternion();
  const rel = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  let hips = 0;
  let tilt = 0;
  let dip = 0;
  let against = true;
  let apart = 0;
  let twist = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < 90; i++) {
    rig.step(1, { ...NO_KEYS, forward: true });
    if (i < 30) continue;                 // into its stride first
    hips = Math.max(hips, Math.abs(pose.hipSwing));
    tilt = Math.max(tilt, Math.abs(pose.roll));
    dip = Math.max(dip, pose.dip);
    if (Math.abs(pose.hipSwing) > 0.02) against &&= pose.hipSwing * pose.chestSwing < 0;
    // The chest as drawn against the chest the shoulder and the collider
    // are placed from: they must never come apart. In the hull's own frame,
    // because the figure is drawn where the hull was when it was posed.
    f.chest.updateWorldMatrix(true, false);
    rel.copy(f.mesh.matrixWorld).invert().multiply(f.chest.matrixWorld)
      .decompose(drawn, drawnQ, scale);
    f.posture.chestPoint(pose, real.set(0, 0, 0), real);
    f.posture.chestQuat(pose, realQ);
    apart = Math.max(apart, drawn.distanceTo(real));
    twist = Math.max(twist, drawnQ.angleTo(realQ));
    lowest = Math.min(lowest, f.shoulderAnchor.y);
    highest = Math.max(highest, f.shoulderAnchor.y);
  }
  check("walking, the hips turn and tilt over each stride, and the body dips",
    hips > 0.06 && tilt > 0.04 && dip > 0.015,
    `hips turn ${hips.toFixed(2)} rad and tilt ${tilt.toFixed(2)}, dipping ${(dip * 100).toFixed(1)} cm`);
  check("and the chest turns against the hips, as arms swing against legs", against,
    "every stride");
  check("and the shoulder the sword hangs from walks with the chest that is drawn",
    apart < 1e-3 && twist < 1e-3 && highest - lowest > 0.01,
    `${(apart * 1000).toFixed(2)} mm and ${twist.toFixed(4)} rad apart; the shoulder rose and fell `
      + `${((highest - lowest) * 100).toFixed(1)} cm`);

  // Standing: nothing of the walk left, but not a post either.
  rig.step(60);
  let leanLo = Infinity;
  let leanHi = -Infinity;
  for (let i = 0; i < 240; i++) {
    rig.step(1);
    leanLo = Math.min(leanLo, pose.lean);
    leanHi = Math.max(leanHi, pose.lean);
  }
  check("standing still, the walk is gone and the chest breathes",
    Math.abs(pose.hipSwing) < 1e-3 && Math.abs(pose.roll) < 1e-3 && pose.dip < 1e-5
      && leanHi - leanLo > 0.015,
    `chest rising and falling ${(leanHi - leanLo).toFixed(3)} rad over four seconds`);
}

async function aDeadBodyGoesLimp(): Promise<void> {
  console.log("\na dead body goes limp, and a reset stands it back up whole");
  const rig = await buildRig();
  rig.hold(60);
  const hull = rig.foe.fighter.body;
  const legs = rig.foe.fighter.parts.filter((p) => /thigh|shin/.test(p.name))
    .map((p) => p.collider.parent()!);
  // Dying makes bodies and joints, and a reset has to take every one away.
  const census = () => `${rig.phys.world.bodies.len()} bodies, ${rig.phys.world.impulseJoints.len()} joints`;
  const alive = census();

  const torso = rig.foe.fighter.collider.handle;
  for (let i = 0; i < 60 && !rig.foe.dead; i++) {
    rig.foe.receive(fakeImpact(torso, { closingSpeed: 10 }));
  }
  // Two seconds for it to come down, however it goes.
  rig.hold(120);

  const up = new THREE.Vector3(0, 1, 0);
  const along = (b: typeof legs[number]) => {
    const q = b.rotation();
    return up.clone().applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  };
  // Each knee's bend: the angle between the thigh's length and the shin's.
  const bends = [0, 2].map((i) => along(legs[i]).angleTo(along(legs[i + 1])));
  const highest = Math.max(...legs.map((b) => b.translation().y), hull.translation().y);
  check("its legs are its own now, not posed",
    legs.every((b) => b.isDynamic()) && rig.foe.fighter.limp,
    `${legs.filter((b) => b.isDynamic()).length} of ${legs.length} leg bones simulated`);
  check("and it comes down in a heap, not a plank",
    highest < 0.45 && Math.max(...bends) > 0.2,
    `nothing higher than ${highest.toFixed(2)} m; knees bent ${bends.map((b) => b.toFixed(2)).join(", ")} rad`);

  rig.foe.reset(rig.tuning, foeSpawn(SWORDSMAN));
  rig.impacts.resetSweeps();
  rig.hold(60);
  const stood = rig.foe.fighter.body.translation().y;
  check("a reset stands it back up, legs posed again, nothing left over",
    legs.every((b) => b.isKinematic()) && !rig.foe.fighter.limp
      && Math.abs(stood - SWORDSMAN.build.hullCentreY) < 0.05 && census() === alive,
    `hull at ${stood.toFixed(3)} m against ${SWORDSMAN.build.hullCentreY.toFixed(3)} standing; `
      + `${census()}, ${alive} before it died`);
  // Two seconds, not one: coming for you from across the room, it may stop
  // and show you its weapon first (see the taunts below), and a salute is
  // most of a second of not walking.
  const from = rig.foe.position(new THREE.Vector3());
  for (let i = 0; i < 120; i++) rig.fight(1);
  const went = rig.foe.position(new THREE.Vector3()).distanceTo(from);
  check("and it can walk and fight again", went > 0.3 && rig.foe.state.health > 0,
    `went ${went.toFixed(2)} m in two seconds of fighting`);
}

async function aLostArmIsHeld(): Promise<void> {
  console.log("\na sword arm cut off: the body curls round it, and the other hand holds it");
  const up = new THREE.Vector3(0, 1, 0);
  const reached: string[] = [];
  const kept: string[] = [];
  let curled = true;
  let held = true;
  let steady = true;
  let hangs = true;
  let lowest = 1;
  for (const species of [SWORDSMAN, ORC, GOBLIN]) {
    for (const cut of ["shoulder", "elbow"] as const) {
      const rig = await buildRig({}, species, foeSpawn(species));
      const f = rig.foe.fighter;
      const s = species.build.scale;
      // How far the other hand is from the wound: the socket, or anywhere on
      // the stump of the upper arm down to where it is held.
      const down = cut === "elbow" ? 0.65 * species.build.segment.upperArm.length : 0;
      const stump = new THREE.Line3();
      const hand = new THREE.Vector3();
      const near = new THREE.Vector3();
      const gap = () => {
        const fore = f.offLimb.fore;
        const p = fore.translation();
        const q = fore.rotation();
        hand.set(0, species.build.segment.foreArm.length / 2, 0)
          .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).add(new THREE.Vector3(p.x, p.y, p.z));
        stump.set(f.woundWorld(0, new THREE.Vector3()), f.woundWorld(down, new THREE.Vector3()));
        return down === 0 ? hand.distanceTo(stump.start)
          : hand.distanceTo(stump.closestPointToPoint(hand, true, near));
      };
      rig.holdFoe();
      rig.hold(60);
      const before = gap();
      const part = (cut === "shoulder" ? rig.foe.arm.upper : rig.foe.arm.fore).collider(0)!.handle;
      for (let k = 0; k < 20 && !rig.foe.arm.disarmed; k++) {
        rig.foe.receive(fakeImpact(part, { closingSpeed: 12, time: k * 400 }));
      }
      rig.hold(60);
      const still = gap();
      const pose = f.posture.pose;
      curled &&= pose.lean > 0.25 && pose.sink > 0.03 * s;
      held &&= still < 0.25 * s && still < 0.6 * before;
      // Then two seconds of it backing away from you, which is what it does.
      let worst = 0;
      for (let i = 0; i < 120; i++) {
        rig.fight(1);
        worst = Math.max(worst, gap());
        if (cut === "elbow") {
          const q = rig.foe.arm.upper.rotation();
          const d = -up.clone().applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).y;
          lowest = Math.min(lowest, d);
        }
      }
      steady &&= worst < 0.3 * s;
      if (cut === "elbow") hangs &&= lowest > 0.7;
      reached.push(`${species.key} ${cut} ${before.toFixed(2)}->${still.toFixed(2)}`);
      kept.push(`${worst.toFixed(2)}`);
    }
  }
  check("it curls round the wound", curled, "leaning over it, knees gone a little");
  check("and the other hand goes to it", held, `hand to wound, m: ${reached.join(", ")}`);
  check("and stays on it while it backs away from you", steady,
    `never more than ${kept.join(", ")} m off it, in the same order`);
  check("what is left of an arm cut at the elbow is held in, not swinging",
    hangs, `the stump never came further up than ${(Math.acos(lowest) * 180 / Math.PI).toFixed(0)} deg off hanging`);
}

// --- stage 5: jumping, the bestiary, and the telegraph -----------------------

async function theControlsAreWhereTheySay(): Promise<void> {
  console.log("\nQ/E sidestep, A/D turn");
  // A user-visible contract, and the one thing in this project a player has to
  // unlearn from every other game. Worth a guard.
  check("A and D turn", KEY_MAP.KeyA === "turnLeft" && KEY_MAP.KeyD === "turnRight",
    `A -> ${KEY_MAP.KeyA}, D -> ${KEY_MAP.KeyD}`);
  check("Q and E sidestep", KEY_MAP.KeyQ === "left" && KEY_MAP.KeyE === "right",
    `Q -> ${KEY_MAP.KeyQ}, E -> ${KEY_MAP.KeyE}`);
  check("Space jumps", KEY_MAP.Space === "jump", `Space -> ${KEY_MAP.Space}`);

  const rig = await buildRig();
  rig.step(60);
  const before = rig.fighter.yaw;
  rig.step(30, { ...NO_KEYS, turnLeft: true });
  check("the turn keys actually turn the body", Math.abs(rig.fighter.yaw - before) > 0.4,
    `yaw moved ${(rig.fighter.yaw - before).toFixed(2)} rad in half a second`);

  const start = rig.fighter.position(new THREE.Vector3());
  rig.step(40, { ...NO_KEYS, right: true });
  const moved = rig.fighter.position(new THREE.Vector3()).sub(start);
  check("the sidestep keys move without turning", moved.length() > 0.5,
    `stepped ${moved.length().toFixed(2)} m sideways`);
}

async function jumpingLeavesTheGround(): Promise<void> {
  console.log("\njumping");
  const rig = await buildRig();
  rig.step(90);

  const rest = rig.fighter.position(new THREE.Vector3()).y;
  check("it is standing on something to begin with", rig.fighter.grounded,
    `resting at y ${rest.toFixed(2)}`);

  // One jump, then let go of the key and wait it out.
  let apex = rest;
  for (let i = 0; i < 8; i++) {
    rig.step(1, { ...NO_KEYS, jump: true });
    apex = Math.max(apex, rig.fighter.position(new THREE.Vector3()).y);
  }
  let landedAfter = -1;
  for (let i = 0; i < 120; i++) {
    rig.step(1);
    apex = Math.max(apex, rig.fighter.position(new THREE.Vector3()).y);
    if (landedAfter < 0 && i > 10 && rig.fighter.grounded) landedAfter = i;
  }

  const climb = apex - rest;
  const back = rig.fighter.position(new THREE.Vector3()).y;
  check("a jump clears real height", climb > 0.3,
    `rose ${climb.toFixed(2)} m (asked for ${DEFAULTS.jumpHeight})`);
  check("it clears about what it was asked for, not more",
    climb < DEFAULTS.jumpHeight * 1.5,
    `apex ${climb.toFixed(2)} m against a ${DEFAULTS.jumpHeight} m jump`);
  check("it comes back down", landedAfter >= 0 && Math.abs(back - rest) < 0.05,
    `landed after ${(landedAfter / 60).toFixed(2)}s, back within ${Math.abs(back - rest).toFixed(3)} m`);

  // Holding the key hops rather than climbing: each take-off has to wait for
  // the feet to be on something again.
  let hopApex = rest;
  for (let i = 0; i < 180; i++) {
    rig.step(1, { ...NO_KEYS, jump: true });
    hopApex = Math.max(hopApex, rig.fighter.position(new THREE.Vector3()).y);
  }
  check("holding the key hops, it does not fly",
    hopApex - rest < DEFAULTS.jumpHeight * 1.5,
    `three seconds of held jump peaked at ${(hopApex - rest).toFixed(2)} m`);
}

async function airControlIsWeakerThanGround(): Promise<void> {
  console.log("\na jump commits you to the line you left on");
  const rig = await buildRig();
  rig.step(90);

  // On the ground, sidestepping from a standstill.
  const groundStart = rig.fighter.position(new THREE.Vector3());
  rig.step(24, { ...NO_KEYS, right: true });
  const onGround = rig.fighter.position(new THREE.Vector3()).sub(groundStart).length();

  // In the air, the same command from the same standstill.
  const rig2 = await buildRig();
  rig2.step(90);
  rig2.step(6, { ...NO_KEYS, jump: true });      // leave the ground
  const airStart = rig2.fighter.position(new THREE.Vector3());
  rig2.step(24, { ...NO_KEYS, right: true });
  const inAir = rig2.fighter.position(new THREE.Vector3()).sub(airStart);
  const sideways = Math.hypot(inAir.x, inAir.z);

  check("steering in the air costs you most of your control",
    sideways < onGround * 0.5,
    `${sideways.toFixed(2)} m airborne vs ${onGround.toFixed(2)} m on the ground`);
}

async function aDoubleTapIsAQuickStep(): Promise<void> {
  console.log("\na double tap of a movement key is a quick step");
  // Twice walking pace for under a fifth of a second, the way the keys say:
  // a metre or so, then a rest before the next. From the floor, on your own
  // feet, and a cut leg takes its share off it -- as it does off a walk.
  const rig = await buildRig();
  rig.step(30);
  const pace = rig.fighter.walkSpeed(rig.tuning);
  const shoulder = new THREE.Vector3();
  let stretch = 0;
  // The keys for one step -- the second press of the tap -- and then none:
  // how far it went by the time it stopped, and how fast it got.
  const go = (keys: Keys) => {
    const a = rig.fighter.position(new THREE.Vector3());
    let top = 0;
    rig.step(1, keys);
    for (let i = 0; i < 60; i++) {
      rig.step(1);
      const v = rig.fighter.walkVelocity;
      top = Math.max(top, Math.hypot(v.x, v.z));
      rig.fighter.shoulderWorld(shoulder);
      if (i / 60 < QUICK_TIME + QUICK_SETTLE) {
        stretch = Math.max(stretch, shoulder.distanceTo(rig.arm.handPosition));
      }
    }
    const b = rig.fighter.position(new THREE.Vector3());
    return { dx: b.x - a.x, dz: b.z - a.z, far: Math.hypot(b.x - a.x, b.z - a.z), top };
  };
  const tap = go({ ...NO_KEYS, forward: true });
  const ahead = go({ ...NO_KEYS, forward: true, dash: true });
  check("a quick step goes a metre or so, at twice walking pace -- a tap of the key, nowhere",
    ahead.far > 0.9 && ahead.far < 1.5 && -ahead.dz > 0.9 && Math.abs(ahead.top - 2 * pace) < 0.05
      && tap.far < 0.1,
    `${ahead.far.toFixed(2)} m at up to ${ahead.top.toFixed(2)} m/s, walking ${pace.toFixed(2)}; ` +
    `a tap on its own ${(tap.far * 100).toFixed(0)}cm`);
  // Facing the way it spawned: back is +Z, and its right +X.
  const back = go({ ...NO_KEYS, back: true, dash: true });
  const right = go({ ...NO_KEYS, right: true, dash: true });
  const left = go({ ...NO_KEYS, left: true, dash: true });
  check("back, or either way aside, as far",
    back.dz > 0.9 && right.dx > 0.9 && -left.dx > 0.9,
    `back ${back.dz.toFixed(2)} m, right ${right.dx.toFixed(2)}, left ${(-left.dx).toFixed(2)}`);
  check("and your arm is dragged behind it as far as theirs, no further",
    stretch > 0.64 && stretch < QUICK_STRETCH,
    `shoulder to hand up to ${stretch.toFixed(3)} m in a quick step (segments total 0.58)`);

  // One at a time: asked for again early in its rest, nothing; asked for a
  // moment before the rest is over, it waits for it rather than forget it.
  const rest = rig.tuning.quickStepRest;
  const count = rig.fighter.quickSteps;
  rig.step(1, { ...NO_KEYS, forward: true, dash: true });
  rig.step(Math.round(rest * 0.4 / STEP));
  rig.step(1, { ...NO_KEYS, back: true, dash: true });
  rig.step(60);
  const early = rig.fighter.quickSteps - count;
  rig.step(1, { ...NO_KEYS, forward: true, dash: true });
  rig.step(Math.round((rest - 0.1) / STEP) - 1);
  rig.step(1, { ...NO_KEYS, back: true, dash: true });
  rig.step(12, { ...NO_KEYS, back: true });
  rig.step(60);
  const late = rig.fighter.quickSteps - count - early;
  check("then a rest before the next, and one asked for a moment early waits for it",
    early === 1 && late === 2,
    `asked again ${(rest * 0.4).toFixed(2)}s in: ${early === 1 ? "not taken" : "taken"}; ` +
    `${(rest - 0.1).toFixed(2)}s in: ${late === 2 ? "taken as the rest ran out" : "lost"}`);

  // Off the floor: nothing to push off.
  const before = rig.fighter.quickSteps;
  rig.step(1, { ...NO_KEYS, jump: true });
  rig.step(8);
  const aloft = !rig.fighter.grounded;
  rig.step(1, { ...NO_KEYS, forward: true, dash: true });
  rig.step(60);
  check("never in the air", aloft && rig.fighter.quickSteps === before,
    `${rig.fighter.quickSteps - before} quick steps asked for in the air`);

  // A cut leg: the pace comes down, and so does the way it goes.
  const thigh = rig.fighter.parts.find((p) => p.name.endsWith("thigh"))!;
  for (let i = 0; i < 3; i++) rig.player.receive(fakeImpact(thigh.collider.handle));
  rig.step(60);
  const lamed = go({ ...NO_KEYS, forward: true, dash: true });
  check("and a cut leg shortens it", lamed.far < 0.75 * ahead.far && rig.fighter.lame > 0.5,
    `${lamed.far.toFixed(2)} m lamed (${(rig.fighter.lame * 100).toFixed(0)}%), ` +
    `${ahead.far.toFixed(2)} whole`);
}

async function aLegSweepCanBeJumped(): Promise<void> {
  console.log("\nthe orc's leg sweep travels under a jump");
  // Nothing tells you it is coming but the axe going low, and the answer to it
  // has to actually be there, which means two measured numbers meeting: how
  // low the axe travels, and how high the feet get.
  const rig = await buildRig({}, ORC, foeSpawn(ORC));
  rig.ai.cutOverride = "leg sweep";

  let lowest = 99;
  for (let i = 0; i < 60 * 12; i++) {
    rig.fight(1);
    if (rig.ai.intent === "strike") {
      const tip = rig.foe.arm.tipPosition.y;
      const hand = rig.foe.arm.handPosition.y;
      lowest = Math.min(lowest, Math.max(tip, hand));
    }
  }

  const jumper = await buildRig();
  jumper.step(90);
  const rest = jumper.fighter.position(new THREE.Vector3()).y;
  let apex = rest;
  for (let i = 0; i < 90; i++) {
    jumper.step(1, { ...NO_KEYS, jump: true });
    apex = Math.max(apex, jumper.fighter.position(new THREE.Vector3()).y);
  }

  check("the sweep really does travel low", lowest < 1.2,
    `axe passed at ${lowest.toFixed(2)} m`);
  check("a jump lifts the feet above it", apex - rest > lowest - 0.9,
    `feet rose ${(apex - rest).toFixed(2)} m, sweep at ${(lowest - 0.9).toFixed(2)} m above the knee`);
}

async function weaponsAreToldApartByPhysics(): Promise<void> {
  console.log("\nan axe, a spear and a sword are different objects");

  check("the axe carries its weight at the far end",
    AXE.parts[1].mass > AXE.parts[0].mass * 2 && AXE.parts[1].at > AXE.span * 0.8,
    `${AXE.parts[1].mass}kg head at ${AXE.parts[1].at.toFixed(2)} m from the hand`);
  check("the spear is held choked up, not by the butt",
    SPEAR.parts[0].at < SPEAR.parts[0].halfLen,
    `shaft centre ${SPEAR.parts[0].at.toFixed(2)} m from the hand, half-length ${SPEAR.parts[0].halfLen.toFixed(2)}`);
  check("the spear reaches furthest", SPEAR.span > SWORD.span && SPEAR.span > AXE.span,
    `spear ${SPEAR.span.toFixed(2)} m, axe ${AXE.span.toFixed(2)} m, sword ${SWORD.span.toFixed(2)} m`);

  // Leverage: each weapon does its work somewhere different along itself.
  const peak = (w: typeof SWORD) => {
    let best = 0, at = 0;
    for (let i = 0; i <= 40; i++) {
      const v = w.sweetSpot(i / 40);
      if (v > best) { best = v; at = i / 40; }
    }
    return at;
  };
  check("each weapon bites somewhere of its own",
    peak(SWORD) < 0.85 && peak(AXE) > 0.85 && peak(SPEAR) > 0.9,
    `sword ${peak(SWORD).toFixed(2)}, axe ${peak(AXE).toFixed(2)}, spear ${peak(SPEAR).toFixed(2)}`);
  check("an axe haft does nothing", AXE.sweetSpot(0.5) === 0,
    `mid-haft leverage ${AXE.sweetSpot(0.5).toFixed(2)}`);
  check("a spear shaft does nothing", SPEAR.sweetSpot(0.6) === 0,
    `mid-shaft leverage ${SPEAR.sweetSpot(0.6).toFixed(2)}`);

  // The damage model reads the weapon, not a stat block.
  const hit = (w: typeof SWORD, speed: number) =>
    cutDamage({ closingSpeed: speed, edgeAlign: 0.95, alongBlade: peak(w), weapon: w });
  check("an axe hits harder than a sword at the same speed",
    hit(AXE, 10) > hit(SWORD, 10) * 1.2,
    `axe ${hit(AXE, 10).toFixed(1)} vs sword ${hit(SWORD, 10).toFixed(1)}`);
  // Slow for a cut: at 2.4 m/s a sword's does what it did at 3.5 when a
  // weapon's speed was measured about its grip (see `Arm.velocityAt`). A
  // sword swings about its middle far more than a spear thrusts, so it lost
  // more of its measured speed to that, and with each refitted to the damage
  // it did in a fight, a thrust comes out two and a half cuts here, not the
  // nearly four it did.
  check("a thrust is worth throwing at a speed a cut is not",
    hit(SPEAR, 2.4) > hit(SWORD, 2.4) * 2,
    `at 2.4 m/s: spear ${hit(SPEAR, 2.4).toFixed(1)} vs sword ${hit(SWORD, 2.4).toFixed(1)}`);
}

async function theAxeIsHarderToSwing(): Promise<void> {
  console.log("\nthe axe's inertia is not a number, it is where the iron is");
  // Same body, same arm, same drive, same command -- the ONLY difference is
  // what is in the hand, so any difference in how far the weapon comes round
  // is its mass distribution and nothing else.
  //
  // "Comes round" is where the weapon POINTS: the angle its length swept. It
  // used to be the weapon's whole change of orientation, spin about its own
  // length included, and that spin was measuring a Rapier bug -- two parts
  // offset along a weapon gave it inertia about its own length that grew with
  // how far out they sat, so a spear held by the butt resisted rolling as if
  // it were being swung end over end. With that corrected (see
  // `weaponMassProperties`) and a grip that can turn, spinning a spear about
  // its shaft is nearly free, as it should be, and says nothing about steering.
  const sweptAngle = async (weapon: typeof SWORD): Promise<number> => {
    const rig = await buildRig({}, { ...SWORDSMAN, weapon }, FOE_HOME);
    rig.step(90);

    const start = rig.foe.arm.blade.rotation();
    const from = new THREE.Quaternion(start.x, start.y, start.z, start.w);
    const rate = 0.13 / rig.tuning.sensitivity;
    for (let i = 0; i < 18; i++) {
      rig.foe.arm.readInput(
        { consumeMouse: () => ({ dx: rate, dy: 0, wheel: 0, rollDx: 0 }) }, rig.tuning);
      rig.foe.arm.drive(rig.tuning);
      rig.step(1);
    }
    const end = rig.foe.arm.blade.rotation();
    const was = new THREE.Vector3(0, 1, 0).applyQuaternion(from);
    const now = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(new THREE.Quaternion(end.x, end.y, end.z, end.w));
    return was.angleTo(now);
  };

  const sword = await sweptAngle(SWORD);
  const axe = await sweptAngle(AXE);
  check("an axe comes round slower than a sword on the same swing",
    axe < sword * 0.95,
    `in 0.3s: sword turned ${(sword * 180 / Math.PI).toFixed(0)}deg, ` +
    `axe ${(axe * 180 / Math.PI).toFixed(0)}deg`);

  // And the choked grip is not decoration. Take the same spear and hold it by
  // the butt -- every part shifted forward by the length that used to hang
  // behind the hand -- and the same arm swings it markedly less far.
  //
  // Markedly, not hugely: a fifth or so less in 0.3s, measured on where the
  // spear points. This used to demand more than a fifth, and passed only
  // because the measure included spin about the shaft that Rapier had made
  // grow with how far out the mass sat; on that physics, measured this way,
  // it was 0.81. The arm's own inertia about the shoulder is most of what a
  // swing has to move, and dilutes what the grip changes.
  const behind = SPEAR.parts[0].halfLen - SPEAR.parts[0].at;
  const byTheButt = {
    ...SPEAR,
    parts: SPEAR.parts.map((part) => ({ ...part, at: part.at + behind })),
  };
  const choked = await sweptAngle(SPEAR);
  const butt = await sweptAngle(byTheButt);
  check("a spear held choked up steers; held by the butt it lags",
    butt < choked * 0.9,
    `${behind.toFixed(2)} m of shaft behind the hand is worth ` +
    `${(choked * 180 / Math.PI).toFixed(0)}deg against ${(butt * 180 / Math.PI).toFixed(0)}deg`);
}

async function theBestiaryScalesHonestly(): Promise<void> {
  console.log("\nbigger is harder to kill, but not harder to dismember");
  const orcHealth = maxHealthFor(ORC.build);
  const goblinHealth = maxHealthFor(GOBLIN.build);
  const humanHealth = maxHealthFor(SWORDSMAN.build);

  check("an orc takes far more killing than a goblin",
    orcHealth > goblinHealth * 3,
    `orc ${orcHealth.toFixed(0)}, human ${humanHealth.toFixed(0)}, goblin ${goblinHealth.toFixed(0)}`);
  check("its joints do NOT scale as fast as its health",
    jointScaleFor(ORC.build) < ORC.build.massScale,
    `joints x${jointScaleFor(ORC.build).toFixed(2)} against health x${ORC.build.massScale.toFixed(2)} ` +
    `— which is why you take its arm off instead`);
  check("a goblin is small, light and quick to cut",
    GOBLIN.build.standing.crown < 1.5 && jointScaleFor(GOBLIN.build) < 0.6,
    `${GOBLIN.build.standing.crown.toFixed(2)} m tall, joints x${jointScaleFor(GOBLIN.build).toFixed(2)}`);
}

async function eachSpeciesCanFight(): Promise<void> {
  console.log("\nthe orc and the goblin can both close and cut");
  for (const species of [ORC, GOBLIN]) {
    const rig = await buildRig({}, species, foeSpawn(species));
    let closest = 99;
    let firstCut = -1;
    const gap = new THREE.Vector3();
    const foeAt = new THREE.Vector3();

    for (let i = 0; i < 60 * 30; i++) {
      rig.fight(1);
      rig.fighter.position(gap);
      rig.foe.position(foeAt);
      closest = Math.min(closest, Math.hypot(gap.x - foeAt.x, gap.z - foeAt.z));
      if (firstCut < 0 && rig.player.health < 100) firstCut = i / 60;
    }

    check(`${species.name} closes the distance`, closest < 2.2,
      `closed to ${closest.toFixed(2)} m`);
    check(`${species.name} draws blood`, firstCut >= 0,
      firstCut >= 0
        ? `first cut at ${firstCut.toFixed(1)}s, player down to ${rig.player.health.toFixed(0)}`
        : "never landed a hit in 30s");
  }
}

async function swingsAreReadOffTheArm(): Promise<void> {
  console.log("\nnothing announces a swing but the arm drawing it back");
  // Every attack used to be held wound up for a declared length -- three
  // quarters of a second of glowing axe -- while the fight panel named it and
  // said how to beat it. Now a swing is made up as it is thrown, aimed at a
  // part of you, and the only warning is the weapon going back, for as long
  // as the arm takes to get it there. So that has to happen every time, it has
  // to mean something -- more weapon, longer -- and nothing else may tell.
  const whole = new Map<string, number[]>();
  const everywhere = new Set<string>();
  for (const kind of [SWORDSMAN, ORC, GOBLIN]) {
    // Never off a quick step: a swing thrown off one is a swing on the move,
    // left out of what is measured below, and they took the place of enough
    // swings drawn back standing to leave a bout too few to take a median of.
    // They are drawn back first as well: see `theyQuickStepToo`.
    const species = { ...kind, footwork: { ...kind.footwork, dart: 0 } };
    const rig = await buildRig({}, species, foeSpawn(species));
    const swings: Swing[] = [];
    const drawing: number[] = [];
    const cycles: number[] = [];
    let drawn = 0;
    let t = 0;
    let cycle = -1;
    let from = rig.foe.arm.aim;
    let told = "";
    let lied = "";
    // Three quarters of a minute: a swing's length is a median over a bout,
    // and since an opponent swings on your misses and as you walk in as well
    // as when it is ready, half a minute of them is a noisier one than it was.
    // A swing on its own and drawn back standing: not the last of a run, nor
    // one carried on round, whose guard is longer coming back up on purpose,
    // nor one drawn back walking in or giving ground, whose wind-up is as long
    // as the walking takes (see the runs, and the swings on the move, below).
    // What is being asked about is the weapon.
    let alone = true;
    for (let i = 0; i < 60 * 45; i++) {
      const before = rig.ai.intent;
      const run = rig.ai.run;
      rig.fight(1);
      const now = rig.ai.intent;
      if (now === "windup" && before !== "windup") {
        swings.push(rig.ai.committed!);
        from = rig.foe.arm.aim;
        t = 0;
        cycle = 0;
        alone = rig.ai.committed!.move === "stand";
      }
      if (rig.ai.spinning) alone = false;
      if (now === "windup") t += STEP;
      if (before === "windup" && now === "strike") {
        drawing.push(t);
        const to = rig.foe.arm.aim;
        const moved = Math.hypot(to.yaw - from.yaw, to.pitch - from.pitch);
        if (moved > 0.25 || Math.abs(to.reach - from.reach) > 0.08) drawn++;
      }
      // Back, through, and on guard again.
      if (cycle >= 0) {
        if (now === "windup" || now === "leap" || now === "strike" || now === "recover") {
          cycle += STEP;
        }
        else {
          if (before === "recover" && alone && run <= 1) cycles.push(cycle);
          cycle = -1;
        }
      }
      const swinging = now === "windup" || now === "leap" || now === "strike";
      if (lied === "" && swinging !== (rig.ai.committed !== null)) {
        lied = `intent "${now}" with ${rig.ai.committed?.cut.name ?? "nothing"} committed`;
      }
      if (told === "" && FIGHTING.has(now) && rig.ai.outlook !== "fighting") {
        told = `the panel said "${rig.ai.outlook}" while it was in "${now}"`;
      }
    }
    whole.set(species.key, cycles);

    const fastest = Math.min(...drawing);
    const slowest = Math.max(...drawing);
    check(`${species.name} draws back before every swing`,
      drawing.length >= 8 && drawn === drawing.length,
      `${drawn} of ${drawing.length} swings drew the weapon back first`);
    check("for as long as its arm takes, not a set time",
      fastest >= 0.09 && median(drawing) < 0.6 && slowest - fastest > 0.05,
      `${fastest.toFixed(2)}-${slowest.toFixed(2)}s, median ${median(drawing).toFixed(2)}s`);

    const parts = new Set(swings.map((s) => s.aim));
    for (const p of parts) everywhere.add(p);
    const alike = new Set(swings.map((s) =>
      [s.from.yaw, s.from.pitch, s.from.reach, s.to.yaw, s.to.pitch, s.roll]
        .map((v) => v.toFixed(3)).join())).size;
    check("it goes for more of you than one place, and never the same way twice",
      parts.size >= 2 && alike === swings.length,
      `${swings.length} swings at your ${[...parts].join(", ")}; ` +
      `${alike} different ones, in ${plural(new Set(swings.map((s) => s.cut.name)).size, "shape")}`);
    check("and nothing but the arm gives it away", told === "" && lied === "",
      told || lied || "45s of fighting: the panel only ever said it was fighting");

  }

  check("between them they go for your head, your body, your sword arm and your legs",
    everywhere.size === 4, `went for your ${[...everywhere].join(", ")}`);

  // And what the orc reaches for, which half a minute of a fight is too short
  // to say: a bout throws a couple of dozen swings, and which of them it
  // could throw depends on where you were standing. Two thousand made up
  // from where it swings from, and never thrown: wherever an overhead and a
  // swing round both reach, it brings the axe over the top three times in
  // four.
  const orc = new Ai(ORC);
  const imagined = Array.from({ length: 2000 }, () => orc.imagine(1));
  const high = imagined.filter((s) => s.aim === "head" || s.aim === "body");
  const over = high.filter((s) => s.cut.name === "overhead").length / high.length;
  const all = imagined.filter((s) => s.cut.name === "overhead").length / imagined.length;
  check("the orc brings the axe over the top three times in four where it has the choice",
    Math.abs(over - 0.75) < 0.04,
    `${(over * 100).toFixed(0)}% overheads at your head or body, ` +
    `${(all * 100).toFixed(0)}% of everything it throws`);

  // More weapon, longer. Swung by an arm scaled to the body carrying it, a
  // metre of ash with 3.65 kg on the end is still slower back, through and
  // up again than a sword: not by a number anybody wrote down, by its weight.
  const sword = median(whole.get("swordsman")!);
  const axe = median(whole.get("orc")!);
  check("a swing of the axe takes longer than a swing of the sword", axe > sword + 0.1,
    `back, through and on guard again: a median ${axe.toFixed(2)}s for the orc's axe, ` +
    `${sword.toFixed(2)}s for the sword`);
}

async function alliesShareAnArenaWithoutCuttingEachOther(): Promise<void> {
  console.log("\nthree fighters, two teams, one set of collision groups -- and the game's nine");
  const sides = makeSides([0, 1, 1]);
  const [you, orc, goblin] = sides;

  // Rapier collides A and B only if each one's membership is in the other's
  // filter, so "can cut" is readable straight off the numbers.
  const canCut = (attacker: typeof you, victim: typeof you) =>
    ((attacker.cuttableFilter >> 16) & (victim.bodyFilter & 0xffff)) !== 0
    && ((victim.bodyFilter >> 16) & (attacker.cuttableFilter & 0xffff)) !== 0;

  check("your weapon reaches both of them",
    canCut(you, orc) && canCut(you, goblin), "player -> orc, player -> goblin");
  check("theirs reach you", canCut(orc, you) && canCut(goblin, you),
    "orc -> player, goblin -> player");
  check("but not each other", !canCut(orc, goblin) && !canCut(goblin, orc),
    "the orc's axe passes through the goblin");
  check("and nobody cuts themselves",
    !canCut(you, you) && !canCut(orc, orc), "own-side bodies are transparent to own blade");

  // The game's own line-up: you, and everything behind the four gates.
  // Five used to be one more than there were bits for; then six were all
  // there were bits for.
  const roster = makeSides([0, ...ROSTER.map(() => 1)]);
  const [me, ...them] = roster;
  const meets = (a: number, b: number) => ((a >>> 16) & (b & 0xffff)) !== 0 && ((b >>> 16) & (a & 0xffff)) !== 0;
  const pairs = them.flatMap((a, i) => them.filter((_, j) => j !== i).map((b) => [a, b] as const));
  check(`${roster.length} fit: your weapon reaches all ${them.length}, theirs reach you and not one another`,
    them.every((t) => canCut(me, t) && canCut(t, me)) && pairs.every(([a, b]) => !canCut(a, b))
      && roster.every((s) => !canCut(s, s)),
    `${them.length} against you, ${pairs.length} pairs of them that must not cut`);
  // Bodies still meet every other body, and weapons every other weapon, but
  // never their own: "everyone but me" with three bits of six each.
  const everyone = roster.flatMap((a, i) => roster.map((b, j) => [a, b, i === j] as const));
  check("every body still meets every other body, and every weapon every other weapon, never its own",
    everyone.every(([a, b, same]) => meets(a.bodyFilter, b.bodyFilter) === !same
      && meets(a.bladeFilter, b.bladeFilter) === !same),
    `${roster.length * (roster.length - 1)} pairs of each, and ${roster.length} of each that must not`);
  check("and every walking hull still bumps into every other, whoever's side it is on",
    roster.every((a, i) => roster.every((b, j) => i === j || meets(a.hullFilter, b.hullFilter))),
    `hull against hull, all ${roster.length * (roster.length - 1)} pairs`);
}

async function resetPutsSeveredLimbsBackOn(): Promise<void> {
  console.log("\nreset puts severed limbs back on");
  const rig = await buildRig();
  rig.step(60);

  const part = (name: string) =>
    rig.foe.fighter.parts.find((p) => p.name === name)!;
  const cut = (handle: number, times: number) => {
    for (let i = 0; i < times; i++) rig.foe.receive(fakeImpact(handle));
  };

  // Take the sword arm and the off arm off first; the head is last because
  // losing it ends the fight and stops anything else registering.
  cut(rig.foe.arm.upper.collider(0)!.handle, 4);
  cut(part("offShoulder").collider.handle, 4);
  cut(part("head").collider.handle, 4);

  check("the foe came apart to begin with",
    rig.foe.arm.disarmed && part("offShoulder").severed === true
      && part("head").severed === true,
    `arm ${rig.foe.arm.severedAt}, off arm and head off`);

  rig.foe.reset(rig.tuning, FOE_HOME);
  rig.ai.reset();
  rig.impacts.resetSweeps();

  const stillOff = ["head", "offShoulder", "offElbow"].filter(
    (n) => part(n).severed === true);
  check("nothing reports itself severed after a reset",
    !rig.foe.arm.disarmed && stillOff.length === 0,
    stillOff.length ? `still flagged severed: ${stillOff.join(", ")}` : "every flag cleared");

  // Flags are cheap. What matters is whether the JOINTS are back: run two
  // seconds of live fight and see whether the parts are still where a body
  // keeps them, or somewhere across the room.
  rig.fight(120);

  // Measure the JOINT, not the limb. The upper arm's centre sits near the
  // shoulder either way, because the drive holds the hand at a target anchored
  // to the shoulder — an arm attached to nothing still hovers roughly where it
  // belongs. What only a joint can do is pin the arm's TOP END to the anchor.
  const shoulder = rig.foe.fighter.shoulderWorld(new THREE.Vector3());
  const upper = rig.foe.arm.upper;
  const r = upper.rotation();
  const p = upper.translation();
  const top = new THREE.Vector3(0, -rig.foe.fighter.build.segment.upperArm.length / 2, 0)
    .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w))
    .add(new THREE.Vector3(p.x, p.y, p.z));
  const armGap = shoulder.distanceTo(top);
  check("the sword arm is pinned to the shoulder, not just hovering there",
    armGap < 0.03,
    `top of the upper arm sits ${(armGap * 1000).toFixed(0)} mm from its anchor`);

  const torso = rig.foe.position(new THREE.Vector3());
  const near = (name: string) => {
    const body = part(name).body!;
    const p = body.translation();
    return torso.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
  };
  check("the head is still on the neck", near("head") < 1.2,
    `head sits ${near("head").toFixed(2)} m from the torso`);
  check("the off arm is still on", near("offShoulder") < 1.2,
    `off arm sits ${near("offShoulder").toFixed(2)} m from the torso`);

  // And it has to be a working fighter again, not a mannequin holding a sword.
  check("it fights again after being put back together",
    rig.foe.arm.state.tipSpeed > 0.5 || rig.ai.intent !== "beaten",
    `intent "${rig.ai.intent}", tip ${rig.foe.arm.state.tipSpeed.toFixed(1)} m/s`);
}

async function everyMovingPartIsInterpolated(): Promise<void> {
  console.log("\nnothing is placed twice, and the posed legs carry their own frames");
  const rig = await buildRig();
  rig.step(60);

  // Anything with a body of its own has to be offered to the interpolator, or
  // it gets placed from the live physics state instead and steps at 60Hz
  // inside a body that does not.
  const withBodies = rig.foe.fighter.parts.filter((p) => p.body !== undefined);
  check("every jointed part is offered to the interpolator",
    withBodies.length > 0 && rig.foe.fighter.jointedParts.length === withBodies.length,
    `${rig.foe.fighter.jointedParts.length} of ${withBodies.length}: ` +
    withBodies.map((p) => p.name).join(", "));

  // The legs are the one thing with no body to read, so they carry their own
  // two poses. Walk, then check that the frame either side of a step differs
  // and that a frame between them lands between them.
  const walk = { ...NO_KEYS, forward: true };
  rig.step(30, walk);

  const hip = (alpha: number) => {
    rig.fighter.applyPose(alpha);
    // The hip pivots hang off the pelvis, alongside the chest -- the other
    // bare Object3D there, and the one that is not a leg.
    const pivots = rig.fighter.pelvis.children.filter(
      (c) => c.type === "Object3D" && c !== rig.fighter.chest);
    return pivots[0].rotation.x;
  };

  rig.step(1, walk);
  const at0 = hip(0);
  const at1 = hip(1);
  const mid = hip(0.5);
  const between = Math.abs(mid - (at0 + at1) / 2) < 1e-6;

  check("a leg's pose differs across one physics step", Math.abs(at1 - at0) > 1e-4,
    `hip swung ${(at1 - at0).toFixed(4)} rad in one step`);
  check("and a frame halfway through lands halfway between", between,
    `alpha 0 ${at0.toFixed(4)}, 0.5 ${mid.toFixed(4)}, 1 ${at1.toFixed(4)}`);
}


/** Which way is into the hall from a gate: the way its lever's front faces. */
function intoHall(g: { lever: { facing: number } }): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.lever.facing);
}

async function theTestingAreaIsAHallAndFourRooms(): Promise<void> {
  console.log("\na hall, and four rooms off it behind gates: two orcs, two kobolds, three goblins, the ogre");
  check("you start in the entrance, and it opens into the hall",
    inRoom(ROOMS.entrance, GAME_SPAWN.x, GAME_SPAWN.z)
      && inRoom(ROOMS.hall, GAME_SPAWN.x, ROOMS.entrance.minZ - 0.5),
    `spawn (${GAME_SPAWN.x}, ${GAME_SPAWN.z}) in ${ROOMS.entrance.name}`);
  check("the practice dummy is in the hall",
    inRoom(ROOMS.hall, DUMMY_AT.x, DUMMY_AT.z),
    `dummy at (${DUMMY_AT.x}, ${DUMMY_AT.z})`);

  const rooms = Object.keys(GATEWAYS) as GatedRoom[];
  const who = (room: GatedRoom) => ROSTER.filter((o) => o.room === room).map((o) => o.species.key).join(", ");
  const home = ROSTER.every((o) => inRoom(ROOMS[o.room], o.at.x, o.at.z) && !inRoom(ROOMS.hall, o.at.x, o.at.z));
  check("two orcs in the pen, two kobolds in the warren, three goblins in the cell, and the ogre in the den",
    home && who("pen") === "orc, orc" && who("warren") === "kobold, kobold"
      && who("cell") === "goblin, goblin, goblin" && who("den") === "ogre",
    rooms.map((r) => `${ROOMS[r].name}: ${who(r)}`).join("; "));
  // A gate in the wall between each room and the hall, and its lever on the
  // hall's side of that wall.
  const between = rooms.every((r) => {
    const g = GATEWAYS[r];
    const out = intoHall(g);
    return inRoom(ROOMS.hall, g.at.x + out.x * 0.5, g.at.z + out.z * 0.5)
      && inRoom(ROOMS[r], g.at.x - out.x * 0.5, g.at.z - out.z * 0.5)
      && inRoom(ROOMS.hall, g.lever.at.x + out.x * 0.3, g.lever.at.z + out.z * 0.3);
  });
  check("each behind a gate out of the hall, with a lever beside it on the hall's side",
    between, rooms.map((r) => `${r} at (${GATEWAYS[r].at.x}, ${GATEWAYS[r].at.z})`).join(", "));

  // And the walls are really there: the layout is only worth anything if a
  // ray from one room to the next is stopped by something.
  const rig = await buildRig();
  rig.step(30);
  const eye = new THREE.Vector3();

  rig.foe.fighter.eyeWorld(eye);
  check("across one room, the line is clear", rig.fighter.sees(eye),
    "the hall, no wall in between");

  // Off the doorway, so it is the wall being tested and not the gate in it.
  const pastTheWall = new THREE.Vector3(-5.5, 1.6, -3.0);
  check("into the next room, it is not", !rig.fighter.sees(pastTheWall),
    "the wall into the warren stops it");

  // The entrance has no door: it is the hall's south end run on.
  rig.place(GAME_SPAWN);
  rig.step(30);
  check("but up the entrance into the hall it is clear",
    rig.fighter.sees(new THREE.Vector3(GAME_SPAWN.x, 1.6, 6)),
    "standing where you start, looking up into the hall");

  // Every doorway has a gate in it: a wall while it is shut, to sight and to
  // the feet's own probe alike, and a doorway once it is up.
  const shut: string[] = [];
  const open: string[] = [];
  for (const r of rooms) {
    const g = rig.arena.gateways[r];
    const out = intoHall(g.spec);
    const inside = new THREE.Vector3(g.spec.at.x - out.x * 3, 1.6, g.spec.at.z - out.z * 3);
    rig.place(new THREE.Vector3(g.spec.at.x + out.x * 2, HOME.y, g.spec.at.z + out.z * 2));
    rig.fighter.yaw = g.spec.lever.facing + Math.PI;
    rig.step(40);
    const shutClear = rig.fighter.clearAlong(-out.x, -out.z, 5);
    if (rig.fighter.sees(inside) || shutClear >= 2.1 || g.gate.opening) {
      shut.push(`${r}: ${shutClear.toFixed(2)} m`);
    }
    g.gate.open();
    let rose = 0;
    while (!g.gate.isOpen && rose < 60 * 6) {
      rig.step(1);
      rose++;
    }
    const openClear = rig.fighter.clearAlong(-out.x, -out.z, 5);
    if (!g.gate.isOpen || !rig.fighter.sees(inside) || openClear !== 5) {
      open.push(`${r}: ${openClear.toFixed(2)} m, up ${g.gate.isOpen}`);
    }
  }
  check("every gate, shut, stops the line and the feet",
    shut.length === 0, shut.join("; ") || "all four: no line through, and under 2.1 m of floor toward it");
  check("and, up, it is a doorway like any other",
    open.length === 0, open.join("; ") || "all four: the line through, and 5 m of floor");
}

/**
 * Where the orc waits in the next two: in the warren, which is as good a room
 * as any to hold a post in -- north of the hall, with its gate in the wall
 * between, as the hall was once north of the training room with a door.
 */
const WARREN_POST = new THREE.Vector3(-1.8, 0, -7.0);

async function anOpponentWaitsUntilItSeesYou(): Promise<void> {
  console.log("\nan opponent that cannot see you holds its post");
  const rig = await buildRig({}, ORC, spawnFor(ORC, WARREN_POST.x, WARREN_POST.z));

  const where = () => rig.foe.position(new THREE.Vector3());
  const start = where();
  for (let i = 0; i < 60 * 4; i++) rig.fight(1);
  const after = where();

  check("it does not come for you through a wall",
    rig.ai.intent === "waiting" && after.distanceTo(start) < 0.2,
    `intent "${rig.ai.intent}", moved ${after.distanceTo(start).toFixed(2)} m in 4s`);
  check("and it does not swing at a wall either",
    rig.foe.arm.state.tipSpeed < 1.5 && rig.ai.committed === null,
    `tip ${rig.foe.arm.state.tipSpeed.toFixed(1)} m/s, committed ` +
    `${rig.ai.committed?.cut.name ?? "nothing"}`);

  // Walk into its room and it is a fight.
  rig.place(new THREE.Vector3(WARREN_POST.x, HOME.y, WARREN_POST.z + 4.5));
  let closest = 99;
  let peakTip = 0;
  for (let i = 0; i < 60 * 8; i++) {
    rig.fight(1);
    const gap = rig.fighter.position(new THREE.Vector3());
    const foeAt = where();
    closest = Math.min(closest, Math.hypot(gap.x - foeAt.x, gap.z - foeAt.z));
    peakTip = Math.max(peakTip, rig.foe.arm.state.tipSpeed);
  }
  check("walk into the room and it comes for you", closest < 2.4,
    `closed to ${closest.toFixed(2)} m once it had the line`);
  check("and swings once it is there", peakTip > 5,
    `peak tip ${peakTip.toFixed(1)} m/s`);
}

async function anOpponentLooksWhereItLastSawYou(): Promise<void> {
  console.log("\nan opponent that loses you looks where it saw you, then goes home");
  const rig = await buildRig({}, ORC, spawnFor(ORC, WARREN_POST.x, WARREN_POST.z));
  const where = () => rig.foe.position(new THREE.Vector3());
  const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

  // It sees you in its room, and then you are on the far side of the wall
  // in the hall. It used to know where for two and a half seconds after, and
  // walked most of the way across its room toward you, into the wall.
  const seenAt = new THREE.Vector3(WARREN_POST.x + 3, HOME.y, WARREN_POST.z + 3.5);
  rig.place(seenAt);
  rig.fight(60);
  rig.place(new THREE.Vector3(-4, HOME.y, 3));
  let south = -Infinity;
  let nearest = Infinity;
  for (let i = 0; i < 60 * 15; i++) {
    rig.fight(1);
    south = Math.max(south, where().z);
    nearest = Math.min(nearest, flat(where(), seenAt));
  }
  check("lost behind a wall, it goes to where it saw you and not to you",
    nearest < 0.8 && south < seenAt.z + 1,
    `came within ${nearest.toFixed(2)} m of where it saw you, ` +
    `and no further toward the wall than z ${south.toFixed(2)}`);
  check("finds nothing there, and goes back to its post",
    rig.ai.intent === "waiting" && flat(where(), WARREN_POST) < 0.3,
    `intent "${rig.ai.intent}", ${flat(where(), WARREN_POST).toFixed(2)} m from its post`);

  // Now, with its gate up, lead it out of its room and into the hall, and
  // vanish. The straight line home from there runs into the wall beside the
  // doorway.
  const led = await buildRig({}, ORC, spawnFor(ORC, WARREN_POST.x, WARREN_POST.z));
  const gate = led.arena.gateways.warren.gate;
  gate.open();
  for (let i = 0; i < 60 * 6 && !gate.isOpen; i++) led.step(1);
  const at = () => led.foe.position(new THREE.Vector3());
  led.place(new THREE.Vector3(GATEWAYS.warren.at.x, HOME.y, -3));
  led.fight(150);
  // How far it got, not where it happens to be at the end: one time in ten,
  // after a swing, it gives ground, and it gave it back into its room once.
  let followed = -Infinity;
  for (let i = 0; i < 132 + 90; i++) {
    led.fight(1, i < 132 ? { ...NO_KEYS, back: true } : NO_KEYS);
    followed = Math.max(followed, at().z);
  }
  // Gone: into the cell, behind its shut gate.
  led.place(new THREE.Vector3(12.4, HOME.y, -6.2));
  led.fight(60 * 20);
  const yaw = led.foe.fighter.yaw;
  const facing = Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw)));
  // Through, not in it: the doorway's far face is at 0.2, and its body is
  // four tenths of a metre across the middle.
  check("backed out through the doorway, it follows you through", followed > 0.5,
    `it got to z ${followed.toFixed(2)}, the hall's side of the doorway`);
  check("and lost there, it goes home the way it came, and faces the way it stood",
    led.ai.intent === "waiting" && flat(at(), WARREN_POST) < 0.3 && facing < 0.1,
    `intent "${led.ai.intent}", ${flat(at(), WARREN_POST).toFixed(2)} m from its post, ` +
    `${(facing * 180 / Math.PI).toFixed(0)}deg off how it stood`);
}

/**
 * The whole line-up, as the game has it -- you and everything behind the four
 * gates (see roster.ts) -- in one arena, and a step that drives them all as
 * the game's does.
 */
async function buildRoster(youAt: THREE.Vector3) {
  const tuning: Tuning = { ...DEFAULTS };
  const scene = new THREE.Scene();
  const phys = await createPhysics(tuning.gravity);
  const targets = new Targets();
  const arena = buildArena(phys, scene, targets);
  const sides = makeSides([0, ...ROSTER.map(() => 1)]);
  const you = new Combatant(phys, scene, youAt, sides[0], tuning, targets, SWORDSMAN, "you", "your");
  const foes = ROSTER.map((o, i) => {
    const combatant = new Combatant(phys, scene, spawnOf(o), sides[i + 1],
      tuning, targets, o.species, o.name, `${o.name}'s`);
    combatant.fighter.yaw = o.facing;
    return { combatant, ai: new Ai(o.species), room: o.room };
  });
  const impacts = new Impacts(phys, scene, targets, tuning);
  let cutsOnYou = 0;
  let cutsAmongThem = 0;
  for (const f of foes) {
    impacts.addBlade(f.combatant.arm, (i) => {
      if (you.receive(i)) cutsOnYou++;
      else if (foes.some((o) => o.combatant.receive(i))) cutsAmongThem++;
    });
  }
  phys.world.updateSceneQueries();
  const still: ArmInput = { consumeMouse: () => ({ dx: 0, dy: 0, wheel: 0, rollDx: 0 }) };
  const gateways = Object.values(arena.gateways);
  let now = 0;
  return {
    phys, arena, you, foes,
    /** Everything that waits in one room. */
    in: (room: GatedRoom) => foes.filter((f) => f.room === room),
    get cutsOnYou() { return cutsOnYou; },
    get cutsAmongThem() { return cutsAmongThem; },
    step(n = 1) {
      for (let k = 0; k < n; k++) {
        you.act(still, NO_KEYS, tuning, STEP);
        for (const f of foes) {
          f.ai.think(f.combatant, you, tuning, STEP);
          f.combatant.act(f.ai, f.ai.keys, tuning, STEP);
        }
        for (const g of gateways) g.gate.step(STEP);
        phys.step();
        for (const g of gateways) g.lever.update();
        you.arm.updateDerived();
        for (const f of foes) f.combatant.arm.updateDerived();
        now += STEP * 1000;
        impacts.update(now);
      }
    },
  };
}

async function thePenOpensOnTwoOrcs(): Promise<void> {
  console.log("\nthe pen: two orcs behind the gate, until it goes up and they come to see why");
  // You by the lever, well inside the distance at which either would notice
  // you, and everything else behind its own gate.
  const lever = GATEWAYS.pen.lever;
  const at = new THREE.Vector3(lever.at.x + 0.8, HOME.y, lever.at.z + 0.3);
  const world = await buildRoster(at);
  const { arena, you } = world;
  const pen = world.in("pen");
  const rest = world.foes.filter((f) => f.room !== "pen");
  const posts = pen.map((f) => f.combatant.position(new THREE.Vector3()));
  const where = (f: { combatant: Combatant }) => f.combatant.position(new THREE.Vector3());
  world.step(60 * 3);

  const near = posts.map((p) => Math.hypot(p.x - at.x, p.z - at.z));
  const stayed = pen.every((f, i) => where(f).distanceTo(posts[i]) < 0.2 && f.ai.outlook === "waiting");
  const facing = pen.every((f, i) => Math.abs(wrap(f.combatant.fighter.yaw - POSTS.pen[i].facing)) < 0.1);
  check("behind the shut gate they hold their posts, facing it: they cannot see you",
    stayed && facing && pen.every((f) => !f.combatant.sees(you)) && near.every((d) => d < 9),
    `${near.map((d) => d.toFixed(1)).join(" and ")} m from you, ` +
    pen.map((f) => `"${f.ai.outlook}"`).join(" and "));

  // The lever thrown, and when the gate starts up whatever can hear it hears
  // it -- as the game wires it.
  let heard = -1;
  const pens = arena.gateways.pen;
  pens.gate.onStart = () => { heard = gateHeard("pen", world.foes); };
  pens.lever.throwOver();
  let listening = false;
  let through = -1;
  let found = -1;
  let swung = false;
  for (let i = 0; i < 60 * 12; i++) {
    world.step(1);
    if (heard >= 0 && !listening) listening = pen.every((f) => f.ai.outlook === "looking");
    if (through < 0 && pen.every((f) => where(f).x > ROOMS.hall.minX + 0.3)) through = i;
    if (found < 0 && pen.every((f) => f.ai.outlook === "fighting")) found = i;
    swung ||= pen.some((f) => f.ai.committed !== null);
  }
  check("the gate going up is heard in the pen, and behind no other gate",
    heard === 2 && listening && rest.every((f) => f.ai.outlook === "waiting"),
    `${heard} heard it; both went to look: ${listening}; the other ${rest.length} ` +
    `${rest.every((f) => f.ai.outlook === "waiting") ? "all still waiting" : "not all waiting"}`);
  check("they come out through the gateway, find you, and fight",
    through >= 0 && found >= 0 && swung,
    `both in the hall after ${(through / 60).toFixed(1)}s, both fighting after ` +
    `${(found / 60).toFixed(1)}s; swung: ${swung}`);
  check("two of them on one side, and not one cut between them",
    world.cutsOnYou > 0 && world.cutsAmongThem === 0,
    `${world.cutsOnYou} cuts on you, ${world.cutsAmongThem} among the ${world.foes.length + 1} of you`);

  // Heard, and nobody there: you down the entrance, round the corner from
  // the gateway. They go and look, find nothing, and go home again.
  const away = await buildRoster(new THREE.Vector3(GAME_SPAWN.x, HOME.y, GAME_SPAWN.z + 2));
  away.step(60 * 2);
  const orcs = away.in("pen");
  const homes = orcs.map((f) => f.combatant.position(new THREE.Vector3()));
  away.arena.gateways.pen.gate.onStart = () => { gateHeard("pen", away.foes); };
  away.arena.gateways.pen.lever.throwOver();
  let left = 0;
  let looked = false;
  for (let i = 0; i < 60 * 30; i++) {
    away.step(1);
    looked ||= orcs.every((f) => f.ai.outlook === "looking");
    left = Math.max(left, ...orcs.map((f, k) => where(f).distanceTo(homes[k])));
  }
  const back = orcs.map((f, k) => where(f).distanceTo(homes[k]));
  check("with nobody to find, they look, give it up, and go back to their posts",
    looked && left > 2 && back.every((d) => d < 0.4) && orcs.every((f) => f.ai.outlook === "waiting"),
    `went ${left.toFixed(1)} m; back to within ${Math.max(...back).toFixed(2)} m of their posts, ` +
    orcs.map((f) => `"${f.ai.outlook}"`).join(" and "));
}

async function severingBleeds(): Promise<void> {
  console.log("\na severed joint bleeds from both faces");
  const rig = await buildRig();
  rig.step(30);

  let event: SeverEvent | null = null;
  rig.dummy.onSever = (e) => { event = e; };
  const fore = rig.dummy.limbs.get("foreArmR")!;
  for (let i = 0; i < 12 && event === null; i++) {
    rig.dummy.receive(fakeImpact(fore.collider.handle));
  }

  const cut = event as SeverEvent | null;
  check("the cut is reported with somewhere to bleed from",
    cut !== null && cut.wound !== undefined && cut.wound.ends?.length === 2,
    cut?.wound ? `${cut.wound.ends?.length} cut faces` : "no wound reported");

  // Both faces have to be attached to something the interpolator moves, or the
  // blood hangs in the air where the arm used to be.
  const ends = cut?.wound?.ends ?? [];
  check("both faces ride on a mesh that is placed every frame",
    ends.length === 2 && ends.every((e) => e.object.parent !== null),
    ends.map((e) => e.object.type).join(", ") || "none");

  // And the pool itself: a wound throws droplets, they fall, and they stop.
  const blood = new Blood(new THREE.Scene());
  blood.wound({
    at: new THREE.Vector3(0, 1.4, 0),
    along: new THREE.Vector3(1, 0, 0),
    ends,
  });
  const thrown = blood.live;
  blood.update(1 / 60);
  const bleeding = blood.bleeding;
  for (let i = 0; i < 60 * 4; i++) blood.update(1 / 60);

  check("a sever throws a burst of droplets", thrown > 20, `${thrown} droplets`);
  check("and the cut faces keep emptying afterwards", bleeding === 2,
    `${bleeding} faces still bleeding`);
  check("it all soaks away eventually", blood.live === 0 && blood.bleeding === 0,
    `${blood.live} droplets left after four seconds`);
}

// -----------------------------------------------------------------------------

// --- the body around the arm ----------------------------------------------------

/**
 * How far the sword arm is inside its own trunk, metres: the elbow, the middle
 * of the forearm and the hand, against the body as it is drawn (see
 * clearance.ts). The arm cannot collide with its own torso, so nothing but the
 * posture and clearance passes keeps this at zero.
 */
function armInTrunk(rig: Rig): number {
  const arm = rig.arm;
  const seg = rig.fighter.build.segment;
  const caps = rig.fighter.trunkCapsules(rig.fighter.posture.pose);
  const uq = arm.upper.rotation();
  const up = arm.upper.translation();
  const elbow = new THREE.Vector3(0, seg.upperArm.length / 2, 0)
    .applyQuaternion(new THREE.Quaternion(uq.x, uq.y, uq.z, uq.w))
    .add(new THREE.Vector3(up.x, up.y, up.z));
  const fp = arm.fore.translation();
  return Math.max(
    intrusion(elbow, seg.foreArm.radius * 1.15, caps, 0),
    intrusion(new THREE.Vector3(fp.x, fp.y, fp.z), seg.foreArm.radius, caps, 0),
    intrusion(arm.handPosition, seg.foreArm.radius * 1.22, caps, 0),
  );
}

/** Settle at a pitch and a reach fraction, with the arm off to the right. */
function windUp(rig: Rig, pitch: number, reach: number): void {
  const [lo, hi] = rig.arm.reachLimits;
  const want = lo + (hi - lo) * reach;
  for (let i = 0; i < 120; i++) {
    const aim = rig.arm.aim;
    rig.input.dx = -(-0.4 - aim.yaw) / rig.tuning.sensitivity * 0.25;
    rig.input.dy = -(pitch - aim.pitch) / rig.tuning.sensitivity * 0.25;
    rig.input.wheel = Math.abs(want - aim.reach) > rig.tuning.reachRate
      ? Math.sign(want - aim.reach) : 0;
    rig.step(1);
  }
}

/** Sweep across the body to the far left, at `rate` rad/s or all at once. */
function sweepAcross(rig: Rig, rate: number | "flick", steps: number, each?: () => void): void {
  const target = Arm.LIMITS.yaw[1];
  for (let i = 0; i < steps; i++) {
    const gap = target - rig.arm.aim.yaw;
    const move = rate === "flick" ? (i === 0 ? gap : 0) : Math.min(gap, rate * STEP);
    rig.input.dx = -move / rig.tuning.sensitivity;
    rig.step(1);
    each?.();
  }
}

async function theArmKeepsOutOfItsOwnChest(): Promise<void> {
  console.log("\nthe sword arm keeps out of its own chest");
  // The arm has no collision with its own body -- it would snag on its own
  // shoulder -- so a cross-body cut went straight through the chest: the
  // designed elbow pole points back, which for an arm aimed across the body
  // is the ribs. Measured before this, twenty centimetres deep.
  const deepest = async (over: Partial<Tuning>, rate: number | "flick") => {
    let worst = 0;
    for (const pitch of [-0.8, -0.3, 0.3]) {
      const rig = await buildRig(over);
      windUp(rig, pitch, 0.5);
      sweepAcross(rig, rate, 100, () => { worst = Math.max(worst, armInTrunk(rig)); });
    }
    return worst;
  };

  const rigid = await deepest({ torsoLead: 0, secondaryMotion: 0, clearance: 0 }, 3);
  const swept = await deepest({}, 3);
  const flicked = await deepest({}, "flick");

  check("without the body's help it goes straight through", rigid > 0.1,
    `${(rigid * 100).toFixed(1)}cm deep with no lead and no clearance (the old behaviour)`);
  check("a cross-body sweep stays out of the chest", swept < 0.01,
    `${(swept * 100).toFixed(1)}cm at worst over three heights (want < 1cm)`);
  check("even a flick only grazes it", flicked < 0.04,
    `${(flicked * 100).toFixed(1)}cm at worst over three heights (want < 4cm)`);

  const rest = await buildRig();
  rest.step(120);
  check("at rest nothing is pushing on the arm", rest.arm.state.clearance === 0,
    `${(rest.arm.state.clearance * 100).toFixed(2)}cm into the body at the guard`);
}

async function aFlickDoesNotSnapTheArm(): Promise<void> {
  console.log("\na flick swings the arm round, it does not snap it");
  // The original snap. A flick to the far left left the arm's swivel more than
  // a quarter turn behind its target; the angular drive then folded the error
  // onto an orientation only a backwards-bent elbow could reach, jammed there
  // saturated while the elbow dragged straight, and at straight -- where the
  // arm's inertia about its own length is nearly nothing -- spun the forearm
  // at 150-170 rad/s.
  const rig = await buildRig();
  windUp(rig, 0.3, 0.5);
  let spin = 0;
  sweepAcross(rig, "flick", 90, () => {
    const q = rig.arm.fore.rotation();
    const along = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    const w = rig.arm.fore.angvel();
    spin = Math.max(spin, Math.abs(w.x * along.x + w.y * along.y + w.z * along.z));
  });
  check("the forearm never spins about its own length", spin < 40,
    `peak ${spin.toFixed(1)} rad/s (it was 150-170)`);
  check("and the arm arrives", rig.arm.state.trackingError < 0.05,
    `tracking error ${rig.arm.state.trackingError.toFixed(3)} m after 1.5s`);
}

/**
 * Where an elbow is round its own arm, read off the forearm's body: the unit
 * direction from the shoulder-to-hand line out to it, into `out`, and how far
 * under that line it hangs, -1..1 -- its share along the arm's own down.
 */
function elbowRound(
  shoulder: THREE.Vector3,
  fore: {
    translation(): { x: number; y: number; z: number };
    rotation(): { x: number; y: number; z: number; w: number };
  },
  half: number, out: THREE.Vector3,
): number {
  const r = fore.rotation();
  const t = fore.translation();
  const along = new THREE.Vector3(0, half, 0)
    .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  const centre = new THREE.Vector3(t.x, t.y, t.z);
  const arm = centre.clone().add(along).sub(shoulder).normalize();
  out.copy(centre).sub(along).sub(shoulder);
  out.addScaledVector(arm, -out.dot(arm)).normalize();
  return out.dot(new THREE.Vector3(0, -1, 0).addScaledVector(arm, arm.y).normalize());
}

async function aRaisedArmDoesNotTurnOver(): Promise<void> {
  console.log("\nraising the hand does not turn the arm over");
  // The elbow hangs toward a pole behind and below the hand, and the pole
  // points away from a spot in front of the chest, a little across it and 24
  // degrees up: almost straight above the guard. Raised through there the
  // elbow had no side of the arm to be on, and went over the top of it to
  // the other -- fifteen degrees in one step of an unhurried raise -- while
  // the blade dipped from upright to below level on its way up.
  const RATE = 0.6;
  const shoulder = new THREE.Vector3();
  const was = new THREE.Vector3();
  const now = new THREE.Vector3();
  const blade = new THREE.Vector3();
  const q = new THREE.Quaternion();
  /** Raise an aim to the top of its range and hold it there, measuring the elbow each step. */
  const raise = (
    rig: Rig, pitch: () => number, lift: (dy: number) => void,
    where: (out: THREE.Vector3) => THREE.Vector3, fore: Parameters<typeof elbowRound>[1],
    each?: () => void,
  ) => {
    const half = rig.fighter.build.segment.foreArm.length / 2;
    let turn = 0;
    let under = 1;
    for (let i = 0; i < 240; i++) {
      if (pitch() < Arm.LIMITS.pitch[1]) lift(-(RATE * STEP) / rig.tuning.sensitivity);
      rig.step(1);
      under = Math.min(under, elbowRound(where(shoulder), fore, half, now));
      if (i > 0) turn = Math.max(turn, now.angleTo(was));
      was.copy(now);
      each?.();
    }
    return { turn: (turn * 180) / Math.PI, under };
  };

  const rig = await buildRig();
  rig.step(60);
  let start = NaN;
  let lowest = 1;
  const sword = raise(rig, () => rig.arm.aim.pitch, (dy) => { rig.input.dy = dy; },
    (out) => rig.fighter.shoulderWorld(out), rig.arm.fore, () => {
      const r = rig.arm.blade.rotation();
      blade.set(0, 1, 0).applyQuaternion(q.set(r.x, r.y, r.z, r.w));
      if (Number.isNaN(start)) start = blade.y;
      lowest = Math.min(lowest, blade.y);
    });
  check("raised from the guard, the elbow goes round a few degrees a step at most",
    sword.turn < 5, `${sword.turn.toFixed(1)} degrees in a step at worst (it was 15)`);
  check("and hangs under the arm all the way up", sword.under > 0,
    `${sword.under.toFixed(2)} under it at worst, where 1 is straight under and -1 straight ` +
    `over the top (it was -1)`);
  check("and the blade goes up with the hand, never down", lowest > start - 0.05,
    `pointing ${lowest.toFixed(2)} up at its lowest, ${start.toFixed(2)} at the guard ` +
    `(it dipped to -0.10)`);

  // The other hand's pole points away from a spot as far across the body the
  // other way, as high up: raised through it empty, its elbow swung 31.
  const other = await buildRig();
  other.step(60);
  const off = other.player.offArm;
  other.input.guarding = true;
  for (let i = 0; i < 120; i++) {
    other.input.offDx = -(-0.34 - off.aimNow.yaw) / other.tuning.sensitivity * 0.25;
    other.input.offDy = -(-0.4 - off.aimNow.pitch) / other.tuning.sensitivity * 0.25;
    other.step(1);
  }
  const empty = raise(other, () => off.aimNow.pitch, (dy) => { other.input.offDy = dy; },
    (out) => other.fighter.offShoulderWorld(out), other.fighter.offLimb.fore);
  check("nor does the other hand, raised empty",
    empty.turn < 5 && empty.under > 0,
    `${empty.turn.toFixed(1)} degrees in a step at worst (it was 31), ` +
    `${empty.under.toFixed(2)} under the arm (it was -1)`);
}

async function slowInputIsUntouched(): Promise<void> {
  console.log("\nintent reaches the arm untouched, and a flick is only rounded off");
  const rig = await buildRig();
  rig.step(60);

  // A brisk drag, 3 rad/s: nothing about this may lag.
  let worst = 0;
  for (let i = 0; i < 30; i++) {
    rig.input.dx = -(3 * STEP) / rig.tuning.sensitivity;
    rig.step(1);
    if (i >= 3) worst = Math.max(worst, Math.abs(rig.arm.postureDrive()!.yaw - rig.arm.aim.yaw));
  }
  check("a drag passes straight through", worst < 1e-9,
    `followed intent within ${worst.toExponential(1)} rad of the mouse`);

  // A flick: two radians in one frame. It is spread over a few frames, not
  // dropped, and not slowed for long -- a real arm needs about as long to get
  // round anyway, which is the point of rounding it off.
  rig.input.dx = (2 / rig.tuning.sensitivity);
  let arrived = -1;
  for (let i = 0; i < 60 && arrived < 0; i++) {
    rig.step(1);
    if (Math.abs(rig.arm.postureDrive()!.yaw - rig.arm.aim.yaw) < 0.01) arrived = i + 1;
  }
  check("a flick arrives within a few frames", arrived > 0 && arrived <= 18,
    `followed intent caught the mouse in ${arrived} steps (${(arrived * STEP * 1000).toFixed(0)} ms)`);
}

async function theChestLeadsTheArm(): Promise<void> {
  console.log("\nthe chest turns ahead of the arm, the hips behind it");
  const rig = await buildRig();
  windUp(rig, -0.3, 0.5);

  const chest: number[] = [];
  const hips: number[] = [];
  const handX: number[] = [];
  const p = new THREE.Vector3();
  sweepAcross(rig, 6, 120, () => {
    chest.push(rig.fighter.posture.pose.chestYaw);
    hips.push(rig.fighter.posture.pose.pelvis);
    // The hand across the hull's own centre line: +X is the sword side.
    rig.fighter.position(p);
    const yaw = rig.fighter.yaw;
    const dx = rig.arm.handPosition.x - p.x;
    const dz = rig.arm.handPosition.z - p.z;
    handX.push(dx * Math.cos(yaw) - dz * Math.sin(yaw));
  });

  // Both start wound back the other way -- the arm was held out to the right,
  // and a body turns away with a backswing -- so progress is measured from
  // where each started, not from square.
  const progress = (series: number[], i: number) =>
    (series[i] - series[0]) / (series[series.length - 1] - series[0]);
  const crossed = handX.findIndex((x) => x < 0);
  const chestThen = crossed > 0 ? progress(chest, crossed) : 0;
  const hipsThen = crossed > 0 ? progress(hips, crossed) : 1;
  check("the chest is more than half turned by the time the hand crosses it",
    crossed > 0 && chestThen > 0.5,
    `chest ${(chestThen * 100).toFixed(0)}% of the way round when the hand crossed (step ${crossed})`);
  check("the hips lag well behind it", hipsThen < chestThen * 0.6,
    `hips ${(hipsThen * 100).toFixed(0)}% of the way round at the same moment`);
  check("the hips still get there", hips[hips.length - 1] > 0.15,
    `hips turned ${hips[hips.length - 1].toFixed(2)} rad, chest ${chest[chest.length - 1].toFixed(2)} rad`);
}

async function theFeetStayPlantedThenStep(): Promise<void> {
  console.log("\nthe feet stay planted under a turn, then step");
  const rig = await buildRig();
  rig.step(60);
  const start = rig.fighter.feet.map((f) => f.yaw);

  let bothUp = false;
  let movedEarly = 0;
  let steps = 0;
  let wasUp = [false, false];
  windUp(rig, -0.3, 0.5);
  sweepAcross(rig, 6, 150, () => {
    const feet = rig.fighter.feet;
    if (feet[0].stepping && feet[1].stepping) bothUp = true;
    feet.forEach((f, i) => { if (f.stepping && !wasUp[i]) steps++; });
    wasUp = feet.map((f) => f.stepping);
    if (rig.fighter.posture.pose.pelvis < 0.15) {
      movedEarly = Math.max(movedEarly, ...feet.map((f, i) => Math.abs(f.yaw - start[i])));
    }
  });
  const facing = rig.fighter.yaw + rig.fighter.posture.pose.pelvis;
  const off = Math.max(...rig.fighter.feet.map((f) => Math.abs(f.yaw - facing)));

  check("a planted foot does not skate while the hips turn over it", movedEarly < 1e-6,
    `feet moved ${movedEarly.toFixed(4)} rad before the hips had turned far`);
  check("held long enough, both feet step round", steps >= 2 && off < 0.12,
    `${steps} step(s); feet within ${off.toFixed(2)} rad of the hips`);
  check("only one foot is ever off the floor", !bothUp, bothUp ? "both at once" : "one at a time");
}

async function theKneesBendLikeAPersons(): Promise<void> {
  console.log("\nthe knees bend forward, not back");
  // A human knee comes forward of the line from hip to ankle as it bends; a
  // horse's hind leg (which is what a sign slip gives you) goes behind it.
  // Measured in the pelvis's frame, where forward is -Z, across a walk and a
  // jump -- the stride and the tuck bend the knee from different code.
  const rig = await buildRig();
  rig.step(30);
  const pelvis = rig.fighter.pelvis;
  const legs = () => pelvis.children
    .filter((c) => c.type === "Object3D" && c !== rig.fighter.chest)
    .map((hipPivot) => {
      // The knee pivot is the hip pivot's bare Object3D child; the shin mesh
      // hangs half its length below it.
      const knee = hipPivot.children.find((c) => c.type === "Object3D")!;
      const shin = knee.children[0];
      const h = pelvis.worldToLocal(hipPivot.getWorldPosition(new THREE.Vector3()));
      const k = pelvis.worldToLocal(knee.getWorldPosition(new THREE.Vector3()));
      const a = pelvis.worldToLocal(
        knee.localToWorld(new THREE.Vector3(0, shin.position.y * 2, 0)));
      // How far the knee sits ahead of the straight hip-ankle line, square
      // to it in the side view, so it stays sound however high the foot is.
      const uy = a.y - h.y, uz = a.z - h.z;
      const vy = k.y - h.y, vz = k.z - h.z;
      return (uy * vz - uz * vy) / Math.hypot(uy, uz);
    });

  let forward = 0;
  let backward = 0;
  const sample = () => {
    rig.fighter.applyPose(1);
    for (const ahead of legs()) {
      forward = Math.max(forward, ahead);
      backward = Math.max(backward, -ahead);
    }
  };
  for (let i = 0; i < 120; i++) { rig.step(1, { ...NO_KEYS, forward: true }); sample(); }
  for (let i = 0; i < 8; i++) { rig.step(1, { ...NO_KEYS, jump: true }); sample(); }
  for (let i = 0; i < 40; i++) { rig.step(1); sample(); }

  check("a bent knee comes forward of the hip-ankle line", forward > 0.05,
    `up to ${(forward * 100).toFixed(1)}cm ahead`);
  check("no knee ever bends backward", backward < 0.002,
    `at most ${(backward * 100).toFixed(2)}cm behind`);
}

async function stoppingPutsTheFeetDown(): Promise<void> {
  console.log("\nstop walking and both feet come down");
  // The stride is posed from how far the body has walked, so it used to stop
  // wherever the walking did: stand still mid-step and you stood on one leg,
  // the other knee bent and its foot a third of a metre off the floor, for as
  // long as you cared to stand there. Every opponent between two steps of its
  // footwork did the same. Stopped anywhere in a stride, both feet have to be
  // back on the floor a moment later, and a body that has never walked stands
  // on straight legs.
  const rig = await buildRig();
  const pelvis = rig.fighter.pelvis;
  const legs = () => {
    rig.fighter.applyPose(1);
    return pelvis.children
      .filter((c) => c.type === "Object3D" && c !== rig.fighter.chest)
      .map((hipPivot) => {
        const knee = hipPivot.children.find((c) => c.type === "Object3D")!;
        const shin = knee.children[0];
        const ankle = knee.localToWorld(new THREE.Vector3(0, shin.position.y * 2, 0));
        return { bend: Math.abs(knee.rotation.x), ankle: ankle.y };
      });
  };
  rig.step(30);
  const fresh = legs();
  const freshBend = Math.max(...fresh.map((l) => l.bend));

  let lift = 0;
  let bend = 0;
  let midStride = 0;
  // Stopped at six different points in a stride.
  for (const walk of [9, 12, 15, 18, 21, 24]) {
    for (let i = 0; i < walk; i++) rig.step(1, { ...NO_KEYS, forward: true });
    const [a, b] = legs();
    midStride = Math.max(midStride, Math.abs(a.ankle - b.ankle));
    rig.step(20);
    const [c, d] = legs();
    lift = Math.max(lift, Math.abs(c.ankle - d.ankle));
    bend = Math.max(bend, c.bend, d.bend);
  }

  check("a body that has never walked stands on straight legs", freshBend < 0.05,
    `knees bent ${freshBend.toFixed(2)} rad at the spawn`);
  check("stopped mid-stride, both feet are down a third of a second later",
    midStride > 0.1 && lift < 0.02 && bend < 0.1,
    `a foot ${(midStride * 100).toFixed(0)}cm up while walking; stopped, ` +
    `${(lift * 100).toFixed(1)}cm between the feet and knees within ${bend.toFixed(2)} rad`);
}

/**
 * Each foot's sole -- the far end of its shin -- in the world and in the
 * hull's own frame (+X right, -Z ahead), left then right, as drawn this step.
 */
function soles(f: Fighter): { world: THREE.Vector3; local: THREE.Vector3 }[] {
  f.applyPose(1);
  return f.pelvis.children
    .filter((c) => c.type === "Object3D" && c !== f.chest)
    .map((hipPivot) => {
      const knee = hipPivot.children.find((c) => c.type === "Object3D")!;
      const shin = knee.children[0];
      const world = knee.localToWorld(new THREE.Vector3(0, shin.position.y * 2, 0));
      return { world, local: f.mesh.worldToLocal(world.clone()) };
    });
}

async function turningOnTheSpotSteps(): Promise<void> {
  console.log("\nturning on the spot, the feet step round after the hips");
  // A and D used to turn the body over feet that turned with it, flat on the
  // floor: a figure on a turntable. The feet stay where they are put now --
  // pointing where they pointed, standing where they stood -- and step round
  // after the hips, one and then the other, for as long as the turn goes on.
  const rig = await buildRig();
  rig.step(60);
  const f = rig.fighter;
  const floor = Math.min(...soles(f).map((s) => s.world.y));

  const steps = [0, 0];
  let wasUp = [false, false];
  let bothUp = false;
  let skate = 0;
  let swivel = 0;
  let twist = 0;
  let first = 0;
  let high = 0;
  const put: (THREE.Vector3 | null)[] = [null, null];
  const aim: (number | null)[] = [null, null];
  // Two seconds of A, from standing.
  for (let i = 0; i < 120; i++) {
    rig.step(1, { ...NO_KEYS, turnLeft: true });
    const feet = f.feet;
    const at = soles(f);
    const facing = f.yaw + f.posture.pose.pelvis;
    feet.forEach((foot, k) => {
      if (foot.stepping && !wasUp[k]) steps[k]++;
      first = Math.max(first, Math.abs(foot.yaw - facing));
      if (foot.stepping) {
        high = Math.max(high, at[k].world.y - floor);
        put[k] = null;
        aim[k] = null;
        return;
      }
      // Planted: from one step to the next it goes nowhere. The first round
      // is left out, while the turn gets going.
      if (put[k] === null || i < 40) {
        put[k] = at[k].world.clone();
        aim[k] = foot.yaw;
        return;
      }
      skate = Math.max(skate, Math.hypot(at[k].world.x - put[k]!.x, at[k].world.z - put[k]!.z));
      swivel = Math.max(swivel, Math.abs(foot.yaw - aim[k]!));
      twist = Math.max(twist, Math.abs(foot.yaw - facing));
    });
    if (feet[0].stepping && feet[1].stepping) bothUp = true;
    wasUp = feet.map((foot) => foot.stepping);
  }
  // Let go: the feet come round square under the hips.
  rig.step(60);
  const facing = f.yaw + f.posture.pose.pelvis;
  const off = Math.max(...f.feet.map((foot) => Math.abs(foot.yaw - facing)));

  check("held on the spot, the feet step round after the body, one and then the other",
    steps[0] >= 3 && steps[1] >= 3 && Math.abs(steps[0] - steps[1]) <= 1 && !bothUp,
    `${steps[0]} steps left, ${steps[1]} right in two seconds, ${bothUp ? "both up at once" : "one at a time"}`);
  check("a stepping foot comes up off the floor where you can see it", high > 0.04,
    `up to ${(high * 100).toFixed(1)} cm`);
  check("a planted foot stays where it was put while the hips go round over it",
    skate < 0.01 && swivel < 1e-6,
    `moved ${(skate * 100).toFixed(2)} cm and turned ${swivel.toFixed(4)} rad on the floor`);
  // From standing, both feet start behind the turn, and the second waits out
  // the whole of the first step: that is the most a leg is ever twisted, and
  // it must still be short of where the hip stops it and the foot is dragged.
  check("the feet keep up: no leg twisted round in its hip, not even at the start",
    twist < 0.3 && first < 0.699,
    `at most ${twist.toFixed(2)} rad off the hips once going, ${first.toFixed(2)} waiting on the first step`);
  check("let go, the feet come square under the hips", off < 0.2,
    `within ${off.toFixed(2)} rad`);
}

async function theLegsGoTheWayTheBodyDoes(): Promise<void> {
  console.log("\nthe legs step the way the body goes: sideways, and back");
  // The stride used to be the same forward walk whichever way the keys sent
  // the body: a sidestep slid along on legs walking ahead, and backing off
  // was a moonwalk. A foot in the air should be going the way the body is.
  // Measured in the hull's frame, where a foot on the floor goes backward
  // against the way of going and a foot in the air goes with it -- the
  // higher of the two, since a straight leg swung out lifts its foot a
  // little at either end of a stride, which says nothing.
  const going = async (keys: Partial<Keys>) => {
    const rig = await buildRig();
    rig.step(60);
    const f = rig.fighter;
    const floor = Math.min(...soles(f).map((s) => s.world.y));
    let was = soles(f);
    let withIt = 0;
    let againstIt = 0;
    let narrow = Infinity;
    let wide = -Infinity;
    let apart = 0;
    let lowest = 0;
    let hips = 0;
    for (let i = 0; i < 90; i++) {
      rig.step(1, { ...NO_KEYS, ...keys });
      const now = soles(f);
      if (i >= 20) {
        const way = new THREE.Vector3(
          (keys.right ? 1 : 0) - (keys.left ? 1 : 0), 0,
          (keys.back ? 1 : 0) - (keys.forward ? 1 : 0)).normalize();
        const up = now[0].world.y > now[1].world.y ? 0 : 1;
        if (now[up].world.y - Math.max(floor, now[1 - up].world.y) > 0.02) {
          const along = now[up].local.clone().sub(was[up].local).dot(way);
          if (along > 0) withIt += along; else againstIt -= along;
        }
        const gap = now[1].local.x - now[0].local.x;
        narrow = Math.min(narrow, gap);
        wide = Math.max(wide, gap);
        apart = Math.max(apart, Math.abs(now[1].local.z - now[0].local.z));
        lowest = Math.max(lowest, Math.min(now[0].world.y, now[1].world.y) - floor);
        hips = Math.max(hips, Math.abs(f.posture.pose.hipSwing));
      }
      was = now;
    }
    return { withIt, againstIt, narrow, wide, apart, lowest, hips };
  };

  const right = await going({ right: true });
  const left = await going({ left: true });
  check("sidestepping, a lifted foot goes the way the body is going",
    right.withIt > 5 * right.againstIt && left.withIt > 5 * left.againstIt,
    `right ${(right.withIt * 100).toFixed(0)} cm with it, ${(right.againstIt * 100).toFixed(0)} against; ` +
    `left ${(left.withIt * 100).toFixed(0)} with, ${(left.againstIt * 100).toFixed(0)} against`);
  check("the feet go wide and come back together, and never cross",
    Math.min(right.narrow, left.narrow) > 0.1 && Math.min(right.wide, left.wide) > 0.4,
    `between ${(Math.min(right.narrow, left.narrow) * 100).toFixed(0)} and ` +
    `${(Math.min(right.wide, left.wide) * 100).toFixed(0)} cm apart`);
  check("side by side, not one ahead of the other, and the hips square",
    Math.max(right.apart, left.apart) < 0.12 && Math.max(right.hips, left.hips) < 0.02,
    `at most ${(Math.max(right.apart, left.apart) * 100).toFixed(1)} cm ahead of each other; ` +
    `the hips swing ${Math.max(right.hips, left.hips).toFixed(3)} rad`);
  check("and one foot is always on the floor", Math.max(right.lowest, left.lowest) < 0.02,
    `the lower foot at most ${(Math.max(right.lowest, left.lowest) * 100).toFixed(1)} cm up`);

  // Walking ahead the knee bends early, pushing off behind, so the foot is
  // already coming up while it is still going back: most of the way, not
  // all of it. Backing up it comes up on the way back, and only then.
  const ahead = await going({ forward: true });
  const back = await going({ back: true });
  check("backing up, the foot in the air goes back, as walking ahead it goes forward",
    ahead.withIt > ahead.againstIt && back.withIt > 5 * back.againstIt,
    `ahead ${(ahead.withIt * 100).toFixed(0)} cm with it, ${(ahead.againstIt * 100).toFixed(0)} against; ` +
    `back ${(back.withIt * 100).toFixed(0)} with, ${(back.againstIt * 100).toFixed(0)} against`);
}

async function theBodyAgreesWithItsProbes(): Promise<void> {
  console.log("\nthe body the probes assume is the body you get");
  // An opponent aims by asking the arm's kinematic probes where its weapon
  // would be. They solve with the posture a held aim SETTLES into, so once the
  // live body has settled the two must be the same shoulder.
  const rig = await buildRig();
  rig.step(30);
  aimAngles(rig, 1.2, -0.2, 150);
  const live = rig.fighter.shoulderWorld(new THREE.Vector3());
  const pose = rig.fighter.posture.steady(rig.arm.aim.yaw, rig.arm.aim.pitch, rig.tuning,
    new Pose());
  const steady = rig.fighter.shoulderWorldFor(pose, new THREE.Vector3());
  check("a held aim settles to the shoulder the probes predict",
    live.distanceTo(steady) < 0.01,
    `${(live.distanceTo(steady) * 100).toFixed(2)}cm apart`);

  // What a blade hits and what the arm keeps out of are one chest.
  const c = rig.fighter.collider.translation();
  const [chest] = rig.fighter.trunkCapsules(rig.fighter.posture.pose);
  const mid = chest.a.clone().add(chest.b).multiplyScalar(0.5);
  check("the torso's collider turns with the drawn chest",
    mid.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) < 0.005,
    `${(mid.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) * 1000).toFixed(1)}mm apart`);

  // And the head follows the blade across.
  check("the head turns to watch the blade", rig.fighter.posture.gazeYaw > 0.1,
    `gaze ${rig.fighter.posture.gazeYaw.toFixed(2)} rad to the left of the chest`);
}

async function thePostureIsInterpolated(): Promise<void> {
  console.log("\nthe trunk is eased between steps like everything else");
  const rig = await buildRig();
  windUp(rig, -0.3, 0.5);
  sweepAcross(rig, 6, 6);
  const chestYaw = (alpha: number) => {
    rig.fighter.applyPose(alpha);
    return rig.fighter.chest.rotation.y + rig.fighter.pelvis.rotation.y;
  };
  const a0 = chestYaw(0);
  const a1 = chestYaw(1);
  const mid = chestYaw(0.5);
  check("the chest moves within a step and lands halfway at half a step",
    Math.abs(a1 - a0) > 1e-3 && Math.abs(mid - (a0 + a1) / 2) < 1e-6,
    `alpha 0 ${a0.toFixed(4)}, 0.5 ${mid.toFixed(4)}, 1 ${a1.toFixed(4)}`);
}

// --- the grip ----------------------------------------------------------------------

async function theWeaponsWeighWhatTheyShould(): Promise<void> {
  console.log("\na weapon's inertia is where its iron is, about every axis");
  // Rapier adds up a body's colliders with the parallel-axis term the wrong
  // way round, which gave the two-part weapons inertia about their own length
  // that no rod has. The weapon body now carries mass properties worked out
  // in weapons.ts instead; these hold it to them.
  const bodyOf = async (weapon: typeof SWORD) => {
    const rig = await buildRig({}, { ...SWORDSMAN, weapon }, FOE_HOME);
    rig.step(1);
    return rig.foe.arm.blade;
  };

  const sword = await bodyOf(SWORD);
  const expected = weaponMassProperties(SWORD);
  const p = sword.principalInertia();
  const off = Math.max(
    Math.abs(p.x - expected.principal.x) / expected.principal.x,
    Math.abs(p.y - expected.principal.y) / expected.principal.y,
    Math.abs(p.z - expected.principal.z) / expected.principal.z);
  // A single part is the one case Rapier always got right: agreeing with it
  // there is what says the shapes are worked out the way it works them out.
  check("a one-part sword comes out exactly as Rapier had it", off < 0.01,
    `principal (${p.x.toFixed(5)}, ${p.y.toFixed(5)}, ${p.z.toFixed(5)}), within ${(off * 100).toFixed(2)}%`);

  const spear = weaponMassProperties(SPEAR);
  check("a spear rolls in the hand like a shaft, not a pole", spear.twist < 0.001,
    `${spear.twist.toFixed(5)} kg·m² about its length (Rapier had 0.265)`);

  const axe = weaponMassProperties(AXE);
  const across = Math.min(axe.principal.x, Math.max(axe.principal.y, axe.principal.z));
  check("an axe is harder to twist than a sword, and far easier than to swing",
    axe.twist > weaponMassProperties(SWORD).twist * 10 && axe.twist < across / 10,
    `twist ${axe.twist.toFixed(4)} kg·m² against a swing of ${across.toFixed(3)}`);

  const spearBody = await bodyOf(SPEAR);
  check("and the weapon weighs what it says", Math.abs(spearBody.mass() - SPEAR.mass) < 1e-3,
    `${spearBody.mass().toFixed(3)} kg (declared ${SPEAR.mass})`);
}

async function theGripKeepsTheEdge(): Promise<void> {
  console.log("\nthe forearm twists to keep the edge where it was asked");
  const edgeOf = (rig: Rig) => {
    const q = rig.arm.blade.rotation();
    return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  };
  const axisOf = (rig: Rig) => {
    const q = rig.arm.blade.rotation();
    return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  };

  // Nothing for it to do at rest: the grip is square and the weapon sits
  // exactly where it sat when it was welded on.
  const rest = await buildRig();
  rest.step(120);
  check("with the body out of the way, the grip stays square",
    Math.abs(rest.arm.state.twist) < 0.035,
    `grip turned ${(rest.arm.state.twist * 180 / Math.PI).toFixed(1)}deg at the guard`);

  // Roll the edge toward the chest from the guard. The elbow meets the ribs
  // and stops; the forearm turns the rest of the way.
  const rollIn = async (over: Partial<Tuning>) => {
    const rig = await buildRig(over);
    rig.step(120);
    const before = edgeOf(rig);
    rig.input.rollDx = 140;
    rig.step(1);
    rig.step(110);
    return { rig, turned: Math.acos(Math.min(1, Math.abs(before.dot(edgeOf(rig))))) };
  };
  const kept = await rollIn({});
  const free = await rollIn({ clearance: 0 });
  check("a roll toward the chest turns the edge all the way",
    Math.abs(kept.turned - free.turned) < 0.15,
    `edge turned ${(kept.turned * 180 / Math.PI).toFixed(0)}deg; with the elbow let into ` +
    `the ribs it turns ${(free.turned * 180 / Math.PI).toFixed(0)}deg`);
  check("without the body pushing back or the hand moving",
    kept.rig.arm.state.clearance === 0 && kept.rig.arm.state.trackingError < 0.01,
    `body pushing ${(kept.rig.arm.state.clearance * 100).toFixed(1)}cm, ` +
    `hand ${(kept.rig.arm.state.trackingError * 100).toFixed(1)}cm off, ` +
    `grip turned ${(kept.rig.arm.state.twist * 180 / Math.PI).toFixed(0)}deg`);

  // Across the body the clearance has to move the elbow, which used to take
  // the edge sixty degrees round with it. Laid square to where the blade
  // actually points, the edge is now the one the aim asked for.
  const hold = async (over: Partial<Tuning>) => {
    const rig = await buildRig(over);
    rig.step(60);
    aimAngles(rig, 1.4, -0.3, 180);
    return rig;
  };
  const cleared = await hold({});
  const asked = await hold({ clearance: 0 });
  const axis = axisOf(cleared);
  const want = edgeOf(asked).addScaledVector(axis, -edgeOf(asked).dot(axis)).normalize();
  const miss = Math.acos(Math.min(1, Math.abs(edgeOf(cleared).dot(want))));
  check("an elbow moved out of the ribs no longer takes the edge with it",
    miss < 0.09 && Math.abs(cleared.arm.state.twist) > 0.35,
    `edge ${(miss * 180 / Math.PI).toFixed(1)}deg from the one asked for, ` +
    `the grip turned ${(cleared.arm.state.twist * 180 / Math.PI).toFixed(0)}deg to do it`);
}

async function theWristKeepsTheLine(): Promise<void> {
  console.log("\nthe wrist points the blade where the aim asked");
  const forearmOf = (rig: Rig) => {
    const q = rig.arm.fore.rotation();
    return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  };
  const bladeOf = (rig: Rig) => {
    const q = rig.arm.blade.rotation();
    return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  };
  const deg = (r: number) => (r * 180 / Math.PI).toFixed(0);

  // Nothing to do at the guard: the weapon continues the forearm, as welded.
  const rest = await buildRig();
  rest.step(120);
  check("at the guard the wrist is straight", rest.arm.state.wrist < 0.035,
    `wrist bent ${(rest.arm.state.wrist * 180 / Math.PI).toFixed(1)}deg at the guard`);

  // Across the body the clearance swivels the elbow out of the ribs, and the
  // forearm -- which the weapon used to continue -- points somewhere else:
  // at the far end of a cut, back over the other shoulder. With the elbow let
  // into the ribs the forearm points where the aim asked, so that arm's blade
  // is the line to hold.
  const hold = async (over: Partial<Tuning>, yaw: number) => {
    const rig = await buildRig(over);
    rig.step(60);
    aimAngles(rig, yaw, -0.3, 180);
    return rig;
  };
  for (const yaw of [1.1, 1.5]) {
    const cleared = await hold({}, yaw);
    const asked = await hold({ clearance: 0 }, yaw);
    const moved = forearmOf(cleared).angleTo(forearmOf(asked));
    const off = bladeOf(cleared).angleTo(bladeOf(asked));
    check(`across the body (yaw ${yaw}) the blade keeps the line the elbow lost`,
      moved > 0.5 && off < 0.14 && cleared.arm.state.trackingError < 0.01,
      `forearm ${deg(moved)}deg off the line, blade ${deg(off)}deg, wrist bent ` +
      `${deg(cleared.arm.state.wrist)}deg, hand ${(cleared.arm.state.trackingError * 100).toFixed(1)}cm off`);
  }
}

/**
 * How far the grip is turned as its stop counts it, radians.
 *
 * `state.twist` is the turn about the weapon's own length, which is what the
 * grip is driven by. The joint's stop holds the turn's share of the hand's
 * whole rotation instead, and the two agree only with the wrist straight: bent
 * fifty-six degrees, the orc's axe hard against its stop and no further read
 * 109 on the first count. So a grip is held to its stop on the stop's own.
 */
function gripTurn(arm: Arm): number {
  const f = arm.fore.rotation();
  const b = arm.blade.rotation();
  const rel = new THREE.Quaternion(f.x, f.y, f.z, f.w).invert()
    .multiply(new THREE.Quaternion(b.x, b.y, b.z, b.w));
  return 2 * Math.asin(Math.min(1, Math.abs(rel.y)));
}

async function noGripSpinsUnderAbuse(): Promise<void> {
  console.log("\nnothing spins in the hand, whoever is holding it");
  // With the weapons' inertia about their own length finally right -- a
  // spear's is a sixteen-hundredth of what Rapier had -- and the grip free to
  // turn, the arm's roll lost the phantom mass that had been steadying it.
  // A freshly spawned goblin spun its spear at 900 rad/s. Ten seconds of the
  // worst input there is, for each of them.
  for (const species of [SWORDSMAN, ORC, GOBLIN]) {
    const rig = await buildRig({}, species, FOE_HOME);
    let rand = 12345;
    const next = () => (rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let spin = 0;
    let turn = 0;
    let bend = 0;
    const q = new THREE.Quaternion();
    for (let i = 0; i < 600; i++) {
      const move = { dx: (next() - 0.5) * 600, dy: (next() - 0.5) * 600,
        wheel: next() > 0.9 ? 1 : next() < 0.1 ? -1 : 0, rollDx: (next() - 0.5) * 220 };
      rig.foe.act({ consumeMouse: () => move }, NO_KEYS, rig.tuning, STEP);
      rig.step(1);
      const r = rig.foe.arm.blade.rotation();
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q.set(r.x, r.y, r.z, r.w));
      const w = rig.foe.arm.blade.angvel();
      spin = Math.max(spin, Math.abs(w.x * axis.x + w.y * axis.y + w.z * axis.z));
      turn = Math.max(turn, gripTurn(rig.foe.arm));
      bend = Math.max(bend, rig.foe.arm.state.wrist);
    }
    // The wrist's stop is 60 degrees about each of its two axes, so a bend
    // across both corners of it is a little more.
    check(`${species.name}'s weapon stays in hand`, spin < 100 && turn < 1.65 && bend < 1.3,
      `peak spin about its length ${spin.toFixed(0)} rad/s, grip never past ` +
      `${(turn * 180 / Math.PI).toFixed(0)}deg, wrist never past ${(bend * 180 / Math.PI).toFixed(0)}deg`);
  }
}

// --- impact: what a blow does to a body that has to stay up -------------------

/** How far a body is tipped off upright, degrees. */
function tiltOf(body: { rotation(): { x: number; y: number; z: number; w: number } }): number {
  const r = body.rotation();
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (r.x * r.x + r.z * r.z)))) * 180 / Math.PI;
}

/** A new swing every call unless a test says otherwise: each gets its own time. */
let blowClock = 1e6;

/**
 * A blow with real weight behind it -- your own sword and arm, as the solver
 * has them -- driving along -Z into a fighter's chest collider at a given
 * fraction of its height. On the flat unless a test says otherwise, so it
 * pushes without cutting: what these measure is the push.
 */
function blowOn(rig: Rig, target: Combatant, closing: number, height: number,
  over: Partial<Impact> = {}): Impact {
  const p = target.position(new THREE.Vector3());
  const b = target.fighter.build;
  blowClock += 1000;
  return fakeImpact(target.fighter.collider.handle, {
    closingSpeed: closing, edgeAlign: 0,
    at: new THREE.Vector3(p.x, p.y - b.hullCentreY + b.standing.crown * height, p.z),
    into: new THREE.Vector3(0, 0, -1),
    bladeVelocity: new THREE.Vector3(0, 0, -closing),
    blowMass: rig.arm.liveWeaponMass + rig.arm.armBehind,
    blade: rig.arm.bladeCollider.handle,
    time: blowClock,
    ...over,
  });
}

/** How far the top of a fighter's sword arm is from the shoulder it hangs off, metres. */
function shoulderGap(c: Combatant): number {
  const shoulder = c.fighter.shoulderWorld(new THREE.Vector3());
  const r = c.arm.upper.rotation();
  const p = c.arm.upper.translation();
  const top = new THREE.Vector3(0, -c.fighter.build.segment.upperArm.length / 2, 0)
    .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w))
    .add(new THREE.Vector3(p.x, p.y, p.z));
  return shoulder.distanceTo(top);
}

async function oneBlowThreeBodies(): Promise<void> {
  console.log("\nthe same blow on three bodies: a goblin goes over, a man is shoved, an orc stands");
  // One swing -- your sword, 8 m/s into the upper chest, on the flat so that
  // nothing is cut -- on each of the three, and what each body then does.
  const seen = new Map<string, {
    effect: string; speed: number; mass: number; moved: number; tilt: number;
  }>();
  for (const species of [GOBLIN, SWORDSMAN, ORC]) {
    const rig = await buildRig({}, species, foeSpawn(species));
    rig.hold(60);
    const start = rig.foe.position(new THREE.Vector3());
    rig.foe.receive(blowOn(rig, rig.foe, 8, 0.75));
    const { effect, speed, mass } = rig.foe.lastBlow!;
    let moved = 0;
    let tilt = 0;
    for (let i = 0; i < 90; i++) {
      rig.hold(1);
      const p = rig.foe.position(new THREE.Vector3());
      moved = Math.max(moved, Math.hypot(p.x - start.x, p.z - start.z));
      tilt = Math.max(tilt, tiltOf(rig.foe.fighter.body));
    }
    seen.set(species.key, { effect, speed, mass, moved, tilt });
  }
  const g = seen.get("goblin")!;
  const m = seen.get("swordsman")!;
  const o = seen.get("orc")!;
  const said = (s: typeof g) =>
    `${s.speed.toFixed(2)} m/s into ${s.mass.toFixed(0)} kg: ${s.effect}`;

  check("the heavier the body, the less of the blow it takes",
    g.speed > m.speed * 2 && m.speed > o.speed * 1.5,
    `goblin ${g.speed.toFixed(2)}, man ${m.speed.toFixed(2)}, orc ${o.speed.toFixed(2)} m/s`);
  check("a goblin goes over", g.effect === "down" && g.tilt > 60,
    `${said(g)}, tipped ${g.tilt.toFixed(0)}deg in 1.5s`);
  check("a man is shoved, and keeps his feet",
    m.effect === "shove" && m.tilt < 1 && m.moved > 0.005 && m.moved < 0.2,
    `${said(m)}, slid ${(m.moved * 100).toFixed(1)} cm`);
  check("an orc does not move", o.moved < 0.01 && o.tilt < 1 && o.effect === "none",
    `${said(o)}, moved ${(o.moved * 1000).toFixed(1)} mm`);
}

async function aKnockedDownFighterGetsUp(): Promise<void> {
  console.log("\nknocked down, it lies there, then gets up whole and fights on");
  const rig = await buildRig({}, GOBLIN, foeSpawn(GOBLIN));
  const gap = () => {
    const a = rig.player.position(new THREE.Vector3());
    const b = rig.foe.position(new THREE.Vector3());
    return Math.hypot(a.x - b.x, a.z - b.z);
  };
  // Let it come for you first, so there is someone to fight when it is up.
  for (let i = 0; i < 60 * 10 && gap() > 1.8; i++) rig.fight(1);
  rig.fight(20);
  const standing = rig.foe.position(new THREE.Vector3()).y;

  rig.foe.receive(blowOn(rig, rig.foe, 10, 0.8));
  const effect = rig.foe.lastBlow!.effect;
  const head = rig.foe.fighter.parts.find((p) => p.name === "head")!.body!;
  let tilt = 0;
  let lowestHead = 99;
  let limp = true;
  let lying = true;
  let upAfter = -1;
  for (let i = 0; i < 60 * 4 && upAfter < 0; i++) {
    rig.fight(1);
    if (!rig.foe.fighter.down) { upAfter = i; break; }
    tilt = Math.max(tilt, tiltOf(rig.foe.fighter.body));
    lowestHead = Math.min(lowestHead, head.translation().y);
    if (!rig.foe.arm.limp) limp = false;
    if (rig.ai.intent !== "down") lying = false;
  }
  check("a hard blow high up puts a goblin on the floor",
    effect === "down" && tilt > 70 && lowestHead < 0.45,
    `${effect}: tipped ${tilt.toFixed(0)}deg, head down to ${lowestHead.toFixed(2)} m`);
  check("and nothing drives it while it is there", limp && lying,
    `arm ${limp ? "hangs" : "was driven"}, intent ${lying ? "down throughout" : "changed"}`);
  check("it gets back up on its own", upAfter > 30 && upAfter < 60 * 3,
    upAfter < 0 ? "still down after 4s" : `up after ${(upAfter / 60).toFixed(2)}s`);

  // Half a second to find its feet, and up to a second more to come back down
  // if it went up. A goblin whose spear lands planted can lever itself off the
  // floor taking its guard back up: its drive is an outside force on the hand,
  // and a goblin's arm is strong enough to lift the goblin. It is rare, and
  // rarer when it is struck mid-swing than at the guard -- which is where it
  // spends its time between swings now.
  const p = new THREE.Vector3();
  let settled = -1;
  for (let i = 0; i < 90 && settled < 0; i++) {
    rig.fight(1);
    rig.foe.position(p);
    if (i >= 29 && tiltOf(rig.foe.fighter.body) < 2 && Math.abs(p.y - standing) < 0.04) {
      settled = i + 1;
    }
  }
  check("upright and on its feet again", settled > 0,
    `tilt ${tiltOf(rig.foe.fighter.body).toFixed(1)}deg, hull at ${p.y.toFixed(3)} m ` +
    `against ${standing.toFixed(3)} standing` +
    (settled > 0 ? `, ${(settled / 60).toFixed(2)}s after it got up` : " after 1.5s"));
  check("with its sword arm still on its shoulder", shoulderGap(rig.foe) < 0.03,
    `top of the upper arm ${(shoulderGap(rig.foe) * 1000).toFixed(0)} mm from its anchor`);

  let windup = false;
  for (let i = 0; i < 60 * 6 && !windup; i++) {
    rig.fight(1);
    windup = rig.ai.intent === "windup";
  }
  check("and it comes at you again", windup,
    windup ? "drew back for a swing" : `intent "${rig.ai.intent}" after 6s`);
}

/** A knocked-down fighter's ragdoll, which only exists while it lies there. */
type Limp = { hips: { rotation(): { x: number; y: number; z: number; w: number } };
  hipsCollider: { handle: number } } | null;

async function aKnockdownGoesLimp(): Promise<void> {
  console.log("\nknocked down, the body goes limp, pulls itself together, and gets up whole");
  const rig = await buildRig({}, GOBLIN, foeSpawn(GOBLIN));
  rig.hold(60);
  const f = rig.foe.fighter;
  const limpOf = () => (f as unknown as { ragdoll: Limp }).ragdoll;
  const legParts = f.parts.filter((p) => /thigh|shin/.test(p.name));
  const legs = legParts.map((p) => p.collider.parent()!);
  const census = () => `${rig.phys.world.bodies.len()} bodies, ${rig.phys.world.impulseJoints.len()} joints`;
  const standing = census();

  const up = new THREE.Vector3(0, 1, 0);
  const upOf = (r: { x: number; y: number; z: number; w: number }) =>
    up.clone().applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  // Where each leg piece is drawn, as a frame would draw it: the body group
  // placed as the renderer's interpolator would, and the figure posed.
  const drawn = () => {
    const p = f.body.translation();
    const r = f.body.rotation();
    f.mesh.position.set(p.x, p.y, p.z);
    f.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    f.applyPose(1);
    f.mesh.updateMatrixWorld(true);
    return legParts.map((l) => l.mesh.getWorldPosition(new THREE.Vector3()));
  };

  rig.foe.receive(blowOn(rig, rig.foe, 10, 0.8));
  const effect = rig.foe.lastBlow!.effect;
  let limp = true;
  let simulated = true;
  let bent = 0;
  let waist = 0;
  let hit: boolean | null = null;
  let hurt = 0;
  let before: THREE.Vector3[] = [];
  let jump = -1;
  for (let i = 0; i < 60 * 4 && f.down; i++) {
    const ragdoll = limpOf();
    if (ragdoll) {
      if (!legs.every((b) => b.isDynamic())) simulated = false;
      const knees = [0, 2].map((k) => upOf(legs[k].rotation()).angleTo(upOf(legs[k + 1].rotation())));
      bent = Math.max(bent, ...knees);
      // How far the chest is from square over the hips: the waist's bend.
      waist = upOf(f.body.rotation()).angleTo(upOf(ragdoll.hips.rotation()));
      // Half a second in, a light cut across the hips of the body on the floor.
      if (i === 30) {
        const health = rig.foe.state.health;
        hit = rig.foe.receive(fakeImpact(ragdoll.hipsCollider.handle, { closingSpeed: 4 }));
        hurt = health - rig.foe.state.health;
      }
      before = drawn();
    } else if (jump < 0 && before.length) {
      // The step it stopped being limp: nothing drawn should have jumped.
      const after = drawn();
      jump = Math.max(...after.map((a, k) => a.distanceTo(before[k])));
    }
    if (i < 3 && !f.limp) limp = false;
    rig.hold(1);
  }
  check("a knockdown goes limp: the legs are the body's own, not posed",
    effect === "down" && limp && simulated,
    `${effect}; ${simulated ? "every leg bone simulated" : "legs posed"} while it was down`);
  check("and it goes over bending, not as a plank", bent > 0.3,
    `knees bent up to ${bent.toFixed(2)} rad`);
  check("the hips on the floor can still be cut", hit === true && hurt > 0,
    hit === null ? "never lay long enough to try" : `hit ${hit}, ${hurt.toFixed(1)} damage`);
  check("before it gets up it has pulled itself straight", waist < 0.35,
    `the chest ${(waist * 180 / Math.PI).toFixed(0)}deg off square over the hips at the last`);
  check("and the legs go from lying to posed without a jump", jump >= 0 && jump < 0.06,
    jump < 0 ? "never saw it get up" : `a leg moved ${(jump * 100).toFixed(1)} cm in the step it did`);

  rig.hold(90);
  check("on its feet, nothing of the ragdoll is left over",
    !f.down && !f.limp && legs.every((b) => b.isKinematic()) && census() === standing,
    `down ${f.down}, ${census()} against ${standing} before it fell`);

  // Floored again halfway up: limp again, from however far up it had got.
  rig.hold(30);
  rig.foe.receive(blowOn(rig, rig.foe, 10, 0.8));
  let rising = false;
  for (let i = 0; i < 60 * 4 && !rising; i++) {
    rig.hold(1);
    rising = f.down && !f.limp;
  }
  rig.hold(10);
  rig.foe.receive(blowOn(rig, rig.foe, 12, 0.8));
  const again = rig.foe.lastBlow!.effect === "down" && f.limp;
  for (let i = 0; i < 60 * 5 && f.down; i++) rig.hold(1);
  rig.hold(60);
  check("knocked down again on its way up, it goes limp again, and still gets up whole",
    rising && again && !f.down && census() === standing && tiltOf(f.body) < 2,
    `${rising ? "caught rising" : "never seen rising"}, ${again ? "limp again" : "not limp"}; `
      + `down ${f.down}, ${census()}, tilt ${tiltOf(f.body).toFixed(1)}deg`);

  // And killed on the floor: it stays down, and a reset still takes it all away.
  rig.foe.receive(blowOn(rig, rig.foe, 10, 0.8));
  rig.hold(20);
  const torso = f.collider.handle;
  for (let i = 0; i < 60 && !rig.foe.dead; i++) rig.foe.receive(fakeImpact(torso, { closingSpeed: 10 }));
  rig.hold(180);
  const stayed = rig.foe.dead && f.limp && legs.every((b) => b.isDynamic());
  rig.foe.reset(rig.tuning, foeSpawn(GOBLIN));
  rig.impacts.resetSweeps();
  rig.hold(60);
  check("killed where it lies, it stays down; a reset stands it up whole",
    stayed && !f.limp && census() === standing
      && Math.abs(f.body.translation().y - GOBLIN.build.hullCentreY) < 0.05,
    `${stayed ? "stayed limp" : "did not stay down"}; ${census()}, `
      + `hull at ${f.body.translation().y.toFixed(3)} m`);
}

async function aStaggerTakesTheSwingOffIt(): Promise<void> {
  console.log("\na stagger takes a swing off something light enough to rock");
  const rig = await buildRig({}, GOBLIN, foeSpawn(GOBLIN));
  rig.ai.cutOverride = "thrust";
  let wound = false;
  for (let i = 0; i < 60 * 15 && !wound; i++) {
    rig.fight(1);
    wound = rig.ai.intent === "windup";
  }
  // Caught with the spear on its way back: a wind-up is as long as the arm
  // needs, which for a goblin's is not long, so this does not wait.
  rig.fight(2);
  const winding = rig.ai.intent === "windup" && rig.ai.committed !== null;

  rig.foe.receive(blowOn(rig, rig.foe, 6, 0.6));
  const effect = rig.foe.lastBlow!.effect;
  rig.fight(1);
  const after = { intent: rig.ai.intent, committed: rig.ai.committed };

  let back = false;
  for (let i = 0; i < 60 * 3 && !back; i++) {
    rig.fight(1);
    back = FIGHTING.has(rig.ai.intent);
  }
  check("a middling blow staggers a goblin mid-wind-up", winding && effect === "stagger",
    `${winding ? "drawing back" : "not drawing back"}, blow ${effect}`);
  check("and its swing is gone",
    after.intent === "reeling" && after.committed === null,
    `intent "${after.intent}", committed ${after.committed?.cut.name ?? "nothing"}`);
  check("until it has its feet back", back, back ? "back at it" : "still reeling after 3s");
}

async function realBlowsAreWeighed(): Promise<void> {
  console.log("\nreal blows, weighed: an orc's axe rocks you, a goblin's spear cannot");
  const tally = new Map<string, Record<string, number>>();
  for (const species of [ORC, GOBLIN]) {
    const rig = await buildRig({}, species, foeSpawn(species));
    const effects: Record<string, number> = { none: 0, shove: 0, stagger: 0, down: 0 };
    rig.impacts.addBlade(rig.foe.arm, (i) => {
      if (rig.player.dead || !rig.player.receive(i)) return;
      if (i.closingSpeed > 1.2) effects[rig.player.lastBlow!.effect]++;
    });
    // Forty seconds of it, however many lives that takes: the AI makes its
    // swings up at random, and an orc that happens to take your head in the
    // first few blows would leave too few to count.
    for (let i = 0; i < 60 * 40; i++) {
      rig.fight(1);
      if (rig.player.dead) rig.place(HOME);
    }
    tally.set(species.key, effects);
  }
  const orc = tally.get("orc")!;
  const goblin = tally.get("goblin")!;
  const line = (e: Record<string, number>) =>
    `${e.none} none, ${e.shove} shoved, ${e.stagger} staggered, ${e.down} down`;
  check("the orc's axe rocks you", orc.stagger + orc.down > 0, line(orc));
  check("the goblin's spear never moves you",
    goblin.shove + goblin.stagger + goblin.down === 0 && goblin.none > 5, line(goblin));

  // And the other way round: real swings of your own at an orc that stands
  // there and takes them.
  const at = spawnFor(ORC, 0, HOME.z - 1.1);
  const rig = await buildRig({}, ORC, at);
  const standAt = new THREE.Vector3(0, HOME.y, HOME.z);
  rig.holdFoe();
  rig.pin(standAt);
  rig.hold(90);
  let hits = 0;
  let rocked = 0;
  let moved = 0;
  rig.impacts.addBlade(rig.arm, (i) => {
    if (!rig.foe.receive(i) || i.closingSpeed < 1.2) return;
    hits++;
    const e = rig.foe.lastBlow!.effect;
    if (e === "stagger" || e === "down") rocked++;
  });
  const target = new THREE.Vector3(0, ORC.build.standing.crown * 0.7, at.z);
  const where = new THREE.Vector3();
  for (let swings = 0; swings < 16; swings++) {
    throwForehand(rig, target, {
      each: () => {
        const p = rig.foe.position(where);
        moved = Math.max(moved, Math.hypot(p.x - at.x, p.z - at.z));
      },
    });
  }
  check("and nothing you swing moves an orc", hits > 10 && rocked === 0 && moved < 0.03,
    `${hits} hits, ${rocked} rocked it, furthest it moved ${(moved * 100).toFixed(1)} cm`);
}

async function theDummySwingsWhenStruck(): Promise<void> {
  console.log("\nthe practice dummy swings on its rope when it is hit");
  const rig = await buildRig();
  rig.step(90);
  const torso = rig.dummy.limbs.get("torso")!;
  const hand = rig.dummy.limbs.get("foreArmR")!;
  const where = (l: typeof torso) => {
    const p = l.body.translation();
    return new THREE.Vector3(p.x, p.y, p.z);
  };
  const rest = where(torso);
  const hit = (limb: typeof torso) => fakeImpact(limb.collider.handle, {
    closingSpeed: 9, edgeAlign: 0, at: where(limb), into: new THREE.Vector3(0, 0, -1),
    blowMass: rig.arm.liveWeaponMass + rig.arm.armBehind, blade: 1, time: (blowClock += 1000),
  });

  rig.dummy.receive(hit(torso));
  let swung = 0;
  for (let i = 0; i < 40; i++) {
    rig.step(1);
    swung = Math.max(swung, where(torso).distanceTo(rest));
  }
  rig.step(50);
  const settled = where(torso).distanceTo(rest);
  check("a blow to the chest swings the whole dummy", swung > 0.02,
    `chest swung ${(swung * 100).toFixed(1)} cm off its rest`);
  // A free pin let it swing for five seconds, and the limb you were cutting
  // was somewhere else by the next cut. Its mount drags.
  check("and its mount settles it before the next cut", settled < 0.01,
    `${(settled * 100).toFixed(1)} cm off a second and a half later`);

  // The same blow on a hand. Given to the hand alone it flung the forearm
  // most of a metre, and a dummy whose arm leaps away from every cut is no
  // use for practising cuts: the whole dummy takes it, and swings.
  const handRest = where(hand);
  const chestRest = where(torso);
  rig.dummy.receive(hit(hand));
  let handMoved = 0;
  let chestMoved = 0;
  for (let i = 0; i < 30; i++) {
    rig.step(1);
    handMoved = Math.max(handMoved, where(hand).distanceTo(handRest));
    chestMoved = Math.max(chestMoved, where(torso).distanceTo(chestRest));
  }
  check("a blow to a hand swings the dummy, and does not fling the hand",
    handMoved < 0.3 && chestMoved > 0.005 && rig.dummy.severedCount === 0,
    `hand ${(handMoved * 100).toFixed(0)} cm, chest ${(chestMoved * 100).toFixed(1)} cm, nothing cut`);
}

async function knockdownsDoNotWearTheBodyOut(): Promise<void> {
  console.log("\nfloored three times over, a body is still in one piece");
  const rig = await buildRig({}, GOBLIN, foeSpawn(GOBLIN));
  rig.hold(60);
  const standing = rig.foe.position(new THREE.Vector3()).y;
  let floored = 0;
  let finite = true;
  for (let round = 0; round < 3; round++) {
    rig.foe.receive(blowOn(rig, rig.foe, 11, 0.8));
    if (rig.foe.fighter.down) floored++;
    for (let i = 0; i < 60 * 4 && rig.foe.fighter.down; i++) {
      rig.hold(1);
      const p = rig.foe.fighter.body.translation();
      if (!Number.isFinite(p.x + p.y + p.z)) finite = false;
    }
    rig.hold(30);
  }
  rig.hold(60);
  const p = rig.foe.position(new THREE.Vector3());
  const head = rig.foe.fighter.parts.find((q) => q.name === "head")!;
  const hp = head.body!.translation();
  check("three blows, three falls", floored === 3, `${floored} of 3 floored it`);
  check("and it is standing whole at the end of it",
    finite && !rig.foe.fighter.down && tiltOf(rig.foe.fighter.body) < 2
      && Math.abs(p.y - standing) < 0.04 && head.severed !== true
      && new THREE.Vector3(hp.x, hp.y, hp.z).distanceTo(p) < 1.0
      && shoulderGap(rig.foe) < 0.03,
    `tilt ${tiltOf(rig.foe.fighter.body).toFixed(1)}deg, hull ${p.y.toFixed(3)} m, ` +
    `head ${new THREE.Vector3(hp.x, hp.y, hp.z).distanceTo(p).toFixed(2)} m off, ` +
    `shoulder gap ${(shoulderGap(rig.foe) * 1000).toFixed(0)} mm`);
}

async function oneSwingIsOneBlow(): Promise<void> {
  console.log("\na blade through two parts of a body is one blow, not two");
  const rig = await buildRig({}, SWORDSMAN, foeSpawn(SWORDSMAN));
  rig.hold(60);
  const offArm = rig.foe.fighter.parts.find((p) => p.name === "offShoulder")!;
  const first = blowOn(rig, rig.foe, 12, 0.6);
  rig.foe.receive(first);
  const once = rig.foe.fighter.knock.length();
  // The same swing, a tenth of a second on, through the arm as well.
  rig.foe.receive({ ...first, colliderHandle: offArm.collider.handle, time: first.time + 100 });
  const twice = rig.foe.fighter.knock.length();
  // Someone else's swing is its own blow.
  rig.foe.receive({ ...first, blade: first.blade + 1, time: first.time + 150 });
  const other = rig.foe.fighter.knock.length();
  check("the second part of one swing adds nothing", once > 0.1 && Math.abs(twice - once) < 1e-9,
    `${once.toFixed(3)} m/s after one part, ${twice.toFixed(3)} after two`);
  check("but a second weapon's blow is its own", other > once * 1.5,
    `${other.toFixed(3)} m/s once a second blade lands`);
}

async function aCorpseLiesStill(): Promise<void> {
  console.log("\nnothing drives a corpse, not even the last thing that drove it");
  // Rapier keeps a user force until it is cleared. A fighter that died with
  // its arm driving hard used to keep that drive forever: the corpse crawled
  // six metres across the floor in ten seconds and was thrown into the air.
  const rig = await buildRig({}, GOBLIN, foeSpawn(GOBLIN));
  rig.fight(150);
  rig.foe.health = 0.1;
  rig.foe.receive(fakeImpact(rig.foe.fighter.collider.handle));
  const died = rig.foe.position(new THREE.Vector3());
  rig.fight(60 * 5);
  let fastest = 0;
  for (let i = 0; i < 60; i++) {
    rig.fight(1);
    const v = rig.foe.fighter.body.linvel();
    fastest = Math.max(fastest, Math.hypot(v.x, v.y, v.z));
  }
  const p = rig.foe.position(new THREE.Vector3());
  const drift = Math.hypot(p.x - died.x, p.z - died.z);
  check("a corpse comes to rest where it fell",
    rig.foe.dead && drift < 1.5 && fastest < 0.3,
    `${drift.toFixed(2)} m from where it died, ${fastest.toFixed(2)} m/s in its sixth second`);
}

async function aDroppedWeaponIsNotKicked(): Promise<void> {
  console.log("\na weapon on the floor is stepped over, not kicked across the room");
  // The legs are kinematic, so nothing they touch can push back. A blade
  // meets bodies, legs included -- and a spear lying on the floor that a foot
  // came down on was fired off at seventeen metres a second, with the corpse
  // still holding it. A weapon nobody is swinging stays out of bodies now.
  let fastest = 0;
  let what = "";
  for (let a = 0; a < 8; a++) {
    const rig = await buildRig({}, GOBLIN, foeSpawn(GOBLIN));
    rig.hold(30);
    rig.foe.health = 0.1;
    rig.foe.receive(fakeImpact(rig.foe.fighter.collider.handle));
    rig.hold(150);
    const spear = rig.foe.arm.blade.translation();
    const yaw = (a * Math.PI) / 4;
    rig.place(new THREE.Vector3(spear.x + Math.sin(yaw) * 1.2, 0.95, spear.z + Math.cos(yaw) * 1.2));
    rig.fighter.yaw = yaw;
    const moving = [rig.foe.fighter.body, rig.foe.arm.blade, rig.foe.arm.fore, rig.foe.arm.upper];
    for (let i = 0; i < 150; i++) {
      rig.step(1, { ...NO_KEYS, forward: true });
      for (const b of moving) {
        const v = b.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        if (sp > fastest) {
          fastest = sp;
          what = b === rig.foe.arm.blade ? "the spear" : b === rig.foe.fighter.body ? "the corpse" : "its arm";
        }
      }
    }
  }
  // Your own sword still meets its arm on the way past, at walking pace.
  check("walked over from eight sides, nothing on the floor is thrown about", fastest < 3,
    `fastest was ${what}, at ${fastest.toFixed(2)} m/s`);
}

// --- footwork -----------------------------------------------------------------

/** How an opponent spent a stretch of a fight, measured from outside it. */
interface Bout {
  /** Seconds in each intent. */
  time: Map<string, number>;
  /** Within four metres of you: metres it moved round you, toward you, and away. */
  around: number;
  toward: number;
  away: number;
  /** How many times it changed which way round you it was going. */
  turns: number;
  /** How far from you it was, every step it was within four metres. */
  ranges: number[];
  /** And every step of that it spent going round you or giving ground: the distance it chose. */
  hover: number[];
  /** The swings it began, by the shape each was thrown with. */
  swings: string[];
  /** The intent each step out of the way began from. */
  evadedFrom: string[];
  /** Steps of footwork spent pressing to move and not moving. */
  blocked: number;
}

/** Turn a fighter toward something, on the turn keys. */
function faceToward(f: Fighter, dx: number, dz: number, keys: Keys): void {
  let err = Math.atan2(-dx, -dz) - f.yaw;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  keys.turnLeft = err > 0.06;
  keys.turnRight = err < -0.06;
}

/** Where the opponent is from the player, flat: [dx, dz]. */
function foeFrom(rig: Rig): [number, number] {
  const me = rig.player.position(new THREE.Vector3());
  const it = rig.foe.position(new THREE.Vector3());
  return [it.x - me.x, it.z - me.z];
}

/** A player who walks straight into the opponent and stays in its face. */
function crowder(): (rig: Rig) => Keys {
  const keys = { ...NO_KEYS };
  return (rig) => {
    const [dx, dz] = foeFrom(rig);
    faceToward(rig.fighter, dx, dz, keys);
    keys.forward = Math.hypot(dx, dz) > 0.75;
    return keys;
  };
}

/**
 * A player who comes at the opponent and cuts across at it whenever it is
 * within a sword's length: a wind back to the right and a hard sweep to the
 * left, once a second. Crude, but it is a real swing of a real arm -- and
 * it has to walk in, because something that keeps its distance is never
 * inside a sword's length of a player who stands still.
 */
function fencer(): (rig: Rig) => Keys {
  const keys = { ...NO_KEYS };
  let left = 0;
  return (rig) => {
    const [dx, dz] = foeFrom(rig);
    faceToward(rig.fighter, dx, dz, keys);
    keys.forward = Math.hypot(dx, dz) > 1.3;
    left -= STEP;
    if (left <= 0 && Math.hypot(dx, dz) < 1.9) left = 1.0;
    const into = 1.0 - left;
    const aim = rig.arm.aim;
    const s = rig.tuning.sensitivity;
    if (left > 0 && into < 0.45) {
      rig.input.dx = -(-1.1 - aim.yaw) / s * 0.2;
      rig.input.dy = -(0.35 - aim.pitch) / s * 0.2;
    } else if (left > 0 && into < 0.75) {
      rig.input.dx = -(1.0 - aim.yaw) / s * 0.35;
      rig.input.dy = -(-0.1 - aim.pitch) / s * 0.2;
    }
    return keys;
  };
}

/** Fight for a while, with the player doing whatever `drive` says, and keep the books. */
function watchBout(rig: Rig, seconds: number, drive: (rig: Rig) => Keys = () => NO_KEYS): Bout {
  const bout: Bout = {
    time: new Map(), around: 0, toward: 0, away: 0, turns: 0,
    ranges: [], hover: [], swings: [], evadedFrom: [], blocked: 0,
  };
  const me = new THREE.Vector3();
  const it = new THREE.Vector3();
  const was = rig.foe.position(new THREE.Vector3());
  // Killed, the player gets up where the bout began -- not at the spawn, which
  // may be two rooms away, and leave the rest of the bout to an empty room.
  rig.player.position(me);
  const home = new THREE.Vector3(me.x, HOME.y, me.z);
  // One step's worth of its walking pace, metres.
  const pace = rig.tuning.moveSpeed * rig.foe.fighter.build.scale * STEP;
  let way = 0;
  // How long the keys it is holding have been held: a step eases up to pace,
  // so one only counts as going nowhere once the feet have had their time.
  let keysWere = "";
  let heldFor = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const before = rig.ai.intent;
    rig.fight(1, drive(rig));
    const now = rig.ai.intent;
    bout.time.set(now, (bout.time.get(now) ?? 0) + STEP);
    if (now === "windup" && before !== "windup") bout.swings.push(rig.ai.committed!.cut.name);
    if (now === "evade" && before !== "evade") bout.evadedFrom.push(before);
    if (rig.player.dead) rig.place(home);

    rig.player.position(me);
    rig.foe.position(it);
    const mx = it.x - was.x;
    const mz = it.z - was.z;
    was.copy(it);
    const k = rig.ai.keys;
    const keys = `${+k.forward}${+k.back}${+k.left}${+k.right}`;
    heldFor = keys === keysWere ? heldFor + STEP : 0;
    keysWere = keys;
    if (FOOTWORK.has(now) && (k.forward || k.back || k.left || k.right)
      && heldFor > rig.tuning.stepEase && Math.hypot(mx, mz) < pace * 0.3) bout.blocked++;

    const dx = it.x - me.x;
    const dz = it.z - me.z;
    const range = Math.hypot(dx, dz);
    if (range > 4 || range < 1e-6) continue;
    bout.ranges.push(range);
    if (now === "circle" || now === "backoff") bout.hover.push(range);
    const out = (mx * dx + mz * dz) / range;
    const round = (mz * dx - mx * dz) / range;
    if (out > 0) bout.away += out; else bout.toward -= out;
    bout.around += Math.abs(round);
    if (Math.abs(round) > pace * 0.35) {
      const w = Math.sign(round);
      if (way !== 0 && w !== way) bout.turns++;
      way = w;
    }
  }
  return bout;
}

/** The share of its time in the fight that it spent winding up, striking or recovering. */
function swinging(b: Bout): number {
  let swing = 0;
  let all = 0;
  for (const [intent, t] of b.time) {
    if (!FIGHTING.has(intent)) continue;
    all += t;
    if (!FOOTWORK.has(intent)) swing += t;
  }
  return all > 0 ? swing / all : 0;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

async function footworkAsksTheStone(): Promise<void> {
  console.log("\nfootwork asks the stone before it steps");
  const rig = await buildRig();
  rig.step(30);
  const at = rig.fighter.position(new THREE.Vector3());
  // The south wall's inner face; walls are 0.4m thick and centred on the line.
  const wall = ROOMS.hall.maxZ - 0.2 - at.z;
  const south = rig.fighter.clearAlong(0, 1, 5);
  const north = rig.fighter.clearAlong(0, -1, 5);
  check("the step probe finds the wall behind you", Math.abs(south - wall) < 0.05,
    `${south.toFixed(2)} m of floor to the south wall, which is ${wall.toFixed(2)} m off`);
  check("and open floor where there is nothing", north === 5,
    `${north.toFixed(2)} m clear of 5 looking north`);

  // Stand in a corner -- the pen's, east and south, a metre off both walls --
  // and let a swordsman go round you. Every step it takes it asks the stone
  // first, so it turns back at a wall rather than walking into one.
  const corner = new THREE.Vector3(ROOMS.pen.maxX - 1.2, HOME.y, ROOMS.pen.maxZ - 1.2);
  const boxed = await buildRig({}, SWORDSMAN, spawnFor(SWORDSMAN, corner.x - 4.8, corner.z - 2.8));
  boxed.place(corner);
  const bout = watchBout(boxed, 25);
  const footwork = [...bout.time].reduce((s, [k, t]) => s + (FOOTWORK.has(k) ? t : 0), 0);
  // And it fights there, going round you and swinging: not stood still in the
  // corner. It goes round you less than it did, since it began drawing back
  // on its way in and while giving ground -- in and out rather than round --
  // and three metres of it in twenty-five seconds was no longer always there.
  check("fought into a corner, it does not walk into the walls",
    bout.blocked < 30 && bout.around > 2 && bout.swings.length > 5,
    `${bout.blocked} of ${Math.round(footwork * 60)} footwork steps went nowhere; ` +
    `${bout.around.toFixed(1)} m round you, ${bout.swings.length} swings`);
}

async function anOpponentMovesBetweenSwings(): Promise<void> {
  console.log("\nbetween swings it moves: round you, in and out, and away");
  // Before it had footwork, forty seconds of this were forty seconds of walk
  // up, swing, swing again -- nine tenths of it winding up, striking or
  // recovering, and twenty centimetres of it sideways. Now it goes round you,
  // and each species goes round you like what it is.
  const bouts = new Map<string, Bout>();
  let yours = 0;
  for (const species of [SWORDSMAN, ORC, GOBLIN]) {
    const rig = await buildRig({}, species, foeSpawn(species));
    // Where your own sword does its work: the percussion point at full
    // stretch, flat from your middle -- measured the way an opponent measures
    // its own.
    const at = rig.player.position(new THREE.Vector3());
    const hits = rig.arm.probeStrike(0, 0, 1, 0, rig.tuning, new THREE.Vector3());
    yours = Math.hypot(hits.x - at.x, hits.z - at.z);
    const bout = watchBout(rig, 25);
    bouts.set(species.key, bout);
    // The old opponent managed under a metre of this in forty seconds.
    check(`${species.name} goes round you`, bout.around > 1.5,
      `${bout.around.toFixed(1)} m round you with ${bout.turns} changes of direction, ` +
      `${bout.away.toFixed(1)} m given, ${bout.swings.length} swings in 25s`);
  }
  const man = bouts.get("swordsman")!;
  const orc = bouts.get("orc")!;
  const goblin = bouts.get("goblin")!;
  const turns = man.turns + orc.turns + goblin.turns;
  check("and not always the same way round", turns >= 3,
    `${turns} changes of direction between the three of them`);
  const pct = (b: Bout) => `${(swinging(b) * 100).toFixed(0)}%`;
  check("the orc presses: it spends more of the fight swinging than the goblin",
    swinging(orc) > swinging(goblin) + 0.05,
    `swinging ${pct(orc)} of the time, against the goblin's ${pct(goblin)} ` +
    `(and the man's ${pct(man)})`);
  // Backing off by choice, not the in-and-out of stepping in to swing: every
  // one of them does that.
  const backing = (b: Bout) => b.time.get("backoff") ?? 0;
  check("the goblin goes round you out of your sword's reach, and backs off more than the orc",
    median(goblin.hover) > yours + 0.3 && backing(goblin) > backing(orc),
    `goes round you ${median(goblin.hover).toFixed(2)} m off, where your sword works at ` +
    `${yours.toFixed(2)}; backed off for ${backing(goblin).toFixed(1)}s to the orc's ` +
    `${backing(orc).toFixed(1)}s`);
}

async function anOpponentGetsOutOfTheWay(): Promise<void> {
  console.log("\nit steps out of a swing it sees coming -- never out of its own");
  // The goblin, because it is the wary one: it answers more than half the
  // swings it sees, where the orc answers one in ten. A reaction time after
  // it sees them, too, so a quick cut has often landed before it moves.
  const goblin = watchBout(await buildRig({}, GOBLIN, foeSpawn(GOBLIN)), 45, fencer());
  check("a goblin hops back out of your cuts", goblin.evadedFrom.length >= 1,
    `${goblin.evadedFrom.length} steps out of the way in 45s of being swung at`);
  const from = goblin.evadedFrom;
  check("and never in the middle of a swing of its own",
    from.every((s) => s === "close" || s === "circle" || s === "backoff" || s === "taunt"),
    `stepped out of the way from: ${[...new Set(from)].join(", ") || "nothing"}`);
}

async function anOpponentMovesInAndOut(): Promise<void> {
  console.log("\nit moves in and out as well as round");
  // Between swings it went round you. It stepped in only to correct its
  // distance, on a slant, and in twenty-five seconds of a swordsman circling
  // you it never once stepped straight back out.
  //
  // Each of these is a chance rolled a step at a time, and a swordsman spends
  // three quarters of a fight swinging rather than stepping, so they are
  // counted over more than a bout -- or, where only the mechanism is in
  // question, with the chance set to certain.
  let rockIn = 0;
  let rockOut = 0;
  for (const species of [SWORDSMAN, GOBLIN]) {
    const rig = await buildRig({}, species, spawnFor(species, 10.0, -7.8));
    rig.place(new THREE.Vector3(10.0, HOME.y, -4.0));
    watchBout(rig, 40);
    rockIn += rig.ai.tally.rockIn;
    rockOut += rig.ai.tally.rockOut;
  }
  check("it rocks in and out across the edge of its reach", rockIn >= 3 && rockOut >= 3,
    `${rockIn} half-steps in and ${rockOut} out, the swordsman and the goblin in 80s`);

  // Step in on it while it is going round you, and see how much ground it
  // gives: how far it gets back, along the line from you, from the nearest it
  // came -- against a goblin that never gives any. From the nearest, because
  // for a reaction time after you start it is still finishing whatever step it
  // was on, which as often as not was one in.
  const given = async (species: Species) => {
    const post = spawnFor(species, 10.0, -7.8);
    const rig = await buildRig({}, species, post);
    const keys = { ...NO_KEYS };
    const me = new THREE.Vector3();
    const it = new THREE.Vector3();
    const toward = () => {
      rig.player.position(me);
      rig.foe.position(it);
      faceToward(rig.fighter, it.x - me.x, it.z - me.z, keys);
    };
    const out: number[] = [];
    for (let k = 0; k < 16; k++) {
      // Back where you both started each time: every step in pushes it a
      // metre and a half down the cell, and two or three of them put its back
      // to the wall, where it gives no ground but swings.
      rig.foe.reset(rig.tuning, post);
      rig.ai.reset();
      rig.place(new THREE.Vector3(10.0, HOME.y, -4.0));
      rig.fight(60 * 2);
      for (let i = 0; i < 600 && rig.ai.intent !== "circle"; i++) {
        toward();
        rig.fight(1, keys);
      }
      toward();
      const ux = (it.x - me.x) / Math.hypot(it.x - me.x, it.z - me.z);
      const uz = (it.z - me.z) / Math.hypot(it.x - me.x, it.z - me.z);
      const from = it.clone();
      let nearest = 0;
      let back = 0;
      for (let i = 0; i < 42; i++) {
        toward();
        rig.fight(1, { ...keys, forward: i < 30 });
        rig.foe.position(it);
        const along = (it.x - from.x) * ux + (it.z - from.z) * uz;
        nearest = Math.min(nearest, along);
        back = Math.max(back, along - nearest);
      }
      out.push(back);
    }
    return median(out);
  };
  const goblin = await given(GOBLIN);
  const stands = await given({ ...GOBLIN, footwork: { ...GOBLIN.footwork, give: 0 } });
  check("step in on a goblin and it gives ground", goblin > stands + 0.1,
    `${goblin.toFixed(2)} m back as you come, where one that never gives ground ` +
    `goes ${stands.toFixed(2)} (medians of 16)`);

  // Swing at it and miss, and you pay for it: it steps in while your weapon
  // is on its way back.
  const paid: string[] = [];
  let punishes = 0;
  for (const species of [SWORDSMAN, GOBLIN]) {
    const rig = await buildRig({}, species, spawnFor(species, 10.0, -7.8));
    rig.place(new THREE.Vector3(10.0, HOME.y, -4.0));
    watchBout(rig, 60, fencer());
    punishes += rig.ai.tally.punishes;
    paid.push(`${species.name} ${rig.ai.tally.punishes}`);
  }
  check("swing at it and miss, and it steps in and makes you pay", punishes >= 5,
    `${paid.join(", ")} times in a minute each of being swung at`);

  // And it offers you something to miss: a step inside your reach, guard up,
  // a beat there, and a step back out. A swordsman that always does when it
  // can, and where your sword does its work, measured as in the bout above.
  const bait = await buildRig({}, { ...SWORDSMAN, footwork: { ...SWORDSMAN.footwork, bait: 1 } },
    spawnFor(SWORDSMAN, 10.0, -7.8));
  bait.place(new THREE.Vector3(10.0, HOME.y, -4.0));
  bait.fight(1);
  const at = bait.player.position(new THREE.Vector3());
  const hits = bait.arm.probeStrike(0, 0, 1, 0, bait.tuning, new THREE.Vector3());
  const yours = Math.hypot(hits.x - at.x, hits.z - at.z);
  const me = new THREE.Vector3();
  const it = new THREE.Vector3();
  let inside = 0;
  let outAgain = 0;
  for (let i = 0; i < 60 * 30; i++) {
    const before = bait.ai.tally.baits;
    bait.fight(1);
    if (bait.ai.tally.baits === before) continue;
    // A bait has begun: how near it comes, and whether it goes back out --
    // most of the way it came in.
    bait.player.position(me);
    bait.foe.position(it);
    const start = Math.hypot(it.x - me.x, it.z - me.z);
    let nearest = start;
    let last = start;
    for (let j = 0; j < 90 && bait.ai.intent === "circle"; j++, i++) {
      bait.fight(1);
      bait.player.position(me);
      bait.foe.position(it);
      last = Math.hypot(it.x - me.x, it.z - me.z);
      nearest = Math.min(nearest, last);
    }
    if (nearest < yours) inside++;
    if (last - nearest > 0.5 * (start - nearest)) outAgain++;
  }
  const baits = bait.ai.tally.baits;
  check("and it steps inside your reach on purpose, and back out", baits >= 3
    && inside >= baits / 2 && outAgain >= inside / 2,
    `${baits} times in 30s: ${inside} inside the ${yours.toFixed(2)} m your sword works at, ` +
    `${outAgain} back out again`);
}

async function weaponsKnockEachOther(): Promise<void> {
  console.log("\nwhen weapons meet, the one with less behind it is knocked aside");
  // It used to be a parry and nothing else: the solver stopped both blades,
  // and a driven arm had its weapon back where it was in two centimetres.
  // Now the two blows are weighed the way a blow on a body is -- weapon and
  // arm, meeting and sticking -- and the one sent back is knocked aside.
  const blow = (r: Rig, a: Arm) => a.liveWeaponMass + r.tuning.armBehindBlow * a.armBehind;
  const you = await buildRig();
  const goblin = await buildRig({}, GOBLIN, foeSpawn(GOBLIN));
  const orc = await buildRig({}, ORC, foeSpawn(ORC));
  const sword = blow(you, you.arm);
  const spear = blow(goblin, goblin.foe.arm);
  const axe = blow(orc, orc.foe.arm);
  const thrust = judgeClash(spear, 8, sword, 0);
  check("a spear thrust into a sword held still moves the sword",
    thrust.knocked === 2 && thrust.speed > 1.5,
    `${spear.toFixed(1)}kg at 8 m/s into ${sword.toFixed(1)}kg: the sword sent back at ${thrust.speed.toFixed(1)} m/s`);
  const beat = judgeClash(sword, 9, spear, 0);
  check("a sword swung hard into a spear held still moves the spear",
    beat.knocked === 2 && beat.speed > 4,
    `the spear sent back at ${beat.speed.toFixed(1)} m/s`);
  const chop = judgeClash(axe, 8, sword, 0);
  check("the orc's axe moves a sword much further than a spear does",
    chop.knocked === 2 && chop.speed > 1.5 * thrust.speed,
    `${axe.toFixed(1)}kg of axe and arm sends it back at ${chop.speed.toFixed(1)} m/s`);
  const even = judgeClash(sword, 6, sword, -6);
  check("two equal blows stop each other and knock neither", even.knocked === 0,
    `knocked ${even.knocked}`);

  // And the arm holding it gives. Without giving, the arm's drive has the
  // weapon back where it was sent almost at once: the knock is a twitch.
  const carried = async (share: number) => {
    const rig = await buildRig();
    rig.step(60);
    const tip = () => rig.arm.tipPosition.clone().sub(rig.fighter.position(new THREE.Vector3()));
    const from = tip();
    // What a knock at 3 m/s does to the hand end of the arm, and to its strength.
    rig.arm.jolt(share, 0.43);
    for (const b of [rig.arm.blade, rig.arm.fore]) {
      const v = b.linvel();
      b.setLinvel({ x: v.x + 3, y: v.y, z: v.z }, true);
    }
    let most = 0;
    for (let i = 0; i < 30; i++) {
      rig.step(1);
      most = Math.max(most, tip().distanceTo(from));
    }
    return most;
  };
  const held = await carried(0);
  const gave = await carried(0.6);
  check("knocked, the arm gives and the weapon is carried off",
    gave > 1.5 * held && gave - held > 0.12,
    `the tip carried ${(gave * 100).toFixed(0)} cm, against ${(held * 100).toFixed(0)} cm by an arm that holds`);

  // Its own weapon knocked aside in the middle of a swing, the swing is gone.
  const mid = await buildRig();
  for (let i = 0; i < 60 * 10 && mid.ai.intent !== "windup"; i++) mid.fight(1);
  const winding = mid.ai.intent === "windup";
  mid.foe.arm.jolt(0.6, 0.43);
  mid.fight(1);
  check("its weapon knocked aside mid-swing, it loses the swing",
    winding && mid.ai.intent === "recover" && mid.ai.committed === null,
    `intent "${mid.ai.intent}", committed ${mid.ai.committed?.cut.name ?? "nothing"}`);

  // Yours knocked aside while it is on its feet, it steps in on it.
  const open = await buildRig();
  let took = 0;
  let tried = 0;
  for (let k = 0; k < 6; k++) {
    open.place(HOME);
    for (let i = 0; i < 600 && open.ai.intent !== "circle"; i++) open.fight(1);
    // On your feet with a sword in your hand: an arm on the floor has nothing
    // to knock, and a passive player is on the floor now and then.
    if (open.player.dead || open.fighter.down) continue;
    tried++;
    const before = open.ai.tally.punishes;
    open.arm.jolt(0.6, 0.43);
    open.fight(40);
    if (open.ai.tally.punishes > before) took++;
  }
  check("your weapon knocked aside, it steps in on the opening", tried >= 3 && took >= 0.6 * tried,
    `${took} of ${tried} times`);

  // And in a fight: stand with your guard up over your head, in front of an
  // orc bringing its axe down on it. Raised, the blade stands upright over
  // the hand now that the arm no longer turns over on the way up, which is no
  // guard against a chop: rolled across the head, as you hold it, it is.
  const guard = await buildRig({}, ORC, spawnFor(ORC, 10.0, -7.8));
  guard.ai.aimOverride = "head";
  const home = new THREE.Vector3(10.0, HOME.y, -4.0);
  guard.place(home);
  let yours = 0;
  guard.impacts.onClash = (c) => { if (c.knocked === guard.arm && c.share >= 0.2) yours++; };
  // Turned to face it, as anyone holding a guard up against something is:
  // left facing the door, the orc went round to one side and brought its axe
  // down past the guard, not into it.
  const facing = { ...NO_KEYS };
  const me = new THREE.Vector3();
  const it = new THREE.Vector3();
  for (let i = 0; i < 60 * 30; i++) {
    const aim = guard.arm.aim;
    const s = guard.tuning.sensitivity;
    guard.input.dx = -(0.2 - aim.yaw) / s * 0.2;
    guard.input.dy = -(0.9 - aim.pitch) / s * 0.2;
    guard.input.rollDx = (-1.5 - aim.roll) / guard.tuning.rollSensitivity * 0.2;
    guard.player.position(me);
    guard.foe.position(it);
    faceToward(guard.fighter, it.x - me.x, it.z - me.z, facing);
    guard.fight(1, facing);
    if (guard.player.dead) guard.place(home);
  }
  check("hold your guard in front of the orc and its axe knocks it aside", yours >= 1,
    `${yours} times in 30s`);
}

interface LeapTrial {
  /** Its feet left the floor. */
  leapt: boolean;
  /** How far its hull rose, metres. */
  rose: number;
  /** The chop began before it was back on the floor. */
  inAir: boolean;
  /** What the chop itself did to you. */
  blood: number;
}

/**
 * Stand in the orc's reach, then a jump away from it, and see what comes:
 * one leap per trial, in the cell, where there is nothing to jump over or
 * into. Either standing still, or stepping aside the moment its feet leave
 * the floor -- which is the answer to a leap.
 */
async function leapTrials(trials: number, stepAside: boolean): Promise<LeapTrial[]> {
  // The orc at the south end of the cell, facing north up the length of it,
  // and put back there for every trial: a leap carries it three metres, and
  // ten of them in a row walked it into the wall.
  const home = spawnFor(ORC, 10.0, -2.8);
  const rig = await buildRig({}, ORC, home);
  const at = new THREE.Vector3();
  const out: LeapTrial[] = [];
  let hurt = 0;
  rig.impacts.addBlade(rig.foe.arm, (i) => {
    const intent = rig.ai.intent;
    if (rig.ai.committed?.leap && (intent === "leap" || intent === "strike")) {
      hurt += cutDamage(i);
    }
  });
  for (let k = 0; k < trials; k++) {
    rig.foe.reset(rig.tuning, home);
    rig.ai.reset();
    rig.hold(20);
    rig.foe.position(at);
    const standing = at.y;
    // In its reach, a pace in front of it...
    rig.place(new THREE.Vector3(at.x, HOME.y, at.z - 1.5));
    rig.fight(30);
    // ...until it is on its feet between swings, not in the middle of one: a
    // swing already coming is thrown at wherever you were, and it comes on
    // from there on foot. A leap is for having got away from it.
    for (let i = 0; i < 120 && !FOOTWORK.has(rig.ai.intent); i++) rig.fight(1);
    // ...then a jump away, on the same line.
    rig.foe.position(at);
    rig.place(new THREE.Vector3(at.x, HOME.y, at.z - 3.6));
    hurt = 0;
    const trial: LeapTrial = { leapt: false, rose: 0, inAir: false, blood: 0 };
    // Stepping aside is a sidestep -- your left, its right -- for as long as a
    // step lasts, from the moment its feet leave the floor.
    let aside = 0;
    for (let i = 0; i < 60 * 4; i++) {
      const before = rig.ai.intent;
      rig.fight(1, stepAside && aside > 0 ? { ...NO_KEYS, left: true } : NO_KEYS);
      aside--;
      const now = rig.ai.intent;
      rig.foe.position(at);
      if (now === "leap") {
        if (!trial.leapt) aside = 24;
        trial.leapt = true;
        trial.rose = Math.max(trial.rose, at.y - standing);
      }
      if (trial.leapt && now === "strike" && before === "leap") {
        trial.inAir = !rig.foe.fighter.grounded;
      }
      if (trial.leapt && now === "recover") break;
    }
    trial.blood = hurt;
    out.push(trial);
  }
  return out;
}

async function theOrcComesAfterYouThroughTheAir(): Promise<void> {
  console.log("\nget away from the orc and it comes after you through the air");
  // It used to walk after you like anything else. Now, having had you in
  // reach, it runs at you with the axe going up, jumps -- your jump, on your
  // keys -- and brings the axe down at the top of it. Once its feet are off
  // the floor it is committed to the line it jumped on and to where you were
  // when it jumped, so stepping aside is the answer: which has to be true, or
  // it is just an axe you cannot avoid.
  const still = await leapTrials(10, false);
  const aside = await leapTrials(10, true);
  const leapt = still.filter((t) => t.leapt);
  const lowest = Math.min(...leapt.map((t) => t.rose));
  check("back out of its reach and it leaps at you", leapt.length >= 7 && lowest > 0.2,
    `${leapt.length} of ${still.length} times; its feet left the floor by at least ` +
    `${(lowest * 100).toFixed(0)}cm`);
  const inAir = leapt.filter((t) => t.inAir).length;
  check("the axe is up before it jumps, and comes down in the air", inAir >= leapt.length - 1,
    `${inAir} of ${leapt.length} chops began before its feet found the floor`);
  const landed = (ts: LeapTrial[]) => ts.filter((t) => t.leapt && t.blood > 0).length;
  const standingHits = landed(still);
  const dodged = aside.filter((t) => t.leapt);
  const asideHits = landed(aside);
  check("stand there and it lands", standingHits >= 0.4 * leapt.length,
    `the chop drew blood ${standingHits} times in ${leapt.length}`);
  check("step aside as its feet leave the floor and it does not",
    dodged.length >= 5 && asideHits <= 0.3 * dodged.length,
    `${asideHits} of ${dodged.length} chops drew blood from someone stepping out of the way`);

  // And not on the way in. Something that has never had you in reach walks
  // up to you like anything else: a leap is how it closes ground you made.
  const fresh = await buildRig({}, ORC, spawnFor(ORC, 10.0, -8.5));
  fresh.foe.position(new THREE.Vector3());
  fresh.place(new THREE.Vector3(10.0, HOME.y, -4.4));
  let jumpedIn = false;
  let closest = 99;
  const me = new THREE.Vector3();
  const it = new THREE.Vector3();
  for (let i = 0; i < 60 * 4; i++) {
    fresh.fight(1);
    if (fresh.ai.committed?.leap) jumpedIn = true;
    fresh.player.position(me);
    fresh.foe.position(it);
    closest = Math.min(closest, Math.hypot(me.x - it.x, me.z - it.z));
  }
  check("but it walks up to you the first time", !jumpedIn && closest < 2.2,
    `${jumpedIn ? "leapt" : "no leap"}; closed to ${closest.toFixed(2)} m`);
}

async function crowdingItDoesNotStopIt(): Promise<void> {
  console.log("\nwalk into its face and it still fights");
  // Crowding used to switch an opponent off: it only ever stepped back, and
  // every swing it had wanted room it never got -- one to six of them in
  // forty seconds. Now it backs off while it can, and swings at you from
  // where it is once you have been inside its guard long enough.
  //
  // In the cell, which is bare: a player who only walks straight at things
  // gets stuck on the first pillar between them, and then nobody is crowding
  // anybody.
  let shaft = 0;
  for (const species of [SWORDSMAN, ORC, GOBLIN]) {
    const rig = await buildRig({}, species, spawnFor(species, 10.0, -7.8));
    rig.place(new THREE.Vector3(10.0, HOME.y, -3.8));
    const bout = watchBout(rig, 15, crowder());
    if (species === GOBLIN) shaft = bout.swings.filter((a) => a === "shaft sweep").length;
    check(`${species.name} swings at you from inside its guard`, bout.swings.length >= 4,
      `${bout.swings.length} swings in 15s with you in its face, median ` +
      `${median(bout.ranges).toFixed(2)} m off`);
  }
  check("inside a goblin's point, it swings the shaft", shaft > 0,
    `${shaft} shaft sweeps -- the one swing it has up close`);
}

// -----------------------------------------------------------------------------
// One swing into the next, and everything else a fight is besides swings
// -----------------------------------------------------------------------------

/**
 * A player who faces the opponent and, the moment a swing of its comes
 * through, steps back out of it for a third of a second -- then comes back in
 * once it has gone by. What a swing that goes through nothing is made of.
 */
function stepper(): (rig: Rig) => Keys {
  const keys = { ...NO_KEYS };
  let back = 0;
  let was = "";
  return (rig) => {
    const [dx, dz] = foeFrom(rig);
    faceToward(rig.fighter, dx, dz, keys);
    const now = rig.ai.intent;
    if (now === "strike" && was !== "strike" && !rig.ai.spinning) back = 0.35;
    was = now;
    back -= STEP;
    keys.back = back > 0;
    keys.forward = back < -0.8 && Math.hypot(dx, dz) > 2.0;
    return keys;
  };
}

/** The mean of some numbers, 0 of none. */
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** How spread out some numbers are: their standard deviation. */
function spread(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Whether the arm moved from one aim to the other the way a swing drawn back does. See `swingsAreReadOffTheArm`. */
function drewBack(
  from: { yaw: number; pitch: number; reach: number }, to: { yaw: number; pitch: number; reach: number },
): boolean {
  return Math.hypot(to.yaw - from.yaw, to.pitch - from.pitch) > 0.25 || Math.abs(to.reach - from.reach) > 0.08;
}

async function aMissRunsIntoTheNextSwing(): Promise<void> {
  console.log("\na swing that meets nothing runs into the next");
  // Every swing used to end with the guard back up in the one place it was
  // always held, and every swing began from there: whatever the last one
  // did, the next one waited. Now a swing that goes through nothing ends
  // where another starts -- a forehand's follow-through is a backhand's wind-
  // up -- and one stopped on your guard may be followed by the same again.
  // Every swing in a run is still drawn back for, and the run is paid for at
  // the end of it.
  let pairs = 0;
  let linked = 0;
  let chained = 0;
  let drawn = 0;
  // How much longer its guard took to come back up after a run than the same
  // creature's does after a swing on its own: an axe is slower back than a
  // sword either way, and which of them happened to run more is not the point.
  const longer: number[] = [];
  const alone: number[] = [];
  const runs: string[] = [];
  for (const species of [SWORDSMAN, ORC, GOBLIN]) {
    const one: number[] = [];
    const run: number[] = [];
    const rig = await buildRig({}, species, spawnFor(species, 20.8, 3.5));
    const home = new THREE.Vector3(20.8, HOME.y, 7.2);
    rig.place(home);
    const drive = stepper();
    let from = rig.foe.arm.aim;
    let following = false;
    let back = -1;
    let length = 0;
    for (let i = 0; i < 60 * 40; i++) {
      const before = rig.ai.intent;
      const was = rig.ai.committed;
      const spun = rig.ai.spinning;
      rig.fight(1, drive(rig));
      const now = rig.ai.intent;
      if (now === "windup" && before !== "windup") {
        following = before === "strike";
        from = rig.foe.arm.aim;
        if (following && was !== null) {
          pairs++;
          const start = mid(rig.ai.committed!.cut.from.yaw);
          if (Math.min(Math.abs(start - was.to.yaw), Math.abs(start - was.from.yaw)) < 0.45) linked++;
        }
      }
      if (before === "windup" && now === "strike" && following) {
        chained++;
        if (drewBack(from, rig.foe.arm.aim)) drawn++;
      }
      // How long its guard takes to come back up, at the end of a run and
      // after a swing on its own -- not out of a spin, which has its own.
      if (now === "recover" && before !== "recover") {
        back = spun ? -1 : 0;
        length = rig.ai.run;
      } else if (now === "recover" && back >= 0) {
        back += STEP;
      }
      if (before === "recover" && now !== "recover" && back >= 0) {
        (length > 1 ? run : one).push(back);
        back = -1;
      }
      if (rig.player.dead) rig.place(home);
    }
    runs.push(`${species.name} ${rig.ai.tally.combos}`);
    if (one.length > 0) {
      for (const r of run) longer.push(r - median(one));
      alone.push(median(one));
    }
  }
  check("a swing that meets nothing runs straight into another, from where it ended",
    pairs >= 6 && linked === pairs,
    `${pairs} swings straight out of the one before (${runs.join(", ")}), ` +
    `${linked} of them starting where the one before ended or began`);
  check("and every one of them is drawn back for", chained >= 5 && drawn === chained,
    `${drawn} of ${chained} drew the weapon back first`);
  check("a run is paid for: its guard is longer coming back up at the end of one",
    longer.length >= 3 && median(longer) > 0.08,
    `a median ${median(longer).toFixed(2)}s longer after ${longer.length} runs than the same ` +
    `creature's after a swing on its own (${alone.map((a) => a.toFixed(2)).join(", ")}s)`);
}

async function itsGuardIsWhereItsLastSwingLeftIt(): Promise<void> {
  console.log("\nits guard is where its last swing left it, and never quite still");
  // It used to bring its weapon back to the one guard after every swing and
  // hold it there, still, until the next: a thing you could learn to stop
  // watching. Now it keeps its weapon on the side the swing ended, eases it
  // back in its own time, moves it between guards as it goes round you, and
  // never holds it quite still -- none of which is a weapon going back.
  const left: number[] = [];
  const right: number[] = [];
  for (const species of [SWORDSMAN, ORC]) {
    const rig = await buildRig({}, species, spawnFor(species, 20.8, 3.5));
    rig.place(new THREE.Vector3(20.8, HOME.y, 7.2));
    let last: Swing | null = null;
    for (let i = 0; i < 60 * 30; i++) {
      const before = rig.ai.intent;
      last = rig.ai.committed ?? last;
      rig.fight(1);
      if (before === "recover" && rig.ai.intent !== "recover" && last !== null) {
        const end = last.to.yaw;
        if (end > 0.5) left.push(rig.foe.arm.aim.yaw);
        if (end < -0.5) right.push(rig.foe.arm.aim.yaw);
      }
      if (rig.player.dead) rig.place(new THREE.Vector3(20.8, HOME.y, 7.2));
    }
  }
  // Where it holds its guard after a swing is all but decided by where the
  // swing ended, so two of each is plenty; swings that end on its right are
  // the fewer, and half a minute of two creatures now and then throws two.
  check("after a swing it keeps its weapon on the side the swing ended",
    left.length >= 2 && right.length >= 2 && mean(left) - mean(right) > 0.3,
    `guard at ${mean(left).toFixed(2)} rad after a swing ending on its left, ` +
    `${mean(right).toFixed(2)} after one ending on its right (${left.length} and ${right.length})`);

  // Going round you and nothing else, it shifts its guard and sways.
  const still = {
    ...SWORDSMAN.footwork, patience: [1000, 1000] as const, bait: 0, feint: 0, taunt: 0,
    parry: 0, wariness: 0,
  };
  const rig = await buildRig({}, { ...SWORDSMAN, footwork: still }, spawnFor(SWORDSMAN, 20.8, 3.0));
  rig.place(new THREE.Vector3(20.8, HOME.y, 6.2));
  const yaws: number[] = [];
  const pitches: number[] = [];
  let fastest = 0;
  let was: { yaw: number; pitch: number } | null = null;
  // Coming back to its guard out of a parry or a step out of the way is the
  // end of those, at a hand's speed: the guard is measured once it is back.
  let settled = 0;
  for (let i = 0; i < 60 * 20; i++) {
    rig.fight(1);
    if (rig.ai.intent !== "circle") {
      was = null;
      settled = 0;
      continue;
    }
    const aim = rig.foe.arm.aim;
    yaws.push(aim.yaw);
    pitches.push(aim.pitch);
    settled += STEP;
    if (was !== null && settled > 0.4) {
      fastest = Math.max(fastest, Math.hypot(aim.yaw - was.yaw, aim.pitch - was.pitch) / STEP);
    }
    was = { yaw: aim.yaw, pitch: aim.pitch };
  }
  // A guard held still, as it was, ranges well under a hundredth of a radian
  // either way over the same bout; a shift or two more or less in twenty
  // seconds is the difference between a tenth and a twentieth.
  check("going round you, it moves its guard about", yaws.length > 600
    && spread(yaws) > 0.03 && spread(pitches) > 0.03,
    `over ${(yaws.length / 60).toFixed(0)}s its guard ranged ${spread(yaws).toFixed(2)} rad across and ` +
    `${spread(pitches).toFixed(2)} up and down (standard deviations)`);
  // At a guard's pace. A guard shifted as fast as a swing goes is a swing,
  // and a sword brought round that fast a foot from you cut you: standing
  // still in front of a swordsman going round you, you lost eight times the
  // health you had before its guard moved at all.
  const swing = HAND_PX * 60 * rig.tuning.sensitivity;
  check("at a guard's pace, not a swing's", fastest < swing / 2,
    `its hand steered at up to ${fastest.toFixed(1)} rad/s, where a swing goes at ${swing.toFixed(1)}`);
}

async function itDrawsBackOnTheMove(): Promise<void> {
  console.log("\nit draws back on its way in, and from giving ground");
  // It used to stop, and then draw back. Now, pressing in, it often draws
  // back on the way and swings as it arrives -- and now and then it gives
  // ground as the weapon goes back and comes in behind it, so that following
  // it is walking onto the swing.
  let coming = 0;
  let closed = 0;
  const me = new THREE.Vector3();
  const it = new THREE.Vector3();
  const gap = (rig: Rig) => {
    rig.player.position(me);
    rig.foe.position(it);
    return Math.hypot(me.x - it.x, me.z - it.z);
  };
  for (const species of [SWORDSMAN, ORC]) {
    const rig = await buildRig({}, species, spawnFor(species, 20.8, 3.5));
    rig.place(new THREE.Vector3(20.8, HOME.y, 7.2));
    let start = 0;
    for (let i = 0; i < 60 * 40; i++) {
      const before = rig.ai.intent;
      rig.fight(1);
      const now = rig.ai.intent;
      const s = rig.ai.committed;
      if (now === "windup" && before !== "windup" && s?.move === "approach") start = gap(rig);
      if (before === "windup" && now === "strike" && s?.move === "approach") {
        coming++;
        if (start - gap(rig) > 0.15) closed++;
      }
      if (rig.player.dead) rig.place(new THREE.Vector3(20.8, HOME.y, 7.2));
    }
  }
  check("pressing in, it draws back on its way and swings as it arrives",
    coming >= 3 && closed >= (2 / 3) * coming,
    `${coming} swings drawn back on the way in, the swordsman's and the orc's in 40s each; ` +
    `${closed} closed the gap by more than 15cm while the weapon went back`);

  const lunger = { ...GOBLIN, footwork: { ...GOBLIN.footwork, lunge: 1 } };
  const rig = await buildRig({}, lunger, spawnFor(GOBLIN, 10.0, -7.8));
  rig.place(new THREE.Vector3(10.0, HOME.y, -4.0));
  let lunges = 0;
  let gave = 0;
  let cameBack = 0;
  let from = 0;
  let widest = 0;
  for (let i = 0; i < 60 * 30; i++) {
    const before = rig.ai.intent;
    rig.fight(1);
    const now = rig.ai.intent;
    const s = rig.ai.committed;
    if (s?.move !== "lunge") continue;
    if (now === "windup" && before !== "windup") from = widest = gap(rig);
    if (now === "windup") widest = Math.max(widest, gap(rig));
    if (before === "windup" && now === "strike") {
      lunges++;
      if (widest - from > 0.1) gave++;
      if (widest - gap(rig) > 0.1) cameBack++;
    }
  }
  check("and from giving ground: a step back as the weapon goes back, and in again behind it",
    lunges >= 3 && gave >= (2 / 3) * lunges && cameBack >= (2 / 3) * lunges,
    `${lunges} lunges by a goblin that always does: ${gave} gave more than 10cm of ground as ` +
    `the spear went back, and ${cameBack} came back in by more than that before it thrust`);
}

async function aMissCanCarryItRound(): Promise<void> {
  console.log("\na swing that goes round through nothing can carry it round on its heel");
  // Shift and a turn turns you on your heel -- everyone, you included -- and
  // a swing that goes round and meets nothing can carry the whole body round
  // after it: the weapon out where the swing ended, the body turning under
  // it, and the same weapon coming round at you again.
  const rig = await buildRig();
  rig.step(30);
  const turned = (keys: Keys) => {
    const was = rig.fighter.yaw;
    rig.step(24, keys);
    const d = rig.fighter.yaw - was;
    rig.step(30);
    return Math.abs(d);
  };
  const walk = turned({ ...NO_KEYS, turnLeft: true });
  const heel = turned({ ...NO_KEYS, turnLeft: true, pivot: true });
  check("Shift with a turn turns you on your heel, several times as fast", heel > 3 * walk,
    `in 0.4s: ${walk.toFixed(2)} rad turning, ${heel.toFixed(2)} on your heel`);

  let spins = 0;
  let backTurned = 0;
  let fastest = 0;
  let met = 0;
  const who: string[] = [];
  for (const [base, cut] of [[ORC, "wide swing"], [SWORDSMAN, "forehand"]] as const) {
    const species = {
      ...base,
      cuts: base.cuts.map((c) => (c.spin ? { ...c, spin: { ...c.spin, chance: 1 } } : c)),
    };
    const fight = await buildRig({}, species, spawnFor(species, 20.8, 3.5));
    fight.ai.cutOverride = cut;
    const home = new THREE.Vector3(20.8, HOME.y, 7.2);
    fight.place(home);
    const drive = stepper();
    let touched = false;
    const touch = () => { if (fight.ai.spinning) touched = true; };
    fight.impacts.addBlade(fight.foe.arm, touch);
    fight.impacts.onClash = touch;
    const me = new THREE.Vector3();
    const it = new THREE.Vector3();
    let turnedAway = false;
    for (let i = 1; i < 60 * 40; i++) {
      const was = fight.ai.spinning;
      fight.fight(1, drive(fight));
      const now = fight.ai.spinning;
      if (now && !was) {
        spins++;
        touched = false;
        turnedAway = false;
      }
      if (now) {
        fastest = Math.max(fastest, fight.foe.arm.state.tipSpeed);
        fight.player.position(me);
        fight.foe.position(it);
        let off = Math.atan2(-(me.x - it.x), -(me.z - it.z)) - fight.foe.fighter.yaw;
        while (off > Math.PI) off -= 2 * Math.PI;
        while (off < -Math.PI) off += 2 * Math.PI;
        if (Math.abs(off) > 2.2) turnedAway = true;
      }
      if (was && !now) {
        if (turnedAway) backTurned++;
        if (touched) met++;
      }
      // Back where they began now and then: a run of misses walks the fight
      // across the den, and into its walls.
      if (fight.player.dead || (i % 360 === 0 && !now)) {
        fight.foe.reset(fight.tuning, spawnFor(species, 20.8, 3.5));
        fight.ai.reset();
        fight.place(home);
      }
    }
    who.push(`${base.name} ${fight.ai.tally.spins}`);
  }
  check("miss with a swing that goes round, and it may come round again", spins >= 4,
    `${spins} spins in 40s each (${who.join(", ")}) against someone stepping back out of every swing`);
  check("its back is to you on the way round, which is the moment to go in",
    backTurned >= spins - 1,
    `${backTurned} of ${spins} turned it more than two radians away from you`);
  check("and the weapon comes round at you at a body's turning speed", fastest > 10 && met >= 2,
    `up to ${fastest.toFixed(1)} m/s at the tip; ${met} of ${spins} met you or your weapon`);
}

/** Every collider a body's weapon is made of. */
function weaponHandles(arm: Arm): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < arm.blade.numColliders(); i++) out.add(arm.blade.collider(i).handle);
  return out;
}

async function itMeetsASwingWithItsWeapon(): Promise<void> {
  console.log("\nit meets a swing with its weapon as well as its feet");
  // Getting out of the way used to be the only answer it had to a blade: it
  // stepped out of it, or stood and took it. Now it may put its own weapon
  // across the line yours is coming on, a reaction time after it sees yours
  // go back -- which is what anyone watching an arm reads, and not a moment
  // before -- and what comes of that is the weapons' business. Stand in front
  // of one going round you and cut at it, sixteen times. About half the swings
  // it parries meet its weapon: a dozen was too few to say so every time.
  const swings = 16;
  const trial = async (base: Species, parry: number) => {
    const species = {
      ...base,
      footwork: {
        ...base.footwork, parry, wariness: 0, counter: 0, bait: 0, feint: 0, rock: 0,
        taunt: 0, lunge: 0, patience: [1000, 1000] as const,
      },
      temper: undefined,
    };
    const rig = await buildRig({}, species, spawnFor(species, 20.8, 5.0));
    rig.place(new THREE.Vector3(20.8, HOME.y, 8.0));
    const its = weaponHandles(rig.foe.arm);
    let parried = 0;
    let met = 0;
    let knocked = 0;
    rig.impacts.onClash = (c) => { if (rig.ai.intent === "parry" && c.knocked === rig.arm) knocked++; };
    // Where your sword reaches its middle from: a man's length for a man, a
    // step further off an orc's bulk, a step nearer a goblin.
    const off = 1.0 * Math.max(0.9, species.build.scale * species.build.girth);
    for (let k = 0; k < swings; k++) {
      for (let i = 0; i < 240 && rig.ai.intent !== "circle"; i++) rig.fight(1);
      // In front of it, facing it.
      const at = rig.foe.position(new THREE.Vector3());
      const yaw = rig.foe.fighter.yaw;
      rig.place(new THREE.Vector3(at.x - Math.sin(yaw) * off, HOME.y, at.z - Math.cos(yaw) * off));
      rig.fighter.yaw = yaw + Math.PI;
      rig.fight(1);
      rig.foe.position(at);
      const cut = forehandAt(rig, new THREE.Vector3(at.x, 1.25 * species.build.scale, at.z));
      const was = rig.ai.tally.parries;
      let seen = rig.impacts.latest;
      let touched = false;
      const t = rig.tuning;
      const w = (v: number, c: number) => Math.max(-c, Math.min(c, v));
      for (const [want, steps] of [[cut.from, 30], [cut.to, 30]] as const) {
        for (let i = 0; i < steps; i++) {
          const aim = rig.arm.aim;
          rig.input.dx = -w((want.yaw - aim.yaw) / t.sensitivity, HAND_PX);
          rig.input.dy = -w((want.pitch - aim.pitch) / t.sensitivity, HAND_PX);
          rig.input.rollDx = w((cut.roll - aim.roll) / t.rollSensitivity, HAND_PX);
          rig.input.wheel = w((rig.arm.reachAt(want.reach) - aim.reach) / t.reachRate, 4);
          rig.fight(1);
          const hit = rig.impacts.latest;
          if (hit !== seen && hit !== null && its.has(hit.colliderHandle)) touched = true;
          seen = hit;
        }
      }
      if (rig.ai.tally.parries > was) {
        parried++;
        if (touched) met++;
      }
      rig.foe.health = rig.foe.maxHealth;
      rig.fight(30);
    }
    return { parried, met, knocked };
  };
  const never = await trial(SWORDSMAN, 0);
  const man = await trial(SWORDSMAN, 1);
  const orc = await trial(ORC, 1);
  check("it puts its weapon in the way of a swing it sees drawn back",
    man.parried >= 6 && man.met >= 2 && never.parried === 0,
    `a swordsman that always does met ${man.parried} of ${swings} forehands, ` +
    `${man.met} of them with its sword; one that never does, ${never.parried}`);
  // Held still in the way, a weapon is knocked aside by a swing with more
  // behind it, as any is; still moving as your blade meets it, the orc's axe
  // sends your sword back instead. Which it is, is where the axe had got to.
  check("and the orc puts its axe in the way", orc.parried >= 4 && orc.met >= 1,
    `${orc.parried} of ${swings} parried, ${orc.met} met by the axe, ` +
    `${orc.knocked} sending your sword back`);
}

async function itHopsClearAndFlinches(): Promise<void> {
  console.log("\nit hops clear, and a cut that lands while it draws back can take the swing off it");
  // A step out of the way is sometimes a hop now: the jump key, back and
  // away, off the floor -- the goblin more often than not, the orc never.
  // How many steps out of the way it takes in a bout is its own business
  // (see above): this one hops every one of them.
  // In the den, which is longer than the cell, and meeting nothing with its
  // spear: in the cell there is not always floor behind it for a hop, and
  // every swing it parries is one it does not step out of.
  const hopper = { ...GOBLIN, footwork: { ...GOBLIN.footwork, hop: 1, parry: 0 } };
  const start = spawnFor(GOBLIN, 20.8, 3.5);
  const rig = await buildRig({}, hopper, start);
  const home = new THREE.Vector3(20.8, HOME.y, 7.2);
  rig.place(home);
  const drive = fencer();
  let rose = 0;
  let floor = rig.foe.position(new THREE.Vector3()).y;
  const it = new THREE.Vector3();
  // A minute of it, put back where it began every seven and a half seconds.
  // It only hops out of a swing it sees coming while it is not swinging
  // itself -- three to ten times a bout -- and a bout that gives it no floor
  // to give ground on gives it fewer: pressed for long enough, it is pinned
  // against a wall. In the den that happened sooner than in the hall this
  // used to be fought in, which was half as wide again, and in forty-five
  // seconds of it one bout in five or so it never hopped at all. You go back
  // first, so that it does not come back down on top of you.
  for (let i = 0; i < 60 * 60; i++) {
    if (i > 0 && i % 450 === 0 && rig.ai.intent !== "evade" && rig.ai.intent !== "backoff") {
      rig.place(home);
      rig.foe.reset(rig.tuning, start);
      rig.ai.reset();
    }
    rig.fight(1, drive(rig));
    rig.foe.position(it);
    if (rig.foe.fighter.grounded && rig.ai.intent !== "evade" && rig.ai.intent !== "backoff") floor = it.y;
    if (rig.ai.intent === "evade" || rig.ai.intent === "backoff") rose = Math.max(rose, it.y - floor);
    if (rig.player.dead) rig.place(home);
  }
  check("a goblin swung at hops back off the floor", rig.ai.tally.hops >= 1 && rose > 0.15,
    `${rig.ai.tally.hops} hops in 60s of being swung at by one that always does, ` +
    `up to ${(rose * 100).toFixed(0)}cm off the floor`);

  // Cut it while it draws back. A stagger takes a swing off anything light
  // enough to rock; this is the swing it lets go of because it hurt, and the
  // orc does not.
  const let_go: string[] = [];
  const counts = new Map<string, [number, number]>();
  for (const species of [GOBLIN, SWORDSMAN, ORC]) {
    const r = await buildRig({}, species, spawnFor(species, 20.8, 5.0));
    r.place(new THREE.Vector3(20.8, HOME.y, 6.8));
    let tries = 0;
    let gone = 0;
    for (let k = 0; k < 12; k++) {
      for (let i = 0; i < 600 && !(r.ai.intent === "windup" && !r.ai.committed?.leap); i++) r.fight(1);
      if (r.ai.intent !== "windup") continue;
      tries++;
      r.foe.receive(fakeImpact(r.foe.fighter.collider.handle, { closingSpeed: 6 }));
      r.fight(1);
      const after: string = r.ai.intent;
      if (after === "recover") gone++;
      r.fight(60);
      r.foe.health = r.foe.maxHealth;
    }
    counts.set(species.key, [gone, tries]);
    let_go.push(`${species.name} ${gone} of ${tries}`);
  }
  const [goblin, gTries] = counts.get("goblin")!;
  const [man, mTries] = counts.get("swordsman")!;
  const [orc, oTries] = counts.get("orc")!;
  check("cut while it draws back, it may let go of the swing -- never the orc",
    gTries >= 8 && goblin >= gTries / 2 && mTries >= 8 && man >= 1 && man < mTries
      && oTries >= 8 && orc === 0,
    `let go of the swing: ${let_go.join(", ")}`);
}

async function aCutLegLamesYou(): Promise<void> {
  console.log("\na cut leg lames you, whoever you are, and a potion mends it");
  const rig = await buildRig();
  rig.step(30);
  const walk = () => {
    const a = rig.fighter.position(new THREE.Vector3());
    rig.step(60, { ...NO_KEYS, forward: true });
    const b = rig.fighter.position(new THREE.Vector3());
    rig.step(40);
    return Math.hypot(b.x - a.x, b.z - a.z);
  };
  const whole = walk();
  const thigh = rig.fighter.parts.find((p) => p.name.endsWith("thigh"))!;
  for (let i = 0; i < 3; i++) rig.player.receive(fakeImpact(thigh.collider.handle));
  const lamed = walk();
  check("cut in the leg, you walk slower", lamed < 0.75 * whole && rig.fighter.lame > 0.5,
    `${whole.toFixed(2)} m in a second whole, ${lamed.toFixed(2)} lamed (${(rig.fighter.lame * 100).toFixed(0)}%)`);
  // The other hand is free: nothing on it.
  rig.player.potions = 1;
  const sip = rig.player.drink();
  rig.step(60 * 4);
  const mended = walk();
  check("and a potion mends it with the rest of you", sip.ok && mended > 0.9 * whole,
    `${mended.toFixed(2)} m in a second after a potion`);
}

async function badlyHurtItFightsLikeIt(): Promise<void> {
  console.log("\nbadly hurt, it fights like it");
  // The orc gets angry and the goblin gets away: the same creature, fought
  // with a quarter of its health left, against itself whole.
  const bout = async (species: Species, hurt: boolean) => {
    const rig = await buildRig({}, species, foeSpawn(species));
    if (hurt) rig.foe.health = rig.foe.maxHealth * 0.25;
    return watchBout(rig, 40);
  };
  const orc = await bout(ORC, false);
  const angry = await bout(ORC, true);
  const goblin = await bout(GOBLIN, false);
  const scared = await bout(GOBLIN, true);
  const pct = (b: Bout) => `${(swinging(b) * 100).toFixed(0)}%`;
  check("hurt, the orc gets angry: it spends more of the fight swinging",
    swinging(angry) > swinging(orc),
    `swinging ${pct(angry)} of the time with a quarter of its health, ${pct(orc)} whole`);
  check("and the goblin gets away: it spends less of it swinging, and more going round you",
    swinging(scared) < swinging(goblin),
    `swinging ${pct(scared)} of the time with a quarter of its health, ${pct(goblin)} whole`);
}

async function itTauntsYouFromOutOfReach(): Promise<void> {
  console.log("\nout of its reach, it shows you its weapon");
  // Never drawn back, so never a lie: the orc beats the floor with its axe.
  const species = { ...ORC, footwork: { ...ORC.footwork, taunt: 1 } };
  const rig = await buildRig({}, species, spawnFor(species, 20.8, 3.0));
  rig.place(new THREE.Vector3(20.8, HOME.y, 8.5));
  const me = new THREE.Vector3();
  const it = new THREE.Vector3();
  let lowest = 9;
  let nearest = 99;
  let windups = 0;
  // Where its axe does its work, flat from its middle, measured as it measures its own.
  rig.foe.position(it);
  const works = rig.foe.arm.probeStrike(0, 0, 1, 0, rig.tuning, new THREE.Vector3());
  const reach = Math.hypot(works.x - it.x, works.z - it.z);
  for (let i = 0; i < 60 * 12; i++) {
    // Back off to the far side of the den now and then, and stand.
    if (i % 240 === 0) rig.place(new THREE.Vector3(20.8, HOME.y, 10.5));
    const keys = { ...NO_KEYS };
    rig.player.position(me);
    rig.foe.position(it);
    faceToward(rig.fighter, it.x - me.x, it.z - me.z, keys);
    const before = rig.ai.intent;
    rig.fight(1, keys);
    if (rig.ai.intent !== "taunt") continue;
    if (before !== "taunt") nearest = Math.min(nearest, Math.hypot(me.x - it.x, me.z - it.z));
    lowest = Math.min(lowest, rig.foe.arm.tipPosition.y);
    if (rig.ai.committed !== null) windups++;
  }
  check("the orc beats the floor with its axe at you, from out of its reach",
    rig.ai.tally.taunts >= 1 && lowest < 0.4 && nearest > 1.3 * reach && windups === 0,
    `${rig.ai.tally.taunts} taunts, the axe down to ${(lowest * 100).toFixed(0)}cm off the floor, ` +
    `never nearer you than ${nearest.toFixed(1)} m, where its axe works at ${reach.toFixed(2)}`);
}

async function theyQuickStepToo(): Promise<void> {
  console.log("\nthey quick-step too: in with a swing, and out after it");
  // Your double tap, on their keys: the same pace, the same rest, and never
  // off the floor. The goblin is never still, the swordsman does it now and
  // then, and the orc hardly ever -- a heavy thing throwing its weight about.
  const rest = DEFAULTS.quickStepRest;
  const steps = new Map<string, number>();
  let soonest = Infinity;
  let darts = 0;
  let thrown = 0;
  let drawn = 0;
  let closed = 0;
  let outs = 0;
  const me = new THREE.Vector3();
  const it = new THREE.Vector3();
  for (const species of [GOBLIN, SWORDSMAN, ORC]) {
    let taken = 0;
    for (let bout = 0; bout < 3; bout++) {
      const rig = await buildRig({}, species, foeSpawn(species));
      rig.player.position(me);
      const home = new THREE.Vector3(me.x, HOME.y, me.z);
      const gap = () => {
        rig.player.position(me);
        rig.foe.position(it);
        return Math.hypot(me.x - it.x, me.z - it.z);
      };
      let last = -Infinity;
      let from = rig.foe.arm.aim;
      let start = 0;
      for (let i = 0; i < 60 * 40; i++) {
        const before = rig.ai.intent;
        const was = rig.foe.fighter.quickSteps;
        const was2 = rig.ai.tally.darts;
        rig.fight(1);
        if (rig.foe.fighter.quickSteps > was) {
          soonest = Math.min(soonest, i * STEP - last);
          last = i * STEP;
        }
        // A swing off a quick step in: where the weapon was as it set off,
        // and how far off you were.
        if (rig.ai.tally.darts > was2) {
          from = rig.foe.arm.aim;
          start = gap();
        }
        const s = rig.ai.committed;
        if (before === "windup" && s?.move === "dart" && rig.ai.intent !== "windup") {
          if (rig.ai.intent === "strike") {
            thrown++;
            if (drewBack(from, rig.foe.arm.aim)) drawn++;
            if (start - gap() > 0.3) closed++;
          }
        }
        if (rig.player.dead) rig.place(home);
      }
      taken += rig.foe.fighter.quickSteps;
      darts += rig.ai.tally.darts;
      outs += rig.ai.tally.quickOuts;
    }
    steps.set(species.key, taken);
  }
  const [goblin, man, orc] = ["goblin", "swordsman", "orc"].map((k) => steps.get(k)!);
  check("the goblin quick-steps all the time, the swordsman now and then, the orc hardly ever",
    goblin > man && man > orc && soonest >= rest - 1e-6,
    `${goblin}, ${man} and ${orc} quick steps in two minutes each; never two nearer than ` +
    `${soonest.toFixed(2)}s apart, where the rest is ${rest}s`);
  check("its moment come, it quick-steps in with the weapon going back, and swings from where it lands",
    darts >= 6 && thrown >= 0.75 * darts && drawn === thrown && closed >= 0.75 * thrown,
    `${darts} quick steps in to swing: ${thrown} swung from where they landed, ${drawn} of those ` +
    `drew the weapon back first, ${closed} closed the gap by more than 30cm`);
  check("and out again after a swing", outs >= 4,
    `${outs} quick steps back out of reach after a swing`);

  // Out of the way of your swing, a quick step gets it further in the moment
  // it has than a step does: a goblin that only goes round you, getting out
  // of the way of everything it sees coming -- quick whenever it is rested --
  // against the same goblin that never quick-steps. Neither of them hops.
  // Put back where they began every five seconds: a bout that wanders off
  // to where your swings never come near it has nothing to get out of.
  const away = async (quick: number) => {
    const goblin = {
      ...GOBLIN,
      footwork: {
        ...GOBLIN.footwork, patience: [60, 60] as const, counter: 0, bait: 0, feint: 0, lunge: 0,
        wariness: 1, hop: 0, parry: 0, quick,
      },
    };
    const start = spawnFor(GOBLIN, 20.8, 3.5);
    const rig = await buildRig({}, goblin, start);
    const home = new THREE.Vector3(20.8, HOME.y, 7.2);
    const moved: number[] = [];
    for (let trial = 0; trial < 8; trial++) {
      rig.foe.reset(rig.tuning, start);
      rig.ai.reset();
      rig.place(home);
      const drive = fencer();
      let from: THREE.Vector3 | null = null;
      let t = 0;
      for (let i = 0; i < 60 * 5; i++) {
        const before = rig.ai.intent;
        const was = rig.ai.tally.quickDodges;
        rig.fight(1, drive(rig));
        if (rig.ai.intent === "evade" && before !== "evade"
          && (quick === 0 || rig.ai.tally.quickDodges > was)) {
          from = rig.foe.position(new THREE.Vector3());
          t = 0;
        }
        if (from && (t += STEP) >= 0.2) {
          rig.foe.position(it);
          moved.push(Math.hypot(it.x - from.x, it.z - from.z));
          from = null;
        }
        if (rig.player.dead) rig.place(home);
      }
    }
    return { moved, quick: rig.ai.tally.quickDodges };
  };
  const quick = await away(1);
  const step = await away(0);
  check("and out of the way of your swing, further in the moment it has than a step goes",
    quick.quick >= 3 && step.quick === 0 && step.moved.length >= 3
      && median(quick.moved) > 1.4 * median(step.moved),
    `${quick.quick} quick steps out of the way, ${median(quick.moved).toFixed(2)} m in the first ` +
    `0.2s; a step ${median(step.moved).toFixed(2)} m (${step.moved.length} of them)`);
}

// -----------------------------------------------------------------------------
// The other arm, the scabbard, the belt, the shield, crouching and vaulting
// -----------------------------------------------------------------------------

/** How fast a body is turning, rad/s. */
function spin(b: { angvel(): { x: number; y: number; z: number } }): number {
  const w = b.angvel();
  return Math.hypot(w.x, w.y, w.z);
}

/** Where a world point sits in a fighter's own frame: +X its sword side, -Z ahead. */
function inHull(f: Fighter, p: { x: number; y: number; z: number }): THREE.Vector3 {
  const h = f.body.translation();
  return new THREE.Vector3(p.x - h.x, p.y - h.y, p.z - h.z)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), -f.yaw);
}

async function theOtherArmHoldsStill(): Promise<void> {
  console.log("\nthe other arm is carried, not flopping about");
  const rig = await buildRig();
  rig.step(120);
  const limb = rig.fighter.offLimb;
  const head = rig.fighter.parts.find((p) => p.name === "head")!.body!;
  let arm = 0;
  let neck = 0;
  for (let i = 0; i < 120; i++) {
    rig.step(1);
    arm = Math.max(arm, spin(limb.upper), spin(limb.fore));
    neck = Math.max(neck, spin(head));
  }
  // Both used to sit in a limit cycle at the torque clamp, flipping every step.
  check("standing still, the other arm holds still", arm < 0.5,
    `${arm.toFixed(2)} rad/s at most over two seconds; it spun at 37 about its own length`);
  check("and so does the head", neck < 0.5,
    `${neck.toFixed(2)} rad/s at most; it buzzed at 15 about its own vertical`);

  const fore = limb.fore.translation();
  const hand = inHull(rig.fighter, fore);
  check("its hand hangs in front of the body, on its own side", hand.z < -0.1 && hand.x < 0,
    `forearm at ${hand.x.toFixed(2)} across, ${(-hand.z).toFixed(2)} ahead`);

  rig.step(60, { ...NO_KEYS, forward: true });
  rig.step(30);
  let after = 0;
  for (let i = 0; i < 30; i++) {
    rig.step(1);
    after = Math.max(after, spin(limb.upper), spin(limb.fore));
  }
  check("a walk and a stop, and it settles back where it hangs",
    rig.player.offArm.trackingError < 0.02 && after < 1,
    `${(rig.player.offArm.trackingError * 100).toFixed(1)} cm off its mark, ${after.toFixed(2)} rad/s`);
}

/** Put the sword up, or take it out, and wait for the hand to finish: at most `limit` steps. */
function stow(rig: Rig, draw: boolean, limit = 240): number {
  if (!rig.arm.stowing && !(draw ? rig.arm.draw() : rig.arm.sheathe())) return -1;
  let n = 0;
  while (rig.arm.stowing && n < limit) {
    rig.step(1);
    n++;
  }
  return n;
}

async function theSwordGoesOnYourBack(): Promise<void> {
  console.log("\nthe sword goes on your back, and comes back to your hand");
  const rig = await buildRig();
  rig.step(60);

  // Carried there, not put there: watch the blade and the hand the whole way.
  const arm = rig.arm as unknown as { sheathPoint: THREE.Vector3; sheathQuat: THREE.Quaternion };
  const hand = () => {
    const f = rig.arm.fore;
    const r = f.rotation();
    const t = f.translation();
    return new THREE.Vector3(0, SWORDSMAN.build.segment.foreArm.length / 2, 0)
      .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  };
  const bladeP = () => {
    const t = rig.arm.blade.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  };
  const bladeQ = () => {
    const r = rig.arm.blade.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
  };
  const put = rig.arm.sheathe();
  let steps = 0;
  let jump = 0;
  let turn = 0;
  let apart = 0;
  let highest = -Infinity;
  let p = bladeP();
  let q = bladeQ();
  while (rig.arm.stowing && steps < 240) {
    const inHand = !rig.arm.sheathed;
    rig.step(1);
    steps++;
    const np = bladeP();
    const nq = bladeQ();
    jump = Math.max(jump, np.distanceTo(p));
    turn = Math.max(turn, 2 * Math.acos(Math.min(1, Math.abs(nq.dot(q)))));
    if (inHand && !rig.arm.sheathed) apart = Math.max(apart, np.distanceTo(hand()));
    highest = Math.max(highest, hand().y - rig.fighter.body.translation().y);
    p = np;
    q = nq;
  }
  const blade = inHull(rig.fighter, rig.arm.blade.translation());
  check("X puts it on your back", put && rig.arm.sheathed && blade.z > 0.08 && blade.y > 0.3,
    `hilt ${blade.z.toFixed(2)} m behind the hull's middle, ${blade.y.toFixed(2)} above it`);
  check("and it takes a moment: the hand takes it there", steps > 45 && steps < 120,
    `${(steps / 60).toFixed(2)} s from the key to the empty hand coming back`);
  check("the hand goes up over the shoulder with it, and stays on the grip all the way in",
    highest > 0.9 && apart < 0.1,
    `hand ${highest.toFixed(2)} m over the hull's middle at the top; never more than ${(apart * 100).toFixed(1)} cm from the grip`);
  check("nothing about it is a snap", jump < 0.12 && turn < 0.6,
    `the blade moved at most ${(jump * 100).toFixed(1)} cm and turned ${turn.toFixed(2)} rad in a step`);

  // Once it has come back down to the aim.
  rig.step(45);
  let shake = 0;
  for (let i = 0; i < 60; i++) {
    rig.step(1);
    shake = Math.max(shake, spin(rig.arm.fore), spin(rig.arm.upper));
  }
  // The drive was tuned with a sword in the hand; empty, it used to flip the
  // arm back and forth every step at the force clamp.
  check("the empty hand holds still", shake < 1 && rig.arm.state.trackingError < 0.02,
    `${shake.toFixed(2)} rad/s at most, ${(rig.arm.state.trackingError * 100).toFixed(1)} cm off`);

  // On your back it is out of the world: it can neither be parried, nor
  // snag a door frame, nor be swept for a cut.
  const out = rig.arm.weaponColliders.every((c) => !c.isEnabled());
  check("and out of the world while it is there: nothing can touch it",
    out && !rig.arm.wielding && rig.arm.blade.isKinematic(),
    `${rig.arm.weaponColliders.length} colliders off, wielding ${rig.arm.wielding}`);

  // It used to be sent to where the back was before the step, and so rode a
  // step behind a body on the move: five centimetres out of the scabbard at
  // a walk.
  const sheath = new THREE.Vector3();
  const sq = new THREE.Quaternion();
  let drift = 0;
  for (let i = 0; i < 90; i++) {
    rig.step(1, { ...NO_KEYS, forward: true, turnLeft: i > 45 });
    rig.fighter.chestFrameWorld(arm.sheathPoint, arm.sheathQuat, sheath, sq);
    drift = Math.max(drift, bladeP().distanceTo(sheath));
  }
  check("walking and turning, it stays in the scabbard", drift < 0.01,
    `${(drift * 1000).toFixed(1)} mm out of place at most`);
  rig.step(30);

  const took = stow(rig, true);
  const hilt = rig.arm.blade.translation();
  const h = hand();
  const gap = Math.hypot(hilt.x - h.x, hilt.y - h.y, hilt.z - h.z);
  rig.step(40);
  check("drawn, it comes over the shoulder into the hand and the arm tracks",
    took > 45 && rig.arm.wielding && gap < 0.01 && rig.arm.state.trackingError < 0.03,
    `${(took / 60).toFixed(2)} s; hilt ${(gap * 1000).toFixed(1)} mm from the hand, ` +
    `${(rig.arm.state.trackingError * 100).toFixed(1)} cm off`);

  // Cut off halfway: the sword is between hand and back, and goes home.
  rig.arm.sheathe();
  rig.step(40);
  const between = rig.arm.stowed && !rig.arm.sheathed;
  rig.player.arm.sever("elbow");
  rig.step(5);
  // Measured against the scabbard, not the hull: a body that has lost its
  // sword arm curls over the wound, and takes its back with it.
  rig.fighter.chestFrameWorld(arm.sheathPoint, arm.sheathQuat, sheath, sq);
  const home = bladeP().distanceTo(sheath);
  check("an arm cut off halfway leaves the sword on the back, not in the air",
    between && rig.arm.sheathed && !rig.arm.stowing && home < 0.01,
    `between ${between}; sheathed ${rig.arm.sheathed}, ${(home * 1000).toFixed(1)} mm from the scabbard`);

  rig.place(HOME);
  rig.arm.sheathe();
  rig.step(30);
  rig.place(HOME);
  check("a reset puts it back in your hand", !rig.arm.sheathed && rig.arm.wielding && !rig.arm.stowing,
    `sheathed ${rig.arm.sheathed}, wielding ${rig.arm.wielding}`);
}

async function aFreeHandTakesThings(): Promise<void> {
  console.log("\npotions, pick-ups and the rack: a free hand, and time");
  const rig = await buildRig();
  const items = new Items(new THREE.Scene(), ITEM_LAYOUT);
  const potion = ITEM_LAYOUT.potions[0];
  rig.place(new THREE.Vector3(potion.x - 0.8, HOME.y, potion.z));
  rig.step(20);
  const drawn = interact(rig.player, items);
  check("with a sword in your hand you pick nothing up", !drawn.ok && rig.player.potions === 0,
    drawn.text);
  rig.arm.sheathe();
  rig.step(20);
  const busy = interact(rig.player, items);
  stow(rig, false);
  const took = interact(rig.player, items);
  check("nor while it is on its way to your back; once it is there, you can",
    !busy.ok && took.ok && rig.player.potions === 1, `${busy.text}; ${took.text}`);

  rig.player.health = 40;
  const sip = rig.player.drink();
  rig.step(12);
  const early = rig.player.health;
  rig.step(150);
  check("a potion gives health back over seconds, not at once",
    sip.ok && early < 50 && Math.abs(rig.player.health - 80) < 0.5 && rig.player.potions === 0,
    `${early.toFixed(1)} a fifth of a second in, ${rig.player.health.toFixed(1)} after`);
  rig.player.health = 95;
  rig.player.potions = 1;
  rig.player.drink();
  rig.step(150);
  check("and never past full", rig.player.health === rig.player.maxHealth,
    `${rig.player.health.toFixed(1)} of ${rig.player.maxHealth}`);

  const rack = ITEM_LAYOUT.rack.at;
  rig.place(new THREE.Vector3(rack.x - 0.9, HOME.y, rack.z));
  rig.step(20);
  stow(rig, false);
  const take = interact(rig.player, items);
  stow(rig, true);
  rig.step(20);
  rig.player.health = 50;
  rig.player.potions = 1;
  const full = rig.player.drink();
  check("a shield on one arm and a sword in the other: no hand to drink with",
    take.ok && rig.player.hasShield && !full.ok && rig.player.potions === 1, full.text);
  stow(rig, false);
  const hang = interact(rig.player, items);
  const hung = !rig.player.hasShield;
  const again = interact(rig.player, items);
  check("the rack takes the shield back, and gives it again",
    hang.ok && hung && again.ok && rig.player.hasShield, `${hang.text}; ${again.text}`);
}

async function fGoesAndGetsIt(): Promise<void> {
  console.log("\nF goes and gets it: walks over, gets down to it, and takes it in the hand");
  const rig = await buildRig();
  const scene = new THREE.Scene();
  const items = new Items(scene, ITEM_LAYOUT);
  const pickup = new Pickup(rig.player, items);
  const f = rig.fighter;
  const potion = ITEM_LAYOUT.potions[0];
  const from = new THREE.Vector3(potion.x - 2, HOME.y, potion.z + 0.3);
  rig.place(from);
  rig.step(20);
  stow(rig, false);

  let outcome: { ok: boolean; text: string } | null = null;
  const go = (n: number, keys: Keys = NO_KEYS, each?: () => void) => {
    for (let i = 0; i < n && (pickup.active || i === 0); i++) {
      const k = pickup.step(keys, STEP, (o) => { outcome = o; }) ?? keys;
      rig.step(1, k);
      each?.();
    }
  };
  const start = pickup.start(NO_KEYS);
  const item = pickup.target;
  let lowest = Infinity;
  let closest = Infinity;
  let takenEarly = false;
  let walked = 0;
  go(600, NO_KEYS, () => {
    lowest = Math.min(lowest, f.eyeWorld(new THREE.Vector3()).y);
    if (item) {
      closest = Math.min(closest, rig.arm.handPosition.distanceTo(item.grip));
      // Before the hand ever got to it, it is not yours.
      if (closest > 0.12 && rig.player.potions > 0) takenEarly = true;
    }
    walked = Math.max(walked, Math.hypot(f.body.translation().x - from.x, f.body.translation().z - from.z));
  });
  const done = outcome as { ok: boolean; text: string } | null;
  check("it walks over to the potion", start.ok && item?.kind === "potion" && walked > 1,
    `${start.text}; walked ${walked.toFixed(2)} m`);
  check("gets down to the floor for it", lowest < SWORDSMAN.build.standing.crown - 0.6,
    `eyes down to ${lowest.toFixed(2)} m`);
  check("and takes it in the hand, not from a distance",
    closest < 0.1 && !takenEarly && done?.ok === true && rig.player.potions === 1,
    `hand ${(closest * 100).toFixed(1)} cm from it at the closest; ${done?.text}`);
  rig.step(40);
  check("and stands up again after", f.sink < 0.02 && f.stoop === 0,
    `sink ${f.sink.toFixed(3)} m`);

  // Going for the rack, a step of your own takes the body back.
  const rack = ITEM_LAYOUT.rack.at;
  rig.place(new THREE.Vector3(rack.x - 2, HOME.y, rack.z + 0.4));
  rig.step(20);
  stow(rig, false);
  outcome = null;
  const off = pickup.start(NO_KEYS);
  go(15);
  go(1, { ...NO_KEYS, back: true });
  check("a key of your own calls it off, and nothing is taken",
    off.ok && !pickup.active && !rig.player.hasShield && f.stoop === 0,
    `${off.text}; still going ${pickup.active}, shield ${rig.player.hasShield}`);

  // Held down when it started, a key is not a new one.
  outcome = null;
  const held = { ...NO_KEYS, forward: true };
  pickup.start(held);
  go(600, held);
  check("but one already held down when it started is not",
    (outcome as { ok: boolean } | null)?.ok === true && rig.player.hasShield,
    (outcome as { text: string } | null)?.text ?? "never finished");

  // A sword in the hand: F says so, and goes nowhere.
  stow(rig, true);
  const nope = pickup.start(NO_KEYS);
  check("with the sword out, F goes nowhere", !nope.ok && !pickup.active, nope.text);
}

async function aLeverIsPulledByHand(): Promise<void> {
  console.log("\nthe lever: F goes to it, the hand takes hold, and pulls it down against its spring");
  const rig = await buildRig();
  const items = new Items(new THREE.Scene(), ITEM_LAYOUT);
  const { lever, gate } = rig.arena.gateways.pen;
  items.add(lever.item);
  const pickup = new Pickup(rig.player, items);
  const f = rig.fighter;
  // A couple of paces out into the hall, turned away from it.
  rig.place(new THREE.Vector3(GATEWAYS.pen.lever.at.x + 1.8, HOME.y, GATEWAYS.pen.lever.at.z + 0.8));
  f.yaw = -Math.PI / 2;
  rig.step(40);

  const drawnPrompt = promptFor(rig.player, items);
  const nope = pickup.start(NO_KEYS);
  check("with your sword drawn it goes nowhere, and the prompt says so",
    !nope.ok && !pickup.active && drawnPrompt === "X then F — pull the lever",
    `"${nope.text}"; the prompt reads "${drawnPrompt}"`);

  stow(rig, false);
  const rest = lever.angle;
  let outcome: { ok: boolean; text: string } | null = null;
  const go = (n: number, keys: Keys = NO_KEYS, each?: () => void) => {
    for (let i = 0; i < n && (pickup.active || i === 0); i++) {
      const k = pickup.step(keys, STEP, (o) => { outcome = o; }) ?? keys;
      rig.step(1, k);
      each?.();
    }
  };
  const prompt = promptFor(rig.player, items);
  const start = pickup.start(NO_KEYS);
  const from = rig.player.position(new THREE.Vector3());
  const on = new THREE.Vector3();
  let walked = 0;
  let closest = Infinity;
  let early = false;
  let held = false;
  let slip = 0;
  let spin = 0;
  let lean = 0;
  let pull = 0;
  let caughtAt = -1;
  let n = 0;
  go(60 * 5, NO_KEYS, () => {
    n++;
    const at = rig.player.position(new THREE.Vector3());
    walked = Math.max(walked, Math.hypot(at.x - from.x, at.z - from.z));
    const hand = rig.arm.handPosition;
    if (!lever.gripped && !held) closest = Math.min(closest, hand.distanceTo(lever.item.grip));
    // Nothing moves it but the hand.
    if (!held && !lever.gripped && Math.abs(lever.angle - rest) > 0.02) early = true;
    held ||= lever.gripped;
    if (lever.gripped) {
      pull++;
      // The joint holding the hand to the bar, stretched: how far the hand is
      // from the place on the bar it took hold of, both as the step left
      // them -- `handPosition` is the drive's, from before the step.
      const r = rig.arm.fore.rotation();
      const t = rig.arm.fore.translation();
      const wrist = new THREE.Vector3(0, SWORDSMAN.build.segment.foreArm.length / 2, 0)
        .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
      slip = Math.max(slip, wrist.distanceTo(lever.gripAt(lever.angle, on)));
      for (const b of [rig.arm.upper, rig.arm.fore]) {
        const w = b.angvel();
        spin = Math.max(spin, Math.hypot(w.x, w.y, w.z));
      }
      lean = Math.max(lean, f.stoop);
    }
    if (caughtAt < 0 && lever.caught) caughtAt = n;
  });
  const done = outcome as { ok: boolean; text: string } | null;
  check("F walks over and turns to it, and the hand goes up to the handle",
    prompt === "F — pull the lever" && start.ok && walked > 1 && closest < 0.035,
    `"${prompt}"; ${start.text}; walked ${walked.toFixed(2)} m, the hand ` +
    `${(closest * 100).toFixed(1)} cm from the handle`);
  check("and nothing moves it until the hand has hold of it", held && !early,
    early ? "it moved before the hand was on it" : "still on its stop until then");
  check("the hand holds on the whole way down -- a joint, not a hand drawn on the handle",
    lever.caught && slip < 0.01 && pull > 10,
    `the hand was at most ${(slip * 1000).toFixed(1)} mm off where it took hold, over ` +
    `${(pull / 60).toFixed(2)}s of pulling`);
  check("the body leans into it, and the arm pulls it without a flail",
    lean > 0.1 && spin < 12,
    `a stoop of ${lean.toFixed(2)}; the arm at most ${spin.toFixed(1)} rad/s`);
  check("down past the catch it stays down, and the hand lets go of it",
    lever.caught && !lever.gripped && lever.angle < lever.bottom + 0.05 && done?.ok === true
      && lever.item.taken,
    `${lever.angle.toFixed(2)} rad against a stop at ${lever.bottom.toFixed(2)}; "${done?.text}"`);

  // The gate goes up on its own from there.
  let moved = -1;
  let up = -1;
  for (let i = 0; i < 60 * 5 && up < 0; i++) {
    rig.step(1);
    if (moved < 0 && gate.lift > 0.01) moved = i;
    if (gate.isOpen) up = i;
  }
  const since = (steps: number) => (steps + n - caughtAt) / 60;
  check("and the gate goes up: moving about half a second after, clear of its doorway in under four",
    moved >= 0 && since(moved) < 0.6 && up >= 0 && since(up) < 4,
    `moving ${since(moved).toFixed(2)}s after the catch, all the way up at ${since(up).toFixed(2)}s`);

  // Down, it is nothing to pull; F looks past it.
  rig.step(20);
  const again = pickup.start(NO_KEYS);
  check("a lever that is down is not offered again",
    !again.ok && promptFor(rig.player, items) === null, `"${again.text}"`);

  // A reset puts it back up and the gate down.
  lever.reset();
  gate.reset();
  rig.step(30);
  check("a reset puts the lever back on its stop and shuts the gate",
    Math.abs(lever.angle - rest) < 0.02 && !lever.caught && !lever.item.taken && gate.lift === 0
      && !gate.opening,
    `lever ${lever.angle.toFixed(3)} rad, caught ${lever.caught}; gate ${gate.lift.toFixed(2)} m up`);

  // Let go of halfway down -- a key of your own -- it goes back up, and
  // nothing opens.
  pickup.start(NO_KEYS);
  let lowest = rest;
  let pressed = false;
  for (let i = 0; i < 60 * 4 && pickup.active; i++) {
    const keys = pressed ? { ...NO_KEYS, back: true } : NO_KEYS;
    rig.step(1, pickup.step(keys, STEP, () => {}) ?? keys);
    if (lever.gripped) lowest = Math.min(lowest, lever.angle);
    pressed ||= lever.gripped && lowest < 0.2;
  }
  const letGo = pressed && !lever.gripped && !pickup.active;
  rig.step(60);
  check("let go of halfway -- a key of your own -- it springs back up, and the gate stays shut",
    letGo && lowest < 0.2 && !lever.caught && Math.abs(lever.angle - rest) < 0.03 && !gate.opening,
    `down to ${lowest.toFixed(2)} rad before the key, back to ${lever.angle.toFixed(2)}; ` +
    `caught ${lever.caught}, gate moving ${gate.opening}`);
}

async function aShieldStopsABlade(): Promise<void> {
  console.log("\na shield stops a blade, and the blow still lands its weight");
  const standAt = new THREE.Vector3(0, HOME.y, HOME.z);
  const run = async (shield: boolean) => {
    const at = spawnFor(SWORDSMAN, 0, HOME.z - 1.1);
    const rig = await buildRig({}, SWORDSMAN, at);
    rig.foe.fighter.yaw = Math.PI;             // facing you
    if (shield) rig.foe.equipShield();
    rig.holdFoe();
    rig.pin(standAt);
    rig.hold(90);
    let blocks = 0;
    let damage = 0;
    let weight = 0;
    rig.impacts.addBlade(rig.arm, (i) => {
      if (rig.foe.block(i)) {
        blocks++;
        weight = Math.max(weight, rig.foe.lastBlow?.speed ?? 0);
        return;
      }
      if (rig.foe.receive(i)) damage += cutDamage(i);
    });
    // Level, across the chest: a cut down across it goes under the shield
    // and into the hips, which says nothing about the shield either way.
    const target = new THREE.Vector3(0, SWORDSMAN.build.standing.crown * 0.72, at.z);
    for (let swings = 0; swings < 12; swings++) throwForehand(rig, target, { level: true });
    return { blocks, damage, weight };
  };
  const bare = await run(false);
  const held = await run(true);
  check("a cut that meets the shield is stopped by it", held.blocks >= 3,
    `the blade met the shield ${held.blocks} times in twelve swings`);
  check("and the body behind it is cut far less",
    bare.damage > 5 && held.damage < bare.damage * 0.5,
    `${held.damage.toFixed(1)} damage behind a shield, ${bare.damage.toFixed(1)} without`);
  check("the weight of a blocked blow still arrives", held.weight > 0,
    `the hardest block moved the body ${held.weight.toFixed(2)} m/s`);
}

async function aShieldOnYourBackStopsACutFromBehind(): Promise<void> {
  console.log("\na shield on your back stops a cut from behind, and the blow still lands its weight");
  const standAt = new THREE.Vector3(0, HOME.y, HOME.z);
  const run = async (shield: boolean, back = true, aside = 0) => {
    const at = spawnFor(SWORDSMAN, aside, HOME.z - 1.1);
    const rig = await buildRig({}, SWORDSMAN, at);
    rig.foe.fighter.yaw = back ? 0 : Math.PI;  // its back to you, or its front
    rig.holdFoe();
    rig.pin(standAt);
    rig.hold(30);
    if (shield) {
      rig.foe.equipShield();
      rig.hold(30);
      rig.foe.sling();
    }
    rig.hold(90);
    let blocks = 0;
    let damage = 0;
    let weight = 0;
    rig.impacts.addBlade(rig.arm, (i) => {
      if (rig.foe.block(i)) {
        blocks++;
        weight = Math.max(weight, rig.foe.lastBlow?.speed ?? 0);
        return;
      }
      if (rig.foe.receive(i)) damage += cutDamage(i);
    });
    // Level, across the shoulder blades, where the shield hangs.
    const high = SWORDSMAN.build.standing.waist + SLUNG.y * SWORDSMAN.build.scale;
    const target = new THREE.Vector3(at.x, high, at.z);
    for (let swings = 0; swings < 12; swings++) throwForehand(rig, target, { level: true });
    return { blocks, damage, weight, slung: rig.foe.shieldOnBack };
  };
  const bare = await run(false);
  const held = await run(true);
  check("a cut across the back meets the shield slung there, and is stopped by it",
    held.slung && held.blocks >= 3,
    `the blade met the shield on its back ${held.blocks} times in twelve swings`);
  check("and the back behind it is cut far less",
    bare.damage > 5 && held.damage < bare.damage * 0.5,
    `${held.damage.toFixed(1)} damage behind a slung shield, ${bare.damage.toFixed(1)} without`);
  check("the weight of a blow stopped on the back still arrives", held.weight > 0,
    `the hardest moved the body ${held.weight.toFixed(2)} m/s`);
  // The point of a cut to the front can reach round the hips and touch it
  // from inside: that is no block, and it spares the front nothing. What
  // twelve cuts come to on a body each of them knocks about is chaotic,
  // though: stood a centimetre or even a millimetre to one side, the same
  // twelve land anything from five to sixty, with or without the shield.
  // So the front is cut from nine places a centimetre apart, and it is what
  // they come to together that is compared -- still at most one cut in
  // twelve caught on the rim.
  const front = { blocks: 0, damage: 0, slung: true };
  let bareFront = 0;
  const places = [-0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04];
  for (const aside of places) {
    const held = await run(true, false, aside);
    front.blocks += held.blocks;
    front.damage += held.damage;
    front.slung &&= held.slung;
    bareFront += (await run(false, false, aside)).damage;
  }
  check("and it guards the back only: cuts to the front land as hard with it there as without",
    front.slung && front.blocks <= places.length && front.damage > bareFront * 0.7,
    `${front.blocks} blocked in ${places.length * 12}; ${front.damage.toFixed(1)} damage to the front `
      + `with a shield on the back, ${bareFront.toFixed(1)} without`);
}

async function theShieldArmIsSteered(): Promise<void> {
  console.log("\nthe left button steers the shield, and the sword stays put");
  const rig = await buildRig();
  rig.step(30);
  rig.player.equipShield();
  rig.step(90);
  const shield = rig.player.offArm.shieldCollider!;
  const low = shield.translation().y;
  const sword = { ...rig.arm.aim };
  rig.input.guarding = true;
  for (let i = 0; i < 20; i++) {
    rig.input.offDy = -12;
    rig.step(1);
  }
  rig.input.guarding = false;
  rig.step(60);
  const high = shield.translation().y;
  const still = Math.abs(rig.arm.aim.yaw - sword.yaw) + Math.abs(rig.arm.aim.pitch - sword.pitch);
  check("dragged up, the shield goes up, and stays there when you let go",
    high - low > 0.3 && rig.player.offArm.trackingError < 0.02,
    `${low.toFixed(2)} -> ${high.toFixed(2)} m, ${(rig.player.offArm.trackingError * 100).toFixed(1)} cm off its mark`);
  check("and the sword held its aim meanwhile", still < 1e-9, `aim moved ${still.toFixed(4)} rad`);
}

async function aCrouchGetsLow(): Promise<void> {
  console.log("\na crouch: everything above the knees goes down, the feet stay on the floor");
  const rig = await buildRig();
  rig.step(60);
  const f = rig.fighter;
  const headOf = () => f.parts.find((p) => p.name === "head")!.collider.translation().y;
  const soles = () => f.body.translation().y - SWORDSMAN.build.hullCentreY;
  const feet = () => f.parts.filter((p) => p.name.endsWith("shin")).map((p) => {
    const c = p.collider;
    const t = c.translation();
    const r = c.rotation();
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const half = SWORDSMAN.build.segment.shin.length / 2;
    return Math.min(t.y + axis.y * half, t.y - axis.y * half) - soles();
  });
  const standing = headOf() - soles();
  const chestUp = f.collider.translation().y;
  rig.step(40, { ...NO_KEYS, crouch: true });
  const crouched = headOf() - soles();
  const chestDown = f.collider.translation().y;
  const low = feet();
  check("the head and the chest go down a third of a metre",
    standing - crouched > 0.3 && chestUp - chestDown > 0.3,
    `head ${standing.toFixed(2)} -> ${crouched.toFixed(2)} m, chest down ${(chestUp - chestDown).toFixed(2)}`);
  check("and the legs bend under it, feet on the floor", low.every((y) => Math.abs(y) < 0.03),
    `lowest ends of the shins ${low.map((y) => y.toFixed(3)).join(", ")} m off the floor`);

  const z0 = f.body.translation().z;
  rig.step(60, { ...NO_KEYS, crouch: true, forward: true });
  const slow = z0 - f.body.translation().z;
  rig.step(30);
  const z1 = f.body.translation().z;
  rig.step(60, { ...NO_KEYS, forward: true });
  const fast = z1 - f.body.translation().z;
  check("crouched, the steps are short", slow < fast * 0.55,
    `${slow.toFixed(2)} m a second crouched, ${fast.toFixed(2)} standing`);
  // Stood still first: measured mid-stride it was the walk's bob it read, which
  // sat on the edge of the tolerance and tipped over it when steps were eased.
  rig.step(30);
  check("and letting go stands you back up", Math.abs(headOf() - soles() - standing) < 0.02,
    `head ${(headOf() - soles()).toFixed(2)} m`);
}

/**
 * How far any leg of a fighter is inside a box of stone, metres: its thigh
 * and shin colliders, which are posed from the legs you can see, sampled
 * along their length. A leg is never pushed out of stone -- it is posed, not
 * simulated -- so this is whether what is drawn goes through it.
 */
function legsInto(f: Fighter, box: { at: THREE.Vector3; half: THREE.Vector3 }): number {
  let worst = 0;
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const part of f.parts) {
    if (!/(thigh|shin)$/.test(part.name)) continue;
    const c = part.collider;
    const t = c.translation();
    const r = c.rotation();
    const half = c.halfHeight();
    const radius = c.radius();
    axis.set(0, 1, 0).applyQuaternion(q.set(r.x, r.y, r.z, r.w));
    for (let k = -2; k <= 2; k++) {
      p.set(t.x, t.y, t.z).addScaledVector(axis, (half * k) / 2);
      const dx = Math.abs(p.x - box.at.x) - box.half.x;
      const dy = Math.abs(p.y - box.half.y) - box.half.y;
      const dz = Math.abs(p.z - box.at.z) - box.half.z;
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0))
        + Math.min(Math.max(dx, dy, dz), 0);
      worst = Math.max(worst, radius - outside);
    }
  }
  return worst;
}

async function aVaultGoesOver(): Promise<void> {
  console.log("\na vault: the vault key goes over something waist high");
  const rig = await buildRig();
  const f = rig.fighter;
  const top = LOW_WALL.half.y * 2;
  // The hips, as drawn: where the hip pivots are, halfway between them.
  const hipsY = () => f.parts.filter((p) => p.name.endsWith("thigh")).reduce((y, p) => {
    const c = p.collider;
    const r = c.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return y + (c.translation().y + up.y * SWORDSMAN.build.segment.thigh.length / 2) / 2;
  }, 0);
  let lowest = Infinity;
  let deepest = 0;
  let turned = 0;
  let plant = Infinity;
  const vaultFrom = (at: THREE.Vector3, keys: Partial<Keys>) => {
    rig.place(at);
    rig.step(20);
    let peak = 0;
    let vaulted = false;
    let climbed = false;
    lowest = Infinity;
    deepest = 0;
    turned = 0;
    plant = Infinity;
    for (let i = 0; i < 90; i++) {
      rig.step(1, {
        ...NO_KEYS, ...keys, jump: !!keys.jump && i < 20, vault: !!keys.vault && i < 20,
      });
      vaulted ||= f.vaulting;
      climbed ||= f.climbing;
      peak = Math.max(peak, f.body.translation().y - SWORDSMAN.build.hullCentreY);
      const z = f.body.translation().z;
      if (f.vaulting && Math.abs(z - LOW_WALL.at.z) < LOW_WALL.half.z) lowest = Math.min(lowest, hipsY());
      deepest = Math.max(deepest, legsInto(f, LOW_WALL));
      turned = Math.max(turned, Math.abs(f.posture.pose.turn));
      const h = f.handhold;
      if (h && h.weight > 0.9) plant = Math.min(plant, handOf(f.offLimb.fore).distanceTo(h.left));
    }
    return { vaulted, climbed, peak, z: f.body.translation().z };
  };
  const nearWall = new THREE.Vector3(LOW_WALL.at.x, HOME.y, LOW_WALL.at.z + 1.2);
  const wall = vaultFrom(nearWall, { vault: true });
  check("the hall's low wall is vaulted, without even running at it",
    wall.vaulted && wall.peak > top && wall.z < LOW_WALL.at.z - LOW_WALL.half.z - 0.3 && f.grounded,
    `soles ${wall.peak.toFixed(2)} m over a ${top.toFixed(2)} m wall, landed ${(LOW_WALL.at.z - wall.z).toFixed(2)} m past its middle`);
  // The hull clears the top by a hand's breadth, and is invisible. What you
  // see goes over it as a vault does: a hand planted on the top, the hips
  // low over it and turned, the legs swung round clear of it.
  check("over it, the hips skim the top with the legs swung round clear of the stone",
    lowest < top + 0.5 && deepest < 0.02 && turned > 0.4,
    `hips ${(lowest - top).toFixed(2)} m over the top, legs never more than ${(deepest * 100).toFixed(1)} cm into it, hips turned ${(turned * 180 / Math.PI).toFixed(0)}deg`);
  check("and the other hand goes down on the top as it goes over", plant < 0.12,
    `the hand came within ${(plant * 100).toFixed(1)} cm of the top`);
  const block = vaultFrom(new THREE.Vector3(BLOCK.at.x, HOME.y, BLOCK.at.z + 1.3), { vault: true });
  const blockFar = BLOCK.at.z - BLOCK.half.z;
  check("and so is the hall's block", block.vaulted && block.z < blockFar,
    `landed at z ${block.z.toFixed(2)}, past its far face at ${blockFar.toFixed(2)}`);
  const pillar = vaultFrom(new THREE.Vector3(-3.9, HOME.y, 3.4 + 1.1), { vault: true });
  check("a pillar is not, and with nothing to vault the key does nothing",
    !pillar.vaulted && pillar.peak < 0.05,
    `vaulted ${pillar.vaulted}, peak ${pillar.peak.toFixed(2)} m`);
  const jumped = vaultFrom(nearWall, { jump: true });
  check("the jump key, standing still, is only a jump", !jumped.vaulted && !jumped.climbed,
    `vaulted ${jumped.vaulted}, climbed ${jumped.climbed}`);
}

/** The hand end of a forearm, world. */
function handOf(fore: {
  translation(): { x: number; y: number; z: number };
  rotation(): { x: number; y: number; z: number; w: number };
}): THREE.Vector3 {
  const r = fore.rotation();
  const t = fore.translation();
  return new THREE.Vector3(0, SWORDSMAN.build.segment.foreArm.length / 2, 0)
    .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
}

async function aClimbGoesUp(): Promise<void> {
  console.log("\na climb: the jump key, moving at a ledge, goes up onto it, hands first");
  const rig = await buildRig();
  const f = rig.fighter;
  const soles = () => f.body.translation().y - SWORDSMAN.build.hullCentreY;
  let deepest = 0;
  let leant = 0;
  const climbFrom = (at: THREE.Vector3, yaw: number, keys: Partial<Keys>, steps = 110) => {
    rig.place(at);
    f.yaw = yaw;
    rig.step(20);
    let climbed = false;
    let hold = Infinity;
    deepest = 0;
    leant = 0;
    for (let i = 0; i < steps; i++) {
      rig.step(1, { ...NO_KEYS, ...keys, jump: !!keys.jump && i < 10, forward: !!keys.forward && i < 30 });
      climbed ||= f.climbing;
      const h = f.handhold;
      if (h && h.weight > 0.9) hold = Math.min(hold, handOf(f.offLimb.fore).distanceTo(h.left));
      if (f.climbing) {
        deepest = Math.max(deepest, legsInto(f, LEDGE), legsInto(f, CRATE));
        leant = Math.max(leant, f.posture.pose.lean);
      }
    }
    return { climbed, soles: soles(), hold, grounded: f.grounded };
  };
  const ledgeTop = LEDGE.half.y * 2;
  const east = new THREE.Vector3(LEDGE.at.x + LEDGE.half.x + 0.7, HOME.y, LEDGE.at.z - 0.5);
  const up = climbFrom(east, Math.PI / 2, { forward: true, jump: true });
  check("W and Space at the ledge climb it: standing on top",
    up.climbed && Math.abs(up.soles - ledgeTop) < 0.05 && up.grounded,
    `soles at ${up.soles.toFixed(2)} m on a ${ledgeTop.toFixed(2)} m ledge`);
  check("the hands go on the edge on the way up", up.hold < 0.1,
    `the other hand came within ${(up.hold * 100).toFixed(1)} cm of its hold`);
  // Up the face and over the edge as a body goes, not a hull floating up it
  // with its knees drawn up: the chest folds down over the top, and a foot
  // comes up onto it -- and nothing of the legs goes through the stone on the
  // way, though the hull is three centimetres off the face.
  check("the chest goes over the top, and the legs come up past the edge, not through it",
    leant > 0.7 && deepest < 0.02,
    `leant ${(leant * 180 / Math.PI).toFixed(0)}deg over, legs never more than ${(deepest * 100).toFixed(1)} cm into the stone`);

  const crateTop = CRATE.half.y * 2;
  const byCrate = new THREE.Vector3(CRATE.at.x + CRATE.half.x + 0.7, HOME.y, CRATE.at.z);
  const first = climbFrom(byCrate, Math.PI / 2, { forward: true, jump: true });
  const onCrate = first.soles;
  for (let i = 0; i < 120; i++) rig.step(1, { ...NO_KEYS, forward: i < 40, jump: i < 10 });
  check("or up onto the crate, and from there onto the ledge",
    first.climbed && Math.abs(onCrate - crateTop) < 0.05 && Math.abs(soles() - ledgeTop) < 0.05,
    `${onCrate.toFixed(2)} m on the crate, then ${soles().toFixed(2)} m`);

  const still = climbFrom(east, Math.PI / 2, { jump: true });
  check("standing still, Space is only a jump", !still.climbed && still.soles < 0.05,
    `climbed ${still.climbed}, soles ${still.soles.toFixed(2)} m`);
  const wall = climbFrom(new THREE.Vector3(0, HOME.y, 12.3), Math.PI, { forward: true, jump: true });
  const pillar = climbFrom(new THREE.Vector3(-3.9, HOME.y, 3.4 + 0.9), 0, { forward: true, jump: true });
  check("a wall is no ledge, and a pillar is no ledge", !wall.climbed && !pillar.climbed,
    `wall ${wall.climbed}, pillar ${pillar.climbed}`);
  const low = climbFrom(new THREE.Vector3(LOW_WALL.at.x, HOME.y, LOW_WALL.at.z + 0.9), 0,
    { forward: true, jump: true }, 60);
  check("and at the low wall it climbs on rather than over: that is the vault key's",
    low.climbed && Math.abs(low.soles - LOW_WALL.half.y * 2) < 0.05,
    `soles at ${low.soles.toFixed(2)} m`);
}

/** Sling or unsling the shield and step until it is done; the steps it took, or -1. */
function sling(rig: Rig, limit = 240, each?: () => void): number {
  if (!rig.player.sling().ok) return -1;
  let n = 0;
  while (rig.player.offArm.slinging && n < limit) {
    rig.step(1);
    each?.();
    n++;
  }
  return n;
}

async function theShieldGoesOnYourBackToo(): Promise<void> {
  console.log("\nZ: the shield goes on your back by the other hand, and comes back to the arm");
  const rig = await buildRig();
  rig.step(30);
  rig.player.equipShield();
  rig.step(60);
  const off = rig.player.offArm;
  const f = rig.fighter;
  const handY = () => {
    const l = f.offLimb;
    const r = l.fore.rotation();
    const t = l.fore.translation();
    return new THREE.Vector3(0, SWORDSMAN.build.segment.foreArm.length / 2, 0)
      .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z)).y;
  };
  const shoulderY = () => f.offShoulderWorld(new THREE.Vector3()).y;

  let over = -Infinity;
  const on = sling(rig, 240, () => { over = Math.max(over, handY() - shoulderY()); });
  const mesh = (off as unknown as { slungMesh: THREE.Object3D | null }).slungMesh;
  check("Z puts it on your back in about a second, the hand going up over the shoulder with it",
    on > 30 && on < 110 && over > 0.08,
    `${(on / 60).toFixed(2)} s; the hand rose ${(over * 100).toFixed(0)} cm over the shoulder`);
  check("where it rides the chest, off the arm: one collider on the back, none on the arm",
    rig.player.shieldOnBack && !rig.player.hasShield && off.shieldCollider === null
      && off.slungCollider !== null && mesh !== null && mesh.parent === f.chest,
    `on the back ${rig.player.shieldOnBack}, on the arm ${off.shieldCollider !== null}, `
      + `on the back ${off.slungCollider !== null}`);

  // Walking and turning, the collider stays where the chest has the shield,
  // behind the body and face out.
  let drift = 0;
  let facing = 1;
  for (let i = 0; i < 90; i++) {
    rig.step(1, { ...NO_KEYS, forward: i < 60, turnLeft: i > 20 && i < 70 });
    const drawn = new THREE.Vector3();
    const q = new THREE.Quaternion();
    f.chestFrameWorld(SLUNG.clone().multiplyScalar(SWORDSMAN.build.scale), SLUNG_TURN, drawn, q);
    const c = off.slungCollider!;
    drift = Math.max(drift, drawn.distanceTo(new THREE.Vector3().copy(c.translation())));
    const r = c.rotation();
    const out = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    facing = Math.min(facing, out.dot(new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw))));
  }
  check("walking and turning, it stays on the back where the shield is drawn, facing out",
    drift < 0.01 && facing > 0.8,
    `${(drift * 1000).toFixed(1)} mm from where it is drawn at worst; facing out ${facing.toFixed(2)}`);

  rig.step(40);
  rig.player.health = 50;
  rig.player.potions = 1;
  const sip = rig.player.drink();
  check("with the sword still in your hand, the other hand is free to drink",
    rig.arm.wielding && sip.ok && rig.player.potions === 0, sip.text);
  check("and it hangs at rest, not held at a guard",
    Math.abs(off.aimNow.pitch - OFF_GUARD.pitch) > 0.3 && off.trackingError < 0.03,
    `pitch ${off.aimNow.pitch.toFixed(2)}, ${(off.trackingError * 100).toFixed(1)} cm off its mark`);

  over = -Infinity;
  const back = sling(rig, 240, () => { over = Math.max(over, handY() - shoulderY()); });
  rig.step(60);
  check("Z again takes it down, the hand going up over the shoulder for it",
    back > 30 && back < 110 && over > 0.08 && rig.player.hasShield && !rig.player.shieldOnBack,
    `${(back / 60).toFixed(2)} s; the hand rose ${(over * 100).toFixed(0)} cm over the shoulder`);
  const a = off.aimNow;
  check("back on the arm it stops blades again, held at its guard",
    off.shieldCollider !== null && Math.abs(a.yaw - OFF_GUARD.yaw) + Math.abs(a.pitch - OFF_GUARD.pitch) < 1e-6
      && off.trackingError < 0.03,
    `collider ${off.shieldCollider !== null}, ${(off.trackingError * 100).toFixed(1)} cm off its guard`);

  // One on your back is still one shield: the rack takes it, and no other.
  // The potion by the rack is nearer than the rack is.
  const items = new Items(new THREE.Scene(), ITEM_LAYOUT);
  for (const item of items.items) if (item.kind === "potion") items.setTaken(item, true);
  const rack = ITEM_LAYOUT.rack.at;
  rig.place(new THREE.Vector3(rack.x - 0.9, HOME.y, rack.z));
  rig.step(20);
  stow(rig, false);
  const take = interact(rig.player, items);
  rig.step(30);
  sling(rig);
  const second = rig.player.equipShield();
  const hang = interact(rig.player, items);
  check("slung, it is still the one shield: none on top of it, and the rack takes it back",
    take.ok && !second && hang.ok && !rig.player.carriesShield && off.slungCollider === null,
    `${take.text}; another ${second}; ${hang.text}`);

  // Anything that takes the arm away leaves it where it had got to.
  rig.place(HOME);
  rig.step(20);
  rig.player.equipShield();
  rig.step(30);
  sling(rig);
  rig.player.sling();
  rig.step(6);
  rig.player.fighter.sever("offShoulder");
  rig.step(30);
  const stuck = rig.player.sling();
  check("an arm cut off going for it leaves it on your back, with nothing to take it down",
    rig.player.shieldOnBack && !off.slinging && !stuck.ok, stuck.text);
}

/** Step the rig and let the things lying about catch up with it. */
function stepWith(rig: Rig, items: Items, n: number, keys: Keys = NO_KEYS): void {
  for (let i = 0; i < n; i++) {
    rig.step(1, keys);
    items.update();
  }
}

/**
 * Where the copy of what the hand holds is, world, with the forearm drawn
 * where the world has it: nothing interpolates the meshes here.
 */
function copyInHand(rig: Rig, bit = 0): THREE.Vector3 {
  const t = rig.arm.fore.translation();
  const r = rig.arm.fore.rotation();
  rig.arm.foreMesh.position.set(t.x, t.y, t.z);
  rig.arm.foreMesh.quaternion.set(r.x, r.y, r.z, r.w);
  rig.arm.foreMesh.updateMatrixWorld(true);
  return rig.arm.palm.children[0].children[bit].getWorldPosition(new THREE.Vector3());
}

/** Where the palm is, how fast it is going, and the forearm's spin, as the world has them. */
function palmMotion(rig: Rig): { p: THREE.Vector3; v: THREE.Vector3; w: THREE.Vector3 } {
  const fore = rig.arm.fore;
  const t = fore.translation();
  const r = fore.rotation();
  const p = rig.arm.palm.position.clone()
    .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  const c = fore.worldCom();
  const w = new THREE.Vector3().copy(fore.angvel());
  const v = new THREE.Vector3().copy(fore.linvel())
    .add(w.clone().cross(p.clone().sub(new THREE.Vector3(c.x, c.y, c.z))));
  return { p, v, w };
}

async function whatYouCutOffYouCanCarryOff(): Promise<void> {
  console.log("\nwhat you cut off someone, and their weapon: into your hand, into your bag, and let go of");
  // Out on the open floor of the hall's west half, where nothing else is lying.
  const at = spawnFor(SWORDSMAN, -1.2, 7.4);
  const rig = await buildRig({}, SWORDSMAN, at);
  rig.holdFoe();
  const items = new Items(new THREE.Scene(), ITEM_LAYOUT);
  items.watch([rig.foe]);
  const pickup = new Pickup(rig.player, items);
  const foe = rig.foe;
  const part = (name: string) => foe.fighter.parts.find((p) => p.name === name)!;
  const cut = (handle: number, times: number) => {
    for (let i = 0; i < times; i++) foe.receive(fakeImpact(handle));
  };
  const wrist = () => (foe.arm as unknown as { wristJoint: unknown }).wristJoint;
  const fist = () => (foe.arm as unknown as { handMeshObj: THREE.Object3D }).handMeshObj.parent;
  stepWith(rig, items, 30);

  // The sword forearm first: once the head is off, nothing else lands.
  cut(foe.arm.fore.collider(0)!.handle, 4);
  cut(part("head").collider.handle, 4);
  stepWith(rig, items, 150);
  const lying = items.items.filter((i) => i.piece);
  const head = lying.find((i) => i.name === "the swordsman's head");
  const fore = lying.find((i) => i.name === "the swordsman's forearm");
  const sword = lying.find((i) => i.name === "the swordsman's sword");
  const headBody = part("head").body!;
  check("a head, a forearm, and the sword still in its fist lie on the floor to be taken",
    foe.dead && lying.length === 3 && head?.kind === "remains" && fore?.kind === "remains"
      && sword?.kind === "weapon" && head.at.y < 0.3
      && head.at.distanceTo(new THREE.Vector3().copy(headBody.translation())) < 1e-6,
    lying.map((i) => `${i.name} (${i.kind}) at ${i.at.y.toFixed(2)} m`).join("; "));

  // Go and get it, as F does: sword away, over to it, down, and up -- from
  // the side of it away from everything else lying there, as you would.
  const go = (target: Item) => {
    let outcome: { ok: boolean; text: string } | null = null;
    const others = items.items.filter((i) => i.piece && !i.taken && i !== target);
    const away = new THREE.Vector3(1.3, 0, 0.4);
    if (others.length) {
      const c = others.reduce((sum, i) => sum.add(i.at), new THREE.Vector3()).multiplyScalar(1 / others.length);
      away.set(target.at.x - c.x, 0, target.at.z - c.z);
      if (away.lengthSq() < 1e-6) away.set(1, 0, 0);
      away.setLength(1.3);
    }
    const from = new THREE.Vector3(target.at.x + away.x, HOME.y, target.at.z + away.z);
    rig.place(from);
    stepWith(rig, items, 20);
    stow(rig, false);
    const start = pickup.start(NO_KEYS);
    const aimedAt = pickup.target;
    for (let i = 0; i < 600 && pickup.active; i++) {
      const k = pickup.step(NO_KEYS, STEP, (o) => { outcome = o; }) ?? NO_KEYS;
      stepWith(rig, items, 1, k);
    }
    return { start, aimedAt, outcome: outcome as { ok: boolean; text: string } | null };
  };
  const got = go(head!);
  check("F goes for the head and keeps it in the hand, not the bag",
    got.start.ok && got.aimedAt === head && got.outcome?.ok === true && rig.player.held === head
      && head!.taken && !rig.player.inventory.pieces.includes(head!),
    `${got.start.text}; ${got.outcome?.text}; holding ${rig.player.held?.name}`);
  const busy = pickup.start(NO_KEYS);
  const prompt = promptFor(rig.player, items);
  check("held, it is out of the world, and the hand takes nothing else: F says it would bag it",
    !headBody.isEnabled() && !part("head").mesh.visible && rig.arm.palm.children.length === 1
      && !busy.ok && busy.text.startsWith("your hand is full")
      && prompt?.startsWith("F — put the swordsman's head in your bag") === true,
    `enabled ${headBody.isEnabled()}; ${busy.text}; prompt "${prompt}"`);

  const bagged = items.bag(rig.player);
  const entries = rig.player.inventory.entries();
  check("F again puts it in the bag, and the hand is empty",
    bagged.ok && rig.player.held === null && rig.arm.palm.children.length === 0
      && entries.some((e) => e.kind === "piece" && e.item === head && e.verb === "hold")
      && !headBody.isEnabled(),
    `${bagged.text}; the bag lists ${entries.map((e) => `${e.name} (${e.verb})`).join(", ")}`);
  const out = items.unbag(rig.player, head!);
  check("and from the bag it comes back out into the hand",
    out.ok && rig.player.held === head && !rig.player.inventory.pieces.includes(head!)
      && rig.arm.palm.children.length === 1, out.text);

  // Let go of from a still hand, it comes back into the world where the copy
  // in the hand was, and drops.
  stepWith(rig, items, 60);
  const inHand = copyInHand(rig);
  const drop = items.letGo(rig.player);
  const h = new THREE.Vector3().copy(headBody.translation());
  const v = headBody.linvel();
  stepWith(rig, items, 90);
  const landed = new THREE.Vector3().copy(headBody.translation());
  check("G lets go of it: it comes back where it was in your hand, and drops to the floor",
    drop.ok && drop.text === "let go of the swordsman's head" && headBody.isEnabled()
      && part("head").mesh.visible && !head!.taken
      && rig.player.held === null && rig.arm.palm.children.length === 0
      && h.distanceTo(inHand) < 1e-3 && Math.hypot(v.x, v.y, v.z) < 0.5
      && Math.hypot(landed.x - h.x, landed.z - h.z) < 0.3 && landed.y < 0.3,
    `${drop.text}: ${(h.distanceTo(inHand) * 1000).toFixed(2)} mm from the copy in the hand, `
      + `at ${Math.hypot(v.x, v.y, v.z).toFixed(2)} m/s, from ${h.y.toFixed(2)} m to ${landed.y.toFixed(2)} m, `
      + `${Math.hypot(landed.x - h.x, landed.z - h.z).toFixed(2)} m along the floor`);

  // The sword: the dead fist lets go of it as it is taken, and the forearm
  // stays where it lies.
  const health = rig.player.health;
  const blade = foe.arm.blade;
  const took = go(sword!);
  check("F takes the sword out of the dead fist: the sword in your hand, the forearm left lying",
    took.outcome?.ok === true && rig.player.held === sword && !blade.isEnabled()
      && wrist() === null && fist() === foe.arm.foreMesh
      && foe.arm.fore.isEnabled() && !fore!.taken,
    `${took.outcome?.text}; the fist still on the forearm ${fist() === foe.arm.foreMesh}`);

  // Bagged, the next thing F goes for is the forearm it came out of.
  items.bag(rig.player);
  const next = pickup.start(NO_KEYS);
  const nextOne = pickup.target;
  pickup.cancel();
  items.unbag(rig.player, sword!);
  check("and the next F goes for the forearm it came out of",
    next.ok && nextOne === fore, `${next.text}`);

  // Drawing your own sword, the hand lets go of it.
  stepWith(rig, items, 20);
  rig.arm.draw();
  stepWith(rig, items, 150);
  check("drawing your own sword, the hand lets go of it, and it falls without cutting you",
    rig.player.held === null && blade.isEnabled() && !sword!.taken && rig.arm.wielding
      && blade.translation().y < 0.3 && rig.player.health === health,
    `holding ${rig.player.held?.name ?? "nothing"}; the sword at ${blade.translation().y.toFixed(2)} m; `
      + `health ${health.toFixed(1)} -> ${rig.player.health.toFixed(1)}`);

  // Let go of facing a wall half a metre off, it stays out of the stone --
  // where the copy in the hand has gone into it, it lies across your front
  // instead -- and settles rather than being thrown out.
  const wall = ROOMS.hall.maxZ;
  rig.place(new THREE.Vector3(1.5, HOME.y, wall - 0.55));
  rig.fighter.yaw = Math.PI;                  // facing +Z, the south wall
  stepWith(rig, items, 30);
  stow(rig, false);
  const taken = items.hold(rig.player, sword!);
  stepWith(rig, items, 10);
  const walled = items.letGo(rig.player);
  // Falling from where it was let go of is all the speed it should have.
  const fall = Math.sqrt(2 * -rig.tuning.gravity * blade.translation().y);
  let fastest = 0;
  for (let i = 0; i < 120; i++) {
    stepWith(rig, items, 1);
    const v = blade.linvel();
    fastest = Math.max(fastest, Math.hypot(v.x, v.y, v.z));
  }
  const deepest = blade.translation().z;
  const tip = foe.arm.pointAlongBlade(1, new THREE.Vector3());
  check("let go of against a wall, it stays out of the stone and settles on the floor",
    taken.ok && walled.ok && Math.max(deepest, tip.z) < wall - 0.02 && blade.translation().y < 0.3
      && fastest < fall + 1,
    `nearest the wall ${(wall - Math.max(deepest, tip.z)).toFixed(2)} m off it, `
      + `fastest ${fastest.toFixed(1)} m/s against ${fall.toFixed(1)} from the fall`);

  // A reset puts every piece back on whoever lost it, from the hand or the bag.
  go(head!);
  items.bag(rig.player);
  items.hold(rig.player, sword!);
  items.reset();
  rig.player.reset(rig.tuning, HOME);
  foe.reset(rig.tuning, at);
  rig.impacts.resetSweeps();
  stepWith(rig, items, 60);
  const torso = foe.position(new THREE.Vector3());
  const headGap = torso.distanceTo(new THREE.Vector3().copy(headBody.translation()));
  check("a reset puts the pieces back on, from the hand and the bag, and the sword back in the fist",
    headBody.isEnabled() && part("head").mesh.visible && !part("head").severed && !foe.arm.disarmed
      && blade.isEnabled() && wrist() !== null && fist() === foe.arm.bladeMesh && foe.arm.wielding
      && headGap < 1.2 && rig.player.inventory.empty && rig.player.held === null
      && rig.arm.palm.children.length === 0 && !items.items.some((i) => i.piece),
    `head ${headGap.toFixed(2)} m from the torso; the sword in the fist ${fist() === foe.arm.bladeMesh}`);
}

async function whatYouHoldYouCanThrow(): Promise<void> {
  console.log("\nwhat you hold you can throw: let go of in a swing, it keeps the hand's speed");
  const at = spawnFor(SWORDSMAN, -1.2, 7.4);
  const rig = await buildRig({}, SWORDSMAN, at);
  rig.holdFoe();
  const items = new Items(new THREE.Scene(), ITEM_LAYOUT);
  items.watch([rig.foe]);
  const foe = rig.foe;
  const part = (name: string) => foe.fighter.parts.find((p) => p.name === name)!;
  stepWith(rig, items, 30);
  for (const name of ["offShoulder", "head"]) {
    for (let i = 0; i < 4; i++) foe.receive(fakeImpact(part(name).collider.handle));
  }
  stepWith(rig, items, 150);
  const find = (name: string) => items.items.find((i) => i.name === `the swordsman's ${name}`)!;
  const head = find("head");
  const limb = find("off arm");
  const sword = find("sword");
  const headBody = head.piece!.bits[0].body;
  const groups = headBody.collider(0).collisionGroups();
  const leaving = () => (items as unknown as { leaving: unknown[] }).leaving.length;
  const [pitchLo, pitchHi] = Arm.LIMITS.pitch;
  const open = new THREE.Vector3(1.0, HOME.y, 4.0);

  // Out on the open floor facing north, the sword on the back, it in the hand.
  const ready = (item: Item, where = open, yaw = 0) => {
    rig.place(where);
    rig.fighter.yaw = yaw;
    stepWith(rig, items, 20);
    if (rig.arm.wielding) stow(rig, false);
    return items.hold(rig.player, item);
  };
  // The arm swung through pitch from `from` to `to`, as fast as a hand
  // moving the mouse hard would, and `each` told after every step.
  const swing = (from: number, to: number, each: (n: number) => void) => {
    aimAngles(rig, 0, from, 90);
    for (let n = 1; n <= 30; n++) {
      const gap = to - rig.arm.aim.pitch;
      rig.input.dy = -Math.max(-12 * STEP, Math.min(12 * STEP, gap)) / rig.tuning.sensitivity;
      stepWith(rig, items, 1);
      each(n);
    }
  };
  // Swung once to find where the hand is fastest, and again to let go there:
  // how the hand was moving, what G said, and each body of the piece as it
  // left -- where, its middle, and how it was moving -- and for how many
  // steps after it went on passing through the hand that threw it.
  const throwIt = (item: Item, from: number, to: number) => {
    let peak = 0;
    let peakAt = 0;
    swing(from, to, (n) => {
      const s = palmMotion(rig).v.length();
      if (s > peak) { peak = s; peakAt = n; }
    });
    let hand = palmMotion(rig);
    let out = { ok: false, text: "" };
    let bodies: { p: THREE.Vector3; c: THREE.Vector3; v: THREE.Vector3; w: THREE.Vector3 }[] = [];
    let through = 0;
    swing(from, to, (n) => {
      if (n === peakAt - 1) {
        hand = palmMotion(rig);
        out = items.letGo(rig.player);
        bodies = item.piece!.bits.map(({ body }) => {
          const p = new THREE.Vector3().copy(body.translation());
          const r = body.rotation();
          const c = new THREE.Vector3().copy(body.localCom())
            .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(p);
          return { p, c, v: new THREE.Vector3().copy(body.linvel()), w: new THREE.Vector3().copy(body.angvel()) };
        });
      } else if (out.ok && leaving() > 0) through++;
    });
    return { hand, out, bodies, through };
  };
  const ahead = (from: THREE.Vector3, to: { x: number; z: number }) =>
    (to.x - from.x) * -Math.sin(rig.fighter.yaw) + (to.z - from.z) * -Math.cos(rig.fighter.yaw);

  // The head, overhand.
  ready(head);
  const a = throwIt(head, pitchHi, 0);
  const [h] = a.bodies;
  check("let go of mid-swing, the head leaves at the palm's speed, spinning as the forearm was",
    a.out.text === "threw the swordsman's head" && a.hand.v.length() > 4
      && h.v.distanceTo(a.hand.v) < 1e-3 && h.w.distanceTo(a.hand.w) < 1e-3,
    `${a.out.text}: the palm at ${a.hand.v.length().toFixed(2)} m/s, the head at ${h.v.length().toFixed(2)}, `
      + `${(h.v.distanceTo(a.hand.v) * 1000).toFixed(3)} mm/s apart`);
  stepWith(rig, items, 150);
  const landed = new THREE.Vector3().copy(headBody.translation());
  const went = new THREE.Vector3(landed.x - h.p.x, 0, landed.z - h.p.z);
  const way = new THREE.Vector3(a.hand.v.x, 0, a.hand.v.z).normalize();
  const along = went.clone().normalize().dot(way);
  check("and it flies the way the hand was going, metres off, to the floor",
    went.length() > 2.5 && along > 0.9 && landed.y < 0.3,
    `${went.length().toFixed(2)} m, ${THREE.MathUtils.radToDeg(Math.acos(Math.min(1, along))).toFixed(0)}° `
      + `off the hand's heading, at ${landed.y.toFixed(2)} m`);
  check("it passes through the hand that threw it until it is clear, then meets you like anything else",
    a.through > 0 && leaving() === 0 && headBody.collider(0).collisionGroups() === groups,
    `through you for ${a.through} steps; groups as they were ${headBody.collider(0).collisionGroups() === groups}`);

  // A whole arm, underhand: two bodies and the elbow between them.
  const upper = foe.fighter.build.segment.upperArm.length;
  const lower = foe.fighter.build.segment.foreArm.length;
  ready(limb);
  const b = throwIt(limb, pitchLo, 0.3);
  const [u, f] = b.bodies;
  const apart = u.v.clone().sub(f.v).distanceTo(b.hand.w.clone().cross(u.c.clone().sub(f.c)));
  let widest = 0;
  for (let i = 0; i < 150; i++) {
    stepWith(rig, items, 1);
    widest = Math.max(widest, new THREE.Vector3().copy(limb.piece!.bits[0].body.translation())
      .distanceTo(new THREE.Vector3().copy(limb.piece!.bits[1].body.translation())));
  }
  const limbAt = limb.piece!.bits[0].body.translation();
  check("an arm goes as one: its halves leave together, the elbow holds, and it lands ahead",
    b.out.text === "threw the swordsman's off arm" && apart < 1e-3
      && widest < (upper + lower) / 2 + 0.03 && ahead(open, limbAt) > 1.5 && limbAt.y < 0.3,
    `${b.out.text}: halves ${(apart * 1000).toFixed(3)} mm/s off moving as one, `
      + `${widest.toFixed(3)} m apart at most against ${((upper + lower) / 2).toFixed(3)} straight, `
      + `landed ${ahead(open, limbAt).toFixed(2)} m ahead`);

  // The sword, underhand.
  const health = rig.player.health;
  ready(sword);
  const c = throwIt(sword, pitchLo, 0.3);
  stepWith(rig, items, 150);
  const swordAt = sword.piece!.bits[0].body.translation();
  check("so does a weapon, and it hurts nobody on the way",
    c.out.text === "threw the swordsman's sword" && ahead(open, swordAt) > 1.5 && swordAt.y < 0.3
      && rig.player.health === health,
    `${c.out.text}: landed ${ahead(open, swordAt).toFixed(2)} m ahead; health ${rig.player.health.toFixed(1)}`);

  // At a wall a pace off, it hits the wall and falls back into the room.
  const wall = ROOMS.hall.maxZ;
  const facing = new THREE.Vector3(1.0, HOME.y, wall - 1.2);
  ready(head, facing, Math.PI);
  const d = throwIt(head, pitchHi, 0);
  stepWith(rig, items, 150);
  const bounced = headBody.translation();
  check("thrown at a wall, it stops at the stone and falls back into the room",
    d.out.text === "threw the swordsman's head" && bounced.z < wall - 0.05 && bounced.y < 0.3,
    `${d.out.text}; it lies ${(wall - bounced.z).toFixed(2)} m off the wall, at ${bounced.y.toFixed(2)} m`);

  // With the copy in the hand gone into the floor, as a copy can, it is put
  // down in front of you instead, not left in the stone.
  ready(head);
  stepWith(rig, items, 20);
  const r = rig.arm.fore.rotation();
  const down = new THREE.Vector3(0, 0.02 - copyInHand(rig).y, 0)
    .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
  rig.arm.palm.children[0].position.add(down);
  const sunk = copyInHand(rig).y;
  const hand = rig.arm.handPosition.y;
  const put = items.letGo(rig.player);
  const placed = new THREE.Vector3().copy(headBody.translation());
  const still = headBody.linvel();
  stepWith(rig, items, 90);
  check("where the copy in the hand is in the stone, it is put down in front of you instead",
    put.text === "let go of the swordsman's head" && ahead(open, placed) > 0.25
      && placed.y > 0.4 && placed.y < hand + 1e-3 && Math.hypot(still.x, still.y, still.z) < 1e-6
      && headBody.translation().y < 0.3,
    `the copy at ${sunk.toFixed(2)} m; ${put.text}, ${ahead(open, placed).toFixed(2)} m ahead `
      + `at ${placed.y.toFixed(2)} m, no higher than the hand at ${hand.toFixed(2)}`);

  // And a reset with one on its way out of a hand puts everything right.
  ready(head);
  items.letGo(rig.player);
  const midway = leaving();
  items.reset();
  check("a reset while it is still leaving the hand gives it back what it meets",
    midway === 1 && leaving() === 0 && headBody.collider(0).collisionGroups() === groups,
    `${midway} leaving, then ${leaving()}`);
}

async function theOrcsAxeCanBeWielded(): Promise<void> {
  console.log("\nthe orc's axe, taken off it, is a weapon in your hand: its weight, its edge");
  const orcAt = spawnFor(ORC, -1.5, 7.6);
  const rig = await buildRig({}, ORC, orcAt);
  rig.holdFoe();
  const items = new Items(new THREE.Scene(), ITEM_LAYOUT);
  items.watch([rig.foe]);
  const arm = rig.arm;
  const inner = (a: Arm) => a as unknown as { wristJoint: unknown; scabbardBlade: THREE.Object3D };
  stepWith(rig, items, 30);

  // Off with its head: dead, with the axe still in its fist.
  const head = rig.foe.fighter.parts.find((p) => p.name === "head")!;
  for (let i = 0; i < 8 && !rig.foe.dead; i++) rig.foe.receive(fakeImpact(head.collider.handle));
  stepWith(rig, items, 150);
  const axe = items.items.find((i) => i.kind === "weapon");
  const axeBody = rig.foe.arm.blade;
  check("the dead orc's axe lies there to be taken", rig.foe.dead && axe?.name === "the orc's axe",
    items.items.filter((i) => i.piece).map((i) => i.name).join(", "));

  // At the dummy, sword on the back, the axe in the hand, and X.
  const standAt = new THREE.Vector3(DUMMY_AT.x, HOME.y, DUMMY_AT.z + 1.1);
  rig.place(standAt);
  rig.fighter.yaw = 0;                   // facing -Z, dummy dead ahead
  rig.pin(standAt);
  stepWith(rig, items, 60);
  stow(rig, false);
  const own = arm.liveWeaponMass;
  items.hold(rig.player, axe!);
  const up = items.wield(rig.player);
  stepWith(rig, items, 60);
  check("X takes it up: the arm's weapon is the axe, its weight and shape, jointed in the hand",
    up.ok && arm.weapon === AXE && arm.wieldsTaken && arm.wielding && arm.liveWeaponMass === AXE.mass
      && arm.weaponColliders.length === AXE.parts.length && inner(arm).wristJoint !== null
      && arm.palm.children.length === 0 && rig.player.held === axe,
    `${up.text}: ${arm.weapon.name}, ${arm.liveWeaponMass} kg in ${arm.weaponColliders.length} parts`);
  check("the sword is on your back meanwhile, and the orc's own axe out of the world",
    inner(arm).scabbardBlade.visible && !axeBody.isEnabled() && !arm.sheathed,
    `sword drawn in the scabbard ${inner(arm).scabbardBlade.visible}, orc's axe in the world ${axeBody.isEnabled()}`);

  // Swung at the dummy, it lands as an axe.
  let hits = 0;
  let asAxe = 0;
  let best = 0;
  const target = new THREE.Vector3(DUMMY_AT.x + 0.23, 1.5, DUMMY_AT.z + 0.15);
  rig.impacts.addBlade(arm, (i) => {
    if (!rig.dummy.receive(i)) return;
    hits++;
    if (i.weapon === AXE && i.massKg === AXE.mass) asAxe++;
    best = Math.max(best, cutDamage(i));
  });
  for (let swings = 0; swings < 10; swings++) throwForehand(rig, target);
  check("swung, it cuts with the axe's edge and weight",
    hits > 0 && asAxe === hits && best > 0,
    `${hits} hits on the dummy, ${asAxe} of them the axe's; best ${best.toFixed(1)} damage`);

  // Ten seconds of the worst input there is, as every weapon gets in its
  // owner's hand: a man's arm is not what the axe was tuned on.
  let rand = 12345;
  const next = () => (rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let spin = 0;
  let turn = 0;
  let bend = 0;
  let sane = true;
  const q = new THREE.Quaternion();
  for (let i = 0; i < 600; i++) {
    rig.input.dx = (next() - 0.5) * 600;
    rig.input.dy = (next() - 0.5) * 600;
    rig.input.wheel = next() > 0.9 ? 1 : next() < 0.1 ? -1 : 0;
    rig.input.rollDx = (next() - 0.5) * 220;
    rig.hold(1);
    const r = arm.blade.rotation();
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q.set(r.x, r.y, r.z, r.w));
    const w = arm.blade.angvel();
    spin = Math.max(spin, Math.abs(w.x * axis.x + w.y * axis.y + w.z * axis.z));
    turn = Math.max(turn, gripTurn(arm));
    bend = Math.max(bend, arm.state.wrist);
    sane &&= finite(arm.blade.translation()) && finite(arm.fore.translation());
  }
  // The same bounds every weapon is held to in its own owner's hand.
  check("under ten seconds of the worst input nothing spins in the hand",
    sane && spin < 100 && turn < 1.65 && bend < 1.3 && inner(arm).wristJoint !== null,
    `peak spin about its length ${spin.toFixed(0)} rad/s, grip never past `
      + `${(turn * 180 / Math.PI).toFixed(0)}deg, wrist never past ${(bend * 180 / Math.PI).toFixed(0)}deg`);
  rig.step(60);

  // X again: held again, and the sword's own weight and shape back on the back.
  const down = items.unwield(rig.player);
  check("X again puts it up: held in the hand, the sword back on the back as it was",
    down.ok && !arm.wieldsTaken && arm.weapon === SWORD && arm.sheathed && arm.liveWeaponMass === own
      && arm.weaponColliders.length === SWORD.parts.length && !inner(arm).scabbardBlade.visible
      && rig.player.held === axe && arm.palm.children.length === 1,
    `${down.text}; ${arm.weapon.name} ${arm.liveWeaponMass} kg, sheathed ${arm.sheathed}`);

  // Taken up again and let go of: it leaves the hand where the axe was.
  items.wield(rig.player);
  stepWith(rig, items, 30);
  const was = new THREE.Vector3().copy(arm.blade.translation());
  const health = rig.player.health;
  const drop = items.letGo(rig.player);
  const gap = was.distanceTo(new THREE.Vector3().copy(axeBody.translation()));
  const swordBack = arm.sheathed && arm.weapon === SWORD;
  stepWith(rig, items, 120);
  check("let go of while wielded, the orc's axe is where yours was, falls, and cuts nobody",
    drop.ok && axeBody.isEnabled() && gap < 1e-6 && swordBack && rig.player.held === null
      && axeBody.translation().y < 0.3 && rig.player.health === health,
    `${drop.text}: ${(gap * 1000).toFixed(2)} mm from where it was in the hand, `
      + `now at ${axeBody.translation().y.toFixed(2)} m; health ${rig.player.health.toFixed(1)}`);

  // Wielded, F puts it straight in the bag.
  items.hold(rig.player, axe!);
  items.wield(rig.player);
  stepWith(rig, items, 20);
  const bagged = items.bag(rig.player);
  check("F puts it in the bag straight out of the fight, the sword back on the back",
    bagged.ok && rig.player.inventory.pieces.includes(axe!) && arm.sheathed && arm.weapon === SWORD
      && rig.player.held === null, bagged.text);

  // With it up, a reset: the sword in your hand, the axe in the orc's.
  items.unbag(rig.player, axe!);
  items.wield(rig.player);
  stepWith(rig, items, 10);
  items.reset();
  rig.player.reset(rig.tuning, standAt);
  rig.fighter.yaw = 0;
  rig.foe.reset(rig.tuning, orcAt);
  rig.impacts.resetSweeps();
  stepWith(rig, items, 60);
  check("a reset puts your sword back in your hand and the axe back in the orc's",
    arm.weapon === SWORD && !arm.wieldsTaken && arm.wielding && !inner(arm).scabbardBlade.visible
      && arm.weaponColliders.length === SWORD.parts.length && rig.foe.arm.weapon === AXE
      && axeBody.isEnabled() && inner(rig.foe.arm).wristJoint !== null && rig.player.held === null,
    `yours ${arm.weapon.name}, the orc's ${rig.foe.arm.weapon.name}`);
  hits = 0;
  let asSword = 0;
  rig.impacts.addBlade(arm, (i) => {
    if (!rig.dummy.receive(i)) return;
    hits++;
    if (i.weapon === SWORD) asSword++;
  });
  for (let swings = 0; swings < 6 && hits === 0; swings++) throwForehand(rig, target);
  check("and the sword cuts as a sword again", hits > 0 && asSword === hits,
    `${hits} hits, ${asSword} of them the sword's`);
}

async function everyWeaponCanBeWielded(): Promise<void> {
  console.log("\nevery weapon anything carries can be taken off it and fought with");
  // Every weapon there is -- the list, and whatever anything in the bestiary
  // carries, so a creature that brings a new one along is held to this too.
  const weapons = new Set<Weapon>([...Object.values(WEAPONS), ...Object.values(SPECIES).map((s) => s.weapon)]);
  const bestiary: Species[] = Object.values(SPECIES);
  for (const weapon of weapons) {
    // Taken off whatever carries it, and swung with that creature's own first
    // shape of swing -- a spear is thrust, not swept.
    const carrier = bestiary.find((s) => s.weapon === weapon) ?? { ...SWORDSMAN, weapon };
    const cut = carrier.cuts[0];
    const at = spawnFor(carrier, -1.5, 7.6);
    const rig = await buildRig({}, carrier, at);
    rig.holdFoe();
    const items = new Items(new THREE.Scene(), ITEM_LAYOUT);
    items.watch([rig.foe]);
    const arm = rig.arm;
    stepWith(rig, items, 30);
    const head = rig.foe.fighter.parts.find((p) => p.name === "head")!;
    for (let i = 0; i < 8 && !rig.foe.dead; i++) rig.foe.receive(fakeImpact(head.collider.handle));
    stepWith(rig, items, 150);
    const taken = items.items.find((i) => i.kind === "weapon");

    // At its own distance: a cut at a sword's, a thrust with the point a
    // hand's breadth short at full stretch. From a sword's distance a spear's
    // point is past the target before the thrust has begun, and what goes
    // into it is the shaft, side on. And a weapon too short to cut from a
    // sword's distance -- the kobold's hatchet -- cuts from as far out as its
    // own head reaches: from a sword's, it swung at the air in front of the
    // dummy and never touched it.
    const reach = SWORDSMAN.build.armLength - 0.08 + weapon.grip + weapon.span;
    const standOff = weapon.bite === "point" ? reach - 0.2 : Math.min(1.1, reach - 0.35);
    const standAt = new THREE.Vector3(DUMMY_AT.x, HOME.y, DUMMY_AT.z + standOff);
    rig.place(standAt);
    rig.fighter.yaw = 0;
    rig.pin(standAt);
    stepWith(rig, items, 60);
    stow(rig, false);
    if (taken) items.hold(rig.player, taken);
    const up = items.wield(rig.player);
    stepWith(rig, items, 60);
    let hits = 0;
    let own = 0;
    let best = 0;
    rig.impacts.addBlade(arm, (i) => {
      if (!rig.dummy.receive(i)) return;
      hits++;
      if (i.weapon === weapon && i.massKg === weapon.mass) own++;
      best = Math.max(best, cutDamage(i));
    });
    // A cut goes through the arm, where it can take it off; a thrust goes
    // into the middle of the body, which is what a point is for -- aimed at
    // an arm it goes past it and lays the shaft along the ribs.
    const target = weapon.bite === "point"
      ? new THREE.Vector3().copy(rig.dummy.limbs.get("torso")!.body.translation())
      : new THREE.Vector3(DUMMY_AT.x + 0.23, 1.5, DUMMY_AT.z + 0.15);
    for (let swings = 0; swings < 10; swings++) throwForehand(rig, target, { cut });

    let rand = 12345;
    const next = () => (rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let spin = 0;
    let turn = 0;
    let bend = 0;
    let sane = true;
    const q = new THREE.Quaternion();
    for (let i = 0; i < 600; i++) {
      rig.input.dx = (next() - 0.5) * 600;
      rig.input.dy = (next() - 0.5) * 600;
      rig.input.wheel = next() > 0.9 ? 1 : next() < 0.1 ? -1 : 0;
      rig.input.rollDx = (next() - 0.5) * 220;
      rig.hold(1);
      const r = arm.blade.rotation();
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q.set(r.x, r.y, r.z, r.w));
      const w = arm.blade.angvel();
      spin = Math.max(spin, Math.abs(w.x * axis.x + w.y * axis.y + w.z * axis.z));
      turn = Math.max(turn, gripTurn(arm));
      bend = Math.max(bend, arm.state.wrist);
      sane &&= finite(arm.blade.translation()) && finite(arm.fore.translation());
    }
    rig.step(60);
    const down = items.unwield(rig.player);
    check(`${carrier.name}'s ${weapon.name}: taken off it dead, taken up, and swung with its ${cut.name}, it lands as itself`,
      taken?.name === `${carrier.name}'s ${weapon.name}` && up.ok && hits > 0 && own === hits && best > 0,
      `${up.text || "not taken up"}; ${hits} hits on the dummy, ${own} of them its own; best ${best.toFixed(1)} damage`);
    check(`${carrier.name}'s ${weapon.name}: nothing spins in your hand, and X puts it up again`,
      sane && spin < 100 && turn < 1.65 && bend < 1.3 && down.ok && arm.weapon === SWORD && arm.sheathed,
      `peak spin ${spin.toFixed(0)} rad/s, grip ${(turn * 180 / Math.PI).toFixed(0)}deg, `
        + `wrist ${(bend * 180 / Math.PI).toFixed(0)}deg; ${down.text}`);
  }
}

async function theStonesAndTheRailAreJumped(): Promise<void> {
  console.log("\njumps: the stones along the hall's south wall, and the rail in front of them");
  const rig = await buildRig();
  const f = rig.fighter;
  const soles = () => f.body.translation().y - SWORDSMAN.build.hullCentreY;
  // Walk at something for `walk` steps, and jump `jumpAt` steps in.
  const go = (at: THREE.Vector3, yaw: number, walk: number, jumpAt = -1, vault = false) => {
    rig.place(at);
    f.yaw = yaw;
    rig.step(20);
    let vaulted = false;
    let climbed = false;
    for (let i = 0; i < 150; i++) {
      const now = jumpAt >= 0 && i >= jumpAt && i < jumpAt + 6;
      rig.step(1, { ...NO_KEYS, forward: i < walk, jump: now && !vault, vault: now && vault });
      vaulted ||= f.vaulting;
      climbed ||= f.climbing;
    }
    const p = f.body.translation();
    return { x: p.x, z: p.z, soles: soles(), grounded: f.grounded, vaulted, climbed };
  };
  const [first, second] = STONES;
  const on = (s: typeof first, r: ReturnType<typeof go>) =>
    r.grounded && Math.abs(r.soles - s.half.y * 2) < 0.03 && Math.abs(r.x - s.at.x) < s.half.x;
  const east = -Math.PI / 2;

  // A stone is under a knee: too high to step up onto, too low to climb.
  const floor = new THREE.Vector3(first.at.x - 2.2, HOME.y, first.at.z);
  const walked = go(floor, east, 60);
  const jumped = go(floor, east, 40, 18);
  check("a stone is too high to walk onto, and a running jump puts you on it",
    walked.soles < 0.05 && walked.x < first.at.x - first.half.x && on(first, jumped)
      && !jumped.climbed && !jumped.vaulted,
    `walked: stopped at x ${walked.x.toFixed(2)}, its face at ${(first.at.x - first.half.x).toFixed(2)}; ` +
    `jumped: soles ${jumped.soles.toFixed(2)} m up, at x ${jumped.x.toFixed(2)}`);

  // And a stride apart: walk off one and you are on the floor between them.
  const top = new THREE.Vector3(first.at.x, HOME.y + first.half.y * 2, first.at.z);
  const stepped = go(top, east, 60);
  const leapt = go(top, east, 40, 5);
  check("and from one to the next is a jump too: walk on and you are down between them",
    stepped.soles < 0.05 && on(second, leapt),
    `walked off: soles ${stepped.soles.toFixed(2)} m at x ${stepped.x.toFixed(2)}; ` +
    `jumped: soles ${leapt.soles.toFixed(2)} m at x ${leapt.x.toFixed(2)}, the next stone's middle ${second.at.x}`);

  // The rail is lower still: under anything to vault, and a wall to the feet.
  const north = new THREE.Vector3(RAIL.at.x, HOME.y, RAIL.at.z - 1.8);
  const south = Math.PI;
  const near = RAIL.at.z - RAIL.half.z;
  const far = RAIL.at.z + RAIL.half.z;
  const into = go(north, south, 120);
  const over = go(north, south, 60, 14);
  const vaulted = go(north.clone().setZ(near - 0.9), south, 0, 0, true);
  check("walking at the rail stops you, and a jump takes you over it",
    into.z < near && over.z > far + 0.3 && over.grounded,
    `walked: stopped at z ${into.z.toFixed(2)}, its near face at ${near.toFixed(2)}; ` +
    `jumped: landed at z ${over.z.toFixed(2)}, past its far face at ${far.toFixed(2)}`);
  check("and it is too low to vault: the vault key does nothing at it", !vaulted.vaulted,
    `vaulted ${vaulted.vaulted}`);
}

async function theNewcomersScaleHonestly(): Promise<void> {
  console.log("\na kobold and an ogre: the same body, smaller and bigger, and one weapon that cuts nothing off");
  const human = maxHealthFor(SWORDSMAN.build);
  const kobold = maxHealthFor(KOBOLD.build);
  const ogre = maxHealthFor(OGRE.build);
  check("a kobold comes up to your belt and weighs a fifth of you",
    KOBOLD.build.standing.crown < 1.2 && KOBOLD.build.massScale < 0.25,
    `${KOBOLD.build.standing.crown.toFixed(2)} m tall, x${KOBOLD.build.massScale.toFixed(2)} your weight, ${kobold.toFixed(0)} health to your ${human.toFixed(0)}`);
  // Its neck gives way after a fraction of what yours takes: one clean cut.
  const neck = 7 * jointScaleFor(KOBOLD.build);
  const cut = cutDamage(fakeImpact(0));
  check("and one clean cut of your sword takes its head off", cut > neck,
    `a clean cut does ${cut.toFixed(1)}, its neck takes ${neck.toFixed(1)}`);
  check("an ogre is two and a half metres of it, with four times your health and joints only two and a half times as hard",
    OGRE.build.standing.crown > 2.4 && ogre > 3.5 * human
      && jointScaleFor(OGRE.build) < 0.7 * OGRE.build.massScale,
    `${OGRE.build.standing.crown.toFixed(2)} m, ${ogre.toFixed(0)} health, joints x${jointScaleFor(OGRE.build).toFixed(2)}`);
  check("and a hatchet and a club are what they say: small and quick, big and heavy",
    HATCHET.mass < SWORD.mass / 1.5 && HATCHET.grip + HATCHET.span < 0.5
      && CLUB.mass > AXE.mass * 1.5 && CLUB.bite === "blunt" && (CLUB.rebound ?? 0) > 0,
    `hatchet ${HATCHET.mass} kg over ${(HATCHET.grip + HATCHET.span).toFixed(2)} m, club ${CLUB.mass} kg, ${CLUB.bite}, rebound ${CLUB.rebound}`);

  // A club crushes and takes nothing off: its blows break a limb's health and
  // never its joint. The same blows with a sword's edge take the arm.
  const rig = await buildRig();
  rig.step(30);
  const fore = rig.dummy.limbs.get("foreArmR")!;
  for (let i = 0; i < 40; i++) {
    rig.dummy.receive(fakeImpact(fore.collider.handle, { weapon: CLUB, massKg: CLUB.mass, closingSpeed: 10 }));
  }
  const clubbed = fore.severed;
  let cuts = 0;
  while (!fore.severed && cuts < 10) {
    rig.dummy.receive(fakeImpact(fore.collider.handle));
    cuts++;
  }
  check("forty club blows leave an arm on that a few sword cuts take off", !clubbed && fore.severed,
    `clubbed 40 times: ${clubbed ? "severed" : "still on"}; then ${cuts} sword cuts: ${fore.severed ? "off" : "still on"}`);
}

async function aClubSendsYouFlying(): Promise<void> {
  console.log("\nthe ogre's club: it comes back off you, and you go where it was going");
  // The same weight, the same speed, square into the same body: a blade goes
  // in and stops, a club bounces off and carries it.
  const body = {
    mass: 96, build: SWORDSMAN.build, soles: 0, grounded: true,
  };
  const g = DEFAULTS.gravity;
  const f = DEFAULTS.balance;
  const blow = (weapon: Weapon, v: THREE.Vector3, into = new THREE.Vector3(1, 0, 0)) => {
    const b = judgeBlow(fakeImpact(0, {
      weapon, massKg: weapon.mass, blowMass: 50, closingSpeed: Math.max(0, v.dot(into)),
      bladeVelocity: v, into, at: new THREE.Vector3(0, 1.2, 0),
    }), body, g, f, emptyBlow());
    return { speed: b.speed, lift: b.lift, effect: b.effect };
  };
  const level = new THREE.Vector3(8, 0, 0);
  const rising = new THREE.Vector3(7, 3.5, 0);
  const blade = blow(SWORD, level);
  const club = blow(CLUB, level);
  check("square on, a club's blow throws a body faster than a blade's of the same weight and speed",
    club.speed > blade.speed * 1.3,
    `${club.speed.toFixed(2)} m/s against ${blade.speed.toFixed(2)}`);
  const up = blow(CLUB, rising);
  const bladeUp = blow(SWORD, rising);
  check("coming up, it throws the body up off the floor; a blade coming up never does",
    up.lift > 1 && bladeUp.lift === 0,
    `club ${up.lift.toFixed(2)} m/s up, blade ${bladeUp.lift.toFixed(2)}`);
  // Glancing: all its speed across the body, hardly any into it.
  const glance = blow(CLUB, new THREE.Vector3(0.5, 0, 8));
  check("and a glancing club drags a body no faster than it presses on it",
    glance.speed < club.speed * 0.3,
    `glancing, ${glance.speed.toFixed(2)} m/s; square, ${club.speed.toFixed(2)}`);

  // And a real ogre, swinging up through a body standing in the cell.
  const species: Species = {
    ...OGRE, footwork: { ...OGRE.footwork, parry: 0, taunt: 0 }, flow: { combo: 0, chain: 1 },
  };
  const foeAt = spawnFor(species, 10.0, -7.6);
  const rig = await buildRig({}, species, foeAt);
  const home = new THREE.Vector3(10.0, HOME.y, -4.6);
  rig.place(home);
  rig.fighter.yaw = 0;
  rig.ai.cutOverride = "upswing";
  let throws = 0;
  let farthest = 0;
  let highest = 0;
  let gotUp = 0;
  let severed = false;
  let lift = 0;
  let down = false;
  const from = new THREE.Vector3();
  const at = new THREE.Vector3();
  let rise = 0;
  let fromY = 0;
  for (let i = 0; i < 60 * 50 && throws < 6; i++) {
    rig.fight(1);
    const b = rig.player.lastBlow;
    if (b && b.lift > lift) lift = b.lift;
    rig.player.position(at);
    if (rig.fighter.down && !down) {
      throws++;
      from.copy(at);
      fromY = at.y;
      rise = 0;
    }
    if (rig.fighter.down) {
      rise = Math.max(rise, at.y - fromY);
      farthest = Math.max(farthest, Math.hypot(at.x - from.x, at.z - from.z));
      highest = Math.max(highest, rise);
    }
    if (down && !rig.fighter.down) gotUp++;
    down = rig.fighter.down;
    severed ||= rig.player.arm.disarmed
      || rig.fighter.parts.some((p) => p.severed === true);
    if (rig.player.dead) break;
  }
  check("swung up through you, it puts you on the floor metres away, off your feet on the way",
    throws >= 2 && farthest > 2 && (highest > 0.1 || lift > 1),
    `${throws} times down; thrown up to ${farthest.toFixed(2)} m, the chest ${highest.toFixed(2)} m higher on the way, up to ${lift.toFixed(2)} m/s up`);
  check("and you get up again every time, with nothing taken off you",
    gotUp >= throws - 1 && !severed,
    `got up ${gotUp} of ${throws} times; ${severed ? "something came off" : "whole"}, health ${rig.player.health.toFixed(0)}`);
}

async function theNewcomersCloseAndCut(): Promise<void> {
  console.log("\nthe kobold and the ogre both close and cut");
  for (const species of [KOBOLD, OGRE]) {
    const rig = await buildRig({}, species, foeSpawn(species));
    let closest = 99;
    let firstCut = -1;
    let swings = 0;
    let downs = 0;
    let was = "";
    let down = false;
    const gap = new THREE.Vector3();
    const foeAt = new THREE.Vector3();
    for (let i = 0; i < 60 * 30; i++) {
      rig.fight(1);
      rig.fighter.position(gap);
      rig.foe.position(foeAt);
      closest = Math.min(closest, Math.hypot(gap.x - foeAt.x, gap.z - foeAt.z));
      if (firstCut < 0 && rig.player.health < 100) firstCut = i / 60;
      if (rig.ai.intent === "windup" && was !== "windup") swings++;
      was = rig.ai.intent;
      if (rig.fighter.down && !down) downs++;
      down = rig.fighter.down;
      if (rig.player.dead) break;
    }
    const reach = species === KOBOLD ? 1 : 2.2;
    check(`${species.name} closes the distance and swings`, closest < reach && swings >= 5,
      `closed to ${closest.toFixed(2)} m, ${swings} swings in 30s`);
    check(`${species.name} draws blood${species === OGRE ? ", and puts you on the floor" : ""}`,
      firstCut >= 0 && (species !== OGRE || downs >= 2),
      firstCut >= 0
        ? `first cut at ${firstCut.toFixed(1)}s, you down to ${rig.player.health.toFixed(0)}, floored ${downs} times`
        : "never landed a hit in 30s");
  }
}

async function everyLookFadesWithItsBody(): Promise<void> {
  console.log("\nwhat a creature wears goes with it: the camera fades it out as one");
  // The camera backed into a wall fades the figure out of its way, and what
  // it wears -- a helm, a harness, a tail, a scabbard -- is drawn on top of
  // the body. A material left out of the fade would leave a helmet hanging
  // in front of the lens.
  const missed: string[] = [];
  let pieces = 0;
  for (const species of Object.values(SPECIES) as Species[]) {
    const rig = await buildRig({}, species, foeSpawn(species));
    const f = rig.foe.fighter;
    f.setFade(0.5);
    const roots: THREE.Object3D[] = [f.mesh, ...f.parts.filter((p) => p.body).map((p) => p.mesh)];
    for (const root of roots) {
      root.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          pieces++;
          if (Math.abs(m.opacity - 0.5) > 1e-6 && !missed.includes(species.key)) missed.push(species.key);
        }
      });
    }
  }
  check("every piece of every creature fades with its body", missed.length === 0 && pieces > 200,
    missed.length ? `left solid: ${missed.join(", ")}` : `${pieces} pieces across ${Object.keys(SPECIES).length} creatures, all at half`);
}

async function theNewKeysAreWhereTheySay(): Promise<void> {
  console.log("\nthe new keys are where the HUD says");
  check("C crouches", KEY_MAP.KeyC === "crouch", `C -> ${KEY_MAP.KeyC}`);
  check("Shift turns you on your heel", KEY_MAP.ShiftLeft === "pivot" && KEY_MAP.ShiftRight === "pivot",
    `Shift -> ${KEY_MAP.ShiftLeft}`);
  check("Space jumps and climbs, V vaults", KEY_MAP.Space === "jump" && KEY_MAP.KeyV === "vault",
    `Space -> ${KEY_MAP.Space}, V -> ${KEY_MAP.KeyV}`);
  check("X sheathes and draws, F picks up, H drinks",
    ACTION_MAP.KeyX === "sheathe" && ACTION_MAP.KeyF === "interact" && ACTION_MAP.KeyH === "drink",
    `X -> ${ACTION_MAP.KeyX}, F -> ${ACTION_MAP.KeyF}, H -> ${ACTION_MAP.KeyH}`);
  const one = ACTION_MAP.Digit1;
  const nine = ACTION_MAP.Digit9;
  check("G lets go of what is in your hand", ACTION_MAP.KeyG === "drop", `G -> ${ACTION_MAP.KeyG}`);
  check("Z slings the shield, B opens the inventory, and 1 to 9 use what is in it",
    ACTION_MAP.KeyZ === "sling" && ACTION_MAP.KeyB === "bag"
      && typeof one === "object" && one.use === 0 && typeof nine === "object" && nine.use === 8,
    `Z -> ${ACTION_MAP.KeyZ}, B -> ${ACTION_MAP.KeyB}, 1 -> ${JSON.stringify(one)}, 9 -> ${JSON.stringify(nine)}`);

  // Two short taps of the same key, close together, and only that: the keys
  // are tapped all the time to edge in and out of reach, and a quick step
  // nobody asked for costs a fight. Seconds, as the key events have them.
  const taps = (presses: [string, number, number][]) => {
    const t = new Taps();
    let quick = 0;
    for (const [code, down, up] of presses) {
      if (t.press(code, down)) quick++;
      t.release(code, up);
    }
    return quick;
  };
  const tap = TAP / 2;
  const gap = GAP / 2;
  const twice = taps([["KeyW", 0, tap], ["KeyW", tap + gap, tap + gap + 0.05]]);
  const held = taps([["KeyW", 0, TAP + 0.1], ["KeyW", TAP + 0.1 + gap, TAP + 0.2 + gap]]);
  const slow = taps([["KeyW", 0, tap], ["KeyW", tap + GAP + 0.1, tap + GAP + 0.15]]);
  const between = taps([["KeyW", 0, tap], ["KeyQ", tap + 0.02, tap + 0.06], ["KeyW", tap + gap, tap + gap + 0.05]]);
  const thrice = taps([["KeyS", 0, tap], ["KeyS", tap + gap, 2 * tap + gap], ["KeyS", 2 * (tap + gap), 3 * tap + 2 * gap]]);
  check("two quick taps of W, S, Q or E are a quick step -- a held key, a slow tap or another key between are not",
    twice === 1 && held === 0 && slow === 0 && between === 0 && thrice === 1,
    `two taps ${twice}, held first ${held}, too far apart ${slow}, Q between ${between}, three taps ${thrice}`);
}

async function run(): Promise<void> {
  console.log("Die by the Sword — headless arm harness");
  await freeArmTracks();
  await reachesAtEveryExtension();
  await blockedBladeDefeatsTheArm();
  await edgeRollTracks();
  await survivesAbuse();
  await thinPostIsHittable();
  await damageCurveIsHonest();
  await limbsComeOff();
  await severingTakesChildrenWithIt();
  await resetRebuildsCleanly();
  await aRealSwingSevers();
  await aBladeStopsOnABody();
  await aHitSaysHowHardItWas();
  await theOpponentClosesAndSwings();
  await theOpponentPlaysByTheSameRules();
  await theOpponentCanHurtYou();
  await cuttingTheArmDisarms();
  await bladesIgnoreTheirOwnerButNotTheFoe();
  await deathDropsTheBody();
  await theTrunkWalksWithTheLegs();
  await aDeadBodyGoesLimp();
  await aLostArmIsHeld();

  await theControlsAreWhereTheySay();
  await jumpingLeavesTheGround();
  await airControlIsWeakerThanGround();
  await aDoubleTapIsAQuickStep();
  await aLegSweepCanBeJumped();
  await weaponsAreToldApartByPhysics();
  await theAxeIsHarderToSwing();
  await theBestiaryScalesHonestly();
  await eachSpeciesCanFight();
  await swingsAreReadOffTheArm();
  await alliesShareAnArenaWithoutCuttingEachOther();
  await resetPutsSeveredLimbsBackOn();
  await everyMovingPartIsInterpolated();
  await theTestingAreaIsAHallAndFourRooms();
  await anOpponentWaitsUntilItSeesYou();
  await anOpponentLooksWhereItLastSawYou();
  await thePenOpensOnTwoOrcs();
  await severingBleeds();

  await theArmKeepsOutOfItsOwnChest();
  await aFlickDoesNotSnapTheArm();
  await aRaisedArmDoesNotTurnOver();
  await slowInputIsUntouched();
  await theChestLeadsTheArm();
  await theFeetStayPlantedThenStep();
  await theKneesBendLikeAPersons();
  await stoppingPutsTheFeetDown();
  await turningOnTheSpotSteps();
  await theLegsGoTheWayTheBodyDoes();
  await theBodyAgreesWithItsProbes();
  await thePostureIsInterpolated();

  await theWeaponsWeighWhatTheyShould();
  await theGripKeepsTheEdge();
  await theWristKeepsTheLine();
  await noGripSpinsUnderAbuse();

  await oneBlowThreeBodies();
  await aKnockedDownFighterGetsUp();
  await aKnockdownGoesLimp();
  await aStaggerTakesTheSwingOffIt();
  await realBlowsAreWeighed();
  await theDummySwingsWhenStruck();
  await knockdownsDoNotWearTheBodyOut();
  await oneSwingIsOneBlow();
  await aCorpseLiesStill();
  await aDroppedWeaponIsNotKicked();

  await footworkAsksTheStone();
  await anOpponentMovesBetweenSwings();
  await anOpponentGetsOutOfTheWay();
  await anOpponentMovesInAndOut();
  await weaponsKnockEachOther();
  await crowdingItDoesNotStopIt();
  await theOrcComesAfterYouThroughTheAir();
  await aMissRunsIntoTheNextSwing();
  await itsGuardIsWhereItsLastSwingLeftIt();
  await itDrawsBackOnTheMove();
  await aMissCanCarryItRound();
  await itMeetsASwingWithItsWeapon();
  await itHopsClearAndFlinches();
  await aCutLegLamesYou();
  await badlyHurtItFightsLikeIt();
  await itTauntsYouFromOutOfReach();
  await theyQuickStepToo();

  await theOtherArmHoldsStill();
  await theSwordGoesOnYourBack();
  await aFreeHandTakesThings();
  await fGoesAndGetsIt();
  await aLeverIsPulledByHand();
  await aShieldStopsABlade();
  await theShieldArmIsSteered();
  await theShieldGoesOnYourBackToo();
  await aShieldOnYourBackStopsACutFromBehind();
  await whatYouCutOffYouCanCarryOff();
  await whatYouHoldYouCanThrow();
  await theOrcsAxeCanBeWielded();
  await everyWeaponCanBeWielded();
  await aCrouchGetsLow();
  await aVaultGoesOver();
  await aClimbGoesUp();
  await theStonesAndTheRailAreJumped();
  await theNewcomersScaleHonestly();
  await aClubSendsYouFlying();
  await theNewcomersCloseAndCut();
  await everyLookFadesWithItsBody();
  await theNewKeysAreWhereTheySay();

  console.log(
    `\n${checks - failures}/${checks} checks passed` +
    (failures ? `  \x1b[31m(${failures} failed)\x1b[0m` : "  \x1b[32mOK\x1b[0m"),
  );
  process.exit(failures ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
