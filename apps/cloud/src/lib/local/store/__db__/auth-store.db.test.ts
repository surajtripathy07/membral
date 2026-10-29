// createRpcStore (the GoTrue-protocol stub's persistence) on the real store.
import { beforeAll, describe, expect, it } from "vitest";
import { getServiceClient } from "@/lib/db/clients";
import { type AuthStore, createRpcStore } from "@/lib/local/auth-stub/store";
import { openDb } from "../../../../../test/db-store";

let store: AuthStore;
beforeAll(async () => {
  await openDb();
  store = createRpcStore(getServiceClient());
}, 300_000);

describe("createRpcStore", () => {
  it("create, find by email and id, duplicate email, list", async () => {
    const email = `auth-${crypto.randomUUID()}@codehub.test`;
    const made = await store.create({ email, passwordHash: "hash", userMetadata: { name: "Dev" }, confirmed: true });
    expect(made).not.toBe("email_exists");
    const id = (made as { id: string }).id;
    const byEmail = await store.findByEmail(email);
    expect(byEmail?.id).toBe(id);
    expect(byEmail?.encrypted_password).toBe("hash");
    expect((await store.findById(id))?.email).toBe(email);
    expect(await store.create({ email, passwordHash: "x", userMetadata: {}, confirmed: true })).toBe("email_exists");
    const page = await store.list(1, 5);
    expect(page.total).toBeGreaterThan(0);
    expect(Array.isArray(page.users)).toBe(true);
    await store.recordSignIn(id);
    expect((await store.findById(id))?.last_sign_in_at).not.toBeNull();
  });
  it("refresh tokens: insert, rotate, reuse of a spent token, revoke", async () => {
    const email = `rt-${crypto.randomUUID()}@codehub.test`;
    const id = ((await store.create({ email, passwordHash: "h", userMetadata: {}, confirmed: true })) as { id: string })
      .id;
    const sid = crypto.randomUUID();
    const t0 = `t0-${sid}`;
    const t1 = `t1-${sid}`;
    await store.insertRefresh({ token: t0, userId: id, sessionId: sid, parent: null });
    const rot = await store.rotateRefresh(t0, t1);
    expect(rot).toMatchObject({ userId: id, token: t1 });
    // A parallel refresh within the reuse interval shares the live child.
    expect((await store.rotateRefresh(t0, `t2-${sid}`))?.token).toBe(t1);
    expect(await store.rotateRefresh("no-such-token", "n")).toBeNull();
    await store.revoke(id, "global", null);
    expect(await store.rotateRefresh(t1, `t3-${sid}`)).toBeNull();
  });
});
