// Render checks for SessionFacts (GitHub issue #87). renderToStaticMarkup
// pattern established in portrait-content.test.tsx — vitest.config.ts already
// sets esbuild.jsx: "automatic".
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShapedSessionFacts } from "@/lib/code-sessions/view";
import { SessionFacts } from "../session-facts";

function emptyFacts(overrides: Partial<ShapedSessionFacts> = {}): ShapedSessionFacts {
  return {
    models: [],
    usage: null,
    tools: { items: [], moreCount: 0 },
    files: { items: [], moreCount: 0 },
    ...overrides,
  };
}

// UX audit B6 / W5: the facts strip carries no cost at all — the mirror's
// stored snapshot is no longer read (view.ts), and the header's live,
// whole-session total (page.tsx) is the page's one "$" figure.

describe("SessionFacts", () => {
  it("renders nothing for null facts (no empty skeleton)", () => {
    expect(renderToStaticMarkup(<SessionFacts facts={null} />)).toBe("");
  });

  it("renders models and tokens, and never a second cost figure (B6: exactly one $ in the header)", () => {
    const facts = emptyFacts({
      models: ["claude-sonnet-4-5"],
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10 },
    });
    const html = renderToStaticMarkup(<SessionFacts facts={facts} />);
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).toContain("1.3k tokens");
    expect(html).not.toContain("$");
    expect(html).not.toContain("est.");
  });

  it("renders tools with call counts and files with edit-intensity + created/updated", () => {
    const facts = emptyFacts({
      tools: { items: [{ key: "Edit", label: "Edit", callCount: 7 }], moreCount: 0 },
      files: {
        items: [
          { key: "src/App.tsx", label: "src/App.tsx", editCount: 3, created: true },
          { key: "src/util.ts", label: "src/util.ts", editCount: 1, created: false },
        ],
        moreCount: 0,
      },
    });
    const html = renderToStaticMarkup(<SessionFacts facts={facts} />);
    expect(html).toContain("Edit");
    expect(html).toContain("×7");
    expect(html).toContain("src/App.tsx");
    expect(html).toContain("×3");
    expect(html).toContain("new");
    expect(html).toContain("src/util.ts");
    expect(html).toContain("updated");
  });

  it("NEW (adversarial browser finding): renders the +K more count when tool/file lists were capped, instead of dumping every chip", () => {
    const facts = emptyFacts({
      tools: { items: [{ key: "Edit", label: "Edit", callCount: 50 }], moreCount: 12 },
      files: { items: [{ key: "a.ts", label: "a.ts", editCount: 5, created: null }], moreCount: 99 },
    });
    const html = renderToStaticMarkup(<SessionFacts facts={facts} />);
    expect(html).toContain("+12 more");
    expect(html).toContain("+99 files");
  });

  it("UX audit B6: collapses file chips to the first 3, folding the rest into the '+N files' count", () => {
    const facts = emptyFacts({
      files: {
        items: Array.from({ length: 5 }, (_, i) => ({ key: `f${i}.ts`, label: `f${i}.ts`, editCount: 1, created: false })),
        moreCount: 0,
      },
    });
    const html = renderToStaticMarkup(<SessionFacts facts={facts} />);
    expect(html).toContain("f0.ts");
    expect(html).toContain("f2.ts");
    expect(html).not.toContain("f3.ts");
    expect(html).toContain("+2 files");
  });

  it("hides a zero count instead of rendering ×0 next to a file or tool", () => {
    const facts = emptyFacts({
      tools: { items: [{ key: "Write", label: "Write", callCount: 0 }], moreCount: 0 },
      files: { items: [{ key: "new.ts", label: "new.ts", editCount: 0, created: true }], moreCount: 0 },
    });
    const html = renderToStaticMarkup(<SessionFacts facts={facts} />);
    expect(html).not.toContain("×0");
    expect(html).toContain("new.ts");
    expect(html).toContain("new");
  });

  it("renders nothing when facts are present but every field is empty (defensive)", () => {
    expect(renderToStaticMarkup(<SessionFacts facts={emptyFacts()} />)).toBe("");
  });
});
