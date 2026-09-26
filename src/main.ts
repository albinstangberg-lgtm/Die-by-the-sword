import * as THREE from "three";
import { Loop, STEP } from "./core/loop";
import { Renderer } from "./core/renderer";
import { createPhysics, GROUP, groups, makeSides } from "./core/physics";
import { Interpolator } from "./core/interpolate";
import { Input, type Action } from "./input/input";
import { buildArena, DUMMY_AT, ITEM_LAYOUT, SPAWN } from "./game/arena";
import { Items, promptFor } from "./game/items";
import { Pickup } from "./game/pickup";
import { Targets } from "./game/targets";
import { Dummy } from "./game/dummy";
import { Combatant } from "./game/combatant";
import { PLAYER_PALETTE } from "./game/fighter";
import { MAN_LOOK } from "./game/look";
import { gateHeard, ROSTER, spawnOf } from "./game/roster";
import { SWORDSMAN } from "./game/species";
import type { Arm } from "./game/arm";
import type { Fighter } from "./game/fighter";
import { Ai } from "./game/ai";
import { Impacts } from "./game/impacts";
import { Trail } from "./game/trail";
import { Hud, type Kit } from "./ui/hud";
import { Bag } from "./ui/bag";
import { Panel, loadTuning } from "./ui/panel";

/**
 * Die by the Sword.
 *
 * A hall, a practice dummy, and things that want to kill you behind four
 * gates off it: two orcs with axes in the pen, two kobolds with hatchets in
 * the warren, three goblins with spears in the cell, and an ogre with a club
 * in the den (see arena.ts, and roster.ts for who stands where). Nothing
 * comes out until you pull the lever beside its gate. Every one of them --
 * you included -- is the same Combatant driving the same physical arm under
 * the same force clamp. The only difference between a player and a monster
 * here is who supplies the mouse deltas, and how big the animal holding the
 * weapon is.
 */

const mount = document.getElementById("app")!;
const veil = document.getElementById("veil")!;
const hudEl = document.getElementById("hud")!;
const impactEl = document.getElementById("impact")!;
const panelEl = document.getElementById("panel")!;

async function main(): Promise<void> {
  const tuning = loadTuning();

  const renderer = new Renderer(mount);
  const phys = await createPhysics(tuning.gravity);
  const interp = new Interpolator();

  const targets = new Targets();
  const arena = buildArena(phys, renderer.scene, targets);

  // One side per fighter, all the foes on one team. Deriving them together is
  // what makes "everyone's weapon but my own" a filter rather than a pile of
  // special cases.
  const sides = makeSides([0, ...ROSTER.map(() => 1)]);
  const gateways = Object.values(arena.gateways);

  const player = new Combatant(phys, renderer.scene, SPAWN, sides[0], tuning,
    targets, { ...SWORDSMAN, palette: PLAYER_PALETTE, look: MAN_LOOK }, "you", "your");
  const foes = ROSTER.map((o, i) => ({
    combatant: new Combatant(phys, renderer.scene, spawnOf(o), sides[i + 1], tuning,
      targets, o.species, o.name, `${o.name}'s`),
    ai: new Ai(o.species),
    spawn: spawnOf(o),
    facing: o.facing,
  }));
  // Turned to face the way it faces at its post before it has thought once:
  // its first thought takes its post, and the way it faces there, as it
  // stands. Every body is built facing north, so it comes round over its
  // first steps -- behind a shut gate, where nobody sees it.
  const face = () => {
    for (const f of foes) f.combatant.fighter.yaw = f.facing;
  };
  face();

  const fighter = player.fighter;
  const arm = player.arm;

  const trail = new Trail(renderer.scene);
  const impacts = new Impacts(phys, renderer.scene, targets, tuning);
  const dummy = new Dummy(phys, renderer.scene, targets, DUMMY_AT);
  const items = new Items(renderer.scene, ITEM_LAYOUT);
  // Whatever comes off an opponent can be picked up and carried off.
  items.watch(foes.map((f) => f.combatant));
  // And F goes to a lever as it goes to anything, to pull it.
  for (const g of gateways) items.add(g.lever.item);
  const pickup = new Pickup(player, items);

  const everyone = [player, ...foes.map((f) => f.combatant)];
  // Each of them knows who else is in the fight: its friends are whom it keeps
  // its blade off (see `Ai.company`).
  for (const f of foes) f.ai.company = everyone;

  // Everything with a rigid body goes through the interpolator, and nothing
  // else may place those meshes afterwards. Half the figure used to be absent
  // from this list and copied straight from the physics state during render
  // instead, which threw the interpolation away for that half: above 60Hz the
  // torso stepped while the sword in its hand ran smooth.
  const registerBodies = () => {
    interp.clear();
    for (const c of everyone) {
      interp.add(c.fighter.body, c.fighter.mesh);
      for (const [body, mesh] of c.fighter.jointedParts) interp.add(body, mesh);
      interp.add(c.arm.upper, c.arm.upperMesh);
      interp.add(c.arm.fore, c.arm.foreMesh);
      interp.add(c.arm.blade, c.arm.bladeMesh);
    }
    for (const [body, mesh] of dummy.bodies) interp.add(body, mesh);
    for (const g of gateways) {
      interp.add(g.lever.body, g.lever.mesh);
      interp.add(g.gate.body, g.gate.mesh);
    }
  };
  registerBodies();
  // A piece let go of starts from the hand, wherever it last lay.
  items.placed = (body) => interp.jump(body);

  const hud = new Hud(hudEl, impactEl);
  const bag = new Bag();
  hud.trackDummy(dummy);
  hud.trackFight(player, foes);
  const blood = impacts.blood;
  dummy.onSever = (e) => {
    hud.showSever(e);
    if (e.wound) blood.wound(e.wound);
  };

  // Every weapon cuts whoever it lands on but the one holding it: the dummy,
  // you, and any of them, allies too. Each weapon reports through the same
  // reporter, and a fighter it lands on says what the blow did to it.
  impacts.addBlade(arm, (i) => {
    if (dummy.receive(i)) { hud.showImpact(i, true); return; }
    const struck = foes.find((f) => f.combatant.receive(i));
    hud.showImpact(i, struck !== undefined, struck?.combatant.lastBlow ?? null);
  });
  for (const f of foes) {
    impacts.addBlade(f.combatant.arm, (i) => {
      // A shield stops the blade before it reaches anything that bleeds, and
      // the weight of the blow comes through the arm anyway.
      if (player.block(i)) { hud.showBlock(i, player.lastBlow); return; }
      if (player.receive(i)) { hud.showHurt(i, player.lastBlow); return; }
      // One of them caught by another's blade is cut like anyone else.
      for (const g of foes) {
        if (g === f) continue;
        if (g.combatant.block(i)) return;
        const was = g.combatant.health;
        if (g.combatant.receive(i)) {
          if (g.combatant.health < was) hud.showNote(`${f.combatant.name} cuts ${g.combatant.name}`);
          return;
        }
      }
    });
    f.combatant.onDisarm = (_where, wound) => {
      hud.showSever({ label: `${f.combatant.name} is disarmed`, at: wound.at });
      blood.wound(wound);
    };
    f.combatant.onLoseLimb = (_part, wound) => blood.wound(wound);
    f.combatant.onDeath = () =>
      hud.showSever({ label: `${f.combatant.name} is down`, at: new THREE.Vector3() });
  }

  // A gate going up is a noise, and whatever is behind it comes to see why.
  for (const g of gateways) {
    g.gate.onStart = () => {
      hud.showNote(`${g.room.name}'s gate grinds up`);
      gateHeard(g.spec.room, foes);
    };
  }

  // Two weapons met and one was knocked aside: say so, when it was yours or
  // theirs by you, and hard enough to be an opening rather than a tap.
  impacts.onClash = (c) => {
    if (c.share < 0.2) return;
    const other = (a: typeof arm) => foes.find((f) => f.combatant.arm === a)?.combatant;
    if (c.knocked === arm) {
      const by = other(c.by);
      hud.showNote(`your ${arm.weapon.name} is knocked aside${by ? ` by ${by.name}` : ""}`, true);
    } else if (c.by === arm) {
      const them = other(c.knocked);
      if (them) hud.showNote(`you knock ${them.name}'s ${c.knocked.weapon.name} aside`);
    }
  };

  player.onDisarm = (_where, wound) => {
    hud.showSever({ label: "your sword arm", at: wound.at });
    blood.wound(wound);
  };
  player.onLoseLimb = (_part, wound) => blood.wound(wound);

  const input = new Input(renderer.webgl.domElement);

  // Joint-anchor markers, off by default. Declared before applyTuning so the
  // closure never sees it in the temporal dead zone.
  const skeleton = buildSkeleton(renderer.scene);

  const applyTuning = () => {
    phys.world.gravity = { x: 0, y: tuning.gravity, z: 0 };
    arm.applyMasses(tuning);
    trail.setVisible(tuning.showTrail);
    skeleton.visible = tuning.showSkeleton;
  };

  const panel = new Panel(panelEl, tuning, applyTuning);

  input.onTogglePanel = () => panel.toggle();

  // One-shot actions happen inside the next fixed step, never in the middle
  // of an event handler: taking a sword out of the hand is a joint leaving
  // the world, and that belongs between two steps.
  const pending: Action[] = [];
  input.onAction = (a) => pending.push(a);
  const perform = (a: Action) => {
    // A number, with the inventory open: whatever is on that line -- a
    // potion drunk, anything else out of the bag and into the hand.
    if (typeof a === "object") {
      const entry = bag.open ? player.inventory.entries()[a.use] : undefined;
      if (!entry) return;
      const out = entry.kind === "potion" ? player.drink() : items.unbag(player, entry.item);
      hud.showNote(out.text, !out.ok);
      return;
    }
    switch (a) {
      case "sheathe": {
        // Whatever the hand was doing -- going for something, holding
        // something -- it is wanted for the sword now. Unless what it holds
        // is a weapon: then that is the one it takes up, and puts up again.
        pickup.cancel();
        if (player.arm.wieldsTaken || player.held?.kind === "weapon") {
          const out = player.arm.wieldsTaken ? items.unwield(player) : items.wield(player);
          hud.showNote(out.text, !out.ok);
          break;
        }
        if (player.held) hud.showNote(items.letGo(player).text);
        if (!player.arm.stowing) {
          if (player.arm.sheathed) player.arm.draw(); else player.arm.sheathe();
        }
        break;
      }
      case "interact": {
        // Again, while going for something: never mind. With something in
        // the hand: into the bag with it.
        if (pickup.active) { pickup.cancel(); break; }
        if (player.held) {
          const out = items.bag(player);
          hud.showNote(out.text, !out.ok);
          break;
        }
        const out = pickup.start(input.keys);
        if (!out.ok) hud.showNote(out.text, true);
        break;
      }
      case "drop": {
        const out = items.letGo(player);
        hud.showNote(out.text, !out.ok);
        break;
      }
      case "sling": {
        // The other hand, over its own shoulder: nothing to do with the sword
        // hand, so a pick-up it is busy with goes on.
        const out = player.sling();
        hud.showNote(out.text, !out.ok);
        break;
      }
      case "drink": {
        const out = player.drink();
        hud.showNote(out.text, !out.ok);
        break;
      }
      case "bag":
        bag.toggle();
        break;
    }
  };

  input.onReset = () => {
    // Before anyone is put back together: whatever was cut off and carried
    // away has to be back in the world for its owner's reset to put it on.
    pickup.cancel();
    items.reset();
    player.reset(tuning, SPAWN);
    for (const f of foes) {
      f.combatant.reset(tuning, f.spawn);
      f.ai.reset();
    }
    face();
    // Shut behind them again, now that nobody is standing in the gateways, and
    // the levers back up.
    for (const g of gateways) {
      g.lever.reset();
      g.gate.reset();
    }
    dummy.reset();
    // The rays anybody casts before the world next steps -- what an opponent
    // sees, thinking first thing -- see all that where it now is, and not the
    // gate still up and everyone where they were.
    phys.world.propagateModifiedBodyPositionsToColliders();
    phys.world.updateSceneQueries();
    pending.length = 0;
    // The dummy's bodies are all new, so the interpolator's entries point at
    // freed handles; rebuild the whole set rather than leaving stale ones.
    registerBodies();
    interp.snap();
    // Bodies have jumped across the room; a sweep from where they were would
    // cut everything in between.
    impacts.resetSweeps();
    trail.clear();
    blood.clear();
    hud.trackDummy(dummy);
  };
  input.onLockChange = (locked) => {
    veil.classList.toggle("hidden", locked);
  };
  veil.addEventListener("click", () => input.requestLock());

  applyTuning();
  // The world's rays find nothing until it has stepped once, and everybody
  // looks before the first step: the walls -- and the gates -- have to be
  // there to look at.
  phys.world.updateSceneQueries();

  // --- camera: over the left shoulder, so the right arm stays in frame ---
  const camOffset = new THREE.Vector3(-0.85, 1.35, 2.95);
  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const desiredPos = new THREE.Vector3();
  const desiredTarget = new THREE.Vector3();
  const fighterPos = new THREE.Vector3();
  const camEye = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  let camInitialised = false;

  /**
   * How close the camera may come to a wall before it stops backing into it.
   *
   * One room was enough to get away without this -- you had to walk into a
   * corner to see through anything. Three rooms with doorways between them are
   * not: the camera sits nearly three metres behind the fighter, which is most
   * of the way through the wall you are standing next to.
   */
  const CAM_CLEARANCE = 0.3;
  /**
   * And how close it may come to the fighter, whatever the wall says.
   *
   * It has to be allowed very close indeed, because a wall right behind you
   * leaves nowhere else to put it: at a comfortable distance the camera ends
   * up on the far side of the stone, looking at the outside of the room. So it
   * comes in to just behind the head, and the figure gets out of the way
   * instead (below).
   */
  const CAM_MIN = 0.5;
  /**
   * Where the figure starts to fade, and where it has gone entirely.
   *
   * The sword arm holds on longer than the body: it is the thing you are
   * steering, and it only goes when the camera is close enough to be inside it.
   */
  const FADE_FROM = 2.1;
  const FADE_TO = 0.95;
  const ARM_FADE_FROM = 1.25;
  const ARM_FADE_TO = 0.72;
  // Anything the architecture collides with will do; a fighter is not a wall
  // and the practice dummy is not either.
  const camFilter = groups(GROUP.PROP, GROUP.WORLD);
  const camRay = new phys.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  /** Pull the camera in to the nearest wall between it and the fighter. */
  const clearWalls = (from: THREE.Vector3, to: THREE.Vector3) => {
    camDir.copy(to).sub(from);
    const reach = camDir.length();
    if (reach < 1e-3) return;
    camDir.multiplyScalar(1 / reach);

    camRay.origin = { x: from.x, y: from.y, z: from.z };
    camRay.dir = { x: camDir.x, y: camDir.y, z: camDir.z };
    const hit = phys.world.castRay(camRay, reach, true, undefined, camFilter);
    if (hit === null) return;
    to.copy(from).addScaledVector(camDir, Math.max(CAM_MIN, hit.timeOfImpact - CAM_CLEARANCE));
  };

  const updateCamera = (dt: number) => {
    fighter.position(fighterPos);
    const sin = Math.sin(fighter.yaw);
    const cos = Math.cos(fighter.yaw);
    desiredPos.set(
      fighterPos.x + camOffset.x * cos + camOffset.z * sin,
      fighterPos.y + camOffset.y,
      fighterPos.z + -camOffset.x * sin + camOffset.z * cos,
    );

    // Look between the fighter's chest and the blade tip, so a big swing pulls
    // the framing with it instead of leaving the sword off-screen.
    desiredTarget.copy(fighterPos).add(new THREE.Vector3(0, 0.55, 0))
      .lerp(arm.tipPosition, 0.28);

    camEye.set(fighterPos.x, fighterPos.y + camOffset.y * 0.72, fighterPos.z);
    clearWalls(camEye, desiredPos);

    if (!camInitialised) {
      camPos.copy(desiredPos);
      camTarget.copy(desiredTarget);
      camInitialised = true;
    } else {
      // Frame-rate independent smoothing.
      camPos.lerp(desiredPos, 1 - Math.exp(-14 * dt));
      camTarget.lerp(desiredTarget, 1 - Math.exp(-9 * dt));
    }

    // And once more from where the camera actually is, since the smoothing
    // lags the desired position and can leave it inside the stone it was just
    // pulled out of.
    clearWalls(camEye, camPos);

    // Close in, the fighter's own body is the only thing in shot, so it gets
    // out of the way. Its sword arm does not.
    const close = camPos.distanceTo(camEye);
    fighter.setFade((close - FADE_TO) / (FADE_FROM - FADE_TO));
    arm.setFade((close - ARM_FADE_TO) / (ARM_FADE_FROM - ARM_FADE_TO));

    renderer.camera.position.copy(camPos);
    renderer.camera.lookAt(camTarget);
    renderer.follow(fighterPos);
  };

  /** What you carry and how you stand, for the HUD. */
  const kit = (): Kit => ({
    sword: arm.disarmed ? "lost"
      : arm.wieldsTaken ? "back"
      : arm.stowing ? (arm.drawing ? "drawing" : "sheathing")
        : arm.sheathed ? "back" : "hand",
    shield: player.offArm.slinging ? (player.offArm.slingingOn ? "slinging" : "unslinging")
      : player.shieldOnBack ? "back"
        : player.hasShield
          ? (player.fighter.offLimb.elbowOn && player.fighter.offLimb.shoulderOn ? "arm" : "lost")
          : "none",
    potions: player.potions,
    bagged: player.inventory.pieces.length,
    holding: player.held ? `${player.held.name}${arm.wieldsTaken ? " (wielded)" : ""}` : null,
    healing: player.healing,
    stance: player.dead || fighter.down ? "down"
      : fighter.vaulting ? "vaulting"
        : fighter.climbing ? "climbing"
          : pickup.active ? (pickup.target?.lever ? "pulling" : "picking up")
            : !fighter.grounded ? "airborne"
              : fighter.crouching ? "crouching" : "standing",
    guarding: input.guardMode,
    prompt: pickup.active || fighter.vaulting || fighter.climbing ? null : promptFor(player, items),
  });

  const loop = new Loop({
    fixed: (dt) => {
      for (const a of pending.splice(0)) perform(a);
      // Going to get something, the body is walked there by the pick-up
      // through the same keys, until it has it or the player takes over.
      const keys = pickup.step(input.keys, dt, (out) => hud.showNote(out.text, !out.ok))
        ?? input.keys;
      // Mouse deltas are consumed here, not in render: reading them per frame
      // double-counts input whenever one frame spans two physics steps.
      player.act(input, keys, tuning, dt);
      // A double tap asks for one quick step, once.
      input.dashSeen();

      for (const f of foes) {
        f.ai.think(f.combatant, player, tuning, dt);
        f.combatant.act(f.ai, f.ai.keys, tuning, dt);
      }
      for (const g of gateways) g.gate.step(dt);

      interp.capture();
      phys.step();
      interp.commit();
      // Pulled far enough, a lever catches, and sets its gate going.
      for (const g of gateways) g.lever.update();
      items.update();

      for (const c of everyone) c.arm.updateDerived();
      impacts.update(performance.now());
      // A sword on your back, or on its way there or back, traces nothing;
      // drawn again, its arc starts afresh.
      if (tuning.showTrail) {
        if (arm.stowed) trail.clear(); else trail.sample(arm);
      }
    },
    render: (alpha, dt) => {
      interp.apply(alpha);
      for (const c of everyone) c.syncMeshes(alpha, c === player && tuning.showGhost);
      if (tuning.showSkeleton) updateSkeleton(skeleton, arm, fighter);
      updateCamera(dt);
      const carried = kit();
      hud.update(arm.state, loop.frameMs, input.rollMode, fighter.grounded, carried);
      bag.update(player, carried);
      renderer.draw();
    },
  });

  loop.start();

  // Surface the physics rate once, so the number in the HUD has a reference.
  console.info(
    `physics ${Math.round(1 / STEP)}Hz fixed; ` +
    `drive kp=${tuning.armKp} kd=${tuning.armKd} maxF=${tuning.maxForce}N`,
  );
}

// -----------------------------------------------------------------------------

function buildSkeleton(scene: THREE.Scene): THREE.Group {
  const g = new THREE.Group();
  g.visible = false;
  const mat = new THREE.MeshBasicMaterial({ color: 0xff6b3d, depthTest: false });
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), mat);
    m.renderOrder = 999;
    g.add(m);
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x5fd3ff, depthTest: false }),
  );
  line.renderOrder = 999;
  line.frustumCulled = false;
  g.add(line);
  scene.add(g);
  return g;
}

const _tmp = new THREE.Vector3();

/** Draws shoulder / elbow / hand, plus the gap between hand and ghost. */
function updateSkeleton(g: THREE.Group, arm: Arm, fighter: Fighter): void {
  fighter.shoulderWorld(_tmp);
  g.children[0].position.copy(_tmp);

  const up = arm.upper.translation();
  const uq = arm.upper.rotation();
  _tmp.set(0, 0.15, 0)
    .applyQuaternion(new THREE.Quaternion(uq.x, uq.y, uq.z, uq.w))
    .add(new THREE.Vector3(up.x, up.y, up.z));
  g.children[1].position.copy(_tmp);

  g.children[2].position.copy(arm.handPosition);

  // The error vector itself: hand to ghost. When this line is long, the world
  // is beating the arm.
  const line = g.children[3] as THREE.Line;
  const pos = line.geometry.attributes.position as THREE.BufferAttribute;
  pos.setXYZ(0, arm.handPosition.x, arm.handPosition.y, arm.handPosition.z);
  pos.setXYZ(1, arm.ghostPosition.x, arm.ghostPosition.y, arm.ghostPosition.z);
  pos.needsUpdate = true;
}

main().catch((err) => {
  console.error(err);
  veil.innerHTML = `<div class="inner">
    <h1>Failed to start</h1>
    <p>${err instanceof Error ? err.message : String(err)}</p>
    <p>Check the browser console.</p>
  </div>`;
});
