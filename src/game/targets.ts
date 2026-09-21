/**
 * A registry mapping collider handles to readable names.
 *
 * The arena and the dummy both put their colliders in here, so the impact
 * reporter can name what you just hit without knowing anything about either.
 */
export class Targets {
  private labels = new Map<number, string>();

  register(handle: number, label: string): void {
    this.labels.set(handle, label);
  }

  forget(handle: number): void {
    this.labels.delete(handle);
  }

  labelFor(handle: number): string {
    return this.labels.get(handle) ?? "something";
  }
}
