import type { Item } from "./items";

/**
 * What a body carries that is not in a hand, on an arm or on its back: the
 * potions it has picked up, and whatever it has cut off somebody else and
 * taken with it. B opens it.
 *
 * It is not a stat sheet and nothing in it does anything by being there. A
 * potion still takes a free hand to drink and still gives its health back
 * over seconds (see `Combatant.drink`); a head is a head, out of the world
 * until it is put down again, in front of you, where it falls to the floor
 * like anything else (see `Items.drop`).
 */

/** One line of it: what, how many, and what using it does. */
export type Entry =
  | { kind: "potion"; name: string; count: number; verb: string }
  | { kind: "remains"; name: string; item: Item; verb: string };

export class Inventory {
  /** Health potions. */
  potions = 0;
  /** Pieces of other bodies, in the order they were taken. */
  readonly remains: Item[] = [];

  /**
   * Everything in it, in the order it is listed and numbered: the potions as
   * one line, then each piece on its own, oldest first.
   */
  entries(): Entry[] {
    const out: Entry[] = [];
    if (this.potions > 0) {
      out.push({ kind: "potion", name: "health potion", count: this.potions, verb: "drink" });
    }
    for (const item of this.remains) out.push({ kind: "remains", name: item.name, item, verb: "drop" });
    return out;
  }

  get empty(): boolean {
    return this.potions === 0 && this.remains.length === 0;
  }

  /** A piece into it. */
  stow(item: Item): void {
    if (!this.remains.includes(item)) this.remains.push(item);
  }

  /** And out again. False if it was not in here. */
  unstow(item: Item): boolean {
    const i = this.remains.indexOf(item);
    if (i < 0) return false;
    this.remains.splice(i, 1);
    return true;
  }

  clear(): void {
    this.potions = 0;
    this.remains.length = 0;
  }
}
