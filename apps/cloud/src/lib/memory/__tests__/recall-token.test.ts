import { beforeEach, describe, expect, it } from "vitest";
import { mintRecallToken, verifyRecallToken } from "../recall-token";

describe("recall-token", () => {
  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";
  });

  it("mints a token that verifies back to the same userId/projectId/mintedAt", () => {
    const mintedAt = new Date("2026-09-13T12:00:00.000Z");
    const token = mintRecallToken("user-1", "project-1", mintedAt);
    const payload = verifyRecallToken(token);
    expect(payload).toEqual({ userId: "user-1", projectId: "project-1", mintedAt: mintedAt.toISOString() });
  });

  it("mints a valid token for a null project (no project resolved yet)", () => {
    const token = mintRecallToken("user-1", null);
    expect(verifyRecallToken(token)).toMatchObject({ userId: "user-1", projectId: "" });
  });

  it("rejects a tampered payload (verification is statelessly checkable, not just decodable)", () => {
    const token = mintRecallToken("user-1", "project-1");
    const [version, body, mac] = token.split(".");
    const forged = `${version}.${Buffer.from(JSON.stringify({ u: "attacker", p: "project-1", t: new Date().toISOString() })).toString("base64url")}.${mac}`;
    expect(verifyRecallToken(forged)).toBeNull();
    void body;
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintRecallToken("user-1", "project-1");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "a-different-secret";
    expect(verifyRecallToken(token)).toBeNull();
  });

  it("returns null for malformed input rather than throwing", () => {
    expect(verifyRecallToken(undefined)).toBeNull();
    expect(verifyRecallToken(null)).toBeNull();
    expect(verifyRecallToken("")).toBeNull();
    expect(verifyRecallToken("not-a-token")).toBeNull();
    expect(verifyRecallToken("v1.onlytwoparts")).toBeNull();
    expect(verifyRecallToken("v2.a.b")).toBeNull(); // wrong version
  });
});
