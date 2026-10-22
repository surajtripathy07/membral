import { describe, expect, it } from "vitest";

// G2 step 2.1 pin: the runtime export surface of extract.ts. The issue-grounding
// block moves to lib/attribution/grounding.ts and extract.ts re-exports it, so
// this set must stay exactly the same across the move.
describe("extract.ts export surface", () => {
  // 30s: the dynamic import of ../extract can outrun vitest's 5s default under the coverage run (#320).
  it("exports exactly the pinned names", async () => {
    expect(Object.keys(await import("../extract")).sort()).toEqual([
      "MAX_OPEN_BLOCKERS_OFFERED",
      "OPEN_BLOCKER_OFFER_TEXT_CHARS",
      "PROMPT_VERSION",
      "SUB_AGENT_NOTE",
      "USER_PASS_ASSISTANT_CONTEXT_CHARS",
      "buildBlockerReaskPrompt",
      "buildLaterBlockerPrompt",
      "buildUserPassTurns",
      "buildUserPrompt",
      "checkLaterBlockerResolutions",
      "collectUserNamedRefs",
      "evidenceTouchesBlocker",
      "extractUserTurnPass",
      "extractWindow",
      "findResolutionEvidenceTurn",
      "groundMentions",
      "groundSessionIssues",
      "groundWorkedSpan",
      "isForgeRepoIdentity",
      "issueRefNumber",
      "openBlockerLabel",
      "ownerGate",
      "qualifyIssueRef",
      "reaskBlockerResolutions",
      "refQuotedOrDropped",
      "renderOpenBlockersBlock",
      "resolveRecursOf",
      "selectBlockerReaskLines",
      "sessionHasActions",
    ]);
  }, 30_000);
});
