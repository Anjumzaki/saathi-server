/** Tiny TTL cache with explicit invalidation. Per process: other dynos converge within the TTL. */
export class TtlCache<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private inflight: Promise<T> | null = null;
  private generation = 0;

  constructor(
    private readonly loader: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(): Promise<T> {
    if (this.value !== undefined && this.clock() < this.expiresAt) return this.value;
    if (this.inflight) return this.inflight;
    const gen = this.generation;
    this.inflight = this.loader()
      .then((v) => {
        if (gen === this.generation) {
          this.value = v;
          this.expiresAt = this.clock() + this.ttlMs;
        }
        return v;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.generation++;
    this.value = undefined;
    this.expiresAt = 0;
    this.inflight = null;
  }
}
