import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockRpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
  })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  checkRateLimit,
  clientIp,
  deviceCodeBucket,
  enforceRateLimit,
  ipBucket,
  ipOrFallbackBucket,
  keyBucket,
  rateLimited,
  resolveRule,
  userBucket,
} from "../rate-limit";

describe("rate-limit util", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean any env overrides between tests.
    delete process.env.RATE_LIMIT_SEARCH;
    delete process.env.RATE_LIMIT_SEARCH_WINDOW;
  });

  describe("bucket-key construction", () => {
    it("builds user / key / ip buckets with a stable shape", () => {
      expect(userBucket("search", "u-1")).toBe("search:user:u-1");
      expect(keyBucket("mcp", "lls_abcd")).toBe("mcp:key:lls_abcd");
      expect(ipBucket("keyfail", "1.2.3.4")).toBe("keyfail:ip:1.2.3.4");
    });
  });

  describe("clientIp", () => {
    it("round-2 review MED 10: prefers x-vercel-forwarded-for over x-forwarded-for (not client-forgeable on Vercel)", () => {
      const req = {
        headers: {
          get: (n: string) => {
            if (n === "x-vercel-forwarded-for") return "9.9.9.9";
            if (n === "x-forwarded-for") return "1.2.3.4, 10.0.0.1"; // a spoof attempt appended-to
            return null;
          },
        },
      };
      expect(clientIp(req)).toBe("9.9.9.9");
    });

    it("round-2 review MED 10: takes the RIGHT-most x-forwarded-for entry (the nearest, least-spoofable hop), not the left-most", () => {
      const req = { headers: { get: (n: string) => (n === "x-forwarded-for" ? "9.9.9.9, 10.0.0.1" : null) } };
      expect(clientIp(req)).toBe("10.0.0.1");
    });

    it("falls back to x-real-ip then 'unknown'", () => {
      const real = { headers: { get: (n: string) => (n === "x-real-ip" ? "5.5.5.5" : null) } };
      expect(clientIp(real)).toBe("5.5.5.5");
      const none = { headers: { get: () => null } };
      expect(clientIp(none)).toBe("unknown");
    });

    it("round-2 review MED 10: buckets an IPv6 address on its /64 prefix, not the full address", () => {
      const req = {
        headers: { get: (n: string) => (n === "x-forwarded-for" ? "2001:db8:1234:5678:aaaa:bbbb:cccc:dddd" : null) },
      };
      expect(clientIp(req)).toBe("2001:db8:1234:5678::/64");

      // A different host portion within the SAME /64 collapses to the same bucket.
      const req2 = {
        headers: { get: (n: string) => (n === "x-forwarded-for" ? "2001:db8:1234:5678:1111:2222:3333:4444" : null) },
      };
      expect(clientIp(req2)).toBe(clientIp(req));
    });

    it("round-2 review MED 10: an IPv4 address is unaffected by IPv6 normalization", () => {
      const req = { headers: { get: (n: string) => (n === "x-real-ip" ? "203.0.113.7" : null) } };
      expect(clientIp(req)).toBe("203.0.113.7");
    });
  });

  describe("deviceCodeBucket", () => {
    it("hashes the deviceCode into the bucket key — never carries the raw secret", () => {
      const bucket = deviceCodeBucket("deviceAuthPoll", "dvc_super-secret-value");
      expect(bucket.startsWith("deviceAuthPoll:code:")).toBe(true);
      expect(bucket).not.toContain("dvc_super-secret-value");
    });

    it("is deterministic for the same deviceCode, distinct for different ones", () => {
      expect(deviceCodeBucket("deviceAuthPoll", "dvc_a")).toBe(deviceCodeBucket("deviceAuthPoll", "dvc_a"));
      expect(deviceCodeBucket("deviceAuthPoll", "dvc_a")).not.toBe(deviceCodeBucket("deviceAuthPoll", "dvc_b"));
    });
  });

  describe("ipOrFallbackBucket", () => {
    it("M1: uses a stable ip bucket for a resolvable IP", () => {
      const req = { headers: { get: (n: string) => (n === "x-forwarded-for" ? "5.5.5.5" : null) } };
      expect(ipOrFallbackBucket("deviceAuthStart", req)).toBe("deviceAuthStart:ip:5.5.5.5");
    });

    it("M1: falls back to a random-ish per-request bucket (never a single shared 'unknown' bucket) when the IP can't be resolved", () => {
      const req = { headers: { get: () => null } };
      const first = ipOrFallbackBucket("deviceAuthStart", req);
      const second = ipOrFallbackBucket("deviceAuthStart", req);
      expect(first.startsWith("deviceAuthStart:ip:unknown:")).toBe(true);
      expect(first).not.toBe(second);
    });
  });

  describe("resolveRule + env override", () => {
    it("uses the coded default when no env is set", () => {
      expect(resolveRule("search")).toEqual({ limit: 60, windowSeconds: 60 });
    });

    it("env overrides a default limit and window", () => {
      process.env.RATE_LIMIT_SEARCH = "5";
      process.env.RATE_LIMIT_SEARCH_WINDOW = "30";
      expect(resolveRule("search")).toEqual({ limit: 5, windowSeconds: 30 });
    });

    it("ignores a garbage/negative env value and keeps the default", () => {
      process.env.RATE_LIMIT_SEARCH = "not-a-number";
      expect(resolveRule("search").limit).toBe(60);
    });

    it("NEW-7: deviceAuthPollIp defaults to 600/min", () => {
      expect(resolveRule("deviceAuthPollIp")).toEqual({ limit: 600, windowSeconds: 60 });
    });

    it("NEW-10: importUpload defaults to 30/min", () => {
      expect(resolveRule("importUpload")).toEqual({ limit: 30, windowSeconds: 60 });
    });
  });

  describe("checkRateLimit", () => {
    it("allowed under the limit, maps RPC snake_case -> camelCase", async () => {
      mockRpc.mockResolvedValueOnce({ data: { allowed: true, retry_after: 0, remaining: 4 }, error: null });
      const res = await checkRateLimit({ bucket: "search:user:u-1", limit: 5, windowSeconds: 60 });
      expect(res).toEqual({ allowed: true, retryAfter: 0, remaining: 4 });
      expect(mockRpc).toHaveBeenCalledWith("rate_limit_check", {
        p_key: "search:user:u-1",
        p_limit: 5,
        p_window_seconds: 60,
      });
    });

    it("blocked over the limit, surfaces retry_after", async () => {
      mockRpc.mockResolvedValueOnce({ data: { allowed: false, retry_after: 42, remaining: 0 }, error: null });
      const res = await checkRateLimit({ bucket: "search:user:u-1", limit: 5, windowSeconds: 60 });
      expect(res).toEqual({ allowed: false, retryAfter: 42, remaining: 0 });
    });

    it("fails OPEN when the RPC errors (limiter outage must not DoS the API)", async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
      const res = await checkRateLimit({ bucket: "b", limit: 5, windowSeconds: 60 });
      expect(res.allowed).toBe(true);
    });
  });

  describe("enforceRateLimit", () => {
    it("resolves the named rule and passes its limit/window to the RPC", async () => {
      process.env.RATE_LIMIT_SEARCH = "7";
      process.env.RATE_LIMIT_SEARCH_WINDOW = "90";
      mockRpc.mockResolvedValueOnce({ data: { allowed: true, retry_after: 0, remaining: 6 }, error: null });
      await enforceRateLimit("search", "search:user:u-1");
      expect(mockRpc).toHaveBeenCalledWith("rate_limit_check", {
        p_key: "search:user:u-1",
        p_limit: 7,
        p_window_seconds: 90,
      });
    });
  });

  describe("rateLimited response", () => {
    it("returns a 429 with a Retry-After header and structured body", async () => {
      const res = rateLimited(30);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("30");
      const body = await res.json();
      expect(body).toEqual({ error: "Rate limit exceeded", retry_after: 30 });
    });
  });
});

// e2e B11: three hand-run sweeps minutes apart all got 429 at 6/hour.
describe("memoryExtractionKick default", () => {
  it("allows a 20-minute sweep plus manual runs every couple of minutes within the hour", () => {
    const prev = process.env.RATE_LIMIT_MEMORY_EXTRACTION_KICK;
    delete process.env.RATE_LIMIT_MEMORY_EXTRACTION_KICK;
    try {
      const rule = resolveRule("memoryExtractionKick");
      expect(rule.windowSeconds).toBe(3600);
      expect(rule.limit).toBeGreaterThanOrEqual(3 + 20);
    } finally {
      if (prev !== undefined) process.env.RATE_LIMIT_MEMORY_EXTRACTION_KICK = prev;
    }
  });
});
