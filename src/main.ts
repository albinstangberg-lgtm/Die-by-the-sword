import * as THREE from "three";
import { Loop, STEP } from "./core/loop";
import { Renderer } from "./core/renderer";
import { createPhysics } from "./core/physics";
import { Interpolator } from "./core/interpolate";
import { Input } from "./input/input";
import { buildArena, SPAWN } from "./game/arena";
import { Fighter } from "./game/fighter";
import { Arm } from "./game/arm";
import { Impacts } from "./game/impacts";
import { Trail } from "./game/trail";
import { Hud } from "./ui/hud";
import { Panel, loadTuning } from "./ui/panel";

/**
 * Die by the Sword — stage 2.
 *
 * A room, a fighter, and one physically simulated sword arm driven by the
 * mouse. There is no combat here on purpose: the whole point of this stage is
 * to find out whether swinging a sword at a wall feels good. If it doesn't,
 * nothing built on top of it will.
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

  const arena = buildArena(phys, renderer.scene);
  const fighter = new Fighter(phys, renderer.scene, SPAWN);
  const arm = new Arm(phys, renderer.scene, fighter, tuning);
  const trail = new Trail(renderer.scene);
  const impacts = new Impacts(phys, renderer.scene, arm, arena);

  interp.add(fighter.body, fighter.mesh);
  interp.add(arm.upper, arm.upperMesh);
  interp.add(arm.fore, arm.foreMesh);
  interp.add(arm.blade, arm.bladeMesh);

  const hud = new Hud(hudEl, impactEl);
  impacts.onImpact = (i) => hud.showImpact(i);

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
    fighter.reset(SPAWN);
    arm.reset(tuning);
    interp.snap();
    trail.clear();
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
      arm.readInput(input, tuning, dt);
      fighter.update(input.keys, tuning, dt);
      arm.drive(tuning);

      interp.capture();
      phys.step();
      interp.commit();

      arm.updateDerived();
      impacts.update(performance.now());
      if (tuning.showTrail) trail.sample(arm);
    },
    render: (alpha, dt) => {
      interp.apply(alpha);
      arm.syncMeshes(tuning);
      fighter.syncMesh();
      if (tuning.showSkeleton) updateSkeleton(skeleton, arm, fighter);
      updateCamera(dt);
      hud.update(arm.state, loop.frameMs);
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
