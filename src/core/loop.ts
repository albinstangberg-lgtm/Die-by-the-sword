/**
 * Fixed-timestep accumulator with render interpolation.
 *
 * Stiff PD drives explode under a variable dt, so physics always advances in
 * whole STEP-sized slices. Rendering then interpolates between the last two
 * physics states by `alpha`, which keeps motion smooth on displays that aren't
 * 60Hz. Without this the sword visibly stutters on a 144Hz monitor.
 */

export const STEP = 1 / 60;
const MAX_SUBSTEPS = 5; // spiral-of-death guard: drop time rather than stall

export interface LoopCallbacks {
  fixed(dt: number): void;
  render(alpha: number, dt: number): void;
}

export class Loop {
  private accumulator = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  /** Rolling average frame time, for the HUD. */
  frameMs = 0;

  constructor(private cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const elapsed = (now - this.last) / 1000;
      this.last = now;
      this.frameMs += ((elapsed * 1000) - this.frameMs) * 0.1;

      // Clamp: after a tab-switch `elapsed` can be many seconds.
      this.accumulator += Math.min(elapsed, STEP * MAX_SUBSTEPS);

      let steps = 0;
      while (this.accumulator >= STEP && steps < MAX_SUBSTEPS) {
        this.cb.fixed(STEP);
        this.accumulator -= STEP;
        steps++;
      }
      this.cb.render(this.accumulator / STEP, elapsed);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
