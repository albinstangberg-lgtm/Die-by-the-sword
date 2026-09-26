import type { ArmState } from "../game/arm";
import type { Impact, Quality } from "../game/impacts";
import type { Dummy, SeverEvent } from "../game/dummy";
import type { Combatant } from "../game/combatant";
import type { Ai } from "../game/ai";
import { cutDamage } from "../game/damage";
import type { Blow, Knock } from "../game/balance";

/**
 * What you are carrying and how you are standing, once a frame. Everything
 * here changes rarely, so it is only redrawn when it does.
 */
export interface Kit {
  /** Where the sword is, or where it is going. */
  sword: "hand" | "back" | "lost" | "sheathing" | "drawing";
  /** Where the shield is, or where it is going -- or that it went with the arm. */
  shield: "none" | "arm" | "back" | "slinging" | "unslinging" | "lost";
  potions: number;
  /** Pieces of other people, and their weapons, in the bag. */
  bagged: number;
  /** What the sword hand is holding, if anything: a piece of somebody, or their weapon. */
  holding: string | null;
  /** Drinking one: health still to come back. */
  healing: number;
  stance: "standing" | "crouching" | "vaulting" | "climbing" | "picking up" | "pulling" | "airborne" | "down";
  /** The left button is held: the mouse is on the other arm. */
  guarding: boolean;
  /** What F would do right now, or null. */
  prompt: string | null;
}

/** Where the sword is, in words: for the kit readout and the inventory. */
export const SWORD_TEXT: Record<Kit["sword"], string> = {
  hand: "in hand", back: "on your back", lost: "lost",
  sheathing: "going on your back", drawing: "coming out",
};

/** And the shield. */
export const SHIELD_TEXT: Record<Kit["shield"], string> = {
  none: "none", arm: "on your arm", back: "on your back",
  slinging: "going on your back", unslinging: "coming off your back",
  lost: "lost with the arm",
};

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

/** What a blow did to the body it landed on. */
const KNOCK_TEXT: Record<Knock, string> = {
  none: "doesn't budge",
  shove: "shoved",
  stagger: "staggered",
  down: "knocked down",
};

/**
 * The push half of a hit, as one line: what it did, and the numbers that
 * decided it -- how fast the blow moved the whole body, and how much body
 * there was to move. The same swing reads 1.3 m/s into 38 kg on a goblin and
 * 0.3 into 173 on an orc, which is the whole story.
 */
function knockLine(blow: Blow, said = KNOCK_TEXT[blow.effect]): string {
  return `<div class="knock ${blow.effect}">${said}
      <span>&middot; ${blow.speed.toFixed(1)} m/s into ${blow.mass.toFixed(0)} kg</span></div>`;
}

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
  private twist!: HTMLElement;
  private wrist!: HTMLElement;
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
  private guardHint!: HTMLElement;
  private kitEl!: HTMLElement;
  private promptEl: HTMLElement;
  private lastKitSig = "";

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
          <dt>grip twist</dt><dd data-f="twist">0°</dd>
          <dt>wrist bend</dt><dd data-f="wrist">0°</dd>
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
          <dt>left-drag</dt><dd data-f="guardhint">other arm / shield</dd>
          <dt>wheel</dt><dd>reach</dd>
          <dt>W / S</dt><dd>forward, back</dd>
          <dt>A / D</dt><dd>turn</dd>
          <dt>Shift</dt><dd>+ A / D: turn on your heel</dd>
          <dt>Q / E</dt><dd>sidestep</dd>
          <dt>tap tap</dt><dd>W / S / Q / E: quick step</dd>
          <dt>Space</dt><dd data-f="jumphint">jump &middot; W+Space climb</dd>
          <dt>V</dt><dd>vault</dd>
          <dt>C</dt><dd>crouch</dd>
          <dt>X</dt><dd>sheathe / draw / wield</dd>
          <dt>Z</dt><dd>shield on back / arm</dd>
          <dt>F</dt><dd>pick up &middot; pull &middot; into bag</dd>
          <dt>G</dt><dd>let go &middot; mid-swing, throw</dd>
          <dt>H</dt><dd>drink a potion</dd>
          <dt>B</dt><dd>inventory</dd>
          <dt>Tab</dt><dd>tuning panel</dd>
          <dt>R</dt><dd>reset</dd>
          <dt>Esc</dt><dd>release mouse</dd>
        </dl>
      </section>
      <section>
        <h2>Kit</h2>
        <dl data-f="kit"></dl>
      </section>
      <section>
        <dl><dt>frame</dt><dd data-f="fps">0.0 ms</dd></dl>
      </section>`;

    this.promptEl = document.createElement("div");
    this.promptEl.id = "prompt";
    this.promptEl.className = "overlay";
    document.body.appendChild(this.promptEl);

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
    this.twist = f("twist");
    this.wrist = f("wrist");
    this.roll = f("roll");
    this.fps = f("fps");
    this.rollHint = f("rollhint");
    this.jumpHint = f("jumphint");
    this.guardHint = f("guardhint");
    this.kitEl = f("kit");
    this.errBar = b("err");
    this.satBar = b("sat");
  }

  update(
    s: ArmState, frameMs: number, rolling = false, grounded = true, kit: Kit | null = null,
  ): void {
    this.err.textContent = `${s.trackingError.toFixed(3)} m`;
    this.sat.textContent = `${Math.round(s.saturation * 100)}%`;
    this.tip.textContent = `${s.tipSpeed.toFixed(1)} m/s`;
    this.elbow.textContent = `${Math.round((s.elbow * 180) / Math.PI)}°`;
    this.twist.textContent = `${Math.round((s.twist * 180) / Math.PI)}°`;
    this.wrist.textContent = `${Math.round((s.wrist * 180) / Math.PI)}°`;
    this.roll.textContent = `${Math.round((s.roll * 180) / Math.PI)}°`;
    this.fps.textContent = `${frameMs.toFixed(1)} ms`;

    // Right-drag is modal, so say so while it is live — otherwise the mouse
    // quietly stops sweeping the arm and it reads as a stuck control.
    this.rollHint.textContent = rolling ? "ROLLING" : "roll edge";
    this.rollHint.style.color = rolling ? "var(--ink)" : "";

    // Air control is a fraction of ground control, so knowing you are off the
    // floor matters: you cannot take a jump back.
    this.jumpHint.textContent = grounded ? "jump · W+Space climb" : "AIRBORNE";
    this.jumpHint.style.color = grounded ? "" : "var(--ink)";

    if (kit) this.updateKit(kit);

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
          this.player.state.knockedDown, this.player.state.reeling,
          ...this.foes.flatMap((f) => [
            Math.round(f.combatant.health), f.combatant.state.disarmed,
            f.combatant.dead, f.ai.outlook,
            f.combatant.state.knockedDown, f.combatant.state.reeling,
          ]),
        ].join(",")
      : "";
    if (fsig !== this.lastFightSig) {
      this.lastFightSig = fsig;
      this.refreshFight();
    }
  }

  /** The kit readout, the other arm's hint, and the prompt for F. */
  private updateKit(kit: Kit): void {
    const shielded = kit.shield === "arm";
    this.guardHint.textContent = kit.guarding ? (shielded ? "SHIELD" : "OTHER ARM")
      : shielded ? "shield" : "other arm / shield";
    this.guardHint.style.color = kit.guarding ? "var(--ink)" : "";

    const sig = [kit.sword, kit.shield, kit.potions, kit.bagged, kit.holding ?? "",
      Math.ceil(kit.healing), kit.stance, kit.prompt ?? ""].join("|");
    if (sig === this.lastKitSig) return;
    this.lastKitSig = sig;

    const potions = kit.healing > 0
      ? `${kit.potions} &middot; +${Math.ceil(kit.healing)} coming`
      : String(kit.potions);
    this.kitEl.innerHTML = `
      <dt>sword</dt><dd>${SWORD_TEXT[kit.sword]}</dd>
      <dt>shield</dt><dd>${SHIELD_TEXT[kit.shield]}</dd>
      <dt>holding</dt><dd>${kit.holding ?? "nothing"}</dd>
      <dt>potions</dt><dd>${potions}</dd>
      <dt>in bag</dt><dd>${kit.bagged}</dd>
      <dt>stance</dt><dd>${kit.stance}</dd>`;

    this.promptEl.textContent = kit.prompt ?? "";
    this.promptEl.classList.toggle("shown", kit.prompt !== null);
  }

  /** A line of news in the impact readout: a pickup, a drink, a refusal. */
  showNote(text: string, bad = false): void {
    if (!text) return;
    this.impactEl.innerHTML = `<div class="quality${bad ? " none" : " note"}">${text}</div>`;
    this.impactEl.classList.remove("fade");
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.impactEl.classList.add("fade"), 1800);
  }

  /**
   * A blade stopped on your shield: what it was, how hard it came, and what
   * its weight did to you anyway.
   */
  showBlock(i: Impact, blow: Blow | null = null): void {
    const rocked = blow !== null && blow.effect !== "none";
    this.impactEl.innerHTML = `
      <div class="quality block">blocked &mdash; ${i.closingSpeed.toFixed(1)} m/s on ${i.what}</div>
      ${rocked ? knockLine(blow!, blow!.effect === "down" ? "you are knocked down" : KNOCK_TEXT[blow!.effect]) : ""}`;
    this.impactEl.classList.remove("fade");
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.impactEl.classList.add("fade"), 1400);
  }

  /**
   * `onDummy` is true when the hit landed on something that can be cut, and
   * `blow` is what it did to the body it landed on, if that was a fighter.
   */
  showImpact(i: Impact, onDummy: boolean, blow: Blow | null = null): void {
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
      ${blow ? knockLine(blow) : ""}
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

  /**
   * Flash the screen edge when the player is cut, and say so when a blow has
   * rocked them or put them on the floor -- which a blow can do without
   * cutting at all.
   */
  showHurt(i: Impact, blow: Blow | null = null): void {
    const amount = cutDamage(i);
    const rocked = blow !== null && (blow.effect === "stagger" || blow.effect === "down");
    if (amount <= 0 && !rocked) return;
    if (amount > 0) {
      document.body.classList.add("hurt");
      clearTimeout(this.hurtTimer);
      this.hurtTimer = window.setTimeout(() => document.body.classList.remove("hurt"), 260);
    }

    const cut = amount > 0
      ? `<div class="quality sever">you are cut &mdash; ${amount.toFixed(1)}</div>` : "";
    const knocked = rocked
      ? knockLine(blow!, blow!.effect === "down" ? "you are knocked down" : "you stagger")
      : "";
    this.impactEl.innerHTML = `${cut}${knocked}`;
    this.impactEl.classList.remove("fade");
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.impactEl.classList.add("fade"), 1600);
  }

  private refreshFight(): void {
    if (!this.player) return;
    const row = (c: Combatant, outlook = "") => {
      const s = c.state;
      const pct = (s.health / s.maxHealth) * 100;
      const cls = s.dead ? "gone" : pct < 30 ? "bad" : pct < 60 ? "warn" : "";
      // "dead" rather than "down", now that being down is something you get
      // up from.
      const tags = [
        s.disarmed ? "disarmed" : "",
        s.knockedDown ? "knocked down" : "",
        s.reeling ? "staggered" : "",
        s.dead ? "dead" : "",
      ].filter(Boolean).join(" · ");
      return `<div class="limb ${cls}">
          <span>${c.name}${tags ? ` — ${tags}` : ""}</span>${outlook ? `<em>${outlook}</em>` : ""}
          <i style="width:${pct.toFixed(0)}%"></i>
        </div>`;
    };

    /**
     * After each opponent's name, whether it has noticed you -- or, fighting
     * something of another side, what -- and nothing more.
     *
     * This used to be a line of its own naming the attack being wound up and
     * saying how to beat it, with a bar filling toward the moment it landed.
     * Nothing says what is coming now: you read that off its arm. And it goes
     * on the same line as its health, so that eight of them fit down the side
     * of the screen.
     */
    const outlook = (ai: Ai) => {
      const them = ai.fighting;
      return ai.outlook === "fighting" && them !== null && them !== this.player
        ? `fighting ${them.name}` : ai.outlook;
    };
    this.fightEl.innerHTML = `<h2>Fight</h2>${row(this.player)}`
      + this.foes.map((f) => row(f.combatant, outlook(f.ai))).join("");
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
