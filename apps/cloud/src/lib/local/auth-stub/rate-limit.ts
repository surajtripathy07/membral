// In-memory sliding-window limiter for the password grant. The stub is local-only and single-process, so no
// shared store is needed; restarting the app resets it, which is fine for a loopback service with one user.
export interface WindowLimiter {
  /** True when the call is allowed (and counted); false when the key is over its limit. */
  hit(key: string, nowMs: number): boolean;
}

export function createWindowLimiter(limit: number, windowMs: number): WindowLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, nowMs) {
      const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(nowMs);
      hits.set(key, recent);
      if (hits.size > 1000) {
        for (const [k, v] of hits) if (v.every((t) => nowMs - t >= windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}
