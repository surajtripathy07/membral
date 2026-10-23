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
// - RULE "The decision" / "Why": packages/cli/src/lib/api-client.ts:681 (`status === 504 && !idempotent`, import
//   is not idempotent); rubric fact "no-retry-reason" in tasks.json ("server may have saved the first attempt,
//   not idempotent"); the with answer: "the server may have already saved this batch".
// - RULE "In the code": api-client.ts:681 and packages/cli/src/lib/__tests__/api-client.policy.test.ts:696
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
export const SELF_HOSTING_DOC_URL = `${REPO_URL}/blob/main/docs/SELF-HOSTING.md`;
export const SELF_HOSTING_URL = `${SELF_HOSTING_DOC_URL}#the-image`;

// The headline uses the tagline's key words (README line 3, PRODUCT.md), shortened to fit the hero.
export const HEADLINE = "Your coding agent can answer from what your past sessions found.";

// The hero holds the headline, the install button and one real exchange from the recorded pair below: the
// request as typed (cut after "for it") and how each agent's answer begins, all verbatim, each cut marked by an
// ellipsis (<= 50 words in all, counted by the landing eval harness, kept outside this repo in the maintainer's
// extract-search-lab/landing-eval).
// The request itself ("Add a retry for it") is quoted in full in the pair section; the hero has no room for it
// beside the whole With sentence, the two role labels and HERO_FOR (<= 50 words).
export const HERO_FOR = "Sessions are your chats with Claude Code, Codex, opencode or Copilot.";

export const HERO_EXCHANGE: { label: string; role: string; text?: string; kind: "without" | "with" }[] = [
  {
    label: "Without Membral",
    role: "Added the 504 retry",
    text: "“…import now retries a 504”",
    kind: "without",
  },
  {
    label: "With Membral",
    role: "Kept the decision",
    text: "“I didn't add a retry for the 504. Earlier sessions deliberately decided against one, and you chose to keep that.”",
    kind: "with",
  },
];

// In the landing's proof block, after the outage result: the page's one comparison with a rules file, the
// alternative a reader already has.
export const HERO_ALTERNATIVE =
  "A rules file such as CLAUDE.md, which your agent reads every session, holds only what someone wrote into it. If the answer is already there, that file is enough; on such questions in our tests, the agent did slightly worse with Membral. Membral holds what past sessions found and decided, and you write none of it.";

// The landing's one compact proof block; the full outage receipt and the recorded pair live on /proof.
// Sources: README.md lines 9-11 and "Proof" ("no run without Membral said the database was restarted rather than
// restored. All five runs with Membral did, in every set."; "Limits: some runs with Membral gave only a lower bound
// for the downtime"; "both sides ran with that memory empty"), the same counts as OUTAGE.limits below
// (results/2026-10-10-hand-recount.md). Sentences joined, no number added.
// The block also quotes three of OUTAGE.with.lines verbatim (the restart, the time window, the caveat):
// sections.tsx ProofTeaser picks them, so no outage sentence is written twice.
export const PROOF_TEASER = {
  lines: [
    "Asked how production was brought back after the database stopped responding, no run without Membral said the database was restarted rather than restored.",
    "All five runs with Membral did, in every one of four recorded sets.",
    "Limits: some runs with Membral gave only a lower bound for the downtime, and both sides ran with Claude Code's own memory empty.",
  ],
  link: "See the recorded runs",
};

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
      text: "packages/cli/src/lib/api-client.ts:681",
      href: `${REPO_URL}/blob/main/packages/cli/src/lib/api-client.ts#L681`,
    },
    test: {
      text: "api-client.policy.test.ts:696",
      href: `${REPO_URL}/blob/main/packages/cli/src/lib/__tests__/api-client.policy.test.ts#L696`,
    },
  },
};

export const TEST_LIMITS =
  "What we do not know yet: these tests used one repository and one developer's sessions, all in Claude Code. The import request was run 5 times per side in four recorded sets. In those sets, 9 of 20 runs without Membral and 5 of 20 with Membral added the retry anyway, and in one set more runs with Membral than without changed the import code. Where a rule lived only in a document, Membral did not change what the agent did.";

// Setup's 30 days: README.md "Install" (the link).
export const HOW_IT_WORKS: { step: string; body: string; link?: { text: string; href: string } }[] = [
  {
    step: "It saves each session",
    body: "When a session ends it is uploaded automatically; setup arranges that for each agent it finds. Setup also brings in your last 30 days.",
    link: { text: "Install steps in the README", href: README_INSTALL_URL },
  },
  {
    step: "It keeps what mattered",
    body: "Decisions, findings and outcomes, each with the quote it came from and a link back to the session.",
  },
  {
    step: "Your agent looks it up",
    body: "In Claude Code, past decisions that match your request arrive with it. In every agent setup connects, the agent can search for more.",
  },
];

export const CHATS: {
  title: string;
  points: { term: string; body: string }[];
  link: { text: string; href: string };
} = {
  title: "Your chats too",
  points: [
    {
      term: "A Chrome extension saves them",
      body: "It saves your ChatGPT and Claude.ai conversations to your Membral account while you use them in the browser.",
    },
    {
      term: "Your agents can search them",
      body: "The same tools that find past coding sessions also find past chats: search_conversations, get_conversation and list_recent_conversations.",
    },
    {
      term: "Found by their words",
      body: "Search matches the words in your chats, so an agent can pull up what you discussed without extra setup.",
    },
  ],
  link: { text: "Chrome extension setup", href: "/setup" },
};

export const NOT_THIS: { term: string; body: string }[] = [
  {
    term: "Not a live view of your pull requests, tests or deploys.",
    body: "It says what a past session found and gives the link; the agent checks the current state itself.",
  },
];

export const PRIVACY = {
  uploaded: [
    "What you typed, what the agent wrote back, and which files and tools it used. That includes code the agent wrote.",
    "The output of the tools it ran, such as file reads and command output, is not kept for Claude Code sessions.",
    "Text shaped like a key, token or password is replaced with [REDACTED] before it is stored, and writes to files like .env or private keys keep no text. This works by known patterns, so a secret in an unusual shape can get through.",
    "At setup you choose which projects to sync; a project you leave out stays on your machine.",
  ],
  local: [
    "All of it runs in Docker on your machine with membral local up. Nothing leaves it except the calls extraction makes to the model you choose. With your own Claude Code login (it needs a token from claude setup-token), that includes Claude Code's own traffic to Anthropic, and the first start downloads Claude Code from npm onto your machine; the image does not include it. With a local Ollama model, nothing leaves your machine at all.",
    "You need Docker (Compose 2.23 or newer) and Node 22.5 or newer.",
  ],
};

export const LOCAL_IMAGE_NOTE =
  "The app image is published with the public launch; until then, build it from a clone first:";

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Which agents work with it?",
    a: "Setup connects Claude Code, opencode, GitHub Copilot (CLI and VS Code Copilot Chat), Codex CLI and Antigravity: their sessions are saved, and each can search them. Past decisions arrive with your request only in Claude Code, and Claude Code is the only agent we have tested. Any other agent that supports MCP, a standard way for agents to use outside tools, can search too.",
  },
  {
    q: "Which model reads the sessions?",
    a: "You pick, when you start the stack on your machine: your Claude Code login, a hosted model with your key, or a local Ollama model. With none, import, session pages and search still work; nothing is extracted.",
  },
  {
    q: "Can my team use it?",
    a: "Each developer installs it with their own account, and their agent looks up their own sessions. Not there yet: team or admin controls, or one shared store for a team.",
  },
  {
    q: "Does it capture ChatGPT and Claude.ai chats?",
    a: "Yes. The Chrome extension saves them as you use them in the browser, and your agents can search them next to your coding sessions.",
  },
  {
    q: "Do my chats leave my machine?",
    a: "The extension sends them to your own local Membral, at http://localhost:3000 by default. They stay on your machine.",
  },
  {
    q: "Is it open source?",
    a: "Yes, under the MIT license.",
  },
];

export type StartStep = {
  text: string;
  /** A command the reader types, shown with a Copy button; "install" links back to the hero's install command. */
  command?: "install" | string;
  note?: string;
};

export const START: {
  title: string;
  steps: StartStep[];
  sampleLabel: string;
  sample: string;
  plugin: string;
} = {
  title: "Start",
  steps: [
    {
      text: "In a terminal with Node 22.5 or newer and Git, run the install command. Then start the local stack with membral local up --embeddings ollama (Ollama and the nomic-embed-text model first).",
      command: "install",
      note: "It clones the MIT repository, then builds the membral command-line tool from packages/cli and installs it globally.",
    },
    {
      text: "membral local up runs setup for you: it signs in to your local Membral, lists the projects it found (all checked; uncheck any to keep them local) and connects the coding agents it finds.",
    },
    {
      text: "To check that it worked, run:",
      command: "membral status",
      note: "It shows your account, this device and what synced last.",
    },
    {
      text: "Then work as usual. Your sessions are listed in your local dashboard, and in Claude Code each past decision that comes with a request names the session it came from.",
    },
  ],
  /** The shape of one line the agent receives with a request (format of renderPromptRecallLine); the text is the example's decision. */
  sampleLabel: "A line Claude Code receives looks like this (the age, session id and link here are examples):",
  sample:
    "[decision · 2d ago · session abcd1234] An import is never re-sent after a 504: the server may already have saved the batch. → https://example.com/merge-requests/1",
  plugin: "Use Claude Code? You can install the plugin instead.",
};
