import * as THREE from "three";
import type { Build } from "./anatomy";
import { jointBall, shellMesh } from "./skin";

/**
 * What a creature looks like, past its size and its colours.
 *
 * None of this is anything a blade finds or a joint holds: it is drawn on
 * top of the shells skin.ts lays over the colliders, as children of meshes
 * that are already placed, and it follows them wherever they go -- a head
 * that comes off takes its ears and its helm with it, and a leg bent over a
 * wall takes its boot. Every size here is a share of the part it hangs on,
 * so one look fits a goblin and an orc alike.
 */
export interface Look {
  /** Which face it has, and so what sticks out of it. */
  readonly face: "man" | "orc" | "goblin" | "kobold" | "ogre";
  /** Hair, its colour: a crop on a man, a topknot on anything else. */
  readonly hair?: number;
  /** A steel cap, with a bar down over the nose. */
  readonly helm?: boolean;
  /** What colour its eyes are, and whether they catch the light like an animal's. */
  readonly eyes: number;
  readonly glow?: boolean;
  /**
   * What it wears on its trunk: a tunic belted over breeches, a leather
   * harness over a bare chest, rags, or a hide round its middle and nothing
   * else.
   */
  readonly dress: "tunic" | "harness" | "rags" | "hide";
  /** Boots, or bare feet with claws on them. */
  readonly feet: "boots" | "claws";
  /** Plates on its shoulders. */
  readonly pauldrons?: boolean;
  /** Bracers on its forearms. */
  readonly bracers?: boolean;
  /** Its leather, and its metal. */
  readonly leather: number;
  readonly metal?: number;
  /** A tail, as a share of its height. */
  readonly tail?: number;
  /** A gut, as a share of its chest's radius. */
  readonly belly?: number;
  /** Scales rather than skin. */
  readonly scales?: boolean;
}

/** A man in a tunic and boots: you, and the reference. */
export const MAN_LOOK: Look = {
  face: "man", hair: 0x3b2a1e, eyes: 0x2a2018, dress: "tunic", feet: "boots",
  bracers: true, leather: 0x4a3526,
};

// --- the materials -----------------------------------------------------------

/**
 * One set of materials for a figure, and every one of them in `all`, so the
 * figure can be faded out as one (see `Fighter.setFade`).
 *
 * Each figure has its own, since fading is per figure; the textures under
 * them are shared, built once, and built from numbers rather than a canvas,
 * so the headless harness makes them as happily as a browser does.
 */
export class Wardrobe {
  readonly cloth: THREE.MeshStandardMaterial;
  readonly skin: THREE.MeshStandardMaterial;
  readonly mark: THREE.MeshStandardMaterial;
  /** Darker cloth: belts, breeches under a tunic, the soles of feet. */
  readonly belt: THREE.MeshStandardMaterial;
  readonly leather: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshStandardMaterial;
  readonly hair: THREE.MeshStandardMaterial;
  readonly eye: THREE.MeshStandardMaterial;
  /** Horn, tusk, claw and teeth. */
  readonly bone: THREE.MeshStandardMaterial;
  /** The inside of a mouth, a nostril. */
  readonly dark: THREE.MeshStandardMaterial;
  readonly all: THREE.Material[];

  constructor(palette: { cloth: number; skin: number; mark: number }, readonly look: Look) {
    const tex = textures();
    const skinTex = look.scales ? tex.scales : tex.skin;
    this.cloth = new THREE.MeshStandardMaterial({
      color: palette.cloth, roughness: 0.88, map: tex.weave, bumpMap: tex.weave, bumpScale: 0.6,
    });
    this.skin = new THREE.MeshStandardMaterial({
      color: palette.skin, roughness: look.scales ? 0.5 : 0.66, map: skinTex,
      bumpMap: skinTex, bumpScale: look.scales ? 0.9 : 0.5,
    });
    this.mark = new THREE.MeshStandardMaterial({ color: palette.mark, roughness: 0.6 });
    this.belt = new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.cloth).multiplyScalar(0.55), roughness: 0.7, map: tex.weave,
    });
    this.leather = new THREE.MeshStandardMaterial({
      color: look.leather, roughness: 0.62, map: tex.grain, bumpMap: tex.grain, bumpScale: 0.8,
    });
    this.metal = new THREE.MeshStandardMaterial({
      color: look.metal ?? 0x9aa1a8, roughness: 0.34, metalness: 0.85,
    });
    this.hair = new THREE.MeshStandardMaterial({
      color: look.hair ?? 0x222222, roughness: 0.9, map: tex.weave,
    });
    this.eye = new THREE.MeshStandardMaterial({
      color: look.eyes, roughness: 0.18,
      emissive: look.glow ? new THREE.Color(look.eyes) : new THREE.Color(0),
      emissiveIntensity: look.glow ? 0.9 : 0,
    });
    this.bone = new THREE.MeshStandardMaterial({ color: 0xd8cfb4, roughness: 0.45 });
    this.dark = new THREE.MeshStandardMaterial({ color: 0x2a1512, roughness: 0.8 });
    this.all = [this.cloth, this.skin, this.mark, this.belt, this.leather, this.metal,
      this.hair, this.eye, this.bone, this.dark];
  }

  /** The same, as new materials: for a limb that fades on its own (see `Arm.setFade`). */
  copy(palette: { cloth: number; skin: number; mark: number }): Wardrobe {
    return new Wardrobe(palette, this.look);
  }

  /**
   * Take in something else hung on the figure -- the scabbard on a
   * swordsman's back -- so that it fades with the rest: every material under
   * `root` joins `all`.
   */
  adopt(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mat = (o as THREE.Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        if (!this.all.includes(m)) this.all.push(m);
      }
    });
  }
}

// --- textures ------------------------------------------------------------------

interface Textures {
  skin: THREE.DataTexture;
  scales: THREE.DataTexture;
  weave: THREE.DataTexture;
  grain: THREE.DataTexture;
}

let _textures: Textures | null = null;

/**
 * The four surfaces there are, made once: skin mottled a little, scales,
 * cloth woven, and leather grained. Grey, so they only shade the colour a
 * material already has -- light where it is raised, dark in the creases --
 * and serve as their own bump maps.
 */
function textures(): Textures {
  if (_textures) return _textures;
  const N = 64;
  const noise = tileNoise(N, 4, 11);
  const fine = tileNoise(N, 16, 23);
  _textures = {
    skin: grey(N, (x, y) => 0.9 + 0.07 * noise[y * N + x] + 0.03 * fine[y * N + x], [3, 2]),
    scales: grey(N, (x, y) => scale(x / N, y / N) * 0.2 + 0.78 + 0.04 * fine[y * N + x], [10, 9]),
    weave: grey(N, (x, y) => {
      const u = (x / N) * Math.PI * 2 * 8;
      const v = (y / N) * Math.PI * 2 * 8;
      return 0.84 + 0.08 * Math.sin(u) * Math.sin(v) + 0.06 * fine[y * N + x];
    }, [4, 3]),
    grain: grey(N, (x, y) => 0.82 + 0.1 * fine[y * N + x] + 0.06 * noise[y * N + x], [3, 2]),
  };
  return _textures;
}

/** A grey texture from a shade per texel, 0..1, repeated so many times across a surface. */
function grey(n: number, shade: (x: number, y: number) => number, repeat: [number, number]): THREE.DataTexture {
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = Math.round(255 * Math.min(1, Math.max(0, shade(x, y))));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Smooth value noise that wraps round both ways, `cells` across, -1..1. */
function tileNoise(n: number, cells: number, seed: number): Float32Array {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const lattice = Array.from({ length: cells * cells }, rand);
  const at = (i: number, j: number) => lattice[((j % cells) * cells) + (i % cells)];
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells;
      const fy = (y / n) * cells;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const u = fade(fx - i);
      const v = fade(fy - j);
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
      const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
      out[y * n + x] = a + (b - a) * v;
    }
  }
  return out;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Overlapping scales, in rows each half a scale along from the last: bright
 * where a scale bellies out, dark at the edge it overlaps the next by.
 */
function scale(u: number, v: number): number {
  const rows = 4;
  const across = 4;
  const row = Math.floor(v * rows);
  const off = row % 2 === 0 ? 0 : 0.5;
  const cu = ((u * across + off) % 1) - 0.5;
  const cv = (v * rows) % 1;
  const d = Math.hypot(cu * 1.2, (cv - 0.25) * 0.9);
  return Math.max(0, 1 - d * 1.9) ** 0.7;
}

// --- the head --------------------------------------------------------------------

/**
 * A head: an egg, wider at the skull than the jaw, and a face on the front of
 * it, which is -Z. `radius` is the collider's, and every part here a share of
 * it -- see `headMesh` in skin.ts, which this replaces and whose egg it keeps.
 *
 * The face is also how anything tells which way the figure is looking, at
 * four metres, in bad light: so the brow and the nose, the snout or the tusks
 * stick out, and a monster's eyes catch the light.
 */
export function headFor(radius: number, w: Wardrobe): THREE.Group {
  const look = w.look;
  const r = radius;
  const g = new THREE.Group();
  const add = (m: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
    m.position.set(x * r, y * r, z * r);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const blob = (mat: THREE.Material, size: number, sx: number, sy: number, sz: number) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(size * r, 14, 10), mat);
    m.scale.set(sx, sy, sz);
    return m;
  };
  const horn = (mat: THREE.Material, base: number, length: number) =>
    new THREE.Mesh(new THREE.ConeGeometry(base * r, length * r, 8), mat);

  const broad = { man: 0.93, orc: 1.0, goblin: 0.95, kobold: 0.9, ogre: 1.05 }[look.face];
  const tall = { man: 1, orc: 0.96, goblin: 1, kobold: 0.94, ogre: 0.9 }[look.face];
  const skull = shellMesh(w.skin, { from: r * 0.78, to: r * 1.0, length: r * 2.3, belly: 1.03 });
  skull.scale.set(broad, tall, 0.98);
  skull.position.y = r * 0.12;
  g.add(skull);

  // The eyes, under a brow.
  const eyeSize = { man: 0.1, orc: 0.085, goblin: 0.12, kobold: 0.11, ogre: 0.09 }[look.face];
  const eyeX = { man: 0.3, orc: 0.31, goblin: 0.34, kobold: 0.46, ogre: 0.3 }[look.face];
  const eyeZ = { man: -0.84, orc: -0.86, goblin: -0.84, kobold: -0.66, ogre: -0.87 }[look.face];
  for (const sx of [-1, 1]) {
    const eye = add(blob(w.eye, eyeSize, 1, 0.9, 0.7), sx * eyeX, 0.14, eyeZ);
    eye.castShadow = false;
  }
  const brow = { man: [0.72, 0.1, 0.16], orc: [0.9, 0.17, 0.28], goblin: [0.62, 0.08, 0.14],
    kobold: [0.25, 0.08, 0.15], ogre: [0.78, 0.15, 0.22] }[look.face];
  if (look.face === "kobold") {
    // A ridge over each eye rather than a brow across.
    for (const sx of [-1, 1]) add(blob(w.skin, 0.2, 1.3, 0.45, 0.8), sx * 0.44, 0.3, -0.62);
  } else {
    add(blob(w.skin, 0.5, brow[0] * 2, brow[1] * 2, brow[2] * 2), 0, 0.3, -0.78);
  }

  switch (look.face) {
    case "man": {
      const nose = add(horn(w.skin, 0.14, 0.4), 0, -0.02, -1.0);
      nose.rotation.x = -Math.PI / 2 + 0.35;
      nose.scale.set(1, 1, 0.7);
      add(blob(w.skin, 0.28, 1.25, 0.8, 1), 0, -0.7, -0.52);          // chin
      add(new THREE.Mesh(new THREE.BoxGeometry(0.34 * r, 0.035 * r, 0.05 * r), w.dark), 0, -0.4, -0.88);
      for (const sx of [-1, 1]) add(blob(w.skin, 0.2, 0.45, 1, 0.7), sx * 0.93, 0.05, 0.02);
      break;
    }
    case "orc": {
      add(blob(w.skin, 0.2, 1.4, 0.75, 0.8), 0, -0.02, -0.98);        // a broad flat nose
      add(blob(w.skin, 0.55, 1.3, 0.72, 1), 0, -0.55, -0.42);         // a jaw thrust out
      for (const sx of [-1, 1]) {
        const tusk = add(horn(w.bone, 0.075, 0.36), sx * 0.28, -0.36, -0.9);
        tusk.rotation.z = -sx * 0.22;
        const ear = add(horn(w.skin, 0.15, 0.55), sx * 0.95, 0.18, 0.08);
        ear.rotation.set(0, sx * 0.4, -sx * (Math.PI / 2 - 0.45));
        ear.scale.set(1, 1, 0.45);
      }
      break;
    }
    case "goblin": {
      const nose = add(horn(w.skin, 0.13, 0.72), 0, -0.04, -1.15);
      nose.rotation.x = -Math.PI / 2 + 0.28;
      add(new THREE.Mesh(new THREE.BoxGeometry(0.62 * r, 0.04 * r, 0.06 * r), w.dark), 0, -0.44, -0.8);
      for (const sx of [-1, 1]) {
        const ear = add(horn(w.skin, 0.3, 1.15), sx * 1.15, 0.22, 0.15);
        ear.rotation.set(0, sx * 0.35, -sx * (Math.PI / 2 - 0.22));
        ear.scale.set(1, 1, 0.32);
      }
      break;
    }
    case "kobold": {
      // A snout: a tapering muzzle out of the face, nostrils at the end of it.
      const snout = add(new THREE.Mesh(taper(0.48 * r, 0.26 * r, 1.05 * r, 14), w.skin), 0, -0.2, -0.5);
      snout.rotation.x = -Math.PI / 2 - 0.1;
      snout.scale.set(1, 1, 0.78);
      for (const sx of [-1, 1]) {
        const nostril = add(blob(w.dark, 0.05, 1, 1, 1), sx * 0.1, -0.16, -1.55);
        nostril.castShadow = false;
        // Horns swept back off the crown, standing out behind it.
        const hornM = add(horn(w.bone, 0.11, 0.8), sx * 0.36, 1.1, 0.62);
        hornM.rotation.set(1.1, 0, sx * 0.22);
        // Teeth along the jaw.
        for (let k = 0; k < 3; k++) {
          const tooth = add(horn(w.bone, 0.035, 0.1), sx * 0.24, -0.42, -0.95 - k * 0.17);
          tooth.rotation.x = Math.PI;
        }
        const frill = add(horn(w.skin, 0.12, 0.42), sx * 0.8, 0.2, 0.3);
        frill.rotation.set(0.6, 0, -sx * 1.2);
      }
      add(new THREE.Mesh(new THREE.BoxGeometry(0.5 * r, 0.035 * r, 0.8 * r), w.dark), 0, -0.36, -1.0);
      break;
    }
    case "ogre": {
      add(blob(w.skin, 0.25, 1.4, 0.9, 0.8), 0, -0.06, -0.98);        // a flat wide nose
      add(blob(w.skin, 0.62, 1.45, 0.78, 1.05), 0, -0.62, -0.4);     // an underslung jaw
      add(new THREE.Mesh(new THREE.BoxGeometry(0.7 * r, 0.05 * r, 0.06 * r), w.dark), 0, -0.46, -0.98);
      for (const sx of [-1, 1]) {
        const tusk = add(horn(w.bone, 0.09, 0.3), sx * 0.36, -0.36, -0.98);
        tusk.rotation.z = -sx * 0.15;
        add(blob(w.skin, 0.2, 0.5, 1, 0.75), sx * 1.0, 0.0, 0.05);
      }
      break;
    }
  }

  if (look.helm) {
    // A kettle of steel over the crown, a rim round it, and a bar down over
    // the nose.
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.07, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), w.metal);
    cap.scale.set(broad, 1, 1);
    add(cap, 0, 0.22, 0.02);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 1.06, r * 0.06, 6, 24), w.metal);
    rim.rotation.x = Math.PI / 2;
    rim.scale.set(broad, 1, 1);
    add(rim, 0, 0.18, 0.02);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.11 * r, 0.62 * r, 0.07 * r), w.metal), 0, 0.02, -1.04);
  } else if (look.hair !== undefined) {
    if (look.face === "man") {
      // Cropped: a cap of it over the crown and down the back.
      const crop = new THREE.Mesh(
        new THREE.SphereGeometry(r * 1.03, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), w.hair);
      crop.rotation.x = 0.42;
      crop.scale.set(broad, 1, 1);
      add(crop, 0, 0.16, 0.06);
    } else {
      // A topknot.
      add(blob(w.hair, 0.26, 1, 0.8, 1), 0, 1.14, 0.3);
      const tail = add(horn(w.hair, 0.13, 0.7), 0, 0.9, 0.7);
      tail.rotation.x = 2.2;
    }
  }
  return g;
}

/** A cone with a round end, `r0` at its base and `r1` at its tip, along +Y. */
function taper(r0: number, r1: number, length: number, radial: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(r0, 0)];
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push(new THREE.Vector2(r0 + (r1 - r0) * t, length * t * 0.9));
  }
  for (let i = 1; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r1 * Math.cos(a), length * 0.9 + r1 * Math.sin(a)));
  }
  return new THREE.LatheGeometry(pts, radial);
}

// --- the trunk ---------------------------------------------------------------------

/** What a trunk is dressed in, as the figure needs to build it. */
export interface TrunkWear {
  /** The chest's shell. */
  chest: THREE.MeshStandardMaterial;
  /** The shoulders' balls, the hips' shell and theirs, and the thighs. */
  shoulders: THREE.MeshStandardMaterial;
  hips: THREE.MeshStandardMaterial;
  thighs: THREE.MeshStandardMaterial;
  shins: THREE.MeshStandardMaterial;
}

/** Which material each part of the trunk and legs is made of, for a look. */
export function trunkWear(w: Wardrobe): TrunkWear {
  switch (w.look.dress) {
    case "tunic":
      return { chest: w.cloth, shoulders: w.cloth, hips: w.cloth, thighs: w.belt, shins: w.belt };
    case "harness":
      return { chest: w.skin, shoulders: w.skin, hips: w.belt, thighs: w.belt, shins: w.belt };
    case "rags":
      return { chest: w.cloth, shoulders: w.skin, hips: w.cloth, thighs: w.skin, shins: w.skin };
    case "hide":
      return { chest: w.skin, shoulders: w.skin, hips: w.skin, thighs: w.skin, shins: w.skin };
  }
}

/**
 * What goes over the trunk: a skirt of tunic, rag or hide from the waist,
 * straps crossing a bare chest, a gut, a tail. `chest` is the chest's shell
 * (children of it take its oval section, which is what a strap round it
 * wants); `hips` the hips group, placed in the hull's own frame.
 */
export function dressTrunk(
  build: Build, w: Wardrobe, chest: THREE.Object3D, hips: THREE.Object3D,
  shoulders: THREE.Object3D[],
): void {
  const look = w.look;
  const { segment: SEG, standing: ST } = build;
  const local = build.local;
  const s = build.scale;
  const t = build.scale * build.girth;

  // From the waist down over the hips: a tunic's skirt, rags or a hide.
  const waist = local(ST.waist);
  const hem = local(ST.hip) - 0.09 * s;
  const skirtMat = look.dress === "tunic" ? w.cloth : look.dress === "rags" ? w.cloth : w.leather;
  const jag = look.dress === "tunic" ? 0 : look.dress === "rags" ? 0.05 * s : 0.035 * s;
  const skirt = new THREE.Mesh(
    skirtGeometry(SEG.pelvis.radius * 1.02, SEG.pelvis.radius * 1.3, waist - hem, jag), skirtMat);
  skirt.position.y = hem;
  skirt.scale.set(1.1, 1, 0.95);
  skirt.castShadow = true;
  hips.add(skirt);

  // A belt over the top of it, and a buckle on the front.
  const belt = new THREE.Mesh(
    new THREE.CylinderGeometry(SEG.pelvis.radius * 1.07, SEG.pelvis.radius * 1.07, 0.06 * s, 22),
    look.dress === "hide" ? w.leather : w.belt);
  belt.scale.set(1.1, 1, 0.94);
  belt.position.y = waist;
  belt.castShadow = true;
  hips.add(belt);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.07 * t, 0.055 * s, 0.02 * t), w.metal);
  buckle.position.set(0, waist, -SEG.pelvis.radius * 1.02);
  hips.add(buckle);

  if (look.dress === "tunic") {
    // A hem, and a neck to the tunic, in its trim.
    const trim = new THREE.Mesh(new THREE.TorusGeometry(SEG.pelvis.radius * 1.3, 0.006 * t, 4, 26), w.mark);
    trim.rotation.x = Math.PI / 2;
    trim.scale.set(1.1, 0.95, 1);
    trim.position.y = hem + 0.01 * s;
    hips.add(trim);
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(SEG.torso.radius * 0.5, 0.01 * t, 6, 20), w.belt);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = SEG.torso.length * 0.46;
    chest.add(collar);
  } else if (look.dress === "harness") {
    // Two straps crossing the chest, front and back: bands round the chest's
    // own oval, tipped each way.
    // On the chest's surface, which bellies out to nine tenths of its
    // radius at the middle; a strap any tighter goes under it.
    for (const tip of [-0.6, 0.6]) {
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(SEG.torso.radius * 0.97, 0.022 * t, 5, 32), w.leather);
      band.rotation.set(Math.PI / 2, tip, 0);
      band.position.y = SEG.torso.length * 0.05;
      chest.add(band);
    }
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * t, 0.04 * t, 0.025 * t, 10), w.metal);
    boss.rotation.x = Math.PI / 2;
    boss.position.set(0, SEG.torso.length * 0.05, -SEG.torso.radius * 0.99);
    chest.add(boss);
  } else if (look.dress === "rags") {
    // A rag of a sash over one shoulder.
    const sash = new THREE.Mesh(
      new THREE.TorusGeometry(SEG.torso.radius * 0.84, 0.028 * t, 4, 26), w.belt);
    sash.rotation.set(Math.PI / 2, 0.7, 0);
    sash.position.y = SEG.torso.length * 0.08;
    chest.add(sash);
  }

  if (look.pauldrons) {
    // Plates over the shoulders, on the balls the girdle carries about.
    for (const ball of shoulders) {
      const r = SEG.upperArm.radius * 1.5;
      const plate = new THREE.Mesh(
        new THREE.SphereGeometry(r * 1.25, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), w.metal);
      plate.scale.set(1.15, 0.75, 1.0);
      plate.position.y = r * 0.08;
      plate.rotation.z = Math.sign(ball.position.x) * -0.35;
      plate.castShadow = true;
      ball.add(plate);
    }
  }

  if (look.belly) {
    // A gut, hanging over the belt.
    const r = SEG.torso.radius * look.belly;
    const gut = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), w.skin);
    gut.scale.set(1.12, 0.9, 0.9);
    gut.position.set(0, waist + 0.03 * s, -SEG.torso.radius * 0.42);
    gut.castShadow = true;
    hips.add(gut);
  }

  if (look.tail) {
    // Out of the back of the hips, down and back, and up at the end.
    const len = look.tail * ST.crown;
    const root = new THREE.Vector3(0, local(ST.hip) + 0.05 * s, SEG.pelvis.radius * 0.7);
    const curve = new THREE.CatmullRomCurve3([
      root,
      root.clone().add(new THREE.Vector3(0, -0.18 * len, 0.28 * len)),
      root.clone().add(new THREE.Vector3(0.04 * len, -0.42 * len, 0.58 * len)),
      root.clone().add(new THREE.Vector3(0.1 * len, -0.5 * len, 0.86 * len)),
      root.clone().add(new THREE.Vector3(0.14 * len, -0.36 * len, 1.02 * len)),
    ]);
    const tail = new THREE.Mesh(tube(curve, SEG.pelvis.radius * 0.5, 0.012 * s, 18, 10), w.skin);
    tail.castShadow = true;
    hips.add(tail);
  }
}

/**
 * A skirt: a short open cone from `top` round at the waist to `bottom` round
 * at its hem, `length` long, with some thickness to it, and its hem cut
 * ragged by `jag` if it is rags or a hide. Along +Y from the hem.
 */
function skirtGeometry(top: number, bottom: number, length: number, jag: number): THREE.BufferGeometry {
  const thick = 0.012;
  const pts = [
    new THREE.Vector2(bottom - thick, 0), new THREE.Vector2(bottom, 0),
    new THREE.Vector2(top + (bottom - top) * 0.1, length * 0.9), new THREE.Vector2(top, length),
    new THREE.Vector2(top - thick, length),
  ];
  const radial = 28;
  const geo = new THREE.LatheGeometry(pts, radial);
  if (jag > 0) {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 1e-4) continue;
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      const cut = Math.abs(Math.sin(a * 7)) * jag + Math.abs(Math.sin(a * 3 + 1)) * jag * 0.5;
      pos.setY(i, cut);
    }
    geo.computeVertexNormals();
  }
  return geo;
}

/** A tube along a curve, `r0` round at its start and `r1` at its end, closed at both. */
function tube(
  curve: THREE.Curve<THREE.Vector3>, r0: number, r1: number, segments: number, radial: number,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(segments, false);
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const n = frames.normals[i].clone().multiplyScalar(Math.cos(a))
        .add(frames.binormals[i].clone().multiplyScalar(Math.sin(a)));
      pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, c, b, b, c, d);
    }
  }
  // Caps: a point at each end.
  const start = pos.length / 3;
  curve.getPointAt(0, p);
  pos.push(p.x, p.y, p.z);
  const end = pos.length / 3;
  curve.getPointAt(1, p);
  pos.push(p.x, p.y, p.z);
  for (let j = 0; j < radial; j++) {
    idx.push(start, j, (j + 1) % radial);
    const base = segments * radial;
    idx.push(end, base + ((j + 1) % radial), base + j);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// --- arms and legs -------------------------------------------------------------------

/**
 * Sleeves and bracers on an arm: `upper` and `fore` are its two shells, each
 * built with local +Y running from the joint down the limb, `length` and
 * `radius` the segments'.
 */
export function dressArm(
  w: Wardrobe, upper: THREE.Object3D, fore: THREE.Object3D,
  seg: { upper: { length: number; radius: number }; fore: { length: number; radius: number } },
): void {
  const look = w.look;
  if (look.dress === "tunic") {
    const len = seg.upper.length * 0.55;
    const sleeve = shellMesh(w.cloth, {
      from: seg.upper.radius * 1.2, to: seg.upper.radius * 1.08, length: len, belly: 1.02,
    });
    sleeve.position.y = -seg.upper.length / 2 + len / 2;
    upper.add(sleeve);
  }
  if (look.bracers) {
    const len = seg.fore.length * 0.42;
    const bracer = shellMesh(w.leather, {
      from: seg.fore.radius * 0.92, to: seg.fore.radius * 0.8, length: len, belly: 1.0,
    });
    bracer.position.y = seg.fore.length / 2 - len / 2 - seg.fore.length * 0.04;
    fore.add(bracer);
  } else if (look.dress === "harness") {
    // A band of leather round the arm.
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(seg.upper.radius * 1.02, seg.upper.radius * 0.18, 5, 16), w.leather);
    band.rotation.x = Math.PI / 2;
    band.position.y = seg.upper.length * 0.08;
    upper.add(band);
  }
}

/**
 * A hand: a palm, fingers curled round, a thumb, and claws if it has them.
 * Along +Y from the wrist, the palm toward -Z -- the way the forearm meshes
 * put a hand, whose grip closes round +Y.
 */
export function handFor(radius: number, w: Wardrobe, material: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), material);
  palm.scale.set(0.82, 1.3, 0.55);
  palm.castShadow = true;
  g.add(palm);
  const fingers = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.62, 10, 8), material);
  fingers.scale.set(1.25, 0.9, 1.1);
  fingers.position.set(0, radius * 0.95, -radius * 0.18);
  g.add(fingers);
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(radius * 0.22, radius * 0.55, 3, 8), material);
  thumb.position.set(-radius * 0.62, radius * 0.25, -radius * 0.28);
  thumb.rotation.z = 0.5;
  g.add(thumb);
  if (w.look.feet === "claws") {
    for (let k = -1; k <= 1; k++) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.12, radius * 0.45, 6), w.bone);
      claw.position.set(k * radius * 0.35, radius * 1.45, -radius * 0.3);
      claw.rotation.x = -0.5;
      g.add(claw);
    }
  }
  return g;
}

/**
 * A boot, or a bare clawed foot: on a shin whose shell has local +Y running
 * UP to the knee, `length` and `radius` the shin's. `foot` is the foot mesh
 * the figure already hangs off the shin, lying forward along -Z.
 */
export function dressLeg(
  w: Wardrobe, shin: THREE.Object3D, foot: THREE.Mesh,
  seg: { length: number; radius: number }, scale: number,
): void {
  if (w.look.feet === "boots") {
    const len = seg.length * 0.5;
    const boot = shellMesh(w.leather, {
      from: seg.radius * 0.74, to: seg.radius * 0.98, length: len, belly: 1.02,
    });
    boot.position.y = -seg.length / 2 + len / 2;
    shin.add(boot);
    const cuff = jointBall(seg.radius * 0.99, w.leather, 0.35);
    cuff.position.y = -seg.length / 2 + len;
    shin.add(cuff);
    foot.material = w.leather;
    // A sole, a shade darker.
    const sole = new THREE.Mesh(
      new THREE.BoxGeometry(seg.radius * 1.35, 0.018 * scale, seg.length * 0.52), w.belt);
    sole.position.set(0, -seg.radius * 0.55, 0);
    sole.rotation.x = -Math.PI / 2;
    foot.add(sole);
  } else {
    if (w.look.dress === "hide") {
      // Hide bound round the shin with thongs.
      const len = seg.length * 0.55;
      const wrap = shellMesh(w.leather, {
        from: seg.radius * 0.8, to: seg.radius * 1.02, length: len, belly: 1.06,
      });
      wrap.position.y = -seg.length / 2 + len / 2 + seg.length * 0.06;
      shin.add(wrap);
      for (let k = 0; k < 3; k++) {
        const y = -seg.length / 2 + seg.length * (0.14 + k * 0.16);
        const thong = new THREE.Mesh(
          new THREE.TorusGeometry(seg.radius * (0.86 + k * 0.06), seg.radius * 0.07, 4, 14), w.belt);
        thong.rotation.x = Math.PI / 2 + (k % 2 ? 0.2 : -0.2);
        thong.position.y = y;
        shin.add(thong);
      }
    }
    foot.material = w.skin;
    foot.scale.set(1.05, 1, 0.8);
    for (let k = -1; k <= 1; k++) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(seg.radius * 0.14, seg.radius * 0.55, 6), w.bone);
      // The foot lies along its own Y turned forward (see `footMesh`), so
      // its toe is +Y.
      claw.position.set(k * seg.radius * 0.32, seg.length * 0.27, -seg.radius * 0.1);
      claw.rotation.x = 0.35;
      foot.add(claw);
    }
  }
}
