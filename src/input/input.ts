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
  left: boolean;
  right: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  rollLeft: boolean;
  rollRight: boolean;
}

const KEY_MAP: Record<string, keyof Keys> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  ArrowLeft: "turnLeft",
  ArrowRight: "turnRight",
  KeyQ: "rollLeft",
  KeyE: "rollRight",
};

export class Input {
  readonly keys: Keys = {
    forward: false, back: false, left: false, right: false,
    turnLeft: false, turnRight: false, rollLeft: false, rollRight: false,
  };

  /** Mouse travel since the last `consumeMouse()`, in pixels. */
  private dx = 0;
  private dy = 0;
  private wheel = 0;

  locked = false;
  onLockChange?: (locked: boolean) => void;
  onTogglePanel?: () => void;
  onReset?: () => void;

  constructor(private target: HTMLElement) {
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.clearKeys();
      this.onLockChange?.(this.locked);
    });

    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });

    addEventListener("wheel", (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY) * -1; // wheel up = extend
    }, { passive: false });

    addEventListener("keydown", (e) => {
      if (e.code === "Tab") { e.preventDefault(); this.onTogglePanel?.(); return; }
      if (e.code === "KeyR") { this.onReset?.(); return; }
      const k = KEY_MAP[e.code];
      if (k) { this.keys[k] = true; e.preventDefault(); }
    });

    addEventListener("keyup", (e) => {
      const k = KEY_MAP[e.code];
      if (k) { this.keys[k] = false; e.preventDefault(); }
    });

    // Losing focus mid-swing otherwise leaves keys stuck down.
    addEventListener("blur", () => this.clearKeys());
  }

  requestLock(): void {
    this.target.requestPointerLock();
  }

  /** Returns accumulated mouse travel and resets it. Call once per fixed step. */
  consumeMouse(): { dx: number; dy: number; wheel: number } {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    return out;
  }

  private clearKeys(): void {
    for (const k of Object.keys(this.keys) as (keyof Keys)[]) this.keys[k] = false;
  }
}
