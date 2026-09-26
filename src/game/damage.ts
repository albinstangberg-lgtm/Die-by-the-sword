import { heft, SWORD, type Weapon } from "./weapons";

/**
 * The damage model.
 *
 * Stage 2 measured every hit but did nothing with it. This is where those
 * measurements become consequences, and the shape of the function is the whole
 * design: there is no hitbox test, no attack that "is" a light or heavy attack.
 * A swing does damage in proportion to how well it was actually thrown.
 *
 *   damage = (closing speed − threshold) × bite alignment² × sweet spot
 *            × heft × sharpness × DAMAGE_PER_MS
 *
 * Each term throws away a different kind of bad swing:
 *
 *   closing speed   a slow blade pushes, it does not cut. Below the threshold
 *                   a hit is a shove no matter how perfectly aimed.
 *   bite alignment  SQUARED, so it is brutal. Turn the blade 45° off and you
 *                   keep a quarter of your damage; turn it 90° and you have
 *                   slapped someone with a steel plank. For a spear the axis
 *                   measured is the point rather than an edge, so the same
 *                   term asks how squarely the thrust went in.
 *   sweet spot      where the leverage is, and it is the weapon's own answer:
 *                   a sword's percussion point two thirds down, an axe's head,
 *                   a spear's last fifteen centimetres.
 *   heft            the square root of the weapon's mass in kilograms, over
 *                   the sword's. Not a stat -- the same kilogram figure the
 *                   solver uses to decide how hard the thing is to swing.
 *   sharpness       how concentrated the bite is. A spear point parts tissue
 *                   where an edge has to shear it, which is why a thrust that
 *                   arrives at walking pace is still worth throwing and a cut
 *                   at the same speed is a shove.
 *
 * A player cannot game this. The only way to raise the number is to swing
 * faster, with the edge leading, and connect on the right part of the weapon —
 * which is to say, to actually cut properly.
 */

export interface CutQuality {
  closingSpeed: number;  // m/s into the surface
  edgeAlign: number;     // 0..1, |dot(bite axis, contact normal)|
  alongBlade: number;    // 0 at the guard, 1 at the tip
  /** What landed it. Its leverage curve and cut threshold are its own. */
  weapon?: Weapon;
  /** Live weapon mass in kg, if it differs from the weapon's declared mass. */
  massKg?: number;
}

/** Below this a hit from the reference sword is a push, not a cut. */
export const MIN_CUT_SPEED = SWORD.minCutSpeed;

/**
 * Points of damage per m/s past the threshold, for a sword's edge dead square
 * at its percussion point.
 *
 * Not 1, because the speeds are honest now. A weapon's speed at a point used
 * to be worked out about its grip, which gave every point of a turning weapon
 * its centre of mass's swing a second time: half as fast again as the blade
 * really went. Every threshold and every sharpness was set against those
 * speeds. Measured about the centre of mass, the same swings did half the
 * damage; this, with each weapon's threshold and sharpness fitted again to
 * the same seven thousand hits on flesh, puts it back -- as many of each
 * weapon's hits get past its threshold as did, and it does as much in all.
 * Not the same hits: a spear's shaft swung round used to outrun its point
 * thrust home, and now it does not, so a spear draws blood more often, and
 * less each time.
 */
export const DAMAGE_PER_MS = 1.47;

/**
 * Leverage along the reference sword: zero across the guard and ricasso,
 * peaking around two thirds down where a real blade's percussion point sits,
 * easing off at the tip where there is speed but no mass behind it.
 */
export function sweetSpot(alongBlade: number): number {
  return SWORD.sweetSpot(alongBlade);
}

export function cutDamage(q: CutQuality): number {
  const weapon = q.weapon ?? SWORD;
  if (q.closingSpeed <= weapon.minCutSpeed) return 0;
  return (q.closingSpeed - weapon.minCutSpeed)
    * q.edgeAlign * q.edgeAlign
    * weapon.sweetSpot(q.alongBlade)
    * heft(q.massKg ?? weapon.mass)
    * weapon.sharpness
    * DAMAGE_PER_MS;
}

/**
 * How much punishment each joint takes before it parts.
 *
 * Tuned against the damage curve above: a clean committed sword cut lands
 * around 6-12, so a wrist or an elbow goes in one or two good strikes, a
 * shoulder in two or three, and cutting a body in half at the waist takes real
 * commitment. A bigger body scales these up with its mass (see Combatant), so
 * an orc's shoulder is not a human's.
 */
export const JOINT_INTEGRITY: Record<string, number> = {
  neck: 7,
  waist: 26,
  shoulder: 10,
  elbow: 7,
  hip: 18,
  knee: 12,
};
