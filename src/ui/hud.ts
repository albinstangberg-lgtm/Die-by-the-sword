import type { ArmState } from "../game/arm";
import type { Impact, Quality } from "../game/impacts";

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

  private err!: HTMLElement;
  private errBar!: HTMLElement;
  private sat!: HTMLElement;
  private satBar!: HTMLElement;
  private tip!: HTMLElement;
  private elbow!: HTMLElement;
  private roll!: HTMLElement;
  private fps!: HTMLElement;
  private rollHint!: HTMLElement;

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
          <dt>W A S D</dt><dd>move</dd>
          <dt>Q / E</dt><dd>turn</dd>
          <dt>Tab</dt><dd>tuning panel</dd>
          <dt>R</dt><dd>reset</dd>
          <dt>Esc</dt><dd>release mouse</dd>
        </dl>
      </section>
      <section>
        <dl><dt>frame</dt><dd data-f="fps">0.0 ms</dd></dl>
      </section>`;

    const f = (n: string) => this.root.querySelector<HTMLElement>(`[data-f="${n}"]`)!;
    const b = (n: string) => this.root.querySelector<HTMLElement>(`[data-b="${n}"]`)!;
    this.err = f("err");
    this.sat = f("sat");
    this.tip = f("tip");
    this.elbow = f("elbow");
    this.roll = f("roll");
    this.fps = f("fps");
    this.rollHint = f("rollhint");
    this.errBar = b("err");
    this.satBar = b("sat");
  }

  update(s: ArmState, frameMs: number, rolling = false): void {
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

    // 0.25m of lag is a lot: at that point the blade is visibly not where you
    // asked for it, which is exactly when the mechanic is doing its job.
    const errPct = Math.min(100, (s.trackingError / 0.25) * 100);
    setBar(this.errBar, errPct, errPct > 80 ? "bad" : errPct > 45 ? "warn" : "");
    const satPct = s.saturation * 100;
    setBar(this.satBar, satPct, satPct > 95 ? "bad" : satPct > 70 ? "warn" : "");
  }

  showImpact(i: Impact): void {
    const sweet = i.alongBlade > 0.55 && i.alongBlade < 0.95;
    this.impactEl.innerHTML = `
      <div class="quality">${QUALITY_TEXT[i.quality]} &mdash; ${i.what}</div>
      <div class="detail">
        ${i.closingSpeed.toFixed(1)} m/s into it
        &middot; ${i.tangentSpeed.toFixed(1)} m/s along
        &middot; edge ${Math.round(i.edgeAlign * 100)}%
        &middot; ${describePoint(i.alongBlade)}${sweet ? " (sweet spot)" : ""}
      </div>`;
    this.impactEl.classList.remove("fade");
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.impactEl.classList.add("fade"), 1400);
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
