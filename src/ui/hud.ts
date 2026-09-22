import type { ArmState } from "../game/arm";
import type { Impact, Quality } from "../game/impacts";
import type { Dummy, SeverEvent } from "../game/dummy";
import type { Combatant } from "../game/combatant";
import type { Ai } from "../game/ai";
import { cutDamage } from "../game/damage";

/** One opponent and the brain driving it, as the fight panel needs them. */
export interface TrackedFoe {
  combatant: Combatant;
  ai: Ai;
}

/**
 * Live readouts.
 *
 * `tracking error` is the number to watch while tuning. Near zero means the
 * arm is winning and the sword feels weightless; a large, saturated gap means
 * the world is winning. The whole feel of the mechanic is how that number
 * behaves over a swing.
 */

const QUALITY_TEXT: Record<Quality, string> = {
  touch: "touch",
  flat: "flat of the blade",
  glance: "glancing",
  bite: "bites",
  clean: "clean cut",
};

export class Hud {
  private root: HTMLElement;
  private impactEl: HTMLElement;
  private fadeTimer = 0;
  private lastDummySig = "";
  private lastFightSig = "";

  private err!: HTMLElement;
  private errBar!: HTMLElement;
  private sat!: HTMLElement;
  private satBar!: HTMLElement;
  private tip!: HTMLElement;
  private elbow!: HTMLElement;
  private roll!: HTMLElement;
  private fps!: HTMLElement;
  private dummyEl!: HTMLElement;
  private fightEl!: HTMLElement;
  private player: Combatant | null = null;
  private foes: TrackedFoe[] = [];
  private hurtTimer = 0;
  private dummy: Dummy | null = null;
  private rollHint!: HTMLElement;
  private jumpHint!: HTMLElement;

  constructor(root: HTMLElement, impactEl: HTMLElement) {
    this.root = root;
    this.impactEl = impactEl;
    this.root.innerHTML = `
      <section>
        <h2>Arm</h2>
        <dl>
          <dt>tracking error</dt><dd data-f="err">0.00 m</dd>
          <dt>drive saturation</dt><dd data-f="sat">0%</dd>
          <dt>tip speed</dt><dd data-f="tip">0.0 m/s</dd>
          <dt>elbow</dt><dd data-f="elbow">0°</dd>
          <dt>blade angle error</dt><dd data-f="roll">0°</dd>
        </dl>
        <div class="bar" data-b="err"><i style="width:0%"></i></div>
        <div class="bar" data-b="sat"><i style="width:0%"></i></div>
      </section>
      <section>
        <h2>Controls</h2>
        <dl>
          <dt>mouse</dt><dd>sword arm</dd>
          <dt>right-drag</dt><dd data-f="rollhint">roll edge</dd>
          <dt>wheel</dt><dd>reach</dd>
          <dt>W / S</dt><dd>forward, back</dd>
          <dt>A / D</dt><dd>turn</dd>
          <dt>Q / E</dt><dd>sidestep</dd>
          <dt>Space</dt><dd data-f="jumphint">jump</dd>
          <dt>Tab</dt><dd>tuning panel</dd>
          <dt>R</dt><dd>reset</dd>
          <dt>Esc</dt><dd>release mouse</dd>
        </dl>
      </section>
      <section>
        <dl><dt>frame</dt><dd data-f="fps">0.0 ms</dd></dl>
      </section>`;

    this.fightEl = document.createElement("div");
    this.fightEl.id = "fight";
    this.fightEl.className = "overlay";
    document.body.appendChild(this.fightEl);

    this.dummyEl = document.createElement("div");
    this.dummyEl.id = "dummy";
    this.dummyEl.className = "overlay";
    document.body.appendChild(this.dummyEl);

    const f = (n: string) => this.root.querySelector<HTMLElement>(`[data-f="${n}"]`)!;
    const b = (n: string) => this.root.querySelector<HTMLElement>(`[data-b="${n}"]`)!;
    this.err = f("err");
    this.sat = f("sat");
    this.tip = f("tip");
    this.elbow = f("elbow");
    this.roll = f("roll");
    this.fps = f("fps");
    this.rollHint = f("rollhint");
    this.jumpHint = f("jumphint");
    this.errBar = b("err");
    this.satBar = b("sat");
  }

  update(s: ArmState, frameMs: number, rolling = false, grounded = true): void {
    this.err.textContent = `${s.trackingError.toFixed(3)} m`;
    this.sat.textContent = `${Math.round(s.saturation * 100)}%`;
    this.tip.textContent = `${s.tipSpeed.toFixed(1)} m/s`;
    this.elbow.textContent = `${Math.round((s.elbow * 180) / Math.PI)}°`;
    this.roll.textContent = `${Math.round((s.roll * 180) / Math.PI)}°`;
    this.fps.textContent = `${frameMs.toFixed(1)} ms`;

    // Right-drag is modal, so say so while it is live — otherwise the mouse
    // quietly stops sweeping the arm and it reads as a stuck control.
    this.rollHint.textContent = rolling ? "ROLLING" : "roll edge";
    this.rollHint.style.color = rolling ? "var(--ink)" : "";

    // Air control is a fraction of ground control, so knowing you are off the
    // floor matters: you cannot take a jump back.
    this.jumpHint.textContent = grounded ? "jump" : "AIRBORNE";
    this.jumpHint.style.color = grounded ? "" : "var(--ink)";

    // 0.25m of lag is a lot: at that point the blade is visibly not where you
    // asked for it, which is exactly when the mechanic is doing its job.
    const errPct = Math.min(100, (s.trackingError / 0.25) * 100);
    setBar(this.errBar, errPct, errPct > 80 ? "bad" : errPct > 45 ? "warn" : "");
    const satPct = s.saturation * 100;
    setBar(this.satBar, satPct, satPct > 95 ? "bad" : satPct > 70 ? "warn" : "");

    // Cheap, but it runs every frame — only redraw when something changed.
    const sig = this.dummy ? [...this.dummy.limbs.values()]
      .map((l) => (l.severed ? -1 : Math.round(l.integrity * 4))).join(",") : "";
    if (sig !== this.lastDummySig) {
      this.lastDummySig = sig;
      this.refreshDummy();
    }

    const fsig = this.player
      ? [
          Math.round(this.player.health), this.player.state.disarmed, this.player.dead,
          ...this.foes.flatMap((f) => [
            Math.round(f.combatant.health), f.combatant.state.disarmed,
            f.combatant.dead, f.ai.intent, f.ai.committed?.name ?? "",
            Math.round(f.ai.tell * 8),
          ]),
        ].join(",")
      : "";
    if (fsig !== this.lastFightSig) {
      this.lastFightSig = fsig;
      this.refreshFight();
    }
  }

  /** `onDummy` is true when the hit landed on something that can be cut. */
  showImpact(i: Impact, onDummy: boolean): void {
    const sweet = i.alongBlade > 0.55 && i.alongBlade < 0.95;
    const dmg = cutDamage(i);

    // Damage is only meaningful against something cuttable; stone just reports
    // how the swing went.
    const tally = onDummy
      ? `<span class="dmg${dmg <= 0 ? " none" : ""}">${
          dmg <= 0 ? "no cut" : `${dmg.toFixed(1)} damage`}</span>`
      : "";

    this.impactEl.innerHTML = `
      <div class="quality">${QUALITY_TEXT[i.quality]} &mdash; ${i.what} ${tally}</div>
      <div class="detail">
        ${i.closingSpeed.toFixed(1)} m/s into it
        &middot; ${i.tangentSpeed.toFixed(1)} m/s along
        &middot; ${i.weapon.bite} ${Math.round(i.edgeAlign * 100)}%
        &middot; ${describePoint(i.alongBlade)}${sweet ? " (sweet spot)" : ""}
      </div>`;
    this.impactEl.classList.remove("fade");
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.impactEl.classList.add("fade"), 1600);
  }

  showSever(e: SeverEvent): void {
    this.impactEl.innerHTML = `<div class="quality sever">${e.label} severed</div>`;
    this.impactEl.classList.remove("fade");
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.impactEl.classList.add("fade"), 2200);
  }

  trackDummy(dummy: Dummy): void {
    this.dummy = dummy;
  }

  trackFight(player: Combatant, foes: TrackedFoe[]): void {
    this.player = player;
    this.foes = foes;
  }

  /** Flash the screen edge when the player is cut. */
  showHurt(i: Impact): void {
    const amount = cutDamage(i);
    if (amount <= 0) return;
    document.body.classList.add("hurt");
    clearTimeout(this.hurtTimer);
    this.hurtTimer = window.setTimeout(() => document.body.classList.remove("hurt"), 260);

    this.impactEl.innerHTML =
      `<div class="quality sever">you are cut &mdash; ${amount.toFixed(1)}</div>`;
    this.impactEl.classList.remove("fade");
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.impactEl.classList.add("fade"), 1600);
  }

  private refreshFight(): void {
    if (!this.player) return;
    const row = (c: Combatant) => {
      const s = c.state;
      const pct = (s.health / s.maxHealth) * 100;
      const cls = s.dead ? "gone" : pct < 30 ? "bad" : pct < 60 ? "warn" : "";
      const tags = [
        s.disarmed ? "disarmed" : "",
        s.dead ? "down" : "",
      ].filter(Boolean).join(" · ");
      return `<div class="limb ${cls}">
          <span>${c.name}${tags ? ` — ${tags}` : ""}</span>
          <i style="width:${pct.toFixed(0)}%"></i>
        </div>`;
    };

    /**
     * The telegraph, in words.
     *
     * The weapon lighting up says "something is coming"; this says what, and
     * what to do about it. Once you have learned the three attacks you can
     * stop reading it -- which is the point of a fixed repertoire.
     */
    const tell = (f: TrackedFoe) => {
      const a = f.ai.committed;
      if (!a || f.combatant.dead) {
        return `<div class="intent">${f.combatant.name}: ${f.ai.intent}</div>`;
      }
      const winding = f.ai.intent === "windup";
      return `<div class="attack${winding ? " winding" : ""}">
          <span class="move">${a.name}</span>
          <span class="counter">${a.counter}</span>
          <i style="width:${(f.ai.tell * 100).toFixed(0)}%"></i>
        </div>`;
    };

    this.fightEl.innerHTML = `<h2>Fight</h2>${row(this.player)}`
      + this.foes.map((f) => row(f.combatant) + tell(f)).join("");
  }

  /** Integrity bars for every joint still holding. */
  private refreshDummy(): void {
    if (!this.dummy) return;
    const rows = [...this.dummy.limbs.values()]
      .filter((l) => l.spec.jointKind !== null)
      .map((l) => {
        const frac = l.severed ? 0 : Math.max(0, l.integrity / l.maxIntegrity);
        const cls = l.severed ? "gone" : frac < 0.34 ? "bad" : frac < 0.7 ? "warn" : "";
        return `<div class="limb ${cls}">
            <span>${l.spec.label}</span>
            <i style="width:${(frac * 100).toFixed(0)}%"></i>
          </div>`;
      }).join("");
    this.dummyEl.innerHTML = `<h2>Dummy &mdash; ${this.dummy.severedCount} severed</h2>${rows}`;
  }
}

function describePoint(along: number): string {
  if (along < 0.15) return "on the guard";
  if (along < 0.45) return "strong of the blade";
  if (along < 0.8) return "middle";
  return "on the tip";
}

function setBar(el: HTMLElement, pct: number, cls: string): void {
  const fill = el.firstElementChild as HTMLElement;
  fill.style.width = `${pct}%`;
  el.className = `bar${cls ? ` ${cls}` : ""}`;
}
