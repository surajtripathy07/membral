// Goal 2026-09-26 P9 / W10 — minePatterns is deterministic and bounded.
import { describe, expect, it } from "vitest";
import { digestPrefix, minePatterns, type PatternTurn, stepLabel } from "../mine";

const bash = (digest: string, ts?: string): PatternTurn => ({ tool_name: "Bash", props: { inputDigest: digest }, ts });
const edit = (path: string, ts?: string): PatternTurn => ({ tool_name: "Edit", file_path: path, ts });
const read = (path: string): PatternTurn => ({ tool_name: "Read", file_path: path });

/** npm test → Edit ts → git commit, with reads sprinkled in. */
const habit = (day: number): PatternTurn[] => [
  read("src/a.ts"),
  bash("npm test -- --run", `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`),
  edit("src/a.ts"),
  edit("src/b.ts"),
  bash("git commit -m 'fix'", `2026-09-${String(day).padStart(2, "0")}T10:30:00Z`),
];

describe("minePatterns", () => {
  it("a sequence repeated in three sessions is a pattern; one repeated in two is not (minSessions 3)", () => {
    const patterns = minePatterns(
      {
        s1: habit(1),
        s2: habit(2),
        s3: habit(3),
        // `glab mr view → Edit md → git push` only twice
        s4: [bash("glab mr view 17"), edit("README.md"), bash("git push")],
        s5: [bash("glab mr view 18"), edit("NOTES.md"), bash("git push origin main")],
      },
      { minSessions: 3 },
    );
    expect(patterns.map((p) => p.steps)).toEqual([["npm test", "Edit ts", "git commit"]]);
    expect(patterns[0].sessionCount).toBe(3);
    expect(patterns[0].sessionIds).toEqual(["s3", "s2", "s1"]);
    expect(patterns[0].lastSeenAt).toBe("2026-09-03T10:30:00Z");
    expect(patterns[0].key).toBe("npm test → Edit ts → git commit");
  });

  it("at most three patterns per project are kept", () => {
    const seqs = [
      ["npm test", "Edit ts", "git commit"],
      ["gh pr view", "Edit md", "git push"],
      ["pytest", "Edit py", "git commit"],
      ["cargo test", "Edit rs", "git push"],
      ["go test", "Edit go", "git commit"],
    ];
    const input: Record<string, PatternTurn[]> = {};
    seqs.forEach((seq, si) => {
      // Each distinct sequence in 3 + si sessions so the ranking is unambiguous.
      for (let k = 0; k < 3 + si; k++) {
        input[`p${si}-s${k}`] = [bash(seq[0]), edit(`x.${seq[1].slice(5)}`), bash(seq[2])];
      }
    });
    const patterns = minePatterns(input, { minSessions: 3 });
    expect(patterns).toHaveLength(3);
    expect(patterns.map((p) => p.sessionCount)).toEqual([7, 6, 5]);
    expect(patterns[0].steps).toEqual(["go test", "Edit go", "git commit"]);
  });

  it("a sub-sequence with the same support as a longer kept pattern is not listed twice", () => {
    const input: Record<string, PatternTurn[]> = {};
    for (let k = 0; k < 4; k++) {
      input[`s${k}`] = [bash("npm test"), edit("a.ts"), bash("git commit -m x"), bash("git push")];
    }
    const patterns = minePatterns(input, { minSessions: 3, maxPatterns: 10 });
    expect(patterns).toHaveLength(1);
    expect(patterns[0].steps).toEqual(["npm test", "Edit ts", "git commit", "git push"]);
  });

  it("consecutive edits collapse and the same sequence twice in one session counts once", () => {
    const twice = [...habit(1), ...habit(1)];
    const patterns = minePatterns({ s1: twice, s2: habit(2), s3: habit(3) }, { minSessions: 3 });
    expect(patterns[0].sessionCount).toBe(3);
  });

  it("no tool turns, no forge tools → no patterns and no error (B12)", () => {
    expect(minePatterns({}, { minSessions: 3 })).toEqual([]);
    expect(minePatterns({ s1: [{ tool_name: null }], s2: [read("x")] }, { minSessions: 1 })).toEqual([]);
  });
});

describe("stepLabel / digestPrefix", () => {
  it("normalises digests to first token + subcommand and edits to their extension", () => {
    expect(digestPrefix("cd /repo && npm test -- --run src")).toBe("npm test");
    expect(digestPrefix("git commit -m 'msg' && git push")).toBe("git commit");
    expect(digestPrefix("glab mr view 17 --web")).toBe("glab mr view");
    expect(digestPrefix("gh pr create --fill")).toBe("gh pr create");
    expect(digestPrefix("pytest -q tests/")).toBe("pytest");
    expect(digestPrefix("   ")).toBeNull();
    expect(stepLabel(edit("apps/cloud/src/x.tsx"))).toBe("Edit tsx");
    expect(stepLabel({ tool_name: "Write", file_path: "Makefile" })).toBe("Edit");
    expect(stepLabel({ tool_name: "Bash", props: {} })).toBe("Bash");
    expect(stepLabel({ tool_name: "Agent", props: { inputDigest: "scout the tests" } })).toBe("Agent");
    expect(stepLabel(read("a"))).toBeNull();
  });
});

describe("digestPrefix drops env assignments (F15)", () => {
  it("PGPASSWORD=x psql … is `psql`, never the secret", () => {
    expect(digestPrefix("PGPASSWORD=hunter2 psql -h localhost -c 'select 1'")).toBe("psql");
    expect(digestPrefix("A=1 B=2 npm test -- --run")).toBe("npm test");
    expect(digestPrefix("env NODE_ENV=test npx vitest run")).toBe("npx vitest");
    expect(digestPrefix("FOO=bar")).toBeNull();
  });
});
