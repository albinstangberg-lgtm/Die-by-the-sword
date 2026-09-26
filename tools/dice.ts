/**
 * The harness's dice.
 *
 * The game rolls `Math.random()` for the AI's every choice, the way a body
 * falls when it dies and the spin of a severed limb, and a check that follows
 * a fight starts from wherever the fight left things. With real dice the same
 * code failed one check on one run and four on the next. Here `Math.random` is
 * a seeded generator instead, so every run with the same seed is the same run:
 *
 *   SMOKE_SEED=7 npm run smoke
 *
 * This is its own module, imported first by smoke.ts, because a module's
 * imports are all evaluated before its own body runs: three.js rolls dice as it
 * loads (four for the uuid of every object it makes), and so could the game.
 *
 * Only the harness is seeded. The game keeps the real dice.
 */

/**
 * The seed a plain `npm run smoke` rolls with, picked because every check
 * passed on it. Every rule should pass on every seed, but a tendency (see
 * smoke.ts) can miss on some, so a change that deals different dice can turn
 * one over on this seed without having broken anything: `npm run smoke:seeds`
 * says whether it did. One that misses here but no more often without the
 * change stops nothing; move this seed only if one keeps doing so.
 */
const DEFAULT_SEED = 2;

export const SEED = seedFrom(process.env.SMOKE_SEED);

function seedFrom(text: string | undefined): number {
  if (text === undefined || text === "") return DEFAULT_SEED;
  if (!/^\d+$/.test(text) || Number(text) > 0xffffffff) {
    throw new Error(`SMOKE_SEED must be a whole number from 0 to ${0xffffffff}, not "${text}"`);
  }
  return Number(text);
}

let state = 0;

/** mulberry32: 32 bits of state, and a number in [0, 1) from each step of it. */
function roll(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Start the dice again from the seed and a name. Each group of checks rolls
 * its own, so adding, dropping or moving a group changes nothing another group
 * rolls.
 */
export function reseed(name: string): void {
  // FNV-1a over the name, starting from the seed.
  let h = (0x811c9dc5 ^ SEED) >>> 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  state = h | 0;
}

reseed("");
Math.random = roll;
