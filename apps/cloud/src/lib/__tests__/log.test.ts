import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, log, requestId } from "../log";

/** Capture the single JSON line emitted for a given console method. */
function captureLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const arg = spy.mock.calls[0][0] as string;
  return JSON.parse(arg) as Record<string, unknown>;
}

describe("log", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("JSON shape", () => {
    it("emits one line of JSON with level, msg, ts and extra fields", () => {
      log.info("hello", { foo: 1, bar: "x" });
      const rec = captureLine(logSpy);
      expect(rec.level).toBe("info");
      expect(rec.msg).toBe("hello");
      expect(rec.foo).toBe(1);
      expect(rec.bar).toBe("x");
      expect(typeof rec.ts).toBe("string");
      // ts must be a valid ISO timestamp
      expect(new Date(rec.ts as string).toISOString()).toBe(rec.ts);
    });

    it("routes warn to console.warn and error to console.error", () => {
      log.warn("careful");
      log.error("boom");
      expect(captureLine(warnSpy).level).toBe("warn");
      expect(captureLine(errorSpy).level).toBe("error");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("reserved keys (level/msg/ts) cannot be shadowed by user fields", () => {
      log.info("real", { level: "spoofed", msg: "spoofed", extra: true });
      const rec = captureLine(logSpy);
      expect(rec.level).toBe("info");
      expect(rec.msg).toBe("real");
      expect(rec.extra).toBe(true);
    });
  });

  describe("withContext binding", () => {
    it("binds context fields on every line and merges child context", () => {
      const child = log.withContext({ request_id: "r-1", route: "/api/x" });
      child.info("start", { step: 1 });
      const rec = captureLine(logSpy);
      expect(rec.request_id).toBe("r-1");
      expect(rec.route).toBe("/api/x");
      expect(rec.step).toBe(1);
    });

    it("child logger layers on top of parent context (user_id added later)", () => {
      const base = new Logger({ request_id: "r-2", route: "/api/y" });
      const withUser = base.withContext({ user_id: "u-9" });
      withUser.error("failed", { err: "nope" });
      const rec = captureLine(errorSpy);
      expect(rec.request_id).toBe("r-2");
      expect(rec.route).toBe("/api/y");
      expect(rec.user_id).toBe("u-9");
      expect(rec.err).toBe("nope");
    });

    it("does not mutate the parent logger", () => {
      const base = new Logger({ request_id: "r-3" });
      base.withContext({ user_id: "u-1" });
      base.info("no user bound");
      const rec = captureLine(logSpy);
      expect(rec.request_id).toBe("r-3");
      expect(rec.user_id).toBeUndefined();
    });
  });

  describe("requestId propagation", () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it("passes through an inbound x-request-id header", () => {
      const req = new Request("http://x/api", { headers: { "x-request-id": "trace-abc" } });
      expect(requestId(req)).toBe("trace-abc");
    });

    it("accepts a bare Headers object", () => {
      const h = new Headers({ "x-request-id": "trace-def" });
      expect(requestId(h)).toBe("trace-def");
    });

    it("generates a UUID when no header is present", () => {
      const req = new Request("http://x/api");
      const id = requestId(req);
      expect(id).toMatch(UUID_RE);
    });

    it("generates a UUID when called with nothing", () => {
      expect(requestId()).toMatch(UUID_RE);
    });

    it("accepts an inbound id of exactly 128 safe characters", () => {
      const id = `${"a".repeat(64)}.B-9_${"z".repeat(59)}`;
      expect(id).toHaveLength(128);
      expect(requestId(new Request("http://x/api", { headers: { "x-request-id": id } }))).toBe(id);
    });

    it("replaces an inbound id that is too long or carries unsafe characters", () => {
      for (const bad of ["a".repeat(129), "trace abc", "trace/abc", "<script>", 'a"b', "trace%0d%0a"]) {
        const req = new Request("http://x/api", { headers: { "x-request-id": bad } });
        expect(requestId(req), bad).toMatch(UUID_RE);
      }
    });

    it("ignores a blank inbound header and generates instead", () => {
      const req = new Request("http://x/api", { headers: { "x-request-id": "   " } });
      expect(requestId(req)).toMatch(UUID_RE);
    });
  });
});
