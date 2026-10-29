import { describe, expect, it } from "vitest";
import { parseQuery } from "../parse";
import { insertSql } from "../sql";

describe("insertSql ignore-duplicates", () => {
  const rows = [{ a: 1 }];
  const result = { mode: "count" } as const;
  it("emits no ON CONFLICT clause without a primary key or on_conflict", () => {
    const { sql } = insertSql("t", rows, parseQuery([]), { resolution: "ignore-duplicates", pk: [] }, result);
    expect(sql).not.toMatch(/on conflict/i);
  });
  it("targets the primary key when there is one", () => {
    const { sql } = insertSql("t", rows, parseQuery([]), { resolution: "ignore-duplicates", pk: ["id"] }, result);
    expect(sql).toMatch(/on conflict \("id"\) do nothing/i);
  });
});
