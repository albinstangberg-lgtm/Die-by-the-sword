import type { Item } from "./items";

/**
 * The bag: what a body carries that is not in a hand, on an arm or on its
 * back. B opens it.
 *
 * Potions go straight into it when they are picked up: they are for using.
 * A piece of somebody, or their weapon, is held in the hand when it is picked
 * up, and goes in only when F puts it there; from the bag it comes back out
 * into the hand (see `Items.hold`).
 *
 * It is not a stat sheet and nothing in it does anything by being there. A
 * potion still takes a free hand to drink and still gives its health back
 * over seconds (see `Combatant.drink`); a head is a head, out of the world
 * until it is let go of again.
 */

/** One line of it: what, how many, and what using it does. */
export type Entry =
  | { kind: "potion"; name: string; count: number; verb: string }
  | { kind: "piece"; name: string; item: Item; verb: string };

export class Inventory {
  /** Health potions. */
  potions = 0;
  /** Pieces of other bodies, and their weapons, in the order they were put in. */
  readonly pieces: Item[] = [];

  /**
   * Everything in it, in the order it is listed and numbered: the potions as
   * one line, then each piece on its own, oldest first.
   */
  entries(): Entry[] {
    const out: Entry[] = [];
    if (this.potions > 0) {
      out.push({ kind: "potion", name: "health potion", count: this.potions, verb: "drink" });
    }
    for (const item of this.pieces) out.push({ kind: "piece", name: item.name, item, verb: "hold" });
    return out;
  }

  get empty(): boolean {
    return this.potions === 0 && this.pieces.length === 0;
  }

  /** A piece into it. */
  stow(item: Item): void {
    if (!this.pieces.includes(item)) this.pieces.push(item);
  }

  /** And out again. False if it was not in here. */
  unstow(item: Item): boolean {
    const i = this.pieces.indexOf(item);
    if (i < 0) return false;
    this.pieces.splice(i, 1);
    return true;
  }

  clear(): void {
    this.potions = 0;
    this.pieces.length = 0;
  }
}
