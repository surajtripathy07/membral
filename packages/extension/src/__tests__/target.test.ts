import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../common/constants.js";

const store: Record<string, unknown> = {};
const contains = vi.fn();
const request = vi.fn();

vi.stubGlobal("chrome", {
  storage: {
    local: {
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      }),
    },
  },
  permissions: { contains, request },
});

const { normalizeCloudUrl, applyCloudUrl } = await import("../common/target.js");

describe("normalizeCloudUrl", () => {
  it("empty input clears the override", () => {
    expect(normalizeCloudUrl("  ")).toEqual({ ok: true, cleared: true });
  });

  it("reduces to the origin and builds the match pattern", () => {
    expect(normalizeCloudUrl("https://membral.example.com/some/path/")).toEqual({
      ok: true,
      cleared: false,
      url: "https://membral.example.com",
      originPattern: "https://membral.example.com/*",
    });
    expect(normalizeCloudUrl("http://192.168.1.5:3400")).toMatchObject({
      url: "http://192.168.1.5:3400",
      originPattern: "http://192.168.1.5:3400/*",
    });
  });

  it("rejects non-URLs and non-http schemes", () => {
    expect(normalizeCloudUrl("membral.example.com")).toMatchObject({ ok: false });
    expect(normalizeCloudUrl("ftp://membral.example.com")).toMatchObject({ ok: false });
    expect(normalizeCloudUrl("javascript:alert(1)")).toMatchObject({ ok: false });
  });
});

describe("applyCloudUrl", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    contains.mockReset().mockResolvedValue(false);
    request.mockReset().mockResolvedValue(true);
  });

  it("requests host access for the origin, then stores the URL", async () => {
    const result = await applyCloudUrl("https://membral.example.com/x");
    expect(request).toHaveBeenCalledWith({ origins: ["https://membral.example.com/*"] });
    expect(result).toEqual({ ok: true, url: "https://membral.example.com" });
    expect(store[STORAGE_KEYS.CLOUD_URL]).toBe("https://membral.example.com");
  });

  it("skips the prompt when access is already held", async () => {
    contains.mockResolvedValue(true);
    const result = await applyCloudUrl("http://localhost:3000");
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
  });

  it("shows an error and stores nothing when the user refuses", async () => {
    request.mockResolvedValue(false);
    const result = await applyCloudUrl("https://membral.example.com");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("refused");
    expect(STORAGE_KEYS.CLOUD_URL in store).toBe(false);
  });

  it("reports a thrown permission error instead of throwing", async () => {
    request.mockRejectedValue(new Error("boom"));
    expect(await applyCloudUrl("https://membral.example.com")).toMatchObject({ ok: false });
    expect(STORAGE_KEYS.CLOUD_URL in store).toBe(false);
  });

  it("an empty value removes the stored override without a permission request", async () => {
    store[STORAGE_KEYS.CLOUD_URL] = "https://old.example.com";
    expect(await applyCloudUrl("")).toEqual({ ok: true, url: null });
    expect(STORAGE_KEYS.CLOUD_URL in store).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("an invalid value stores nothing and asks for nothing", async () => {
    expect(await applyCloudUrl("nope")).toMatchObject({ ok: false });
    expect(request).not.toHaveBeenCalled();
    expect(STORAGE_KEYS.CLOUD_URL in store).toBe(false);
  });
});
