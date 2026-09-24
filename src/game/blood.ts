import * as THREE from "three";

/**
 * Blood.
 *
 * A cut that takes a limb off used to be a joint quietly leaving the world:
 * the piece dropped, a dark disc appeared on the cut face, and that was the
 * whole of it. The measurement was right and the moment read as nothing. This
 * is the moment -- a burst of droplets thrown along the blade's travel, and
 * two cut faces that go on emptying for a second and a half afterwards.
 *
 * It is a pool, not an allocator: a fixed number of droplets, reused oldest
 * first, drawn in one draw call. A droplet is a point sprite with its own
 * size, colour and fade, which is the one thing `THREE.PointsMaterial` cannot
 * do -- hence the eight lines of shader.
 *
 * Nothing here touches the physics. Blood does not collide, it is not a body,
 * and a droplet landing on the floor is a number going to zero.
 */

/** Droplets in the pool. A sever spends about a third of it. */
const MAX = 480;

/** Seconds a cut face keeps bleeding after the joint parts. */
const BLEED_TIME = 1.6;
/** Droplets per second from a fresh stump, decaying to nothing over that time. */
const BLEED_RATE = 46;

/** Slightly above the floor, so a landed droplet is not z-fighting with it. */
const FLOOR_Y = 0.016;

const DRAG = 0.9;
const GRAVITY = 9.81;

/** Arterial. Darker for the practice dummy, which is stuffed with rags. */
export const BLOOD = 0x9e1508;
export const DUMMY_BLOOD = 0x7a1a12;

/** One cut face, as a local point on something the Interpolator already moves. */
export interface WoundEnd {
  object: THREE.Object3D;
  local: THREE.Vector3;
}

/** Everything a spray needs to know about a joint coming apart. */
export interface Wound {
  /** Where the blade crossed. */
  at: THREE.Vector3;
  /** How the blade was travelling, so the spray follows the cut. */
  along: THREE.Vector3;
  /** The piece that fell and the stump it left. Both keep bleeding. */
  ends?: readonly WoundEnd[];
  tint?: number;
}

interface Stump extends WoundEnd {
  left: number;
  tint: THREE.Color;
  /** Fractional droplets carried between steps, so a low rate still emits. */
  carry: number;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aFade;
  attribute vec3 aTint;
  varying float vFade;
  varying vec3 vTint;
  void main() {
    vFade = aFade;
    vTint = aTint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (320.0 / max(0.05, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vFade;
  varying vec3 vTint;
  void main() {
    if (vFade <= 0.0) discard;
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    gl_FragColor = vec4(vTint, vFade * smoothstep(0.25, 0.08, r2));
    // The scene is tone-mapped and written out in sRGB. A custom shader is
    // not given either for free, and without them the droplets come out as
    // flat, too-bright stickers against a graded room.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Blood {
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly tint = new Float32Array(MAX * 3);
  private readonly size = new Float32Array(MAX);
  private readonly fade = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly span = new Float32Array(MAX);
  private next = 0;
  /** Whether anything is in flight. Cleared once the last droplet has gone. */
  private busy = false;

  private readonly geom = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private readonly stumps: Stump[] = [];

  private readonly _colour = new THREE.Color();
  private readonly _dir = new THREE.Vector3();
  private readonly _at = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geom.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.geom.setAttribute("aFade", new THREE.BufferAttribute(this.fade, 1));
    this.geom.setAttribute("aTint", new THREE.BufferAttribute(this.tint, 3));
    this.geom.setDrawRange(0, MAX);

    this.points = new THREE.Points(this.geom, new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  /**
   * A cut that did not come apart.
   *
   * `strength` is the damage the hit actually did, normalised: a flat slap
   * produces nothing, a clean cut produces a visible spray, and the heaviest
   * blows in the game three times that, thrown further. Tying it to the
   * damage rather than to the contact means the blood agrees with the number
   * in the HUD, which is the whole reason to draw it.
   */
  spray(at: THREE.Vector3, along: THREE.Vector3, strength: number, tint = BLOOD): void {
    const s = clamp01(strength);
    if (s <= 0.02) return;
    this.emit(at, along, Math.round(2 + s * 34), 0.8 + Math.sqrt(s) * 2.9, tint, 1 + s * 0.3);
  }

  /** A joint parting: a hard burst, and cut faces that go on emptying. */
  wound(w: Wound): void {
    const tint = w.tint ?? BLOOD;
    this.emit(w.at, w.along, 42, 3.4, tint, 1.25);
    for (const end of w.ends ?? []) {
      this.stumps.push({
        object: end.object,
        local: end.local.clone(),
        left: BLEED_TIME,
        tint: new THREE.Color(tint),
        carry: 0,
      });
    }
  }

  /**
   * Throw `count` droplets from a point, mostly along `along`.
   *
   * Mostly, not exactly: a cut sprays in a cone, and a spray that all goes one
   * way reads as a jet of paint. The upward bias is what makes it arc and
   * fall rather than simply travel.
   */
  private emit(
    at: THREE.Vector3, along: THREE.Vector3, count: number,
    speed: number, tint: number, scale: number,
  ): void {
    this._dir.copy(along);
    if (this._dir.lengthSq() < 1e-6) this._dir.set(0, 1, 0);
    this._dir.normalize();
    this._colour.set(tint);

    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;

      const spread = 0.75;
      const vx = this._dir.x + (Math.random() - 0.5) * spread;
      const vy = this._dir.y + (Math.random() - 0.5) * spread + 0.55;
      const vz = this._dir.z + (Math.random() - 0.5) * spread;
      const v = speed * (0.35 + Math.random() * 0.9);

      this.pos[i * 3] = at.x;
      this.pos[i * 3 + 1] = at.y;
      this.pos[i * 3 + 2] = at.z;
      this.vel[i * 3] = vx * v;
      this.vel[i * 3 + 1] = vy * v;
      this.vel[i * 3 + 2] = vz * v;
      this.tint[i * 3] = this._colour.r;
      this.tint[i * 3 + 1] = this._colour.g;
      this.tint[i * 3 + 2] = this._colour.b;
      this.busy = true;
      this.size[i] = (0.016 + Math.random() * 0.03) * scale;
      this.span[i] = 0.8 + Math.random() * 1.1;
      this.life[i] = this.span[i];
      this.fade[i] = 1;
    }
  }

  /** One fixed step of falling. */
  update(dt: number): void {
    for (const stump of this.stumps) this.bleed(stump, dt);
    for (let i = this.stumps.length - 1; i >= 0; i--) {
      if (this.stumps[i].left <= 0) this.stumps.splice(i, 1);
    }

    // Most of the time nothing has bled for a while, and re-uploading a pool
    // of zeroes every step is work for nobody.
    if (!this.busy) return;
    this.busy = false;

    const damp = Math.max(0, 1 - DRAG * dt);
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.fade[i] = 0;
        continue;
      }
      this.busy = true;
      this.life[i] -= dt;

      const o = i * 3;
      if (this.pos[o + 1] > FLOOR_Y) {
        this.vel[o] *= damp;
        this.vel[o + 1] = this.vel[o + 1] * damp - GRAVITY * dt;
        this.vel[o + 2] *= damp;
        this.pos[o] += this.vel[o] * dt;
        this.pos[o + 1] += this.vel[o + 1] * dt;
        this.pos[o + 2] += this.vel[o + 2] * dt;
        // Landed. It stops where it hit and soaks away rather than rolling.
        if (this.pos[o + 1] <= FLOOR_Y) {
          this.pos[o + 1] = FLOOR_Y;
          this.vel[o] = 0;
          this.vel[o + 1] = 0;
          this.vel[o + 2] = 0;
          this.life[i] = Math.min(this.life[i], 0.45);
          this.span[i] = 0.45;
        }
      }

      this.fade[i] = clamp01(this.life[i] / Math.max(0.05, this.span[i]));
    }

    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.aFade.needsUpdate = true;
    this.geom.attributes.aSize.needsUpdate = true;
    this.geom.attributes.aTint.needsUpdate = true;
  }

  /**
   * A stump emptying.
   *
   * The point is read off the object's world matrix every step, so a severed
   * arm bleeds all the way to the floor and a stump on a fighter who is still
   * walking about bleeds from the shoulder rather than from where the shoulder
   * used to be.
   */
  private bleed(stump: Stump, dt: number): void {
    stump.left -= dt;
    if (stump.left <= 0) return;
    const strength = stump.left / BLEED_TIME;

    stump.carry += BLEED_RATE * strength * strength * dt;
    const count = Math.floor(stump.carry);
    if (count <= 0) return;
    stump.carry -= count;

    this._at.copy(stump.local).applyMatrix4(stump.object.matrixWorld);
    // Straight down, with enough sideways to look like it is being pushed out.
    this._dir.set((Math.random() - 0.5) * 0.5, -1, (Math.random() - 0.5) * 0.5);
    this.emit(this._at, this._dir, count, 1.1, stump.tint.getHex(), 0.9);
  }

  /** Droplets still in flight or drying. The harness counts these. */
  get live(): number {
    let n = 0;
    for (let i = 0; i < MAX; i++) if (this.life[i] > 0) n++;
    return n;
  }

  /** Cut faces still emptying. */
  get bleeding(): number {
    return this.stumps.length;
  }

  /** After a reset: no droplets in mid-air from a fight that no longer happened. */
  clear(): void {
    this.stumps.length = 0;
    this.life.fill(0);
    this.fade.fill(0);
    this.busy = false;
    this.geom.attributes.aFade.needsUpdate = true;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
