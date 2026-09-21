import * as THREE from "three";
import type { Arm } from "./arm";

/**
 * A ribbon tracing the blade's swept arc over the last ~0.35s.
 *
 * It isn't decoration: the arc is the clearest read on whether a swing was
 * committed or a wrist flick, and it makes the blade's lag behind the ghost
 * hand visible as a shape rather than a number.
 */

const SEGMENTS = 22;
const GRIP_LEN = 0.11;
const TIP_Y = GRIP_LEN + 0.86;

export class Trail {
  private mesh: THREE.Mesh;
  private positions = new Float32Array(SEGMENTS * 2 * 3);
  private alphas = new Float32Array(SEGMENTS * 2);
  private head = 0;
  private filled = 0;

  private readonly _base = new THREE.Vector3();
  private readonly _tip = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geom.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphas, 1));

    // Two vertices per sample (base edge + tip edge) stitched into a strip.
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      index.push(a, b, c, b, d, c);
    }
    geom.setIndex(index);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(0x9fd8ff) } },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          gl_FragColor = vec4(uColor, vAlpha * 0.5);
        }`,
    });

    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Sample the blade's current base/tip edge. Call once per fixed step. */
  sample(arm: Arm): void {
    const bq = arm.blade.rotation();
    const bp = arm.blade.translation();
    this._q.set(bq.x, bq.y, bq.z, bq.w);

    this._base.set(0, GRIP_LEN, 0).applyQuaternion(this._q);
    this._base.set(bp.x + this._base.x, bp.y + this._base.y, bp.z + this._base.z);
    this._tip.set(0, TIP_Y, 0).applyQuaternion(this._q);
    this._tip.set(bp.x + this._tip.x, bp.y + this._tip.y, bp.z + this._tip.z);

    this.head = (this.head + 1) % SEGMENTS;
    this.filled = Math.min(this.filled + 1, SEGMENTS);
    this.write(this.head, this._base, this._tip);
    this.refreshAlphas();
  }

  private write(slot: number, base: THREE.Vector3, tip: THREE.Vector3): void {
    const o = slot * 6;
    this.positions[o] = base.x;
    this.positions[o + 1] = base.y;
    this.positions[o + 2] = base.z;
    this.positions[o + 3] = tip.x;
    this.positions[o + 4] = tip.y;
    this.positions[o + 5] = tip.z;
  }

  /**
   * Fade each sample by age. The strip is indexed in fixed slot order, so the
   * seam between newest and oldest slot must be forced to zero alpha or the
   * ribbon draws a stray sheet across the room.
   */
  private refreshAlphas(): void {
    for (let i = 0; i < SEGMENTS; i++) {
      let age = (this.head - i + SEGMENTS) % SEGMENTS;
      let a = age >= this.filled ? 0 : 1 - age / SEGMENTS;
      if (i === (this.head + 1) % SEGMENTS) a = 0;  // the seam
      this.alphas[i * 2] = a;
      this.alphas[i * 2 + 1] = a;
    }
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  clear(): void {
    this.filled = 0;
    this.alphas.fill(0);
    (this.mesh.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}
