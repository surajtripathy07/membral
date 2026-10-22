// Hand-written model for the `claude-code-rich` fixture: no network, $0.
// Each reply is validated at import time with the production parsers
// (schema.ts ExtractionWire + parseMemoryRecord, LaterBlockerResolutionCheck),
// so a malformed script fails loudly instead of silently extracting nothing.

import { ExtractionWire, LaterBlockerResolutionCheck, parseMemoryRecord } from "@/lib/memory/schema";

/** code_session_turns.idx of the assistant line that carries all three facts (input.jsonl, msg_m2). */
export const RICH_TURN_IDX = 6;

export const SEEDED_DECISION = "Health checks run a SELECT 1 query against the primary database.";
export const SEEDED_BLOCKER = "The /health endpoint times out when the database is slow.";
export const NEW_DECISION = "Health checks use pool.ping() with a 500ms timeout instead of a SELECT 1 query.";
export const NEW_LEARNING = "pool.ping() skips the query planner, so it stays fast when the database is under load.";

const MAIN = {
  records: [
    {
      kind: "decision",
      text: NEW_DECISION,
      quote: "Health checks now use pool.ping() with a 500ms timeout instead of a SELECT 1 query.",
      turn_idx: RICH_TURN_IDX,
      turn_role: "assistant",
      durable: true,
      paths: ["src/routes/health.ts"],
      confidence: 0.9,
    },
    {
      kind: "learning",
      text: NEW_LEARNING,
      quote: "pool.ping() skips the query planner entirely, which is why it stays fast under load.",
      turn_idx: RICH_TURN_IDX,
      turn_role: "assistant",
      durable: true,
      confidence: 0.9,
    },
  ],
  issues: [],
};
const USER_PASS = { records: [] };
const LATER_JUDGE = {
  resolutions: [
    {
      index: 0,
      resolved: true,
      same_problem: true,
      evidence_quote:
        "The readiness probe now answers in under 50ms with a slow database, so the /health timeout is fixed.",
    },
  ],
};

// Fail loudly on a script the production parsers would reject.
ExtractionWire.parse(MAIN);
for (const r of MAIN.records) {
  const p = parseMemoryRecord(r);
  if (!p.success) throw new Error(`script.ts: record rejected by parseMemoryRecord: ${p.error.message}`);
}
ExtractionWire.parse(USER_PASS);
LaterBlockerResolutionCheck.parse(LATER_JUDGE);

/** Picks the reply by the system prompt's opening line; any other call is a script gap and throws. */
export function richScript(body: { messages: Array<{ role: string; content: string }> }): string {
  const system = body.messages.find((m) => m.role === "system")?.content ?? "";
  if (system.startsWith('You extract short "session memory" records')) return JSON.stringify(MAIN);
  if (system.startsWith("You read the OWNER's own messages")) return JSON.stringify(USER_PASS);
  if (system.startsWith("You check whether a coding session resolved any OPEN blockers")) {
    return JSON.stringify(LATER_JUDGE);
  }
  throw new Error(`script.ts: no scripted reply for system prompt ${JSON.stringify(system.slice(0, 80))}`);
}
