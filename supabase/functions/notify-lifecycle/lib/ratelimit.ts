// ============================================================================
// lib/ratelimit.ts — Token bucket provider rate limiter
// ============================================================================
// Replaces naive sleep(150ms) (AUDIT P1-6). Provider-aware:
//   * steady rate (tokens/sec) + burst capacity
//   * pauseUntil() for 429 Retry-After responses — the whole worker backs off
//   * take() resolves when a token is available (or the pause expires)
// Single-drainer architecture (DB lease) means one in-process bucket is the
// correct scope; multi-worker deployments should lower RATE_RPS per instance.

export interface TokenBucketOptions {
  rps?: number;      // refill rate, tokens per second
  burst?: number;    // bucket capacity
  maxWaitMs?: number; // give up (throw) if a token takes longer than this
}

export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;
  private pausedUntil = 0;
  private readonly maxWaitMs: number;

  constructor(opts: TokenBucketOptions = {}) {
    const rps = Math.max(0.05, opts.rps ?? 2);
    this.capacity = Math.max(1, opts.burst ?? Math.ceil(rps * 2));
    this.refillPerMs = rps / 1000;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.maxWaitMs = opts.maxWaitMs ?? 120_000;
  }

  /** Back off the whole bucket (e.g. after HTTP 429 with Retry-After). */
  pause(seconds: number): void {
    const until = Date.now() + Math.max(0, seconds) * 1000;
    if (until > this.pausedUntil) this.pausedUntil = until;
    this.tokens = 0; // drain: force refill-from-zero behavior after the pause
  }

  get pausedUntilTimestamp(): number {
    return this.pausedUntil;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Resolve when a token is available. Throws on maxWaitMs breach. */
  async take(): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const now = Date.now();
      if (this.pausedUntil > now) {
        const wait = Math.min(this.pausedUntil - now, deadline - now);
        if (wait <= 0) throw new Error("rate limit wait exceeded maxWaitMs");
        await sleep(wait);
        continue;
      }
      this.refill(Date.now());
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const needed = (1 - this.tokens) / this.refillPerMs;
      const wait = Math.min(Math.ceil(needed), deadline - Date.now());
      if (wait <= 0) throw new Error("rate limit wait exceeded maxWaitMs");
      await sleep(Math.max(wait, 5));
    }
  }

  /** Non-blocking probe (tests/health). */
  available(): number {
    this.refill(Date.now());
    return Math.floor(this.tokens);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
