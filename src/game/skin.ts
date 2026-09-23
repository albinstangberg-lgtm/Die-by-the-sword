import * as THREE from "three";

/**
 * The visible body.
 *
 * What a fighter *is* -- the hull that walks, the capsules a blade finds, the
 * joints that come apart -- does not change here. This module is only what you
 * see. Each capsule is drawn as a tapered shell rather than a sausage, and the
 * gaps between them are filled with joint balls, so the silhouette runs
 * unbroken from shoulder to wrist instead of reading as a bag of parts.
 *
 * The rule from the interpolation finding still holds: every shell built here
 * is either a mesh the Interpolator already places, or a CHILD of one. Nothing
 * in this file gets its own place in the render loop, so nothing here can
 * overwrite an interpolated transform.
 *
 * Shells are solids of revolution -- a profile swept round the limb's own
 * axis. That buys smooth shading, a taper from one end to the other and a
 * little muscle in the middle for the price of one geometry, and it lines up
 * with the collider it stands in for because it is built from the same two
 * numbers the collider is.
 */

/** Profile resolution. Enough to read as round; small enough to be free. */
const CAP_STEPS = 5;
const SHAFT_STEPS = 6;
const RADIAL = 18;

export interface ShellSpec {
  /** Radius at the -Y end, metres. */
  from: number;
  /** Radius at the +Y end. */
  to: number;
  /** End to end, matching the capsule it stands in for. */
  length: number;
  /** Fullness at mid-span: 1 is a straight taper, 1.1 a muscled limb. */
  belly?: number;
  radial?: number;
}

/**
 * A tapered, capped shell, centred on the origin with its axis along Y.
 *
 * Which end is which is the caller's business and it matters: a limb body is
 * built with its local +Y running from the joint DOWN the limb, while the
 * posed legs hang off a pivot with +Y pointing back UP at the hip. Passing
 * `from` and `to` explicitly is what keeps both honest.
 */
export function shellGeometry(spec: ShellSpec): THREE.LatheGeometry {
  const length = Math.max(spec.length, 1e-3);
  const belly = spec.belly ?? 1;
  const half = length / 2;

  // The caps have to fit inside the length. A pelvis is shorter than two of
  // its own radii, and two full hemispheres there would meet and turn inside
  // out, so a squat segment gets squashed caps instead.
  const capA = Math.min(spec.from, half * 0.92);
  const capB = Math.min(spec.to, half * 0.92);
  const yA = -half + capA;
  const yB = half - capB;

  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= CAP_STEPS; i++) {
    const a = (i / CAP_STEPS) * (Math.PI / 2);
    pts.push(new THREE.Vector2(spec.from * Math.sin(a), yA - capA * Math.cos(a)));
  }
  for (let i = 1; i < SHAFT_STEPS; i++) {
    const t = i / SHAFT_STEPS;
    const eased = t * t * (3 - 2 * t);
    const r = (spec.from + (spec.to - spec.from) * eased)
      * (1 + (belly - 1) * Math.sin(Math.PI * t));
    pts.push(new THREE.Vector2(r, yA + (yB - yA) * t));
  }
  for (let i = 0; i <= CAP_STEPS; i++) {
    const a = (i / CAP_STEPS) * (Math.PI / 2);
    pts.push(new THREE.Vector2(spec.to * Math.cos(a), yB + capB * Math.sin(a)));
  }

  return new THREE.LatheGeometry(pts, spec.radial ?? RADIAL);
}

/** A shell as a shadow-casting mesh. */
export function shellMesh(material: THREE.Material, spec: ShellSpec): THREE.Mesh {
  const mesh = new THREE.Mesh(shellGeometry(spec), material);
  mesh.castShadow = true;
  return mesh;
}

/**
 * A ball filling a joint.
 *
 * It belongs to the PROXIMAL side -- shoulder balls on the torso, elbow balls
 * on the upper arm, knees on the thigh -- so that cutting a limb off leaves
 * the rounded joint on the body and a flat cut face on the piece that fell.
 */
export function jointBall(
  radius: number, material: THREE.Material, squash = 1,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), material);
  mesh.scale.set(1, squash, 1);
  mesh.castShadow = true;
  return mesh;
}

/**
 * A hand: a flattened blob at the wrist.
 *
 * Small, because it is scenery -- the weapon turns in a grip at the end of the
 * forearm and the hand is not a body in the simulation at all. Without one the sword grows
 * straight out of a tapered stump, which is the single thing that most gave
 * away that this was a pile of capsules.
 */
export function handMesh(radius: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), material);
  mesh.scale.set(0.82, 1.35, 0.52);
  mesh.castShadow = true;
  return mesh;
}

/** A foot, lying along the limb's forward axis rather than down it. */
export function footMesh(
  radius: number, length: number, material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 4, 10),
    material,
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = true;
  return mesh;
}

/**
 * A head: an egg, wider at the skull than the jaw, with a nose to face by.
 *
 * Drawn a little larger than the ball it stands on, because the collider is
 * sized by mass rather than by looks and a head at that radius reads as sunk
 * into its own shoulders. A centimetre and a half of slop between what you
 * see and what a blade finds is the price, and it is the right way round:
 * the visible head is the generous one.
 */
export function headMesh(
  radius: number, skin: THREE.Material, mark: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();

  const skull = shellMesh(skin, {
    from: radius * 0.78, to: radius * 1.0, length: radius * 2.3, belly: 1.03,
  });
  skull.scale.set(0.95, 1, 0.98);
  skull.position.y = radius * 0.12;
  g.add(skull);

  // The facing marker. A figure at four metres is a silhouette and without
  // this there is no telling which way it is looking, which matters a great
  // deal once it is trying to kill you.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 0.3, radius * 0.8, 10), mark,
  );
  nose.position.set(0, radius * 0.1, -radius * 0.92);
  nose.rotation.x = -Math.PI / 2;
  g.add(nose);

  return g;
}

/** The dark disc left on a cut face, so a limb reads as severed, not dropped. */
const CUT_COLOUR = 0x6d1f19;

export function stumpCap(radius: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.94, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: CUT_COLOUR, roughness: 0.55 }),
  );
}

/** Free a subtree's geometries and materials. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
