// G3 step 3B-6a: the conversation detail page's reads now live in
// `loadConversationPage` (load.ts). This drives the loader against a REAL
// `@membral/test-kit` FakeDb and snapshots every `select` chain it issues today
// — found (conversations → memories) and missing (conversations → service-role
// existence check) — so the Conversation repository move can be checked against
// this read log afterwards. Records what the code does today; asserts nothing new.
import { createFakeDb, type FakeDb } from "@membral/test-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/types";

// The existence check uses the service-role client; point it at the same FakeDb
// so its select lands in the same ordered read log.
const service = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/clients", () => ({ tryServiceClient: () => service.db }));

import { loadConversationPage } from "../load";

const USER_ID = "00000000-0000-4000-8000-00000000c0de";
const CONV_ID = "c0de0000-0000-4000-8000-000000000001";
const OTHER_ID = "c0de0000-0000-4000-8000-000000000002";

/** `<name>`: only the `select` ops, in order, with `seq` renumbered 1..n (same convention as
 * `apps/cloud/src/__golden__/routes/harness.ts`'s `expectReadLog`). */
async function expectReadLog(db: FakeDb, name: string): Promise<void> {
  const reads = db.oplog.filter((op) => op.op === "select").map((op, i) => ({ ...op, seq: i + 1 }));
  await expect(`${JSON.stringify(reads, null, 2)}\n`).toMatchFileSnapshot(name);
}

function seed(): FakeDb {
  return createFakeDb({
    flavour: "db",
    recordReads: true,
    tables: {
      conversations: [
        {
          id: CONV_ID,
          user_id: USER_ID,
          source: "chatgpt",
          title: "Planning the CodeHub release",
          created_at: "2026-09-20T00:00:00.000Z",
          updated_at: "2026-09-20T00:00:00.000Z",
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          metadata: {},
        },
      ],
      memories: [
        {
          id: "3e300000-0000-4000-8000-000000000001",
          user_id: USER_ID,
          type: "fact",
          content: "Ships CodeHub on Fridays",
          confidence: 0.9,
          source_conversation_ids: [CONV_ID],
        },
      ],
    },
  });
}

describe("/conversations/[id] load.ts — read log (G3 3B-6a)", () => {
  beforeEach(() => {
    service.db = null;
  });

  it("records every select for a found conversation", async () => {
    const db = seed();
    service.db = db;
    const out = await loadConversationPage(db as unknown as Db, USER_ID, CONV_ID);

    expect(out.kind).toBe("found");
    if (out.kind === "found") {
      expect(out.conversation.id).toBe(CONV_ID);
      expect(out.memories).toHaveLength(1);
    }
    await expectReadLog(db, "./conversation-load.found.readlog.json");
  });

  it("records the service-role existence check for a missing conversation", async () => {
    const db = seed();
    service.db = db;
    const out = await loadConversationPage(db as unknown as Db, USER_ID, OTHER_ID);

    expect(out).toEqual({ kind: "missing", exists: false });
    await expectReadLog(db, "./conversation-load.missing.readlog.json");
  });
});
