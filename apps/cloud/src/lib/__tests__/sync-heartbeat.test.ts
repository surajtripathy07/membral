import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordChatHeartbeats, recordCodeHeartbeat } from "../sync-heartbeat";

/**
 * A chainable `.from(table).select(...).eq(...).in(...)` + `.upsert(...)`
 * mock — recordChatHeartbeats needs both: the lookup (MINOR 2 fix — preserve
 * an existing last_item_at instead of clobbering it with null) and the
 * final upsert.
 */
function makeSupabaseMock(opts: { existingRows?: { source: string; last_item_at: string | null }[] } = {}) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const inFn = vi.fn().mockResolvedValue({ data: opts.existingRows ?? [], error: null });
  const eq = vi.fn(() => ({ in: inFn }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ upsert, select }));
  return { from, upsert, select, eq, inFn };
}

describe("recordChatHeartbeats", () => {
  it("upserts one row per distinct source, keyed by the max itemAt seen for that source", async () => {
    const { from, upsert } = makeSupabaseMock();
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await recordChatHeartbeats(supabase, "user-1", [
      { source: "claude", itemAt: "2026-07-20T00:00:00.000Z" },
      { source: "claude", itemAt: "2026-07-22T00:00:00.000Z" },
      { source: "claude", itemAt: "2026-07-19T00:00:00.000Z" },
      { source: "chatgpt", itemAt: "2026-07-10T00:00:00.000Z" },
    ]);

    expect(from).toHaveBeenCalledWith("sync_heartbeats");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "user_id,source" });
    const bySource = Object.fromEntries(rows.map((r: { source: string; last_item_at: string }) => [r.source, r]));
    expect(bySource.claude).toMatchObject({
      user_id: "user-1",
      source: "claude",
      last_item_at: "2026-07-22T00:00:00.000Z",
    });
    expect(bySource.chatgpt).toMatchObject({
      user_id: "user-1",
      source: "chatgpt",
      last_item_at: "2026-07-10T00:00:00.000Z",
    });
    expect(rows[0].last_run_at).toBeDefined();
  });

  // ---- Round-3 adversarial review MINOR 2: compare epoch millis, not raw ISO strings ----

  it("picks the chronologically-latest itemAt across mixed timezone-offset formats, not the lexically-largest string", async () => {
    const { from, upsert } = makeSupabaseMock();
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    // Absolute time: the -05:00 timestamp is 2026-07-25T04:00:00Z (LATER);
    // the second is 2026-07-24T23:30:00Z (earlier). Lexically, though,
    // "23:00:00-05:00" < "23:30:00Z" (naive string compare would wrongly
    // keep the earlier one).
    await recordChatHeartbeats(supabase, "user-1", [
      { source: "claude", itemAt: "2026-07-24T23:00:00-05:00" },
      { source: "claude", itemAt: "2026-07-24T23:30:00Z" },
    ]);

    const [rows] = upsert.mock.calls[0];
    expect(rows).toEqual([expect.objectContaining({ source: "claude", last_item_at: "2026-07-24T23:00:00-05:00" })]);
  });

  it("an unparseable itemAt is ignored (not compared, not crashed on) rather than winning by string luck", async () => {
    const { from, upsert } = makeSupabaseMock();
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await recordChatHeartbeats(supabase, "user-1", [
      { source: "claude", itemAt: "not-a-real-date" },
      { source: "claude", itemAt: "2026-07-20T00:00:00.000Z" },
    ]);

    const [rows] = upsert.mock.calls[0];
    expect(rows).toEqual([expect.objectContaining({ source: "claude", last_item_at: "2026-07-20T00:00:00.000Z" })]);
  });

  it("a source whose every itemAt is unparseable still gets a row (null), not silently dropped", async () => {
    const { from, upsert } = makeSupabaseMock();
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: "garbage" }]);

    const [rows] = upsert.mock.calls[0];
    expect(rows).toEqual([expect.objectContaining({ source: "claude", last_item_at: null })]);
  });

  it("no source in the batch carries a timestamp: no lookup needed, and a genuinely new source falls back to null", async () => {
    const { from, upsert, select } = makeSupabaseMock({ existingRows: [] });
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: null }]);

    expect(select).toHaveBeenCalled();
    const [rows] = upsert.mock.calls[0];
    expect(rows).toEqual([expect.objectContaining({ source: "claude", last_item_at: null })]);
  });

  // ---- MINOR 2 fix (adversarial review): preserve, don't clobber ----

  it("preserves the existing last_item_at when this batch carries none for that source", async () => {
    const { from, upsert, inFn } = makeSupabaseMock({
      existingRows: [{ source: "claude", last_item_at: "2026-07-01T00:00:00.000Z" }],
    });
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: null }]);

    expect(inFn).toHaveBeenCalledWith("source", ["claude"]);
    const [rows] = upsert.mock.calls[0];
    expect(rows).toEqual([expect.objectContaining({ source: "claude", last_item_at: "2026-07-01T00:00:00.000Z" })]);
  });

  it("does not look up (or touch) a source that DID carry a batch itemAt, even alongside a source that needs lookup", async () => {
    const { from, upsert, inFn } = makeSupabaseMock({
      existingRows: [{ source: "chatgpt", last_item_at: "2026-06-01T00:00:00.000Z" }],
    });
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await recordChatHeartbeats(supabase, "user-1", [
      { source: "claude", itemAt: "2026-07-20T00:00:00.000Z" },
      { source: "chatgpt", itemAt: null },
    ]);

    expect(inFn).toHaveBeenCalledWith("source", ["chatgpt"]); // claude excluded — it didn't need a lookup
    const [rows] = upsert.mock.calls[0];
    const bySource = Object.fromEntries(rows.map((r: { source: string; last_item_at: string }) => [r.source, r]));
    expect(bySource.claude.last_item_at).toBe("2026-07-20T00:00:00.000Z");
    expect(bySource.chatgpt.last_item_at).toBe("2026-06-01T00:00:00.000Z");
  });

  it("a failed lookup falls back to null but still lets the upsert proceed (never blocks the heartbeat)", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const select = vi.fn(() => {
      throw new Error("boom");
    });
    const from = vi.fn(() => ({ upsert, select }));
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await expect(
      recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: null }]),
    ).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows] = upsert.mock.calls[0];
    expect(rows).toEqual([expect.objectContaining({ source: "claude", last_item_at: null })]);
  });

  it("a lookup that resolves with a Postgres error falls back to null but still upserts", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const inFn = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const eq = vi.fn(() => ({ in: inFn }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ upsert, select }));
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await expect(
      recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: null }]),
    ).resolves.toBeUndefined();
    const [rows] = upsert.mock.calls[0];
    expect(rows).toEqual([expect.objectContaining({ source: "claude", last_item_at: null })]);
  });

  it("is a no-op for an empty items list", async () => {
    const { from } = makeSupabaseMock();
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await recordChatHeartbeats(supabase, "user-1", []);
    expect(from).not.toHaveBeenCalled();
  });

  it("never throws when the upsert returns an error — logs and continues", async () => {
    const { from, upsert } = makeSupabaseMock();
    upsert.mockResolvedValueOnce({ error: { message: "db exploded" } });
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await expect(
      recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: "2026-07-01T00:00:00.000Z" }]),
    ).resolves.toBeUndefined();
  });

  it("never throws when the upsert call itself rejects — logs and continues", async () => {
    const { from, upsert } = makeSupabaseMock();
    upsert.mockRejectedValueOnce(new Error("connection refused"));
    const supabase = { from } as unknown as Parameters<typeof recordChatHeartbeats>[0];

    await expect(
      recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: "2026-07-01T00:00:00.000Z" }]),
    ).resolves.toBeUndefined();
  });

  it("never throws when supabase.from itself is missing/throws (e.g. an under-mocked test client)", async () => {
    const supabase = {} as unknown as Parameters<typeof recordChatHeartbeats>[0];
    await expect(
      recordChatHeartbeats(supabase, "user-1", [{ source: "claude", itemAt: null }]),
    ).resolves.toBeUndefined();
  });
});

describe("recordCodeHeartbeat", () => {
  let upsert: ReturnType<typeof vi.fn>;
  let from: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    upsert = vi.fn().mockResolvedValue({ error: null });
    from = vi.fn().mockReturnValue({ upsert });
  });

  it("upserts a single 'code' row with last_run_at set and no last_item_at", async () => {
    const supabase = { from } as unknown as Parameters<typeof recordCodeHeartbeat>[0];
    await recordCodeHeartbeat(supabase, "user-1");

    expect(from).toHaveBeenCalledWith("sync_heartbeats");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "user_id,source" });
    expect(rows).toEqual([expect.objectContaining({ user_id: "user-1", source: "code" })]);
    expect(rows[0].last_run_at).toBeDefined();
  });

  it("never throws when the upsert fails", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "db exploded" } });
    const supabase = { from } as unknown as Parameters<typeof recordCodeHeartbeat>[0];
    await expect(recordCodeHeartbeat(supabase, "user-1")).resolves.toBeUndefined();
  });

  it("never throws when the upsert call rejects", async () => {
    upsert.mockRejectedValueOnce(new Error("connection refused"));
    const supabase = { from } as unknown as Parameters<typeof recordCodeHeartbeat>[0];
    await expect(recordCodeHeartbeat(supabase, "user-1")).resolves.toBeUndefined();
  });
});
