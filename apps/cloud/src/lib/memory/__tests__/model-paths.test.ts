// Prompt v21: a decision's model-named file survives into stored `paths` only
// when grounding sees it in the session and the union filter accepts it.
import { describe, expect, it } from "vitest";
import { computePaths, groundRecord, unionModelPaths } from "../merge";
import type { TurnRow } from "../render";
import type { MemoryRecordParsed } from "../schema";

const REPO = "/work/acme-app";

function turn(o: Partial<TurnRow> & Pick<TurnRow, "idx" | "role" | "kind">): TurnRow {
  return { text: null, tool_name: null, file_path: null, ts: null, props: null, ...o };
}

const TURNS: TurnRow[] = [
  turn({
    idx: 0,
    role: "user",
    kind: "prose",
    text: "keep legacy-build on in build/flags.json, the release script reads it",
  }),
  turn({
    idx: 1,
    role: "assistant",
    kind: "prose",
    text: "Keeping the legacy-build flag on in build/flags.json because the release script reads it on every tag",
  }),
  turn({ idx: 2, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: `${REPO}/src/app.ts` }),
];

function record(o: Partial<MemoryRecordParsed>): MemoryRecordParsed {
  return {
    kind: "decision",
    text: "Keep the legacy-build flag on in build/flags.json: the release script reads it, so do not remove the flag.",
    quote: "Keeping the legacy-build flag on in build/flags.json because the release script reads it",
    turn_idx: 1,
    turn_role: "assistant",
    durable: true,
    paths: [],
    scope: "project",
    confidence: 0.8,
    ...o,
  };
}

/** groundRecord, then the same union tail-capture.ts applies before insert. */
function storedPaths(raw: MemoryRecordParsed): string[] | null {
  const g = groundRecord(raw, TURNS, "v21", 0);
  if (!g) return null;
  return unionModelPaths(computePaths(g.turn_idx, TURNS, REPO), g.paths, REPO);
}

describe("model paths: grounding through the union to the stored row", () => {
  it("keeps a verified decision's path that a session turn shows, after the computed paths", () => {
    expect(storedPaths(record({ paths: ["build/flags.json"] }))).toEqual(["src/app.ts", "build/flags.json"]);
  });

  it("drops a blocker's model path", () => {
    const raw = record({
      kind: "blocker",
      text: "Removing the legacy-build flag waits on the release script owner.",
      paths: ["build/flags.json"],
    });
    expect(storedPaths(raw)).toEqual(["src/app.ts"]);
  });

  it("drops a model path the session never shows", () => {
    expect(storedPaths(record({ paths: ["build/other.json"] }))).toEqual(["src/app.ts"]);
  });

  it("drops an unverified decision's model path", () => {
    expect(
      storedPaths(
        record({ quote: "this text is nowhere in the session at all, not even close", paths: ["build/flags.json"] }),
      ),
    ).toEqual(["src/app.ts"]);
  });
});

describe("unionModelPaths filter", () => {
  it("keeps computed first, dedupes, strips ./", () => {
    expect(unionModelPaths(["a/b.ts"], ["./a/b.ts", " docs/x.md "])).toEqual(["a/b.ts", "docs/x.md"]);
    expect(unionModelPaths(["a.ts", "a.ts"], undefined)).toEqual(["a.ts"]);
  });

  it("rejects URLs, control chars, NUL, over-long, drive letters, UNC, .. and off-repo absolute paths", () => {
    const bad = [
      "https://codehub.example/a.ts",
      "src/a\u0000.ts",
      "src/a\n.ts",
      `src/${"x".repeat(200)}.ts`,
      "C:\\repo\\x.ts",
      "\\\\share\\x",
      "../other/x.ts",
      "src/../../x.ts",
      "/etc/passwd",
      "~/notes.md",
      "",
    ];
    expect(unionModelPaths([], bad, REPO)).toEqual([]);
  });

  it("makes an in-repo absolute path relative, and drops it when the repo is unknown", () => {
    expect(unionModelPaths([], [`${REPO}/build/flags.json`], REPO)).toEqual(["build/flags.json"]);
    expect(unionModelPaths([], [`${REPO}/build/flags.json`])).toEqual([]);
  });

  it("rejects a path that PII redaction would change", () => {
    expect(unionModelPaths([], ["docs/someone@example.com.md"])).toEqual([]);
  });

  it("never grows past 20 paths", () => {
    const computed = Array.from({ length: 19 }, (_, i) => `src/f${i}.ts`);
    expect(unionModelPaths(computed, ["a.ts", "b.ts", "c.ts"])).toHaveLength(20);
  });
});
