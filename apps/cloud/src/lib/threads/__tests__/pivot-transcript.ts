// Shared by the D-055 pivot tests: Claude Code JSONL built line by line in the
// shape of the real fixtures, run through the core parser as the CLI does, and
// grounded the way tail-capture hands the extractor's output to groundSessionIssues.
import { claudeCodeParser } from "@membral/core";
import { type GroundedSessionIssue, groundSessionIssues } from "@/lib/memory/extract";
import type { SessionIssueParsed } from "@/lib/memory/schema";

export const GH = "github.com/acme/billing";
export const GL = "codehub.example/acme/billing";

// --- transcript builder ------------------------------------------------------

export type Step = { user: string } | { say: string } | { bash: string; out: string } | { edit: string };

export function jsonl(steps: Step[], gitBranch: string): string {
  const lines: string[] = [];
  let n = 0;
  const base = () => {
    n += 1;
    return {
      uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      timestamp: new Date(Date.UTC(2026, 8, 27, 9, 0, n)).toISOString(),
      cwd: "/home/dev/billing",
      sessionId: "11111111-2222-4333-8444-555555555555",
      gitBranch,
      isSidechain: false,
    };
  };
  const assistant = (content: unknown[]) => ({
    ...base(),
    type: "assistant",
    message: {
      model: "claude-haiku-4-5-20251001",
      id: `msg_${n}`,
      type: "message",
      role: "assistant",
      content,
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  let tool = 0;
  for (const s of steps) {
    if ("user" in s) {
      lines.push(JSON.stringify({ ...base(), type: "user", message: { role: "user", content: s.user } }));
    } else if ("say" in s) {
      lines.push(JSON.stringify(assistant([{ type: "text", text: s.say }])));
    } else {
      tool += 1;
      const id = `toolu_${String(tool).padStart(6, "0")}`;
      const input =
        "bash" in s
          ? { command: s.bash }
          : { file_path: `/home/dev/billing/${s.edit}`, old_string: "a", new_string: "b" };
      lines.push(JSON.stringify(assistant([{ type: "tool_use", id, name: "bash" in s ? "Bash" : "Edit", input }])));
      const out = "bash" in s ? s.out : `The file /home/dev/billing/${s.edit} has been updated.`;
      lines.push(
        JSON.stringify({
          ...base(),
          type: "user",
          message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: out, is_error: false }] },
          toolUseResult: { stdout: out, stderr: "", interrupted: false },
        }),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface Turn {
  idx: number;
  role: string;
  kind: string;
  tool_name: string | null;
  file_path: string | null;
  text: string | null;
  props: { toolUseId?: unknown; action?: unknown; actions?: unknown; inputDigest?: unknown };
}

export function parse(steps: Step[], gitBranch = "main"): Turn[] {
  const s = claudeCodeParser.parse(
    { source: "claude-code", sourceSessionId: "pivot", path: "n/a" },
    jsonl(steps, gitBranch),
  );
  return s.turns.map((t) => ({
    idx: t.idx,
    role: t.role,
    kind: t.kind,
    tool_name: t.toolName ?? null,
    file_path: t.filePath ?? null,
    text: t.text ?? null,
    props: { toolUseId: t.toolUseId, action: t.action, actions: t.actions, inputDigest: t.inputDigest },
  }));
}

/** The user prose turn whose text contains `needle`. */
export function at(turns: Turn[], needle: string): number {
  const t = turns.find((x) => x.role === "user" && x.kind === "prose" && x.text?.includes(needle));
  if (!t) throw new Error(`no user turn with ${needle}`);
  return t.idx;
}

export function issue(
  ref: string,
  quote: string,
  turnIdx: number,
  span?: { from_turn: number; to_turn: number },
): SessionIssueParsed {
  const out: SessionIssueParsed = {
    ref,
    kind: "issue",
    evidence_quote: quote,
    mentions: [{ turn_idx: turnIdx, quote }],
  };
  if (span) out.worked_span = span;
  return out;
}

export function ground(
  turns: Turn[],
  project: string,
  issues: SessionIssueParsed[],
  extra: Partial<Parameters<typeof groundSessionIssues>[3]> = {},
): GroundedSessionIssue[] {
  return groundSessionIssues(issues, turns, project, { actionsVersion: 1, ...extra });
}

export const row = (rows: GroundedSessionIssue[], ref: string, kind: "issue" | "merge_request" = "issue") =>
  rows.find((r) => r.ref === ref && r.kind === kind);
export const ladder = (r: GroundedSessionIssue | undefined) => r && [r.build_verb, r.review_verb, r.tier];

// --- shared command lines ------------------------------------------------------

export const commit = (branch: string, sha: string, subject: string): Step => ({
  bash: `git add -A && git commit -m "${subject}"`,
  out: `[${branch} ${sha}] ${subject}\n 1 file changed, 3 insertions(+), 1 deletion(-)`,
});
export const push = (branch: string): Step => ({
  bash: `git push -u origin ${branch}`,
  out: `To github.com:acme/billing.git\n * [new branch]      ${branch} -> ${branch}\nbranch '${branch}' set up to track 'origin/${branch}'.`,
});
export const ghCreate = (n: number): Step => ({
  bash: `gh pr create --fill`,
  out: `https://github.com/acme/billing/pull/${n}`,
});

export const bothModes = [
  ["inference ON", "1"],
  ["inference OFF", undefined],
] as const;
