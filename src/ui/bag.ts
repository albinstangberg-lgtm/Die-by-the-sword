import type { Combatant } from "../game/combatant";
import { SHIELD_TEXT, SWORD_TEXT, type Kit } from "./hud";

/**
 * The inventory, on B.
 *
 * A list and nothing more: what you have on you, what you carry, numbered,
 * and what the number does -- drink a potion, put a piece of somebody down.
 * The fight does not stop while it is open, and the mouse is still your arm:
 * looking in a pack in the middle of a fight costs what it costs.
 */
export class Bag {
  private readonly root: HTMLElement;
  private lastSig = "";
  private shown = false;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div");
    this.root.id = "bag";
    this.root.className = "overlay hidden";
    parent.appendChild(this.root);
  }

  get open(): boolean {
    return this.shown;
  }

  toggle(): void {
    this.shown = !this.shown;
    this.root.classList.toggle("hidden", !this.shown);
    this.lastSig = "";
  }

  /** Once a frame. Only redrawn when something in it changed. */
  update(who: Combatant, kit: Kit): void {
    if (!this.shown) return;
    const entries = who.inventory.entries();
    const sig = [kit.sword, kit.shield, Math.ceil(kit.healing),
      ...entries.map((e) => `${e.name}:${e.kind === "potion" ? e.count : ""}`)].join("|");
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const lines = entries.map((e, i) => {
      const count = e.kind === "potion" && e.count > 1 ? ` &times;${e.count}` : "";
      const key = i < 9 ? `<kbd>${i + 1}</kbd>` : "<kbd></kbd>";
      return `<li>${key}<span>${e.name}${count}</span><em>${e.verb}</em></li>`;
    }).join("");
    const healing = kit.healing > 0 ? `<p class="note">+${Math.ceil(kit.healing)} health coming</p>` : "";

    this.root.innerHTML = `
      <h2>Inventory</h2>
      <dl>
        <dt>sword</dt><dd>${SWORD_TEXT[kit.sword]}</dd>
        <dt>shield</dt><dd>${SHIELD_TEXT[kit.shield]}</dd>
      </dl>
      ${entries.length ? `<ol>${lines}</ol>` : `<p class="empty">nothing in your pack</p>`}
      ${healing}
      <p class="note">${entries.length ? "1&ndash;9 to use &middot; " : ""}B to close &middot; the fight goes on</p>`;
  }
}
