// Landing copy. Every factual sentence here traces to a file in this repo; the
// SOURCES block below lists each one. Change a sentence only together with the
// source it cites. The page states no money, speed-up or percentage figure of any kind
// (maintainer ruling 2026-10-10; goal docs/goals/2026-10-10_landing-readme-value-conveyance_goal.md).
// The page cites as reader-openable sources only public paths (scripts/public-tree/build-public-tree.sh drops
// docs/design, docs/goals, docs/DECISIONS.md, docs/PRODUCT.md); a private path appears only inside an agent's own
// verbatim words.
//
// SOURCES (sentence -> file)
// Hero
// - HEADLINE: the tagline's key words (docs/PRODUCT.md "Tagline", README.md line 3), shortened; the same short
//   form is the description of packages/cli and apps/cloud (package.json).
// - HERO_FOR: defines "session" in plain words; the agents setup connects (README.md "Harnesses";
//   packages/core/src/sessions/registry.ts:15-26).
// - HERO_EXCHANGE roles: "Added the 504 retry" = the without answer adds a retry for the 504 (a gateway
//   timeout; the with quote below names the 504) on import (demos/without-membral-answer.png, PAIR.without.said); "Kept the decision" = the with
//   answer left the rule in place (PAIR.with.said).
//   "With Membral" text: PAIR.with.said, verbatim from the first two sentences of the recorded answer, which go on
//   ", and you chose to keep that." (~/.membral/demos/with-without/import-504-retry-with.cast); the cut ends in an
//   ellipsis.
//   "Without Membral" text: PAIR.without.said, verbatim from demos/without-membral-answer.png (the first words of
//   the without final answer).
// - HERO_ALTERNATIVE (the page's one rules-file contrast): a rules file holds what someone wrote into it
//   (CLAUDE.md is read every session); Membral's records are extracted from sessions, nobody writes them: README.md
//   "What it does"; "enough when the answer is there; the agent did slightly worse with Membral (control task 4 vs 5 facts, resume task 3 vs 4)":
//   2026-10-09-power-value.md "Where Membral does NOT help a power user" (questions the user's own docs answer).
// The outage (OUTAGE)
// - asked: tasks.json, task outage-recall, "prompt", verbatim.
// - without: the final answer of run outage-recall-A-1, loop 3 (runs/2026-10-09-loop3/outage-recall-A-1/
//   stream.jsonl, last "result" event; the runs folder is gitignored), its first two sentences and its
//   sentence "Any account I gave you ... would be invented.", verbatim.
// - with: the final answer of run outage-recall-B-5, loop 3 (same folder), verbatim sentences: "We restarted the
//   production Supabase Postgres through the Supabase management API."; "No." (after "Could we have restored
//   from a backup?"); "[WAL-G was enabled, but] there were no restore points. Restoring wasn't an option, and a
//   restart was the only recovery available." (the bracketed words are cut, marked […]: they name a backup tool
//   and add no fact the reader needs); "...from roughly 06:50 to 07:29 UTC on Oct 1." (cut before it:
//   "About 40 minutes,", a duration, left out); its caveat "These come from recorded session notes. I haven't
//   checked Supabase's own logs or status history." The sentence naming the production project reference is not
//   quoted. Cuts are marked […].
// - "Nothing in the repository or its git history recorded it": `git grep -E '06:50|07:29|restore points|wedged'
//   825901d` (the frozen sha) finds no incident record, and `git show 825901d:docs/HANDOFF.md` has no outage
//   entry (claim research 2026-10-10); run A-1's own search of docs and git history found none.
// - Auto memory: both arms ran in a fresh scratch HOME with Claude Code's auto memory empty (A-1: "my memory
//   directory is empty"); on the developer's own machine that memory did hold a note on the incident (written
//   2026-10-01).
// - Counts, every recorded set: results/2026-10-10-hand-recount.md (hand recount of every final answer, 5 runs x
//   2 arms x 4 sets; supersedes the regex-scored rubric counts for the restart fact): said restarted, not restored,
//   without 0/5 in each set, with 5/5 in each set (baseline, final, loop2, loop3). "Some found only part": loop 3
//   B1 and B4 scored 1 of 4 rubric facts; some gave only a lower bound for the downtime (hand recount, caveats).
// The pair (import-504-retry)
// - PAIR_LEDE "membral import uploads a chat export file": packages/cli/src/help.ts (import command). "Earlier
//   sessions decided ... and wrote that rule into the code": tasks.json import-504-retry ground_truth
//   (sessions of 2026-10-05/06; the 5 October session built the per-endpoint retry table in api-client.ts).
//   "Both agents could read it": the rule is in the repository both recorded sessions ran in
//   (packages/cli/src/lib/api-client.ts, the `status === 504 && !idempotent` check beside RULE4_BACKOFF). "The one without Membral read it and changed it": its recorded
//   answer (demos/without-membral-answer.png) edits the retry policy and the design note that held the rule.
//   "The one with Membral got the earlier decision with its reason and kept it": demos/with-membral-answer.png
//   and the recorded answer (PAIR.with.said).
// - PAIR_QUOTE: the final answer of run import-504-retry-A-1, loop 3 (runs/2026-10-09-loop3, gitignored),
//   verbatim: "your repo documented the old behaviour as a deliberate decision, not an oversight." and
//   "I went ahead anyway"; a repeat of the same request without Membral (loop 3: 3 of 5 runs without Membral
//   added the retry, 2 stopped and asked: hand recount).
// - PAIR_TITLE "In this recording": the pair is one take per side; across four sets 11 of 20 runs without Membral
//   and 15 of 20 with Membral did not add the retry (hand recount).
// - Frame crop (visibleHeight): the rows below are Claude Code's slash-command menu, visible in both stills; the
//   without still is also cut after "The change" (its Tests rows carry the recording's mouse pointer).
// - Run.excerpt: transcribed verbatim from demos/without-membral-answer.png and demos/with-membral-answer.png.
// - Pair prompt, verbatim: scripts/eval/with-without/tasks.json, task import-504-retry, "prompt".
// - Pair quotes: without, verbatim from demos/without-membral-answer.png: "membral import now retries a 504
//   within its existing 5xx budget". With, verbatim from the recorded answer: "I didn't add a retry for the 504.
//   Earlier sessions deliberately decided against one", and from demos/with-membral-answer.png.
// - Still/clip dimensions: with 1028x268, without 1028x616.
// - RULE "The decision" / "Why": packages/cli/src/lib/api-client.ts:749 (`status === 504 && !idempotent`, import
//   is not idempotent); rubric fact "no-retry-reason" in tasks.json ("server may have saved the first attempt,
//   not idempotent"); the with answer: "the server may have already saved this batch".
// - RULE "In the code": api-client.ts:749 and packages/cli/src/lib/__tests__/api-client.policy.test.ts:706
//   ("a 504 is not retried for import").
// - TEST_LIMITS: one repository, one developer, Claude Code only: 2026-10-09-power-value.md (limits) and
//   2026-10-09-value.md ("Method"); the import request, 5 runs per side in four sets: the four results files
//   above; "9 of 20 without, 5 of 20 with added the retry anyway": results/2026-10-10-hand-recount.md table (b)
//   (per set without / with: 3/1, 1/0, 2/3, 3/1); "in one set more runs with Membral changed the import code":
//   2026-10-09-loop2.md summary row
//   import-504-retry, wasted work without 2 vs with 3; "a rule that lived only in a document": 2026-10-09-value.md
//   "Where Membral does NOT help" (queue-env-accessors: both sides converted the file in 5 of 5 runs).
// How it works
// - Saved when a session ends, automatically, set up per agent: README.md "Install in detail" (Claude Code
//   hooks, an opencode plugin, Copilot CLI hooks, Codex CLI config); packages/cli/src/setup.ts summary lines.
// - Setup brings in the last 30 days: README.md "Install".
// - Decisions, findings, outcomes, each with the quote and a link to the session: README.md "What it does".
// - The lookup that arrives with a request is Claude Code only: packages/cli/src/setup.ts:90 and :504 (the
//   UserPromptSubmit recall hook is installed for Claude Code only); every connected agent gets MCP search
//   (setup.ts:678, :692; Codex :625; Copilot :572) and a session-start note (Claude Code :504, Copilot :558,
//   Codex :625, opencode :447). Every eval ran in Claude Code only (2026-10-09-power-value.md limits).
// What it is not
// - Not a live view; it gives the link and the agent checks: README.md "Not for".
// - The rules-file contrast is told once, in HERO_ALTERNATIVE.
// Privacy (consistent with apps/cloud/src/app/privacy/page.tsx and its SOURCES block)
// - What is uploaded, tool output not kept, written text kept and capped: packages/core/src/sessions/claude-code.ts
//   (tool results stay elided; written text capped by WRITTEN_TEXT_MAX_CHARS).
// - Secret redaction by pattern: packages/core/src/sessions/redact.ts ("Conservative secret redaction").
//   Files like .env, keys and credentials keep no text: SENSITIVE_FILE_BASENAMES in claude-code.ts.
// - Per-project choice at setup: packages/cli/src/sync-allowlist.ts (~/.membral/sync.json), help.ts setup step 4.
// - Outage lede "Supabase, a hosted Postgres service": the database the quoted answer names (OUTAGE.with).
// - Supabase Postgres, row-level security, the operator holds the admin key and can technically read stored
//   data: privacy/page.tsx "Where it is stored" (migrations 029:184-199, 084:173-181; lib/db/clients.ts:21).
// - Extraction on by default, server sends session text from the last 30 days to a hosted model provider under
//   the operator's key: apps/cloud/src/lib/feature-flags.ts:508-513, lib/memory/extraction-queue.ts:109,
//   lib/llm/config.ts:68-115; claude-code-provider.ts:47-48 refuses on Vercel.
// - Delete = the whole account, from Settings; one session cannot be deleted yet:
//   apps/cloud/src/app/api/account/delete/route.ts:1-16; privacy/page.tsx "Not available yet".
// - Local: Docker; nothing leaves the machine except model calls; Docker Compose 2.23+ and Node 22.5+;
//   `membral local up`; claude-code provider needs `claude setup-token`; with no model, import, session pages,
//   search and MCP still work but nothing is extracted: README.md "Run it locally"; docs/SELF-HOSTING.md:3-4.
//   The image does not include Claude Code; the first start downloads the pinned version from npm into a volume
//   (apps/cloud/docker/entrypoint.sh:8-13, apps/cloud/docker/claude-cli/install.sh, packages/cli/src/local-stack.ts CLAUDE_CLI_VOLUME).
// - LOCAL_IMAGE_NOTE: the ghcr.io package "is published at the public launch"; until then build from a clone:
//   docs/SELF-HOSTING.md "The image"; .github/workflows/image.yml publishes only when vars.PUBLISH_IMAGE is 'true'.
// FAQ
// - Agents (Claude Code, opencode, GitHub Copilot CLI + VS Code Copilot Chat, Codex CLI): README.md "Harnesses";
//   packages/core/src/sessions/registry.ts:15-26. Request-time lookup Claude Code only and tests in Claude Code
//   only: see How it works above.
// - Any MCP client can search: README.md "Status" ("MCP tools ... for any MCP-speaking client").
// - Which model reads the sessions: see Privacy above; local choices: README.md "Run it locally" and
//   docs/SELF-HOSTING.md section 2 (claude-code, a hosted key, Ollama; none = nothing extracted).
// - Teams: no team or admin controls exist in apps/cloud/src (accounts are single-user); each developer installs
//   with their own account: README.md "Install in detail".
// - Open source, MIT: LICENSE.
// Start
// - The command clones the repository and installs the CLI (apps/cloud/src/lib/install-command.ts); `membral local up` runs setup: setup steps (sign in, scan agents,
//   choose projects, first import, MCP): packages/cli/src/help.ts "membral setup".
// - Node 22.5 or newer: packages/cli/package.json "engines". Built from packages/cli: apps/cloud/package.json
//   "prebuild" (packages/cli/scripts/pack.mjs --out public/membral-cli.tgz). MIT: LICENSE.
// - membral status "shows your account, this device and what synced last": packages/cli/src/help.ts ("status").
// - What you see next (Claude Code): each prompt-recall line starts `[<kind> · <age> · session <first 8 of the
//   id>]` (apps/cloud/src/lib/memory/prompt-recall.ts renderPromptRecallLine; ageText in lib/domain/age.ts);
//   sessions are listed at membral.me (apps/cloud/src/app/(dashboard)/code).
// - START.sample: the real line shape `[<kind> · <age> · session <8 chars>] <text> → <ref_url>` (renderPromptRecallLine,
//   prompt-recall.ts:182-188; ageText gives "2d ago") with the example's decision text (RULE); the age, "abcd1234"
//   and the example.com link are placeholders, labelled as examples in sampleLabel.
// - Start step 2: sign-in opens the browser (login-command.ts:146); setup then shows the project checklist in the
//   terminal, all boxes checked for new projects (setup.ts:191-217, :415) and connects the agents it finds.
// - Antigravity: setup installs its hooks and MCP entry when its install root exists (setup.ts:511-521); sessions
//   are parsed (packages/core/src/sessions/agy.ts, registry.ts:15-26).
// - Claude Code plugin alternative (two /plugin commands, needs an API key from Settings): README.md "Install".

export const REPO_URL = "https://github.com/surajtripathy07/membral";
export const README_INSTALL_URL = `${REPO_URL}#run-it-locally`;
export const PROOF_URL = `${REPO_URL}#proof`;
export const PROOF_LABEL = "README, Proof";

// The h1. The 2026-11-06 redesign copy below (everything after the PAIR/RULE blocks) is a DRAFT awaiting the
// owner's approval; each string is one line to edit. Sources for the new strings:
// - Fig. 1 caption and leader: the recorded import-504-retry run (see "The pair" above); 2026-10-08.
// - Fig. 2: the hand recount, results/2026-10-10-hand-recount.md (5 runs x 2 arms; 5/5 vs 0/5).
// - Fig. 3 measured row: the 2026-11-06 latency run (prompt-recall p50 88 ms, p95 192 ms, 30 calls; store of 2,536
//   main sessions and 302,385 excerpts), recorded in the build brief; full method belongs on /proof.
// - Fig. 4 record: a real record from the maintainer's store (session 39322882, turn 33, as of 2026-10-29).
// - Start steps: README.md "Run it locally", steps 1 to 4.
export const HEADLINE = "Your coding agent can answer from what your past sessions found.";

// The full proof: a question only past sessions could answer, as a text receipt (shown on /proof).
export const OUTAGE = {
  title: "An outage nobody wrote down in the repository.",
  lede: "Earlier sessions handled an outage of the production database (Supabase, a hosted Postgres service). Nothing in the repository or its git history recorded it. We asked about it in Claude Code, in that repository:",
  askedLabel: "The question",
  asked:
    "The prod database went unresponsive last week. What did we actually do to get it back, could we have restored from a backup instead, and how long were we down?",
  without: {
    label: "Without Membral",
    lines: [
      "I can't answer this from what's available to me. I found no record of the outage.",
      "[…] Any account I gave you of what was done, whether a restore would have worked, or the downtime would be invented.",
    ],
  },
  with: {
    label: "With Membral",
    lines: [
      "We restarted the production Supabase Postgres through the Supabase management API.",
      "Could we have restored from a backup? No. […] there were no restore points. Restoring wasn't an option, and a restart was the only recovery available.",
      "[…] from roughly 06:50 to 07:29 UTC on Oct 1.",
      "[…] These come from recorded session notes. I haven't checked Supabase's own logs or status history.",
    ],
  },
  limitsLabel: "What this does and does not show",
  limits: [
    "The question was run 5 times per side in four recorded sets. No run without Membral said the database was restarted rather than restored; every run with Membral did (5 of 5 in each of the four sets), and some found only part of the answer.",
    "Both sides ran with Claude Code's own memory empty. On the developer's machine, that memory did hold a note on the outage.",
    "The two answers above are quoted from one run per side; […] marks a cut.",
  ],
};

export type Run = {
  label: string;
  /** One plain-words verdict beside the still. */
  verdict: string;
  /** The agent's own words from its final answer, verbatim, readable without the still. */
  said: string;
  /** Alt text for the still: what the agent's final answer says. */
  alt: string;
  /** Short clip of the moment the agent answers, cut from the recording. */
  clip: { mp4: string; webm: string; poster: string };
  /** Real pixel size of the still and clip, for layout without shift. */
  size: { width: number; height: number };
  /**
   * Rows of the frame shown, from the top. Below them the recording shows Claude Code's slash-command menu
   * (/cd, /copy), which is not part of the answer, and in the without frame a line cut mid-sentence.
   */
  visibleHeight: number;
  /**
   * The frame's text, transcribed verbatim from the still, shown as real text under 640 px instead of the
   * image (which would be too small to read there). "[…]" marks lines left out.
   */
  excerpt: string;
  /** True when `said` is already the start of `excerpt`, so the phone layout does not print it twice. */
  saidInExcerpt: boolean;
};

export const PAIR_TITLE = "A rule that was written down. In this recording, one agent overrode it anyway.";

// Verbatim prompt of the frozen task (tasks.json, import-504-retry), typed into both recorded sessions.
export const PAIR_PROMPT = "membral import sometimes fails with a 504. Add a retry for it, with tests.";

export const PAIR_NOTE = "Recorded in Claude Code, same repository, one take per side.";

// The point of the pair in plain words, above the two takes. The rule itself is told once, in RULE.
export const PAIR_LEDE =
  "Here the rule was in the code. The membral import command uploads a chat export file to the server. Earlier sessions decided it must not re-send an import after a 504, a server timeout, and wrote that rule into the code. Both agents could read the rule and the design note that gives its reason. The one with Membral also got the earlier sessions' decision with the request, and kept it.";

// A repeat run of the same request without Membral, in its own words (SOURCES: PAIR_QUOTE).
export const PAIR_QUOTE = {
  label: "The same request again, without Membral",
  text: "…your repo documented the old behaviour as a deliberate decision, not an oversight. […] I went ahead anyway…",
};

export const PAIR: { without: Run; with: Run } = {
  without: {
    label: "Without Membral",
    verdict: "Read the rule, then changed it and added the retry.",
    said: "membral import now retries a 504 within its existing 5xx budget",
    alt: "Recorded Claude Code session. Final answer: membral import now retries a 504 up to 3 times, with new tests.",
    clip: {
      mp4: "/demos/without-membral-answer-12s.mp4",
      webm: "/demos/without-membral-answer-12s.webm",
      poster: "/demos/without-membral-answer.webp",
    },
    size: { width: 1028, height: 616 },
    // Through "The change" (ends at row ~340). The "Tests" and "Setup gaps" rows below are cut: they add no
    // point to the comparison, and the recording's mouse pointer sits on the "a 200" in the Tests rows.
    visibleHeight: 352,
    excerpt:
      'membral import now retries a 504 within its existing 5xx budget (3 attempts, with the rule-4 backoff). The three tests I added or changed pass. […]\n\nThe change\n- Policy: packages/cli/src/lib/api-client.ts has a new retry504 field on the endpoint policy, set only for import. A forced upload still returns the 504 without a retry.\n- Timeouts: a client timeout on import is still not retried.\n- Design note: docs/design/cli-api-client-contract.md now says import opts in to the 504 retry. It still records the quota and "already stored" race as an accepted risk.\n[…]',
    saidInExcerpt: true,
  },
  with: {
    label: "With Membral",
    verdict: "Got the earlier decision with its reason, left the retry out, and said why.",
    said: "I didn't add a retry for the 504. Earlier sessions deliberately decided against one",
    alt: "Recorded Claude Code session, final answer, starting at 'Instead, a 504 on membral import now exits with a clear message': the agent left the retry out because earlier sessions decided against one; the server may already have saved the batch.",
    clip: {
      mp4: "/demos/with-membral-answer-12s.mp4",
      webm: "/demos/with-membral-answer-12s.webm",
      poster: "/demos/with-membral-answer.webp",
    },
    size: { width: 1028, height: 268 },
    visibleHeight: 222,
    excerpt:
      'Instead, a 504 on membral import now exits with a clear message: "Import timed out on the server (504). It is not re-sent automatically because the server may have already saved this batch — check your dashboard, then re-run membral import if it is missing." Before, it only printed Import failed: 504 <body>.\n\n- Code: the new message is in postImportBatch in packages/cli/src/import-command.ts.\n- Test: a new test in import-command.test.ts checks that a 504 sends one request, exits 1 and prints that message.\n[…]',
    saidInExcerpt: false,
  },
};

// The rule both agents could read, with links to the exact lines. Sources: SOURCES "RULE".
export const RULE = {
  title: "The rule both agents could read",
  found: [
    {
      label: "The decision",
      text: "An import is never re-sent after a 504.",
    },
    {
      label: "Why",
      text: "A 504 means the server ran out of time, but it may already have saved the batch. Sending it again could store it twice.",
    },
  ],
  code: {
    label: "In the code",
    rule: {
      text: "packages/cli/src/lib/api-client.ts:749",
      href: `${REPO_URL}/blob/main/packages/cli/src/lib/api-client.ts#L749`,
    },
    test: {
      text: "api-client.policy.test.ts:706",
      href: `${REPO_URL}/blob/main/packages/cli/src/lib/__tests__/api-client.policy.test.ts#L706`,
    },
  },
};

export const TEST_LIMITS =
  "What we do not know yet: these tests used one repository and one developer's sessions, all in Claude Code. The import request was run 5 times per side in four recorded sets. In those sets, 9 of 20 runs without Membral and 5 of 20 with Membral added the retry anyway, and in one set more runs with Membral than without changed the import code. Where a rule lived only in a document, Membral did not change what the agent did.";

// Setup's 30 days: README.md "Install" (the link).

// ---- Landing copy (draft, 2026-11-06) ----

export const NAV = {
  proof: "Proof",
  github: "GitHub",
  cta: "Run it locally",
  skip: "Skip to the content",
};

export const HERO = {
  kicker: "a recorded Claude Code session",
  sub: "Membral keeps your Claude Code, Codex, opencode and Copilot sessions on your machine. Your agent looks them up, including what nobody wrote down.",
  needs: "Needs Node 22.5 or newer and Docker.",
  readLink: "Read what it runs",
  caption:
    "Asked to add a retry for a 504, the agent finds that earlier sessions decided against one and keeps that decision. It improves the error message and its test instead. Recorded 2026-10-08 in Claude Code; condensed and replayed here in about 9\u00a0s. ",
  captionLink: "Watch both recordings",
  leader: "decided in sessions of 5–6 Oct 2026",
  transcriptPrompt: "membral import sometimes fails with a 504. Add a retry for it, with tests.",
};

export const OUTAGE_FIG = {
  heading: "Asked about a past outage, the agent with Membral had the fact in 5 of 5 runs. Without it, 0 of 5.",
  with: { label: "with Membral", hits: 5 },
  without: { label: "without", hits: 0 },
  total: 5,
  caption: "Same model, same prompt, five runs each. Answers recounted by hand on 2026-10-10. ",
  captionLink: "Method and recordings",
};

export const STORE_FIG = {
  heading: "Every harness writes to one store, starting with what is already on your disk.",
  body: "Claude Code, Codex, opencode and Copilot sessions land in one Postgres store on your machine. On day one it imports the last 30 days of sessions you already have. Your agent searches it over MCP, and in Claude Code each prompt gets a lookup before the agent answers.",
  harnesses: ["Claude Code", "Codex", "opencode", "Copilot"],
  store: "one store",
  storeSub: "Postgres, on your machine",
  agent: "your agent",
  agentSub: "MCP search, per-prompt lookup",
  measured:
    "Per-prompt lookup on a store of 2,536 sessions and 302,385 excerpts: 88 ms median, 192 ms p95 over 30 calls. Measured 2026-11-06 on one laptop.",
};

export const HANDOFF = {
  kicker: "the handoff note",
  heading: "Pick up where the last session stopped, without writing a handoff.",
  body: "Every session leaves a handoff note, written by Membral from what the session did. The next session gets it on resume, and any later session can find it by search. No file to write, nothing to remember.",
  rows: [
    { k: "Written by", v: "Membral, from the session's own records" },
    { k: "When", v: "after the session is processed" },
    { k: "Served", v: "when Claude Code resumes or compacts" },
    { k: "Found", v: "by search from any later session" },
    { k: "Your part", v: "nothing" },
  ],
};

export const RECORD_FIG = {
  kicker: "one record from a real store",
  heading: "It is yours: a Postgres database on your machine, MIT licensed.",
  command: "membral local up",
  after:
    " runs the store in Docker on 127.0.0.1. It is plain Postgres you can query yourself. Secrets in common formats, such as API keys, tokens and private keys, are redacted before a session is stored. Switch agents and the memory stays.",
  fields: [
    {
      k: "said",
      v: "“Do not use --all, --force or --full for this. --full re-sends everything in scope, and --force also re-queues extraction.”",
      quote: true,
    },
    { k: "kind", v: "decision", quote: false },
    { k: "as of", v: "2026-10-29", quote: false },
    { k: "harness", v: "Claude Code", quote: false },
    { k: "source", v: "session 39322882 · turn 33", quote: false },
    { k: "stored in", v: "membral-local-db, a Docker volume on this machine", quote: false },
  ],
};

export const CHATS = {
  kicker: "chats in the same store",
  heading: "Your chats too, and any agent you use next.",
  body: "The Chrome extension saves your ChatGPT and Claude.ai chats into the same store, so your coding agent can find what you worked out in a chat. The memory belongs to you, not to one tool, so it serves whichever agent you use, at work or outside it.",
  // the same facts as the body, as table rows
  rows: [
    { k: "Saved by", v: "the Chrome extension" },
    { k: "From", v: "ChatGPT and Claude.ai chats" },
    { k: "Into", v: "the same store as your sessions" },
    { k: "Found by", v: "your coding agent" },
    { k: "Belongs to", v: "you, not to one tool" },
    { k: "Serves", v: "whichever agent you use, at work or outside it" },
  ],
};

// Mirrors README.md "Run it locally". Step 1 points back to the hero's install command (one copy button on the page).
export const START = {
  heading: "Run it locally.",
  prereq:
    "Node 22.5 or newer, Docker. Extraction runs on your own Claude Code login, or on any OpenAI-compatible endpoint you set, including a local one.",
  steps: [
    {
      title: "Install the CLI from a clone.",
      body: "This builds it and installs it globally. Use the command at the top of this page.",
      link: { text: "Show the command", href: "#install" },
    },
    {
      title: "Pick an extraction model.",
      body: "Put one choice in ~/.membral/local/.env (run mkdir -p ~/.membral/local first):",
      options: [
        {
          label: "Claude subscription",
          code: "CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token>",
          note: "When claude is on your PATH and no other choice is set, up selects the claude-code provider for you.",
        },
        { label: "API key", code: "OPENAI_API_KEY=...", note: "Or OPENROUTER_API_KEY." },
        {
          label: "Ollama",
          code: "OLLAMA_CONTEXT_LENGTH=16384 ollama serve",
          note: "A 7B+ model such as qwen2.5:7b, run with this.",
        },
      ],
    },
    {
      title: "Start it.",
      code: "membral local up",
      body: "Add --embeddings ollama to use Ollama's nomic-embed-text instead of the bundled model. It starts three containers: Postgres with pgvector, PostgREST, and the Membral app, at http://localhost:3000.",
    },
    {
      title: "Check it.",
      code: "membral local status",
      body: "It prints an Embeddings line.",
    },
  ],
  noteCommand: "membral local up",
  note: " prints a sign-in URL, a password and an API key. Treat that output as a secret.",
  remove: "membral local down --wipe deletes the store.",
  signup: { text: "Or create an account first", href: "/signup" },
};

export const FAQ: { q: string; a: string }[] = [
  {
    q: "I already keep a CLAUDE.md. Why this?",
    a: "Keep it. CLAUDE.md holds what you chose to write down. Membral holds what your sessions found and decided that nobody wrote down, and your agent looks it up when a question needs it.",
  },
  {
    q: "Can't my agent grep old transcripts?",
    a: "It can try. Transcripts are long, split by tool and full of tool output. Membral pulls out decisions, learnings and outcomes, dates each one, links it to its source turn, and searches by meaning and by keyword.",
  },
  {
    q: "Won't old memories go stale?",
    a: "Each result shows when it was recorded, and replaced records are hidden by default. Live state, like PR status or CI, is never answered from memory: the agent gets the link and checks.",
  },
  {
    q: "Will my agent actually use it?",
    a: "In Claude Code, each prompt gets a lookup before the agent answers, so relevant records arrive without a tool call. That is how the run in Fig. 1 worked. Other harnesses search over MCP, with a short instruction file telling the agent when to.",
  },
  {
    q: "What leaves my machine?",
    a: "The store runs on your machine. Extraction sends session text to the model you configure: your Claude Code login, or an endpoint you choose, which can be local.",
  },
  {
    q: "How much setup is it?",
    a: "Node 22.5 or newer, Docker, and the two commands above. membral local down --wipe removes everything it stored.",
  },
];

export const TEAMS = {
  heading: "Want one memory across a team?",
  body: "Write to founder@membral.me. We want to build it with the first teams who need it.",
  linkText: "Email founder@membral.me",
  href: "mailto:founder@membral.me?subject=Membral%20for%20our%20team",
};

export const CLOSING = { cta: "Run it locally", github: "GitHub" };

export const FOOTER = { email: "founder@membral.me", emailHref: "mailto:founder@membral.me" };

// ---- /proof, the 404 page and the share image (second pass, 2026-11-06) ----
// Draft copy awaiting the owner's approval. Sources:
// - PROOF_P1 sets and method: scripts/eval/with-without/results/2026-10-10-hand-recount.md (a) outage-recall: the
//   four sets (baseline 2026-10-08, final, loop2, loop3 on 2026-10-09), 0/5 vs 5/5 in each, what counted as a hit,
//   both arms in a fresh home with an empty Claude Code memory. Model: results/2026-10-09-value.md ("Headless Claude
//   Code on sonnet").
// - PROOF_P3: the 2026-11-06 latency run recorded in the build brief (research_notes/membral-me/60-brief.md,
//   "/proof"): endpoints, 10 fixed prompts, 1 discarded warm-up pass, 3 timed passes, sequential, a new connection
//   per call; the store counts and the machine as measured on that day.

export const PROOF_PAGE = {
  kicker: "Proof",
  heading: "Recorded runs, with and without Membral",
  lede: "Three figures, each with the method used to produce it and what it does not show. P1 is a question only past sessions could answer. P2 is the same request recorded twice in Claude Code. P3 is how long a lookup takes, and how it was timed.",
  toc: [
    { href: "#outage", label: "Fig. P1 · outage recall" },
    { href: "#pair", label: "Fig. P2 · the recorded pair" },
    { href: "#latency", label: "Fig. P3 · lookup time" },
  ],
  cta: "Run it locally",
};

export const PROOF_P1 = {
  label: "recounted by hand",
  with: "with Membral",
  without: "without",
  runsOf: "runs",
  sets: [
    { name: "Set 1 · 2026-10-08", without: 0, with: 5 },
    { name: "Set 2 · 2026-10-09", without: 0, with: 5 },
    { name: "Set 3 · 2026-10-09", without: 0, with: 5 },
    { name: "Set 4 · 2026-10-09", without: 0, with: 5 },
  ],
  total: 5,
  caption:
    "Each square is one run. Filled means the final answer said the database was restarted rather than restored. Across the four sets: 0 of 20 runs without Membral, 20 of 20 with. Recounted by hand on 2026-10-10.",
  method: [
    { k: "Model", v: "Claude Code, headless, on its sonnet model. The same for both sides." },
    { k: "Prompt", v: "The question above, word for word, in every run." },
    { k: "Runs", v: "5 per side in each of 4 sets, so 20 per side." },
    { k: "Memory", v: "Every run started in a fresh home directory with Claude Code's own memory empty." },
    { k: "Recount", v: "2026-10-10. Every final answer was read in full, not matched by pattern." },
    {
      k: "A hit",
      v: 'The answer says the database was restarted rather than restored. A negated or hypothetical mention, such as "a restart might have helped", does not count.',
    },
  ],
};

export const PROOF_P2 = {
  label: "the recorded pair",
  promptLabel: "Prompt, typed into both sessions",
  ruleLabels: { rule: "The rule", test: "Its test" },
  readmeLead: "The recounted results, in the README (the full eval harness lives in a private lab): ",
  limitsLabel: "What the pair does not show",
};

export const PROOF_P3 = {
  label: "measured on one laptop",
  heading: "On a store of 2,536 sessions, the per-prompt lookup takes 88 ms at the median.",
  body: "An agent reaches the store two ways: the lookup Claude Code runs on each prompt, and the MCP memory_search tool the agent calls itself. Both were timed against the same store.",
  scaleNote: "Bars share one scale. Longest bar: 1,753 ms.",
  rows: [
    { endpoint: "POST /api/memory/prompt-recall", note: "per-prompt lookup", p50: 88, p95: 192 },
    { endpoint: "MCP memory_search", note: "tool call", p50: 1017, p95: 1753 },
  ],
  max: 1753,
  caption: "Median (p50) and 95th percentile (p95) over 30 timed calls per endpoint. Measured 2026-11-06.",
  method: [
    { k: "Endpoints", v: "POST /api/memory/prompt-recall and MCP memory_search." },
    { k: "Prompts", v: "10 fixed prompts." },
    { k: "Passes", v: "1 warm-up pass, discarded. Then 3 timed passes, so 30 timed calls per endpoint." },
    { k: "Order", v: "Sequential, with a new connection for each call." },
    { k: "Store", v: "2,536 main sessions, 222,642 turns, 4,860 records, 302,385 excerpts." },
    { k: "Machine", v: "Apple M1 Max, 32 GB. Docker VM with 6 CPU and 14 GB." },
    { k: "Date", v: "2026-11-06." },
    { k: "Limits", v: "The maintainer's own store. Other load on the laptop was not isolated." },
  ],
};

export const NOT_FOUND = {
  label: "Fig. 0 · no record",
  line: "Nothing was recorded at this address.",
  link: "Back to the logbook",
};

export const OG_IMAGE = {
  alt: "Membral: your coding agent can answer from what your past sessions found.",
  prompt: "membral import sometimes fails with a 504. Add a retry for it, with tests.",
  figLabel: "Fig. 1",
  answerLine: "I didn't add a retry for the 504.", // the first line of the recorded answer, verbatim
};
