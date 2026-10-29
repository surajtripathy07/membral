// D1: assistant turns render as markdown (token palette, no raw HTML);
// thinking keeps its line breaks.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TurnRow } from "@/lib/code-sessions/view";
import { ActivityLine } from "../turn-activity";

function turn(overrides: Partial<TurnRow>): TurnRow {
  return {
    idx: 1,
    role: "assistant",
    kind: "prose",
    text: null,
    tool_name: null,
    file_path: null,
    ts: null,
    toolUseId: null,
    ...overrides,
  };
}

describe("ActivityLine — assistant prose", () => {
  it("renders markdown: emphasis, inline code, fences, bullets", () => {
    const text = "**Done.** Ran `npm test`.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```";
    const html = renderToStaticMarkup(<ActivityLine turn={turn({ text })} />);
    expect(html).toContain("<strong>Done.</strong>");
    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain("<li>one</li>");
    expect(html).toMatch(/<pre><code class="language-ts">const x = 1;\n<\/code><\/pre>/);
    expect(html).not.toContain("**");
  });

  it("never renders raw HTML from the transcript", () => {
    const html = renderToStaticMarkup(<ActivityLine turn={turn({ text: 'hi <script>alert(1)</script> <img src="x">' })} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });

  it("uses tokens only, never raw gray-* utilities", () => {
    const html = renderToStaticMarkup(<ActivityLine turn={turn({ text: "x" })} />);
    expect(html).not.toMatch(/gray-\d/);
    expect(html).toContain("text-ink-2");
  });
});

describe("ActivityLine — thinking", () => {
  it("preserves line breaks and stays muted", () => {
    const html = renderToStaticMarkup(<ActivityLine turn={turn({ kind: "thinking", text: "a\nb" })} />);
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("text-muted");
    expect(html).toContain("a\nb");
  });
});

describe("ActivityLine — observed actions on a tool_use turn", () => {
  it("shows the action next to the tool name, ref linked via forgeUrl, plus the redacted digest", () => {
    const html = renderToStaticMarkup(
      <ActivityLine
        turn={turn({
          idx: 132,
          kind: "tool_use",
          tool_name: "Bash",
          actions: [{ verb: "commented", source: "cli", ref: "#145", refKind: "issue" }],
          inputDigest: "gh issue comment 145 --body-file ‹text›\nmore",
        })}
        projectIdentity="github.com/acme/api"
      />,
    );
    expect(html).toContain('id="turn-132"');
    expect(html).toContain("commented on");
    expect(html).toContain('href="https://github.com/acme/api/issues/145"');
    expect(html).toContain("acme/api#145");
    expect(html).toContain("gh issue comment 145 --body-file ‹text›");
    expect(html).not.toContain("more");
    expect(html).not.toMatch(/gray-\d/);
  });

  it("a tool_use turn with no actions renders just the tool name", () => {
    const html = renderToStaticMarkup(<ActivityLine turn={turn({ kind: "tool_use", tool_name: "Bash", actions: [] })} />);
    expect(html).toContain("Bash");
    expect(html).not.toContain("turn-action");
    expect(html).not.toContain("turn-digest");
  });
});

describe("ActivityLine — cited quote (verify affordance)", () => {
  it("marks the quote in an assistant turn and escapes the rest of the text", () => {
    const text = "Decided: **retry the import once** then stop <script>x</script>";
    const html = renderToStaticMarkup(<ActivityLine turn={turn({ text })} quote="retry the import once" />);
    expect(html).toContain('<mark class="rounded-xs bg-accent-soft');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("marks the quote in a thinking turn", () => {
    const html = renderToStaticMarkup(
      <ActivityLine turn={turn({ kind: "thinking", text: "maybe retry the import once" })} quote="retry the import once" />,
    );
    expect(html).toContain("<mark");
  });

  it("keeps markdown rendering when no quote is given or it is not in the turn", () => {
    const text = "**Done.** Ran it.";
    expect(renderToStaticMarkup(<ActivityLine turn={turn({ text })} quote="not present anywhere" />)).toContain(
      "<strong>Done.</strong>",
    );
    expect(renderToStaticMarkup(<ActivityLine turn={turn({ text })} />)).toContain("<strong>Done.</strong>");
  });
});
