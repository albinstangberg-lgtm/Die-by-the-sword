/**
 * The damage model.
 *
 * Stage 2 measured every hit but did nothing with it. This is where those
 * measurements become consequences, and the shape of the function is the whole
 * design: there is no hitbox test, no attack that "is" a light or heavy attack.
 * A swing does damage in proportion to how well it was actually thrown.
 *
 *   damage = (closing speed − threshold) × edge alignment² × sweet spot
 *
 * Each term throws away a different kind of bad swing:
 *
 *   closing speed   a slow blade pushes, it does not cut. Below the threshold
 *                   a hit is a shove no matter how perfectly aimed.
 *   edge alignment  SQUARED, so it is brutal. Turn the blade 45° off and you
 *                   keep a quarter of your damage; turn it 90° and you have
 *                   slapped someone with a steel plank.
 *   sweet spot      the hilt does nothing and the last few centimetres have
 *                   little leverage. The percussion point, about two thirds
 *                   down, does everything.
 *
 * A player cannot game this. The only way to raise the number is to swing
 * faster, with the edge leading, and connect on the right part of the blade —
 * which is to say, to actually cut properly.
 */

export interface CutQuality {
  closingSpeed: number;  // m/s into the surface
  edgeAlign: number;     // 0..1, |dot(edge, contact normal)|
  alongBlade: number;    // 0 at the guard, 1 at the tip
}

/** Below this a hit is a push, not a cut. */
export const MIN_CUT_SPEED = 2.0;

/**
 * Leverage along the blade. Zero across the guard and ricasso, peaking around
 * two thirds down where a real blade's percussion point sits, easing off at
 * the tip where there is speed but no mass behind it.
 */
export function sweetSpot(alongBlade: number): number {
  if (alongBlade < 0.12) return 0;
  const x = (alongBlade - 0.12) / 0.88;
  return Math.max(0, 1 - ((x - 0.72) / 0.6) ** 2);
}

export function cutDamage(q: CutQuality): number {
  if (q.closingSpeed <= MIN_CUT_SPEED) return 0;
  return (q.closingSpeed - MIN_CUT_SPEED)
    * q.edgeAlign * q.edgeAlign
    * sweetSpot(q.alongBlade);
}

/**
 * How much punishment each joint takes before it parts.
 *
 * Tuned against the damage curve above: a clean committed cut lands around
 * 6-12, so a wrist or an elbow goes in one or two good strikes, a shoulder in
 * two or three, and cutting a body in half at the waist takes real commitment.
 */
export const JOINT_INTEGRITY: Record<string, number> = {
  neck: 7,
  waist: 26,
  shoulder: 10,
  elbow: 7,
  hip: 18,
  knee: 12,
};
