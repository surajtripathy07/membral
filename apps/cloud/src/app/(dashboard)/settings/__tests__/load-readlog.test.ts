// G3 step 3B-4a: the settings page's four direct table reads now live in
// `loadSettingsPage` (load.ts). 3B-4b will repoint them to repository
// functions; this drives the loader against a REAL `@membral/test-kit` FakeDb
// and snapshots every `select` chain it issues today, so that move can be
// checked against this read log afterwards. Records what the code does today;
// asserts nothing new.
import { createFakeDb, type FakeDb } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { loadSettingsPage } from "../load";

const USER_ID = "00000000-0000-4000-8000-00000000c0de";

/** `<name>`: only the `select` ops, in order, with `seq` renumbered 1..n (same convention as
 * `apps/cloud/src/__golden__/routes/harness.ts`'s `expectReadLog`). */
async function expectReadLog(db: FakeDb, name: string): Promise<void> {
  const reads = db.oplog.filter((op) => op.op === "select").map((op, i) => ({ ...op, seq: i + 1 }));
  await expect(`${JSON.stringify(reads, null, 2)}\n`).toMatchFileSnapshot(name);
}

describe("/settings load.ts — read log (G3 3B-4a)", () => {
  it("records every select the settings load issues", async () => {
    const db = createFakeDb({
      flavour: "db",
      recordReads: true,
      tables: {
        profiles: [
          {
            id: USER_ID,
            api_key_prefix: "lls_abcd",
            api_key_scope_node_id: null,
            api_key_scope_code_project_id: null,
          },
        ],
        code_projects: [
          {
            id: "5eed0000-0000-4000-8000-000000000001",
            user_id: USER_ID,
            display_name: "CodeHub",
            repo_identity: "codehub/app",
            last_active_at: "2026-09-20T00:00:00.000Z",
          },
        ],
        api_keys: [
          {
            id: "ae110000-0000-4000-8000-000000000001",
            user_id: USER_ID,
            key_prefix: "lls_wxyz",
            label: "laptop",
            created_at: "2026-09-01T00:00:00.000Z",
            last_used_at: null,
            revoked_at: null,
          },
        ],
      },
    });

    const out = await loadSettingsPage(db as unknown as Db, USER_ID);

    expect(out.apiKeyPrefix).toBe("lls_abcd");
    expect(out.lifeAreas).toEqual([]);
    expect(out.codeProjects).toEqual([{ id: "5eed0000-0000-4000-8000-000000000001", label: "CodeHub" }]);
    expect(out.deviceKeys).toHaveLength(1);
    await expectReadLog(db, "./settings-load.readlog.json");
  });
});
