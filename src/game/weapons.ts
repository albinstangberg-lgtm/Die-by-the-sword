import * as THREE from "three";

/**
 * What is in the hand.
 *
 * A weapon is not a damage number. It is a set of rigid parts with real masses
 * at real distances from the hand, and almost everything that distinguishes an
 * axe from a spear falls out of that:
 *
 *   - An axe carries 2.7kg a metre from the hand. Its moment of inertia is
 *     enormous, so it is slow to start, slow to stop, and once it is moving
 *     the arm's torque budget cannot redirect it. You commit to an axe swing
 *     whether you meant to or not.
 *   - A spear weighs a kilo and is a metre and a third long. It is no easier
 *     to swing than the axe -- the mass is spread, but it is spread FAR -- so
 *     it is a poor sweeping weapon and a superb thrusting one, which is what
 *     makes reach its whole game.
 *   - A sword sits between the two and is the weapon every number in this
 *     project was tuned against.
 *
 * Four things a weapon declares rather than derives, because they describe the
 * shape of its business end and a mass never can:
 *
 *   `bite`        which of its own axes does the damage. A blade cuts with its
 *                 edge (local +Z); a spear stabs with its point, which is its
 *                 length (local +Y).
 *   `sweetSpot`   where along the weapon the leverage is: a sword's percussion
 *                 point, an axe's head, a spear's last fifteen centimetres.
 *   `minCutSpeed` how fast it has to be moving to do anything.
 *   `sharpness`   how concentrated that bite is, against a sword edge's 1.0.
 *                 This is the one number that decides a thrust is worth
 *                 throwing at all: an edge shears tissue and needs speed to do
 *                 it, while a point parts tissue and goes in at a walking
 *                 pace. Without it a spear thrust arriving at 4 m/s scored two
 *                 points of damage and the goblin was decoration.
 *
 * Everything else -- how hard it is to swing, how far it reaches, how much it
 * drags the arm down, how much weight arrives -- is mass and distance.
 */

/** A rigid piece of the weapon, positioned from the hand along local +Y. */
export interface WeaponPart {
  shape: "box" | "capsule";
  /** Half-extents. For a capsule only `halfThick` (the radius) and `halfLen` apply. */
  halfThick: number;   // local X
  halfLen: number;     // local Y
  halfWidth: number;   // local Z -- for a blade, spine to edge
  /** Centre of the part, measured from the hand. */
  at: number;
  /** Sideways offset, for a head mounted ahead of its haft. */
  atZ?: number;
  mass: number;
}

export interface Weapon {
  readonly name: string;
  /** One line for the bestiary. */
  readonly note: string;
  /** Hand to the start of the business end. */
  readonly grip: number;
  /** Business end: `grip` to the tip. What the sweep traces and `alongBlade` spans. */
  readonly span: number;
  /** Declared total, kg. The live figure can differ -- the panel scales the player's. */
  readonly mass: number;
  /** Which axis does the damage: the edge (local +Z) or the point (local +Y). */
  readonly bite: "edge" | "point";
  /** Below this a hit shoves instead of wounding, m/s. */
  readonly minCutSpeed: number;
  /** Force per unit of contact, against a sword edge's 1.0. */
  readonly sharpness: number;
  readonly parts: WeaponPart[];
  /** Leverage along the weapon, 0 at `grip` and 1 at the tip. */
  sweetSpot(along: number): number;
  /**
   * Where the sweep should trace, in weapon-local space.
   *
   * Usually straight up the middle, but an axe's edge stands proud of its
   * haft and arrives first, so its line follows the edge through the head.
   * Getting this wrong makes a weapon cut from the wrong place by however far
   * its edge is offset.
   */
  samplePoint(t: number, out: THREE.Vector3): THREE.Vector3;
  /** Origin at the hand, +Y down the weapon. `glow` is what the telegraph lights. */
  build(): { group: THREE.Group; glow: THREE.MeshStandardMaterial[] };
}

/** The sword's mass, and so the unit every other weapon's weight is read against. */
export const REFERENCE_MASS = 1.4;

/**
 * How much the weapon itself contributes to a wound, from the mass the solver
 * is already using.
 *
 * Not a stat: this is `bladeMass`, the same kilogram figure that decides how
 * hard the thing is to swing. The square root is because a four-kilo axe is
 * not three times a sword -- past a point you are limited by how much of the
 * blow the body can absorb, not by how much steel arrived.
 */
export function heft(massKg: number): number {
  return Math.sqrt(Math.max(0.05, massKg) / REFERENCE_MASS);
}

/** A weapon's mass properties: centre of mass, and inertia along its principal axes. */
export interface MassProperties {
  com: THREE.Vector3;
  /** Principal moments, kg·m², along the axes of `frame`. */
  principal: THREE.Vector3;
  /** Rotation from the weapon's own axes to its principal ones. */
  frame: THREE.Quaternion;
  /** Moment about the weapon's own length: what twisting it in the hand has to turn. */
  twist: number;
}

/**
 * A weapon's mass properties, worked out here rather than left to Rapier.
 *
 * Rapier combines a body's colliders with the parallel-axis term the wrong
 * way round: it adds m(|d|² + d dᵀ) where the theorem says m(|d|² − d dᵀ),
 * so two parts offset ALONG an axis give the body inertia ABOUT that axis
 * that no rod has. Measured, the spear -- a shaft and a head, both on its
 * centre line -- came out 0.265 kg·m² about its own length against a true
 * 0.00015: as hard to roll in the hand as it is to swing end over end. The
 * axe, shaft and offset head, the same. A single-part sword is untouched,
 * which is why nothing noticed until the weapon could turn in the grip.
 *
 * So the weapon's colliders carry no mass of their own, and the body is given
 * this: each part's own inertia from its shape, moved to the common centre of
 * mass the right way, and diagonalised. Parts sit on the weapon's Y-Z plane,
 * so X is always a principal axis and only the Y-Z block needs turning.
 * `total` rescales the declared part masses, preserving their distribution.
 */
export function weaponMassProperties(weapon: Weapon, total = weapon.mass): MassProperties {
  const scale = total / weapon.mass;
  const com = new THREE.Vector3();
  for (const p of weapon.parts) com.add(new THREE.Vector3(0, p.at, p.atZ ?? 0).multiplyScalar(p.mass * scale));
  com.multiplyScalar(1 / total);

  let xx = 0, yy = 0, zz = 0, yz = 0;
  for (const p of weapon.parts) {
    const m = p.mass * scale;
    const own = partInertia(p, m);
    const dy = p.at - com.y;
    const dz = (p.atZ ?? 0) - com.z;
    // Parallel axis: m(|d|² E − d dᵀ), for d = (0, dy, dz).
    xx += own.x + m * (dy * dy + dz * dz);
    yy += own.y + m * dz * dz;
    zz += own.z + m * dy * dy;
    yz += -m * dy * dz;
  }

  // Turn the Y-Z block onto its principal axes: a rotation about X, kept
  // within an eighth of a turn so the weapon's length stays the Y axis --
  // any order of moments is valid, but this is the one that reads.
  const phi = Math.abs(yy - zz) < 1e-12
    ? Math.sign(yz) * Math.PI / 4
    : 0.5 * Math.atan((2 * yz) / (yy - zz));
  const c = Math.cos(phi), s = Math.sin(phi);
  const y1 = yy * c * c + 2 * yz * s * c + zz * s * s;
  const z1 = yy * s * s - 2 * yz * s * c + zz * c * c;
  return {
    com,
    principal: new THREE.Vector3(xx, y1, z1),
    frame: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), phi),
    // A twist turns the weapon about the line through the HAND, not through
    // its own centre, and an axe's head holds that centre off the line.
    twist: yy + total * (com.x * com.x + com.z * com.z),
  };
}

/**
 * One part's inertia about its own centre, along the weapon's axes -- the
 * same shapes the colliders are: a box of these half-extents, or a capsule of
 * this radius whose cylinder is as long as the collider built from it.
 */
function partInertia(p: WeaponPart, m: number): THREE.Vector3 {
  if (p.shape === "box") {
    const x = p.halfThick, y = p.halfLen, z = p.halfWidth;
    return new THREE.Vector3(m * (y * y + z * z) / 3, m * (x * x + z * z) / 3, m * (x * x + y * y) / 3);
  }
  // A cylinder and two hemispherical caps, sharing the mass by volume.
  const r = p.halfThick;
  const h = Math.max(0.005, p.halfLen - p.halfThick);
  const cyl = Math.PI * r * r * 2 * h;
  const caps = (4 / 3) * Math.PI * r * r * r;
  const mc = (m * cyl) / (cyl + caps);
  const ms = m - mc;
  const axial = mc * r * r / 2 + ms * 2 * r * r / 5;
  // Each cap's own moment across the axis is 83/320 m r², and its centre sits
  // 3r/8 beyond the end of the cylinder.
  const across = mc * (3 * r * r + 4 * h * h) / 12
    + ms * (83 * r * r) / 320
    + ms * (h + 3 * r / 8) ** 2;
  return new THREE.Vector3(across, axial, across);
}

// -----------------------------------------------------------------------------

const STEEL = () => new THREE.MeshStandardMaterial({
  color: 0xc3cad2, roughness: 0.28, metalness: 0.88,
});
const EDGE = () => new THREE.MeshStandardMaterial({
  color: 0xf2f6fa, roughness: 0.12, metalness: 0.95,
});
const LEATHER = () => new THREE.MeshStandardMaterial({ color: 0x3a2b22, roughness: 0.9 });
const BRASS = () => new THREE.MeshStandardMaterial({
  color: 0x9a7b3f, roughness: 0.4, metalness: 0.8,
});
const ASH = () => new THREE.MeshStandardMaterial({ color: 0x6d5636, roughness: 0.85 });
const IRON = () => new THREE.MeshStandardMaterial({
  color: 0x8e9299, roughness: 0.45, metalness: 0.7,
});

/** Straight up the weapon's own axis. */
function straightLine(grip: number, span: number) {
  return (t: number, out: THREE.Vector3) => out.set(0, grip + span * t, 0);
}

// --- the sword ---------------------------------------------------------------

const SWORD_GRIP = 0.11;
const SWORD_SPAN = 0.86;
const SWORD_HALF_WIDTH = 0.019;   // along local Z -- the EDGE axis
const SWORD_HALF_THICK = 0.0048;  // along local X -- the flat

/**
 * An arming sword. The reference weapon: every gain, clamp and joint integrity
 * in this project was measured against this exact object.
 *
 * Its leverage peaks about two thirds down, where a real blade's percussion
 * point sits. The hilt does nothing and the last few centimetres have speed
 * but no mass behind them.
 */
export const SWORD: Weapon = {
  name: "sword",
  note: "even in the hand, cuts along two thirds of its length",
  grip: SWORD_GRIP,
  span: SWORD_SPAN,
  mass: REFERENCE_MASS,
  bite: "edge",
  minCutSpeed: 2.0,
  sharpness: 1,
  parts: [{
    shape: "box",
    halfThick: SWORD_HALF_THICK,
    halfLen: SWORD_SPAN / 2,
    halfWidth: SWORD_HALF_WIDTH,
    at: SWORD_GRIP + SWORD_SPAN / 2,
    mass: REFERENCE_MASS,
  }],
  sweetSpot(along) {
    if (along < 0.12) return 0;
    const x = (along - 0.12) / 0.88;
    return Math.max(0, 1 - ((x - 0.72) / 0.6) ** 2);
  },
  samplePoint: straightLine(SWORD_GRIP, SWORD_SPAN),
  build() {
    const g = new THREE.Group();
    const steel = STEEL();
    const edge = EDGE();

    const mid = SWORD_GRIP + SWORD_SPAN / 2;
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(SWORD_HALF_THICK * 2, SWORD_SPAN, SWORD_HALF_WIDTH * 2), steel,
    );
    blade.position.y = mid;
    blade.castShadow = true;
    g.add(blade);

    // Bright slivers on the two cutting edges. Purely visual, but they let you
    // read the blade's roll at a glance -- which matters, because roll decides
    // whether a hit cuts or slaps.
    for (const sz of [-1, 1]) {
      const e = new THREE.Mesh(
        new THREE.BoxGeometry(SWORD_HALF_THICK * 2.1, SWORD_SPAN, 0.003), edge,
      );
      e.position.set(0, mid, sz * SWORD_HALF_WIDTH);
      g.add(e);
    }

    const brass = BRASS();
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.19), brass);
    guard.position.y = SWORD_GRIP;
    guard.castShadow = true;
    g.add(guard);

    const grip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.017, 0.019, SWORD_GRIP, 10), LEATHER());
    grip.position.y = SWORD_GRIP / 2;
    g.add(grip);

    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), brass));

    return { group: g, glow: [steel, edge] };
  },
};

// --- the axe -----------------------------------------------------------------

const AXE_GRIP = 0.06;
const AXE_HAFT_END = 0.92;
const AXE_HEAD_LEN = 0.21;
const AXE_TIP = AXE_HAFT_END + AXE_HEAD_LEN * 0.4;   // 1.004
const AXE_SPAN = AXE_TIP - AXE_GRIP;
/** How far the edge stands proud of the haft. The whole reason it bites. */
const AXE_EDGE_OUT = 0.085;
/** Where along the weapon the head starts. */
const AXE_HEAD_FROM = (AXE_HAFT_END - AXE_HEAD_LEN * 0.6 - AXE_GRIP) / AXE_SPAN;

/**
 * A bearded axe on a metre of ash.
 *
 * Nearly three quarters of its weight sits in the last twenty centimetres, a
 * metre from the hand, which is what makes it an axe rather than a heavy
 * sword: the same arm that whips a sword around can barely change an axe's
 * mind once it is moving. Catch someone with the head and it goes through
 * them; catch them with the haft and you have hit them with a stick.
 */
export const AXE: Weapon = {
  name: "axe",
  note: "all its weight a metre out — commits you to every swing",
  grip: AXE_GRIP,
  span: AXE_SPAN,
  mass: 3.65,
  bite: "edge",
  // An edge on that much mass still has to be travelling to open anything, and
  // the axe is rarely travelling slowly.
  minCutSpeed: 2.2,
  // A broad edge spreads the blow over more of the wound than a sword's does.
  // It hardly matters: the axe gets it all back and more in heft.
  sharpness: 0.85,
  parts: [
    {
      shape: "capsule", halfThick: 0.021, halfLen: AXE_HAFT_END / 2, halfWidth: 0.021,
      at: AXE_HAFT_END / 2, mass: 0.95,
    },
    {
      shape: "box", halfThick: 0.018, halfLen: AXE_HEAD_LEN / 2, halfWidth: AXE_EDGE_OUT / 2,
      at: AXE_HAFT_END - AXE_HEAD_LEN * 0.1, atZ: AXE_EDGE_OUT / 2, mass: 2.7,
    },
  ],
  sweetSpot(along) {
    // Only the head does anything, and it does a great deal.
    return Math.max(0, 1 - ((along - 0.94) / 0.21) ** 2);
  },
  samplePoint(t, out) {
    const y = AXE_GRIP + AXE_SPAN * t;
    // Along the haft until the head, then out along the leading edge -- which
    // arrives first and is what actually meets the target.
    const lead = t <= AXE_HEAD_FROM
      ? 0
      : ((t - AXE_HEAD_FROM) / (1 - AXE_HEAD_FROM)) * AXE_EDGE_OUT;
    return out.set(0, y, lead);
  },
  build() {
    const g = new THREE.Group();
    const iron = IRON();
    const edge = EDGE();

    const haft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.019, 0.023, AXE_HAFT_END, 8), ASH());
    haft.position.y = AXE_HAFT_END / 2;
    haft.castShadow = true;
    g.add(haft);

    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.036, AXE_HEAD_LEN, AXE_EDGE_OUT), iron);
    head.position.set(0, AXE_HAFT_END - AXE_HEAD_LEN * 0.1, AXE_EDGE_OUT / 2);
    head.castShadow = true;
    g.add(head);

    // The bit: a thin bright wedge on the leading face, so which way the axe
    // is facing is readable from across the room.
    const bit = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, AXE_HEAD_LEN * 1.18, 0.016), edge);
    bit.position.set(0, AXE_HAFT_END - AXE_HEAD_LEN * 0.1, AXE_EDGE_OUT);
    g.add(bit);

    // A spike on the back, purely so the silhouette is not a rectangle.
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.09, 6), iron);
    spike.position.set(0, AXE_HAFT_END - AXE_HEAD_LEN * 0.1, -0.05);
    spike.rotation.x = Math.PI / 2;
    g.add(spike);

    const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.03, 8), IRON());
    g.add(butt);

    return { group: g, glow: [iron, edge] };
  },
};

// --- the spear ---------------------------------------------------------------

const SPEAR_GRIP = 0.06;
/** How much shaft hangs out BEHIND the hand. A spear is held choked up. */
const SPEAR_BUTT = 0.36;
const SPEAR_SHAFT_END = 1.00;
const SPEAR_HEAD_LEN = 0.17;
const SPEAR_TIP = SPEAR_SHAFT_END + SPEAR_HEAD_LEN;
const SPEAR_SPAN = SPEAR_TIP - SPEAR_GRIP;
const SPEAR_SHAFT_LEN = SPEAR_SHAFT_END + SPEAR_BUTT;

/**
 * A goblin's spear: a metre and a half of ash with an iron leaf on the end.
 *
 * Held CHOKED UP, a third of a metre from the butt, which is how a spear is
 * actually held and the only reason a 32kg goblin can aim one. Gripped at the
 * end it has a moment of inertia of about 0.9 kg.m^2 -- more than the orc's
 * axe -- and the goblin's arm has a fifth of the orc's torque to steer it
 * with, so every thrust wobbled off line and landed flat. The butt behind the
 * hand balances the head in front of it and brings that down by a third: the
 * shaft goes where it is pointed.
 *
 * Swung side on it is still a broom handle. Driven straight down its own
 * length it is the most dangerous thing in the room, and it arrives from
 * twenty centimetres outside anyone else's reach.
 *
 * Its `bite` is its point rather than an edge, so the alignment term measures
 * how squarely the shaft went in rather than how well an edge was rolled. That
 * is the same rule as a sword, applied to the axis that does the work.
 */
export const SPEAR: Weapon = {
  name: "spear",
  note: "reaches past anyone else, and only straight ahead",
  grip: SPEAR_GRIP,
  span: SPEAR_SPAN,
  mass: 1.05,
  bite: "point",
  // A point concentrates a small force into a few square millimetres, so it
  // opens a wound at a speed an edge would only bruise at.
  minCutSpeed: 1.4,
  // And it is the one weapon here that does not need a swing behind it. A
  // thrust that lands is worth three times the same energy spread along an edge.
  sharpness: 3.2,
  parts: [
    {
      shape: "capsule", halfThick: 0.017, halfLen: SPEAR_SHAFT_LEN / 2, halfWidth: 0.017,
      at: (SPEAR_SHAFT_END - SPEAR_BUTT) / 2, mass: 0.72,
    },
    {
      shape: "box", halfThick: 0.007, halfLen: SPEAR_HEAD_LEN / 2, halfWidth: 0.022,
      at: SPEAR_SHAFT_END + SPEAR_HEAD_LEN / 2, mass: 0.33,
    },
  ],
  sweetSpot(along) {
    // The last fifteen centimetres, and nothing else.
    return Math.max(0, 1 - ((along - 0.98) / 0.15) ** 2);
  },
  samplePoint: straightLine(SPEAR_GRIP, SPEAR_SPAN),
  build() {
    const g = new THREE.Group();
    const iron = IRON();
    const edge = EDGE();

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.018, SPEAR_SHAFT_LEN, 7), ASH());
    shaft.position.y = (SPEAR_SHAFT_END - SPEAR_BUTT) / 2;
    shaft.castShadow = true;
    g.add(shaft);

    const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.07, 7), iron);
    socket.position.y = SPEAR_SHAFT_END + 0.01;
    g.add(socket);

    // A flattened four-sided cone reads as a leaf blade from any angle.
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.034, SPEAR_HEAD_LEN, 4), edge);
    head.position.y = SPEAR_SHAFT_END + SPEAR_HEAD_LEN / 2;
    head.scale.z = 0.34;
    head.castShadow = true;
    g.add(head);

    // Leather where the hand actually sits, so the grip point is readable.
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.14, 7), LEATHER());
    g.add(grip);
    const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 7), iron);
    butt.position.y = -SPEAR_BUTT;
    g.add(butt);

    return { group: g, glow: [iron, edge] };
  },
};

export const WEAPONS = { sword: SWORD, axe: AXE, spear: SPEAR } as const;
