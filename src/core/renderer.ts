import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** Scene, camera, lights, resize handling. Deliberately plain. */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly webgl: THREE.WebGLRenderer;

  constructor(mount: HTMLElement) {
    this.webgl = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.webgl.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.0;
    mount.appendChild(this.webgl.domElement);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.05, 220);

    this.scene.background = new THREE.Color(0x0e1014);
    this.scene.fog = new THREE.Fog(0x0e1014, 15, 54);

    // A metallic surface with nothing to reflect renders black, which is
    // exactly what the sword did before this: a mirror in an empty room. The
    // generated room environment gives the steel something to pick up, and is
    // the difference between a blade and a black stick.
    const pmrem = new THREE.PMREMGenerator(this.webgl);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    // Cool ambient bounce, warm key from high-left: cheap, and it reads the
    // blade's edge well when it rolls.
    const hemi = new THREE.HemisphereLight(0x8899bb, 0x2a241e, 0.6);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffe9c9, 2.0);
    key.position.set(-7, 12, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 40;
    const s = 14;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0008;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x6f8fd0, 0.7);
    rim.position.set(6, 5, -8);
    this.scene.add(rim);

    this.resize();
    addEventListener("resize", () => this.resize());
  }

  private resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.webgl.setSize(w, h);
  }

  draw(): void {
    this.webgl.render(this.scene, this.camera);
  }
}
