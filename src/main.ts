import * as THREE from "three";
import { Loop, STEP } from "./core/loop";
import { Renderer } from "./core/renderer";
import { createPhysics, makeSides } from "./core/physics";
import { Interpolator } from "./core/interpolate";
import { Input } from "./input/input";
import { buildArena, SPAWN } from "./game/arena";
import { Targets } from "./game/targets";
import { Dummy } from "./game/dummy";
import { Combatant } from "./game/combatant";
import { PLAYER_PALETTE } from "./game/fighter";
import { GOBLIN, ORC, SWORDSMAN } from "./game/species";
import type { Arm } from "./game/arm";
import type { Fighter } from "./game/fighter";
import { Ai } from "./game/ai";
import { Impacts } from "./game/impacts";
import { Trail } from "./game/trail";
import { Hud } from "./ui/hud";
import { Panel, loadTuning } from "./ui/panel";

/**
 * Die by the Sword.
 *
 * A room, a practice dummy, and two things that want to kill you: an orc with
 * an axe and a goblin with a spear. Every one of them -- you included -- is the
 * same Combatant driving the same physical arm under the same force clamp. The
 * only difference between a player and a monster here is who supplies the
 * mouse deltas, and how big the animal holding the weapon is.
 */

/** Where the practice dummy hangs — clear of the pillars and the low beam. */
const DUMMY_AT = new THREE.Vector3(2.6, 0, -3.4);

/**
 * The opponents, and where they start.
 *
 * Both across the room and well out of reach, and far enough apart that they
 * do not spend the first second shouldering past each other. Their spawn
 * heights are their own hulls' centres, so nobody starts the fight sunk into
 * the floor or dropping into it.
 */
const FOES = [
  { species: ORC, at: new THREE.Vector3(-1.9, ORC.build.hullCentreY + 0.11, -4.2) },
  { species: GOBLIN, at: new THREE.Vector3(1.1, GOBLIN.build.hullCentreY + 0.11, -4.6) },
];

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
  buildArena(phys, renderer.scene, targets);

  // One side per fighter, all the foes on one team. Deriving them together is
  // what makes "everyone's weapon but my own, and not my ally's back" a filter
  // rather than a pile of special cases.
  const sides = makeSides([0, ...FOES.map(() => 1)]);

  const player = new Combatant(phys, renderer.scene, SPAWN, sides[0], tuning,
    targets, { ...SWORDSMAN, palette: PLAYER_PALETTE }, "you", "your");
  const foes = FOES.map((f, i) => ({
    combatant: new Combatant(phys, renderer.scene, f.at, sides[i + 1], tuning,
      targets, f.species),
    ai: new Ai(f.species),
    spawn: f.at,
  }));

  const fighter = player.fighter;
  const arm = player.arm;

  const trail = new Trail(renderer.scene);
  const impacts = new Impacts(phys, renderer.scene, targets);
  const dummy = new Dummy(phys, renderer.scene, targets, DUMMY_AT);

  const everyone = [player, ...foes.map((f) => f.combatant)];

  const registerBodies = () => {
    interp.clear();
    for (const c of everyone) {
      interp.add(c.fighter.body, c.fighter.mesh);
      interp.add(c.arm.upper, c.arm.upperMesh);
      interp.add(c.arm.fore, c.arm.foreMesh);
      interp.add(c.arm.blade, c.arm.bladeMesh);
    }
    for (const [body, mesh] of dummy.bodies) interp.add(body, mesh);
  };
  registerBodies();

  const hud = new Hud(hudEl, impactEl);
  hud.trackDummy(dummy);
  hud.trackFight(player, foes);
  dummy.onSever = (e) => hud.showSever(e);

  // The player's weapon can cut the dummy or anything on the other team; theirs
  // can only cut the player. Each weapon reports through the same reporter.
  impacts.addBlade(arm, (i) => {
    const landed = dummy.receive(i)
      || foes.some((f) => f.combatant.receive(i));
    hud.showImpact(i, landed);
  });
  for (const f of foes) {
    impacts.addBlade(f.combatant.arm, (i) => {
      if (player.receive(i)) hud.showHurt(i);
    });
    f.combatant.onDisarm = () =>
      hud.showSever({ label: `${f.combatant.name} is disarmed`, at: new THREE.Vector3() });
    f.combatant.onDeath = () =>
      hud.showSever({ label: `${f.combatant.name} is down`, at: new THREE.Vector3() });
  }

  player.onDisarm = () => hud.showSever({ label: "your sword arm", at: new THREE.Vector3() });

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
  input.onReset = () => {
    player.reset(tuning, SPAWN);
    for (const f of foes) {
      f.combatant.reset(tuning, f.spawn);
      f.ai.reset();
    }
    dummy.reset();
    // The dummy's bodies are all new, so the interpolator's entries point at
    // freed handles; rebuild the whole set rather than leaving stale ones.
    registerBodies();
    interp.snap();
    // Bodies have jumped across the room; a sweep from where they were would
    // cut everything in between.
    impacts.resetSweeps();
    trail.clear();
    hud.trackDummy(dummy);
  };
  input.onLockChange = (locked) => {
    veil.classList.toggle("hidden", locked);
  };
  veil.addEventListener("click", () => input.requestLock());

  applyTuning();

  // --- camera: over the left shoulder, so the right arm stays in frame ---
  const camOffset = new THREE.Vector3(-0.85, 1.35, 2.95);
  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const desiredPos = new THREE.Vector3();
  const desiredTarget = new THREE.Vector3();
  const fighterPos = new THREE.Vector3();
  let camInitialised = false;

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

    if (!camInitialised) {
      camPos.copy(desiredPos);
      camTarget.copy(desiredTarget);
      camInitialised = true;
    } else {
      // Frame-rate independent smoothing.
      camPos.lerp(desiredPos, 1 - Math.exp(-14 * dt));
      camTarget.lerp(desiredTarget, 1 - Math.exp(-9 * dt));
    }

    renderer.camera.position.copy(camPos);
    renderer.camera.lookAt(camTarget);
  };

  const loop = new Loop({
    fixed: (dt) => {
      // Mouse deltas are consumed here, not in render: reading them per frame
      // double-counts input whenever one frame spans two physics steps.
      player.act(input, input.keys, tuning, dt);

      for (const f of foes) {
        f.ai.think(f.combatant, player, tuning, dt);
        f.combatant.act(f.ai, f.ai.keys, tuning, dt);
      }

      interp.capture();
      phys.step();
      interp.commit();

      for (const c of everyone) c.arm.updateDerived();
      impacts.update(performance.now());
      if (tuning.showTrail) trail.sample(arm);
    },
    render: (alpha, dt) => {
      interp.apply(alpha);
      for (const c of everyone) c.syncMeshes(tuning);
      dummy.syncMeshes();
      if (tuning.showSkeleton) updateSkeleton(skeleton, arm, fighter);
      updateCamera(dt);
      hud.update(arm.state, loop.frameMs, input.rollMode, fighter.grounded);
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
