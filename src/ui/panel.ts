import { CONTROLS, DEFAULTS, PRESETS, type Control, type Tuning } from "../tuning";

/**
 * The tuning panel. Everything is live — the values feed straight into the PD
 * drive each step, so you can drag `max force` while mid-swing and feel the
 * arm give out under you.
 *
 * Values persist to localStorage, because finding a feel you like and then
 * losing it to a page reload is miserable.
 */

const STORAGE_KEY = "dbts.tuning.v1";

export class Panel {
  private root: HTMLElement;
  private inputs = new Map<keyof Tuning, HTMLInputElement>();

  constructor(root: HTMLElement, private tuning: Tuning, private onChange: () => void) {
    this.root = root;
    this.render();
  }

  private render(): void {
    const parts: string[] = [
      `<p class="note">Live. Tab to hide. Saved to this browser.</p>`,
    ];
    let group = "";
    for (const c of CONTROLS) {
      if (c.group !== group) {
        group = c.group;
        parts.push(`<h2>${group}</h2>`);
      }
      parts.push(this.rowHtml(c));
    }
    parts.push(`<h2>Presets</h2>`);
    for (const name of Object.keys(PRESETS)) {
      parts.push(`<button data-preset="${name}">${name}</button>`);
    }
    this.root.innerHTML = parts.join("");

    for (const c of CONTROLS) {
      const el = this.root.querySelector<HTMLInputElement>(`[data-key="${c.key}"]`)!;
      this.inputs.set(c.key, el);
      el.addEventListener("input", () => {
        if (el.type === "checkbox") {
          (this.tuning[c.key] as boolean) = el.checked;
        } else {
          (this.tuning[c.key] as number) = parseFloat(el.value);
          const out = this.root.querySelector(`[data-out="${c.key}"]`);
          if (out) out.textContent = format(parseFloat(el.value));
        }
        this.save();
        this.onChange();
      });
    }

    this.root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => {
      b.addEventListener("click", () => {
        this.apply(PRESETS[b.dataset.preset!]);
        // Keep the mouse out of the panel so the next swing isn't a stray click.
        b.blur();
      });
    });
  }

  private rowHtml(c: Control): string {
    const v = this.tuning[c.key];
    if (typeof v === "boolean") {
      return `<div class="row toggle"><label>
        <span>${c.label}</span>
        <input type="checkbox" data-key="${c.key}" ${v ? "checked" : ""}>
      </label></div>`;
    }
    const hint = c.hint ? ` title="${c.hint.replace(/"/g, "&quot;")}"` : "";
    return `<div class="row"${hint}><label>
        <span>${c.label}</span><span data-out="${c.key}">${format(v)}</span>
      </label>
      <input type="range" data-key="${c.key}"
             min="${c.min}" max="${c.max}" step="${c.step}" value="${v}">
    </div>`;
  }

  private apply(patch: Partial<Tuning>): void {
    Object.assign(this.tuning, patch);
    this.syncInputs();
    this.save();
    this.onChange();
  }

  private syncInputs(): void {
    for (const [key, el] of this.inputs) {
      const v = this.tuning[key];
      if (typeof v === "boolean") {
        el.checked = v;
      } else {
        el.value = String(v);
        const out = this.root.querySelector(`[data-out="${key}"]`);
        if (out) out.textContent = format(v);
      }
    }
  }

  toggle(): void {
    this.root.classList.toggle("hidden");
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tuning));
    } catch {
      // Private browsing, disabled storage — losing the save is not worth a crash.
    }
  }
}

/** Restore saved tuning, ignoring anything that isn't a key we know. */
export function loadTuning(): Tuning {
  const t: Tuning = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return t;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(DEFAULTS) as (keyof Tuning)[]) {
      const v = saved[key];
      if (typeof v === typeof DEFAULTS[key]) (t[key] as unknown) = v;
    }
  } catch {
    // Corrupt or unavailable storage: fall back to defaults silently.
  }
  return t;
}

function format(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
