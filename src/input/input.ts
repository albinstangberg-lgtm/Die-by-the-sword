/**
 * Pointer-lock input.
 *
 * Without pointer lock the cursor hits the edge of the window mid-swing and the
 * arm stops dead, which is fatal for this mechanic. Locked, we read raw
 * `movementX/Y` deltas and accumulate them ourselves, so the arm can sweep
 * through any range we allow.
 *
 * Deltas are consumed once per FIXED step, not per frame: reading them in the
 * render loop double-counts input whenever a frame spans two physics steps.
 */

export interface Keys {
  forward: boolean;
  back: boolean;
  /** Sidestep, not turn: the feet shuffle, the shoulders keep facing forward. */
  left: boolean;
  right: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  /** Jump -- or, moving at a ledge, climb it. */
  jump: boolean;
  /** Vault whatever is in front, between a knee and a chest high. */
  vault: boolean;
  /** Held: sink onto bent knees. */
  crouch: boolean;
  /**
   * Held: turn on your heel. A and D turn the body round several times as
   * fast -- what carries a swing on round with you, all the way.
   */
  pivot: boolean;
  /**
   * A quick step the way the movement keys say: a short burst, then a rest
   * before the next. Asked for, not held -- a double tap of W, S, Q or E for
   * you, see `Taps`, and the same flag for anything else on two feet.
   */
  dash: boolean;
}

/**
 * The things you do once rather than hold: put the sword up or take it out,
 * sling the shield on your back or take it down, pick up what is in front of
 * you -- or put what is in your hand in the bag -- let go of it, drink, open
 * the bag, and, with it open, use what is in it by the number beside it. They
 * are not `Keys`, which say what is held down each step; they are queued, and
 * happen on the next step.
 */
export type Action = "sheathe" | "sling" | "interact" | "drop" | "drink" | "bag" | Use;

/** A line of the bag, by the digit key beside it: 0 is the first. */
export interface Use {
  readonly use: number;
}

export const ACTION_MAP: Record<string, Action> = {
  KeyX: "sheathe",
  KeyZ: "sling",
  KeyF: "interact",
  KeyG: "drop",
  KeyH: "drink",
  KeyB: "bag",
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`Digit${i + 1}`, { use: i } as Use])),
};

/**
 * A/D turn, Q/E sidestep.
 *
 * This is the reverse of the usual shooter layout and it is deliberate. The
 * mouse is the ARM here, so turning is a keyboard move, and turning is the one
 * you reach for constantly -- you turn to face, you turn to keep an opponent
 * in front of you, you turn mid-swing to carry the blade further round. Putting
 * it on the home-row keys next to W/S and leaving the stretch for the sidestep
 * matches how often each is actually used.
 */
export const KEY_MAP: Record<string, keyof Keys> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "turnLeft",
  KeyD: "turnRight",
  KeyQ: "left",
  KeyE: "right",
  Space: "jump",
  KeyV: "vault",
  KeyC: "crouch",
  ShiftLeft: "pivot",
  ShiftRight: "pivot",
  // The arrow keys stay live as an alias; some people reach for them first.
  ArrowLeft: "turnLeft",
  ArrowRight: "turnRight",
};

/** Longest a key can be held down and still count as a tap, seconds. */
export const TAP = 0.2;
/** Longest from a tap coming up to the same key going down again, seconds. */
export const GAP = 0.25;

/**
 * Double taps of the movement keys: a quick step. A tap is a key let go of
 * within `TAP`; the same key down again within `GAP` of coming up is the
 * quick step, at once -- it does not wait to be let go. Tight on purpose:
 * the keys are tapped all the time to edge in and out of reach, and a step
 * nobody asked for costs a fight. Anything else pressed between, or a key
 * held, and the two presses are two presses.
 */
export class Taps {
  private last: { code: string; down: number; up: number } | null = null;

  /** A movement key went down (not a repeat): whether that is a double tap. */
  press(code: string, now: number): boolean {
    const l = this.last;
    if (l && l.code === code && l.up >= 0 && l.up - l.down <= TAP && now - l.up <= GAP) {
      // Spent: a third tap starts the count again.
      this.last = null;
      return true;
    }
    this.last = { code, down: now, up: -1 };
    return false;
  }

  /** A movement key came up. */
  release(code: string, now: number): void {
    if (this.last && this.last.code === code && this.last.up < 0) this.last.up = now;
  }

  clear(): void {
    this.last = null;
  }
}

/** The keys a double tap of which is a quick step: the ones that walk. */
const STEPS = new Set<keyof Keys>(["forward", "back", "left", "right"]);

export class Input {
  readonly keys: Keys = {
    forward: false, back: false, left: false, right: false,
    turnLeft: false, turnRight: false, jump: false, vault: false, crouch: false, pivot: false,
    dash: false,
  };
  private readonly taps = new Taps();
  /**
   * The key a double tap was of, and whether it has been let go of, until the
   * step that takes the quick step has seen it: see `dashSeen`. A tap is
   * quick and a frame can be slow, and let go of before any step saw it, the
   * quick step would have had no way to go.
   */
  private dashKey: keyof Keys | null = null;
  private dashLet = false;

  /** Mouse travel since the last `consumeMouse()`, in pixels. */
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  /** Horizontal travel accumulated while the right button is held. */
  private rollDx = 0;

  /**
   * Right button held: horizontal mouse travel rolls the cutting edge instead
   * of sweeping the arm sideways. Vertical travel still aims, so you never
   * lose the ability to adjust height while setting your edge.
   */
  private rolling = false;

  /**
   * Left button held: the mouse steers the other arm -- the shield, if there
   * is one -- and the sword holds where it was. The same kind of switch as the
   * right button's roll, for the other hand.
   */
  private guarding = false;
  private offDx = 0;
  private offDy = 0;
  private offWheel = 0;

  locked = false;
  onLockChange?: (locked: boolean) => void;
  onTogglePanel?: () => void;
  onReset?: () => void;
  /** A one-shot action key went down. */
  onAction?: (action: Action) => void;

  constructor(private target: HTMLElement) {
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) {
        this.clearKeys();
        this.rolling = false;
        this.guarding = false;
      }
      this.onLockChange?.(this.locked);
    });

    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      if (this.guarding) {
        this.offDx += e.movementX;
        this.offDy += e.movementY;
        return;
      }
      if (this.rolling) this.rollDx += e.movementX;
      else this.dx += e.movementX;
      this.dy += e.movementY;
    });

    addEventListener("mousedown", (e) => {
      if (this.locked && e.button === 2) this.rolling = true;
      if (this.locked && e.button === 0) this.guarding = true;
    });
    addEventListener("mouseup", (e) => {
      if (e.button === 2) this.rolling = false;
      if (e.button === 0) this.guarding = false;
    });
    // Pointer lock normally suppresses this, but not on every browser, and a
    // context menu mid-swing steals the pointer.
    addEventListener("contextmenu", (e) => e.preventDefault());

    addEventListener("wheel", (e) => {
      if (!this.locked) return;
      e.preventDefault();
      // Wheel up = extend, for whichever arm the mouse is on.
      if (this.guarding) this.offWheel += Math.sign(e.deltaY) * -1;
      else this.wheel += Math.sign(e.deltaY) * -1;
    }, { passive: false });

    addEventListener("keydown", (e) => {
      if (e.code === "Tab") { e.preventDefault(); this.onTogglePanel?.(); return; }
      if (e.code === "KeyR") { this.onReset?.(); return; }
      const action = ACTION_MAP[e.code];
      if (action) {
        e.preventDefault();
        if (!e.repeat) this.onAction?.(action);
        return;
      }
      const k = KEY_MAP[e.code];
      if (k) { this.keys[k] = true; e.preventDefault(); }
      // Down again before the step has seen it let go: it is held.
      if (k === this.dashKey) this.dashLet = false;
      if (k && STEPS.has(k) && !e.repeat && this.taps.press(e.code, e.timeStamp / 1000)) {
        this.keys.dash = true;
        this.dashKey = k;
        this.dashLet = false;
      }
    });

    addEventListener("keyup", (e) => {
      const k = KEY_MAP[e.code];
      if (!k) return;
      e.preventDefault();
      if (STEPS.has(k)) this.taps.release(e.code, e.timeStamp / 1000);
      if (k === this.dashKey && this.keys.dash) this.dashLet = true;
      else this.keys[k] = false;
    });

    // Losing focus mid-swing otherwise leaves keys stuck down.
    addEventListener("blur", () => {
      this.clearKeys();
      this.rolling = false;
      this.guarding = false;
    });
  }

  requestLock(): void {
    this.target.requestPointerLock();
  }

  /** Returns accumulated mouse travel and resets it. Call once per fixed step. */
  consumeMouse(): { dx: number; dy: number; wheel: number; rollDx: number } {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel, rollDx: this.rollDx };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.rollDx = 0;
    return out;
  }

  /** The other arm's share of the mouse since last asked. Once per fixed step. */
  consumeOff(): { dx: number; dy: number; wheel: number; active: boolean } {
    const out = { dx: this.offDx, dy: this.offDy, wheel: this.offWheel, active: this.guarding };
    this.offDx = 0;
    this.offDy = 0;
    this.offWheel = 0;
    return out;
  }

  /**
   * The step that takes a double tap's quick step has seen it: it is asked
   * for once, and the key it was of, if it has been let go of meanwhile,
   * comes up now. Call once per fixed step, after the keys are read.
   */
  dashSeen(): void {
    this.keys.dash = false;
    if (this.dashKey && this.dashLet) this.keys[this.dashKey] = false;
    this.dashKey = null;
    this.dashLet = false;
  }

  /** True while the right button is held — the HUD dims the sweep hint. */
  get rollMode(): boolean {
    return this.rolling && !this.guarding;
  }

  /** True while the left button is held: the mouse is on the other arm. */
  get guardMode(): boolean {
    return this.guarding;
  }

  private clearKeys(): void {
    for (const k of Object.keys(this.keys) as (keyof Keys)[]) this.keys[k] = false;
    this.taps.clear();
    this.dashKey = null;
    this.dashLet = false;
  }
}
