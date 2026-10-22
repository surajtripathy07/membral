export interface RateControllerConfig {
  initialDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxRetriesPerRequest: number;
}

const DEFAULT_CONFIG: RateControllerConfig = {
  initialDelayMs: 200,
  minDelayMs: 100,
  maxDelayMs: 120_000,
  maxRetriesPerRequest: 3,
};

export class RateController {
  private config: RateControllerConfig;
  private delayMs: number;
  private totalRequests = 0;
  private total429s = 0;
  private label: string;

  constructor(label: string, config: Partial<RateControllerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.delayMs = this.config.initialDelayMs;
    this.label = label;
  }

  get maxRetries(): number {
    return this.config.maxRetriesPerRequest;
  }

  get stats(): { totalRequests: number; total429s: number; currentDelayMs: number } {
    return {
      totalRequests: this.totalRequests,
      total429s: this.total429s,
      currentDelayMs: Math.round(this.delayMs),
    };
  }

  onSuccess(): void {
    this.totalRequests++;
    this.delayMs = Math.max(this.config.minDelayMs, this.delayMs * 0.9);
  }

  on429(): void {
    this.totalRequests++;
    this.total429s++;
    this.bump();
  }

  onError(): void {
    this.totalRequests++;
    this.delayMs = Math.min(this.delayMs * 1.5, this.config.maxDelayMs);
    console.warn(`${this.label} error: delay now ${Math.round(this.delayMs)}ms`);
  }

  private bump(): void {
    const d = this.delayMs;
    let multiplier: number;
    if (d < 1000) {
      multiplier = 5;
    } else if (d < 5000) {
      multiplier = 4;
    } else if (d < 15000) {
      multiplier = 3;
    } else if (d < 40000) {
      multiplier = 2;
    } else {
      multiplier = 1.3;
    }
    this.delayMs = Math.min(d * multiplier, this.config.maxDelayMs);
    console.warn(`${this.label} 429 bump: ${Math.round(d)}ms × ${multiplier} = ${Math.round(this.delayMs)}ms`);
  }

  /**
   * MN5 fix (adversarial review): `isCancelled`, when given, makes the wait
   * cancellation-aware -- instead of blocking for the full (up to 120s)
   * backoff delay in one shot, it polls in short slices and resolves as soon
   * as cancellation is observed. Without `isCancelled` this behaves exactly
   * as before (a single delay for the full duration).
   */
  async wait(isCancelled?: () => boolean): Promise<void> {
    if (this.delayMs <= 0) return;
    if (!isCancelled) {
      await delay(this.delayMs);
      return;
    }
    const pollMs = 100;
    const deadline = Date.now() + this.delayMs;
    while (Date.now() < deadline) {
      if (isCancelled()) return;
      await delay(Math.min(pollMs, deadline - Date.now()));
    }
  }

  logSummary(): void {
    console.log(
      `${this.label} rate summary: ${this.totalRequests} requests, ${this.total429s} 429s, final delay ${Math.round(this.delayMs)}ms`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
