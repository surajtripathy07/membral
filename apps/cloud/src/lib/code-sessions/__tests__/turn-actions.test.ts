import { describe, expect, it } from "vitest";
import { digestFirstLine, readTurnObserved, turnActionViews } from "../turn-actions";
import { shapeTurnRow } from "../view";

const PROJECT = "github.com/acme/api";

function views(props: Record<string, unknown>, project: string | null = PROJECT) {
  return turnActionViews(readTurnObserved(props).actions, project);
}

describe("readTurnObserved", () => {
  it("reads actions (all of a chain) and the redacted digest", () => {
    const r = readTurnObserved({
      action: { verb: "committed", source: "cli", refKind: "commit", sha: "abcdef1234" },
      actions: [
        { verb: "committed", source: "cli", refKind: "commit", sha: "abcdef1234" },
        { verb: "pushed", source: "cli", refKind: "branch", ref: "main" },
      ],
      inputDigest: "git commit -m ‹text› && git push",
    });
    expect(r.actions.map((a) => a.verb)).toEqual(["committed", "pushed"]);
    expect(r.inputDigest).toBe("git commit -m ‹text› && git push");
  });

  it("drops a repoUnknown action, same as attribution", () => {
    expect(
      readTurnObserved({ action: { verb: "commented", source: "cli", ref: "#3", refKind: "issue", repoUnknown: true } })
        .actions,
    ).toEqual([]);
  });

  it("empty on missing props", () => {
    expect(readTurnObserved(null)).toEqual({ actions: [], inputDigest: null });
  });

  it("shapeTurnRow carries them only on tool_use rows", () => {
    const props = { toolUseId: "t1", action: { verb: "viewed", source: "cli", ref: "#1", refKind: "issue" } };
    const base = { idx: 1, role: "assistant", text: null, tool_name: "Bash", file_path: null, ts: null, props };
    expect(shapeTurnRow({ ...base, kind: "tool_use" }).actions).toHaveLength(1);
    expect(shapeTurnRow({ ...base, kind: "prose" }).actions).toBeUndefined();
  });
});

describe("turnActionViews", () => {
  it("bare #N is qualified onto the session's project and linked", () => {
    expect(views({ action: { verb: "commented", source: "cli", ref: "#145", refKind: "issue" } })).toEqual([
      {
        verb: "commented on",
        target: { text: "acme/api#145", href: "https://github.com/acme/api/issues/145", mono: true },
      },
    ]);
  });

  it("a hosted GitHub MR spelled with ! reads as #N (PR) and links", () => {
    const [v] = views({
      action: { verb: "viewed", source: "cli", ref: "github.com/fleetco/fleet!52400", refKind: "merge_request" },
    });
    expect(v).toEqual({
      verb: "viewed",
      target: { text: "fleetco/fleet#52400", href: "https://github.com/fleetco/fleet/issues/52400", mono: true },
    });
  });

  it("a non-GitHub host is plain text, MR reads !N", () => {
    const [v] = views(
      {
        action: { verb: "opened_mr", source: "cli", ref: "codehub.example/acme/billing!17", refKind: "merge_request" },
      },
      "codehub.example/acme/billing",
    );
    expect(v).toEqual({ verb: "opened MR", target: { text: "acme/billing!17", href: null, mono: true } });
  });

  it("no project and a bare ref: plain text, never guessed", () => {
    const [v] = views({ action: { verb: "commented", source: "cli", ref: "#9", refKind: "issue" } }, null);
    expect(v.target).toEqual({ text: "#9", href: null, mono: true });
  });

  it("opened PR on GitHub, push and commit read as git did", () => {
    const vs = views({
      actions: [
        { verb: "committed", source: "cli", refKind: "commit", sha: "abcdef1234", branch: "fix-1" },
        { verb: "pushed", source: "cli", refKind: "branch", ref: "fix-1" },
        {
          verb: "opened_mr",
          source: "cli",
          ref: "acme/api#7",
          refKind: "merge_request",
          url: "https://github.com/acme/api/pull/7",
        },
      ],
    });
    expect(vs.map((v) => `${v.verb} ${v.target?.text ?? ""}`.trim())).toEqual([
      "committed abcdef1 to fix-1",
      "pushed to fix-1",
      "opened PR acme/api#7",
    ]);
    expect(vs[2].target?.href).toBe("https://github.com/acme/api/issues/7");
  });

  it("folds identical phrases and says 'ran tests' for a test run", () => {
    const a = { verb: "viewed", source: "cli", ref: "#1", refKind: "issue" };
    expect(views({ actions: [a, a] })).toHaveLength(1);
    expect(views({ action: { verb: "tested", source: "cli" } })).toEqual([{ verb: "ran tests", target: null }]);
  });
});

describe("digestFirstLine", () => {
  it("first line only, capped", () => {
    expect(digestFirstLine("gh issue comment 145\nsecond")).toBe("gh issue comment 145");
    expect(digestFirstLine("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
    expect(digestFirstLine(null)).toBeNull();
  });
});
