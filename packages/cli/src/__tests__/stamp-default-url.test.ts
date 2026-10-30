import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script, no type declarations
import { hostedOrigin, stampDefaultApiUrl } from "../../scripts/stamp-default-url.mjs";
import { DEFAULT_API_URL } from "../credentials";

describe("hostedOrigin", () => {
  it("is undefined outside Vercel, even with NEXT_PUBLIC_APP_URL set", () => {
    expect(hostedOrigin({})).toBeUndefined();
    expect(hostedOrigin({ NEXT_PUBLIC_APP_URL: "https://membral.me" })).toBeUndefined();
  });

  it("uses NEXT_PUBLIC_APP_URL on Vercel, without trailing slashes", () => {
    expect(hostedOrigin({ VERCEL: "1", NEXT_PUBLIC_APP_URL: " https://app.example.com// " })).toBe(
      "https://app.example.com",
    );
  });

  it("falls back to https://membral.me on Vercel", () => {
    expect(hostedOrigin({ VERCEL: "1" })).toBe("https://membral.me");
    expect(hostedOrigin({ VERCEL: "1", NEXT_PUBLIC_APP_URL: "  " })).toBe("https://membral.me");
  });
});

describe("stampDefaultApiUrl", () => {
  const bundle = [
    `var DEFAULT_API_URL = "http://localhost:3000";`,
    `console.log("  --api-url <url>  Server URL (default http://localhost:3000)");`,
    `var url = name === "local" ? "http://localhost:3000" : "<url>";`,
  ].join("\n");

  it("source default stays localhost", () => {
    expect(DEFAULT_API_URL).toBe("http://localhost:3000");
  });

  it("rewrites the default declaration and help text, not the local profile URL", () => {
    const out = stampDefaultApiUrl(bundle, "https://membral.me");
    expect(out).toContain(`var DEFAULT_API_URL = "https://membral.me";`);
    expect(out).toContain("(default https://membral.me)");
    expect(out).toContain(`name === "local" ? "http://localhost:3000"`);
  });

  it("throws when the declaration is missing or duplicated", () => {
    expect(() => stampDefaultApiUrl("var x = 1;", "https://membral.me")).toThrow(/found 0/);
    expect(() => stampDefaultApiUrl(`${bundle}\n${bundle}`, "https://membral.me")).toThrow(/found 2/);
  });
});
