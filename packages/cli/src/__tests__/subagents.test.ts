import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeParser, subAgentSessionId } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSubAgentFiles } from "../subagents.js";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const transcript = (text: string) =>
  line({
    type: "user",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/demo",
    message: { role: "user", content: text },
  });

describe("readSubAgentFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-subagents-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pair = (where: string, id: string, text: string | null) => {
    mkdirSync(where, { recursive: true });
    writeFileSync(
      join(where, `agent-${id}.meta.json`),
      JSON.stringify({ agentType: "general-purpose", description: id }),
    );
    if (text !== null) writeFileSync(join(where, `agent-${id}.jsonl`), transcript(text));
  };

  it("reads direct agents and workflow agents (subagents/workflows/wf_*), ignoring journals and other dirs", async () => {
    pair(dir, "direct1", "direct one");
    pair(join(dir, "workflows", "wf_abc-001"), "wf1", "workflow one");
    pair(join(dir, "workflows", "wf_def-002"), "wf2", null); // meta without a transcript is tolerated
    writeFileSync(join(dir, "workflows", "wf_abc-001", "journal.jsonl"), line({ type: "launched" }));
    pair(join(dir, "workflows", "not-a-workflow"), "ignored", "x");
    pair(join(dir, "nested", "deeper"), "ignored2", "x");

    const files = await readSubAgentFiles(dir);
    expect(files.map((f) => f.agentId).sort()).toEqual(["direct1", "wf1", "wf2"]);
    expect(files.find((f) => f.agentId === "wf1")?.transcript).toContain("workflow one");
    expect(files.find((f) => f.agentId === "wf2")?.transcript).toBeUndefined();
  });

  it("keeps the first copy of an agent id and returns [] for a missing directory", async () => {
    pair(dir, "dup", "direct copy");
    pair(join(dir, "workflows", "wf_x"), "dup", "workflow copy");
    const files = await readSubAgentFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].transcript).toContain("direct copy");
    expect(await readSubAgentFiles(join(dir, "absent"))).toEqual([]);
  });

  it("links a workflow sub-agent to the parent session like any other sub-agent", async () => {
    pair(join(dir, "workflows", "wf_abc-001"), "wf1", "workflow task");
    const files = await readSubAgentFiles(dir);
    const parentId = "11111111-1111-4111-8111-111111111111";
    const ref = { source: "claude-code", sourceSessionId: parentId, path: "n/a" };
    const parent = claudeCodeParser.parse(ref, "", { subAgents: files });
    const children = claudeCodeParser.parseSubAgentSessions?.(parent, { subAgents: files }) ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].parentSessionId).toBe(parentId);
    expect(children[0].sourceSessionId).toBe(subAgentSessionId(parentId, "wf1"));
    expect(parent.subAgents?.map((s) => s.agentId)).toEqual(["wf1"]);
  });
});

describe("readSubAgentFiles: transcripts without a meta sidecar", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-subagents-unpaired-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deliberately skips a workflow agent jsonl that has no meta.json, and counts it", async () => {
    const wf = join(dir, "workflows", "wf_abc-001");
    mkdirSync(wf, { recursive: true });
    writeFileSync(
      join(wf, "agent-paired.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "p" }),
    );
    writeFileSync(join(wf, "agent-paired.jsonl"), transcript("paired"));
    writeFileSync(join(wf, "agent-orphan.jsonl"), transcript("orphan")); // no agent-orphan.meta.json
    writeFileSync(join(wf, "journal.jsonl"), line({ type: "launched" })); // not an agent file: not counted
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-direct-orphan.jsonl"), transcript("direct orphan"));

    const seen: number[] = [];
    const files = await readSubAgentFiles(dir, (n) => seen.push(n));
    expect(files.map((f) => f.agentId)).toEqual(["paired"]);
    expect(seen).toEqual([2]);
  });

  it("does not call onUnpaired when every agent transcript has its meta", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-a.meta.json"), "{}");
    writeFileSync(join(dir, "agent-a.jsonl"), transcript("a"));
    const seen: number[] = [];
    await readSubAgentFiles(dir, (n) => seen.push(n));
    expect(seen).toEqual([]);
  });
});
