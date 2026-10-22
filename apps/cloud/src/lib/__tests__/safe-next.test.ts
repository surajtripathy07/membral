import { describe, expect, it } from "vitest";
import { safeNext } from "../safe-next";

// Adversarial review round 1, minor m7: safeNext() had no test file of its
// own — its coverage lived entirely as a side effect of exercising
// login()/signup() (actions.test.ts) and 2 payloads in
// auth/callback/route.test.ts. This is the module's own direct coverage;
// it does not replace either of those (they check the value actually gets
// embedded correctly downstream), just gives the validator itself a home.
describe("safeNext", () => {
  it("returns / for null, missing, or non-string input", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("passes through an ordinary same-origin path", () => {
    expect(safeNext("/conversations")).toBe("/conversations");
  });

  it("preserves query and hash on an ordinary path", () => {
    expect(safeNext("/device?code=WM7K-4F2Q")).toBe("/device?code=WM7K-4F2Q");
    expect(safeNext("/ok?next=1#x")).toBe("/ok?next=1#x");
  });

  it.each([
    ["absolute URL", "https://evil.example"],
    ["protocol-relative", "//evil.example"],
    ["many leading slashes", "//////evil.com"],
    ["backslash trick", "/\\evil.com"],
    ["javascript: scheme (no leading slash)", "javascript:alert(1)"],
    ["dot-dot climbing to protocol-relative", "/..//evil.com"],
    ["nested dot-dot climb", "/./..//evil.com"],
    ["percent-encoded raw control char (tab)", "/%09/evil.com"],
    ["raw control char (tab)", "/\t/evil.com"],
    ["raw null byte", "/%00/evil"],
    ["lookalike host via subdomain", "https://membral.me.evil.com/x"],
    ["no leading slash at all", "evil.com"],
  ])("rejects %s (%s) and falls back to /", (_label, payload) => {
    expect(safeNext(payload)).toBe("/");
  });

  it("does not decode percent-encoded slashes into a protocol-relative path (stays a literal, harmless path segment)", () => {
    const out = safeNext("/%2F%2Fevil.com");
    expect(out.startsWith("/")).toBe(true);
    expect(out.startsWith("//")).toBe(false);
  });

  it("keeps a same-host payload embedded in query/fragment out of the host position", () => {
    expect(safeNext("/x?a=//evil")).toBe("/x?a=//evil");
    expect(safeNext("/x#//evil")).toBe("/x#//evil");
  });
});
