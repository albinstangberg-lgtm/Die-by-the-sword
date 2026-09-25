import * as THREE from "three";

/**
 * A round shield, strapped to the off forearm -- or slung on the back.
 *
 * Like a weapon it is not a stat. It is a disc of wood with an iron rim and a
 * boss, with a mass the off arm has to hold up and swing about, and a shape a
 * blade has to get round. It collides with blades the way another blade does
 * -- membership of its owner's weapon group, see `Side.shieldFilter` -- so a
 * cut that meets it is stopped by the solver like a parry, and is never taken
 * for flesh. It does no damage and takes none. What it cannot do
 * is make a blow weigh less: the momentum still arrives, through the arm.
 *
 * On the back it rides the chest, and it still stops blades -- the ones that
 * come from behind (see `OffArm.hangOnBack`). What it buys there is the
 * other hand.
 *
 * Every length here is at human scale and multiplied by the build's.
 */
export const SHIELD = {
  name: "shield",
  /** Radius of the face, metres. Wide enough to cover a chest, no wider. */
  radius: 0.3,
  /** Thickness of the boards. */
  thick: 0.024,
  /** Kilograms of wood and iron: a real round shield's weight. */
  mass: 3.2,
  /**
   * Where the boss sits along the forearm, from its middle toward the hand,
   * metres. A shield is held by a grip behind the boss and a strap near the
   * elbow, so its centre sits a little toward the hand.
   */
  along: 0.04,
} as const;

/**
 * Where a shield rides slung on the back, in the chest's own frame -- the
 * scabbard's: +X the sword side, +Y up from the waist pivot, +Z out of the
 * back -- metres at human scale, face out. Across the shoulder blades and low
 * enough that the sword's hilt stands clear over its rim, and far enough out
 * to lie over the scabbard rather than through it. Up and across go with a
 * body's length, and out with its thickness, as the back it lies on does.
 */
export const SLUNG = new THREE.Vector3(0, 0.2, 0.195);
/** Face out of the back: the mesh's +Y turned onto the chest's +Z. */
export const SLUNG_TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

const WOOD = () => new THREE.MeshStandardMaterial({ color: 0x6e4b2d, roughness: 0.86 });
const PAINT = () => new THREE.MeshStandardMaterial({ color: 0x7a2a22, roughness: 0.8 });
const IRON = () => new THREE.MeshStandardMaterial({
  color: 0x8e9299, roughness: 0.45, metalness: 0.7,
});

/**
 * The shield as a mesh: its face is the +Y side, centred on the origin, so
 * the collider it stands in for -- a cylinder about Y -- lines up with it.
 */
export function buildShieldMesh(scale = 1): THREE.Group {
  const g = new THREE.Group();
  const r = SHIELD.radius * scale;
  const t = SHIELD.thick * scale;

  const boards = new THREE.Mesh(new THREE.CylinderGeometry(r, r, t, 28), WOOD());
  boards.castShadow = true;
  g.add(boards);

  // A painted face, so which way the shield faces reads across a room.
  const face = new THREE.Mesh(new THREE.CircleGeometry(r * 0.94, 28), PAINT());
  face.rotation.x = -Math.PI / 2;
  face.position.y = t / 2 + 0.001;
  g.add(face);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(r, t * 0.55, 6, 32), IRON());
  rim.rotation.x = Math.PI / 2;
  g.add(rim);

  const boss = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.24, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), IRON());
  boss.position.y = t / 2;
  boss.castShadow = true;
  g.add(boss);

  return g;
}
