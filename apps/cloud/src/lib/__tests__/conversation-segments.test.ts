// Segment parsing for Claude.ai imports (D7), markdown-stripped previews
// (D6) and mirrored tool-only detection (D8). Fixture shapes mirror
// packages/core/src/importers/claude-export.ts renderContentBlock output;
// content is fictional (CodeHub) per CLAUDE.md's scrub-list convention.
import { describe, expect, it } from "vitest";
import {
  countToolSteps,
  hasContentBlockMarkers,
  isToolOnlyMessage,
  messagePreview,
  parseMessageSegments,
  stripMarkdown,
} from "../conversation-view";

describe("stripMarkdown / messagePreview", () => {
  it("removes bold, inline code, headings, fences, links and quotes", () => {
    const md =
      "## Setup\n\n**Run** `codehub deploy` then see [the docs](https://codehub.example).\n\n```bash\nnpm test\n```\n\n> note";
    const out = stripMarkdown(md);
    expect(out).not.toMatch(/\*\*|`|##|\]\(|^>/m);
    expect(out).toContain("Run codehub deploy then see the docs.");
    expect(out).toContain("npm test");
  });

  it("preview is clamped to the long-message limit and stripped", () => {
    const preview = messagePreview(`**bold** ${"x".repeat(5000)}`);
    expect(preview.startsWith("bold ")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(3000);
  });
});

describe("hasContentBlockMarkers", () => {
  it("true for thinking / tool_use / tool_result blocks", () => {
    expect(hasContentBlockMarkers("[thinking]\nweighing options\n\nHere you go.")).toBe(true);
    expect(hasContentBlockMarkers('[tool_use: web_search]\n{"query":"codehub"}')).toBe(true);
    expect(hasContentBlockMarkers("Intro\n\n[tool_result]\nok")).toBe(true);
  });

  it("false for plain text, ChatGPT-only tags with text bodies, and a lone artifact", () => {
    expect(hasContentBlockMarkers("Just text [with brackets] inline")).toBe(false);
    expect(hasContentBlockMarkers("[quote: file.pdf]\nCodeHub Pro is $29")).toBe(false);
    expect(hasContentBlockMarkers("[artifact: code — app.ts]\n```ts\nx\n```")).toBe(false);
    expect(hasContentBlockMarkers("[the job path] is long")).toBe(false);
    expect(hasContentBlockMarkers('[thoughts]\n{"content_type":"thoughts"}')).toBe(false);
  });
});

describe("parseMessageSegments", () => {
  it("splits thinking, a tool call (pretty JSON), its result, and interleaved text", () => {
    const content = [
      "[thinking]\nI'm checking the CodeHub docs first.",
      '[tool_use: web_search]\n{"query":"codehub deploy","limit":3}',
      '[tool_result]\n[knowledge]\n{"type":"knowledge","title":"CodeHub deploy"}',
      "Found it. Here is how you deploy.",
    ].join("\n\n");
    const segs = parseMessageSegments(content);
    expect(segs.map((s) => s.kind)).toEqual(["thinking", "tool_call", "tool_result", "text"]);
    expect(segs[1]).toEqual({
      kind: "tool_call",
      name: "web_search",
      input: '{\n  "query": "codehub deploy",\n  "limit": 3\n}',
    });
    expect(segs[2]).toMatchObject({ kind: "tool_result", text: expect.stringContaining("CodeHub deploy") });
    expect(segs[3]).toEqual({ kind: "text", text: "Found it. Here is how you deploy." });
  });

  it("a terminal thinking block hands the reply back as text at the first non-reasoning paragraph", () => {
    const content = [
      "[thinking]\nThe user wants a CodeHub rollout plan.",
      "I'm weighing a staged rollout against a big-bang switch, and the staged one wins on risk.",
      "Short version: stage it.",
      "**Week 1** — pilot team.",
    ].join("\n\n");
    const segs = parseMessageSegments(content);
    expect(segs.map((s) => s.kind)).toEqual(["thinking", "text"]);
    expect(segs[0]).toMatchObject({ text: expect.stringContaining("staged one wins") });
    expect(segs[1]).toEqual({ kind: "text", text: "Short version: stage it.\n\n**Week 1** — pilot team." });
  });

  it("a thinking block followed by another marker keeps every paragraph up to that marker", () => {
    // Leading text: the message already has a visible reply, so nothing is promoted.
    const segs = parseMessageSegments(
      "On it.\n\n[thinking]\nFirst.\n\nThen the second thought.\n\n[tool_use: search]\n{}",
    );
    expect(segs[1]).toEqual({ kind: "thinking", text: "First.\n\nThen the second thought." });
    expect(segs[2]).toEqual({ kind: "tool_call", name: "search", input: "{}" });
  });

  it("tool_result absorbs following tool-output paragraphs but not prose", () => {
    const segs = parseMessageSegments(
      "[tool_result]\n=== /notes/a.md ===\nalpha\n\n=== /notes/b.md ===\nbeta\n\n[tool_use: x]\n{}\n\nDone — both notes updated.",
    );
    expect(segs.map((s) => s.kind)).toEqual(["tool_result", "tool_call", "text"]);
    expect(segs[0]).toMatchObject({ text: expect.stringContaining("/notes/b.md") });
  });

  it("renderContentBlock's fallback [type]\\n{json} becomes a labeled unknown block", () => {
    const segs = parseMessageSegments('[token_budget]\n{"type":"token_budget","remaining":10}\n\nHello.');
    expect(segs[0]).toEqual({
      kind: "unknown",
      label: "token_budget",
      text: '{\n  "type": "token_budget",\n  "remaining": 10\n}',
    });
    expect(segs[1]).toEqual({ kind: "text", text: "Hello." });
  });

  it("keeps a malformed/truncated JSON input verbatim instead of throwing", () => {
    const segs = parseMessageSegments('[tool_use: memory_user_edits]\n{"command":"add","text":"cut off');
    expect(segs[0]).toEqual({
      kind: "tool_call",
      name: "memory_user_edits",
      input: '{"command":"add","text":"cut off',
    });
  });

  it("an artifact runs to its closing fence even across blank lines", () => {
    const content =
      "[thinking]\nx\n\n[artifact: code — app.ts]\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nThere you go.";
    const segs = parseMessageSegments(content);
    expect(segs.map((s) => s.kind)).toEqual(["thinking", "artifact", "text"]);
    expect(segs[1]).toEqual({
      kind: "artifact",
      label: "code — app.ts",
      text: "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    });
  });

  it("plain text without markers is one text segment", () => {
    expect(parseMessageSegments("Hello\n\nworld")).toEqual([{ kind: "text", text: "Hello\n\nworld" }]);
  });

  describe("explicit closing markers (fresh claude-export.ts imports)", () => {
    it("uses the closing marker exactly, skipping the heuristics, for thinking/tool_use/tool_result/unknown", () => {
      const content = [
        "[thinking]\nI'm checking the CodeHub docs first.\n[/thinking]",
        '[tool_use: web_search]\n{"query":"codehub deploy"}\n[/tool_use]',
        "[tool_result]\nnot obviously tool-shaped prose, no === or {\n[/tool_result]",
        '[token_budget]\n{"type":"token_budget","remaining":10}\n[/token_budget]',
        "Here is how you deploy.",
      ].join("\n\n");
      const segs = parseMessageSegments(content);
      expect(segs.map((s) => s.kind)).toEqual(["thinking", "tool_call", "tool_result", "unknown", "text"]);
      expect(segs[0]).toEqual({ kind: "thinking", text: "I'm checking the CodeHub docs first." });
      expect(segs[2]).toEqual({
        kind: "tool_result",
        text: "not obviously tool-shaped prose, no === or {",
      });
      expect(segs[3]).toMatchObject({ kind: "unknown", label: "token_budget" });
      expect(segs[4]).toEqual({ kind: "text", text: "Here is how you deploy." });
    });

    it("a closed thinking block with an internal blank line stops exactly at the marker, no reasoning-opener heuristic", () => {
      // Would trip the "terminal thinking" heuristic (reply glued on) if the
      // closing marker were not honored, since nothing here looks like a reply.
      const content = "[thinking]\nI'm still weighing this.\n\nI think staged wins.\n[/thinking]";
      const segs = parseMessageSegments(content);
      expect(segs).toEqual([{ kind: "thinking", text: "I'm still weighing this.\n\nI think staged wins." }]);
    });

    it("old stored data without a closing marker still falls back to the heuristics unchanged", () => {
      // Leading text: the message already has a visible reply, so nothing is promoted.
      const segs = parseMessageSegments(
        "On it.\n\n[thinking]\nFirst.\n\nThen the second thought.\n\n[tool_use: search]\n{}",
      );
      expect(segs[1]).toEqual({ kind: "thinking", text: "First.\n\nThen the second thought." });
      expect(segs[2]).toEqual({ kind: "tool_call", name: "search", input: "{}" });
    });
  });
});

describe("parseMessageSegments — legacy thinking never hides the reply", () => {
  it("promotes a strong-signal trailing paragraph before a tool call, even when other text exists", () => {
    const segs = parseMessageSegments(
      "Intro text.\n\n[thinking]\nThe user wants the deploy log.\n\nFirst, let me check the CodeHub log so you get a real answer.\n\n[tool_use: search]\n{}",
    );
    expect(segs.map((s) => s.kind)).toEqual(["text", "thinking", "text", "tool_call"]);
    expect(segs[1]).toEqual({ kind: "thinking", text: "The user wants the deploy log." });
    expect(segs[2]).toEqual({ kind: "text", text: "First, let me check the CodeHub log so you get a real answer." });
  });

  it("keeps planning paragraphs hidden before a tool call", () => {
    const segs = parseMessageSegments(
      "Intro.\n\n[thinking]\nThe user wants X.\n\nI need to check the log for you.\n\n[tool_use: search]\n{}",
    );
    expect(segs[1]).toEqual({ kind: "thinking", text: "The user wants X.\n\nI need to check the log for you." });
  });

  it("a message with no visible text promotes the trailing reply-like paragraphs", () => {
    const segs = parseMessageSegments(
      "[thinking]\nThe user asked about costs.\n\nI should total it.\n\nDeck built. Now the render.\n\n[tool_use: render]\n{}",
    );
    expect(segs.map((s) => s.kind)).toEqual(["thinking", "text", "tool_call"]);
    expect(segs[1]).toEqual({ kind: "text", text: "Deck built. Now the render." });
  });

  it("falls back to the last paragraph when nothing looks like a reply", () => {
    const segs = parseMessageSegments("[thinking]\nThe user asked.\n\nI should answer.\n\n[tool_use: x]\n{}");
    expect(segs[0]).toEqual({ kind: "thinking", text: "The user asked." });
    expect(segs[1]).toEqual({ kind: "text", text: "I should answer." });
  });

  it("merges a bold reply paragraph into the terminal reply that follows it", () => {
    const segs = parseMessageSegments(
      "[thinking]\nThe user sent numbers.\n\nI've checked: **your margins are healthy**.\n\n## Summary\n\nAll good.",
    );
    expect(segs).toEqual([
      { kind: "thinking", text: "The user sent numbers." },
      { kind: "text", text: "I've checked: **your margins are healthy**.\n\n## Summary\n\nAll good." },
    ]);
  });

  it("leaves a single-paragraph thinking block and explicit closers alone", () => {
    expect(parseMessageSegments("[thinking]\nOnly thought.\n\n[tool_use: x]\n{}")[0]).toEqual({
      kind: "thinking",
      text: "Only thought.",
    });
    const closed = parseMessageSegments(
      "[thinking]\nA.\n\n**B for you.**\n[/thinking]\n\n[tool_use: x]\n{}\n[/tool_use]",
    );
    expect(closed[0]).toEqual({ kind: "thinking", text: "A.\n\n**B for you.**" });
    expect(closed[1].kind).toBe("tool_call");
  });
});

describe("isToolOnlyMessage / countToolSteps (mirrored claude-code rows)", () => {
  it("true when every line is a mirrored tool line", () => {
    const c = "[tool: Read src/a.ts]\n[tool_result elided: ok]\n[tool: Bash]\n[truncated]";
    expect(isToolOnlyMessage(c)).toBe(true);
    expect(countToolSteps(c)).toBe(2);
  });

  it("false when any prose is present, and false for empty content", () => {
    expect(isToolOnlyMessage("Reading the file now.\n[tool: Read src/a.ts]")).toBe(false);
    expect(isToolOnlyMessage("")).toBe(false);
  });
});
