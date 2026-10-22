// Render checks for MessageList (maintainer product-review feedback: the
// ChatGPT conversation page had "too much going on ... besides the
// content"). renderToStaticMarkup pattern established in
// code/[projectId]/project-facts.test.tsx — vitest.config.ts already sets
// esbuild.jsx: "automatic". Fixtures use a fictional tool ("CodeHub") per
// CLAUDE.md's scrub-list convention.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildRenderItems, MessageList } from "../message-list";

describe("MessageList", () => {
  it("renders a plain user message and an assistant reply as full bubbles", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          { role: "user", content: "How do I deploy CodeHub?" },
          { role: "assistant", content: "Run `codehub deploy` from the repo root." },
        ]}
      />,
    );
    expect(html).toContain("How do I deploy CodeHub?");
    expect(html).toContain("codehub deploy");
    expect(html).not.toContain("system context");
  });

  it("collapses a ChatGPT memory/system-context blob to a single muted row instead of a full bubble", () => {
    const noisy = JSON.stringify({
      content_type: "user_editable_context",
      user_profile: "Works at CodeHub.",
    });
    const html = renderToStaticMarkup(
      <MessageList messages={[{ role: "user", content: "hi" }, { role: "assistant", content: noisy }]} />,
    );
    expect(html).toContain("system context — expand");
    // The raw blob is still present (never deleted), just tucked inside the
    // collapsed <details>, not rendered as a full chat bubble.
    expect(html).toContain("user_editable_context");
    expect(html).toContain("Works at CodeHub.");
  });

  it("collapses a tool-call/tool-result payload the same way", () => {
    const toolPayload = JSON.stringify({ tool_use_id: "toolu_1", is_error: false, output: "build ok" });
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "assistant", content: toolPayload }]} />);
    expect(html).toContain("system context — expand");
  });

  it("collapses a non-conversational role (e.g. system) even with ordinary-looking text", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[{ role: "system", content: "You are CodeHub's support assistant." }]} />,
    );
    expect(html).toContain("system context — expand");
  });

  it("never drops a message from the array — noise rows still occupy their original index/position", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          { role: "user", content: "real question" },
          { role: "assistant", content: JSON.stringify({ content_type: "user_editable_context" }) },
          { role: "user", content: "follow-up" },
        ]}
      />,
    );
    // All three positions rendered something (one collapsed row + two bubbles).
    expect(html).toContain("real question");
    expect(html).toContain("follow-up");
    expect(html).toContain("system context — expand");
  });

  it("clamps a very long message with a 'Show more' control, and the full text is still present (not deleted) inside it", () => {
    const long = "word ".repeat(700); // > 3000 chars
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "user", content: long }]} />);
    expect(html).toContain("Show more");
    expect(html.length).toBeGreaterThan(long.length); // full text is present somewhere in the output
  });

  it("does not clamp a short message", () => {
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "user", content: "short message" }]} />);
    expect(html).not.toContain("Show more");
  });

  it("renders a per-message timestamp when present, muted, alongside the role label", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[{ role: "user", content: "hi", timestamp: "2026-01-15T10:30:00.000Z" }]} />,
    );
    // timezone-tolerant: UTC 10:30 can render as the 14th or 15th locally; no year (short strip — the conversation header already carries the date).
    expect(html).toMatch(/Jan 1[45], \d{1,2}:\d{2}/);
  });

  // Real shapes found via a read-only corpus scan after browser-verifying
  // a ChatGPT export; values scrubbed to fictional CodeHub content.
  it("collapses ChatGPT's '[thoughts]' internal reasoning content_type", () => {
    const content = [
      "[thoughts]",
      JSON.stringify({ content_type: "thoughts", thoughts: [{ summary: "s", content: "CodeHub licensing question" }] }),
    ].join("\n");
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "assistant", content }]} />);
    expect(html).toContain("system context — expand");
  });

  it("collapses ChatGPT's '[convo search]' internal memory-retrieval scratchpad (not JSON)", () => {
    const content =
      "[convo search]\n[USER_FACT] [c0] U@2026-07-25T21:59:27Z, -4mo: user was discussing timelines at CodeHub";
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "assistant", content }]} />);
    expect(html).toContain("system context — expand");
  });

  it("keeps a real quoted-document excerpt ([quote: ...]) as a full bubble, not collapsed", () => {
    const content = "[quote: CodeHub_Pricing_Breakdown.pdf — https://codehub.example/files/1]\nCodeHub Pro is $29/mo per seat.";
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "assistant", content }]} />);
    expect(html).not.toContain("system context — expand");
    expect(html).toContain("CodeHub Pro is $29/mo per seat.");
  });

  it("D6: the long-message preview is markdown-stripped and sits inside <summary>, hidden once expanded (no duplicate)", () => {
    const long = `**Opening line** with \`code\`. ${"word ".repeat(700)}`;
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "assistant", content: long }]} />);
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
    expect(summary).toContain("Opening line with code.");
    expect(summary).not.toContain("**");
    expect(summary).toContain("group-open:hidden");
    expect(html).toContain("Show less");
    // The full message is rendered exactly once, after the summary.
    expect(html.slice(html.indexOf("</summary>"))).toContain("<strong>Opening line</strong>");
  });

  it("D7: a Claude.ai message renders thinking / tool call / tool result as collapsed blocks and the reply as text", () => {
    const content = [
      "[thinking]\nI'm checking the CodeHub settings.",
      '[tool_use: memory_user_edits]\n{"command":"add","text":"prefers CodeHub"}',
      "[tool_result]\nOK",
      "Saved — I'll remember you prefer CodeHub.",
    ].join("\n\n");
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "assistant", content }]} />);
    expect(html).not.toContain("[thinking]");
    expect(html).not.toContain("[tool_use");
    expect(html).not.toContain("system context");
    expect(html).toContain("Thinking");
    expect(html).toContain("Tool call");
    expect(html).toContain("memory_user_edits");
    expect(html).toContain("&quot;command&quot;: &quot;add&quot;"); // pretty-printed input
    expect(html).toContain("Tool result");
    expect(html).toContain("remember you prefer CodeHub");
    expect(html.match(/<details/g)?.length).toBe(3);
  });

  it("D8: empty messages draw nothing; mirrored tool-only and cap-emptied runs fold into one quiet row", () => {
    const messages = [
      { role: "user", content: "Refactor CodeHub auth", metadata: { idx: 0 } },
      { role: "assistant", content: "[tool: Read src/auth.ts]\n[tool_result elided: ok]", metadata: { idx: 1, idxs: [1, 2] } },
      { role: "assistant", content: "[tool: Edit src/auth.ts]", metadata: { idx: 3 } },
      { role: "assistant", content: "", metadata: { idx: 4 } },
      { role: "assistant", content: "   " },
      { role: "user", content: "thanks", metadata: { idx: 5 } },
    ];
    const items = buildRenderItems(messages);
    expect(items.map((i) => [i.kind, i.index])).toEqual([
      ["message", 0],
      ["quiet", 1],
      ["message", 5],
    ]);
    const html = renderToStaticMarkup(<MessageList messages={messages} />);
    expect(html).toContain("2 tool steps · 1 message trimmed (size cap)");
    expect(html).not.toContain("system context");
  });

  it("D8: an empty message with no metadata is skipped entirely", () => {
    const html = renderToStaticMarkup(<MessageList messages={[{ role: "assistant", content: "" }]} />);
    expect(html).toBe('<div class="space-y-4"></div>');
  });

  it("D9: no raw gray/blue/purple utilities in the rendered markup", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          { role: "user", content: "hi", timestamp: "2026-01-15T10:30:00.000Z" },
          { role: "assistant", content: `[thinking]\nx\n\nHello **there**. ${"y ".repeat(2000)}` },
          { role: "system", content: "ctx" },
        ]}
      />,
    );
    expect(html).not.toMatch(/\b(?:text|bg|border|prose-[a-z]+:(?:text|bg|border))-(?:gray|blue|purple)-\d/);
  });
});
