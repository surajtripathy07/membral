// Render checks for ProjectFacts / "Activity details" (GitHub issue #87,
// redesigned per the /code information-design pass). renderToStaticMarkup
// pattern established in portrait-content.test.tsx / bootstrap-panel.test.tsx
// — vitest.config.ts already sets esbuild.jsx: "automatic". <details> content
// is present in the static HTML even though visually collapsed by default,
// so string-matching still exercises it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShapedProjectFacts } from "@/lib/code-sessions/view";
import { ProjectFacts } from "../project-facts";

function bucket(items: { key: string; label: string; sessionCount: number }[], moreCount = 0) {
  return { items, moreCount, hasRecurring: items.some((i) => i.sessionCount >= 2) };
}

const EMPTY_FACTS: ShapedProjectFacts = { files: bucket([]), tools: bucket([]), subagents: bucket([]) };

describe("ProjectFacts (Activity details)", () => {
  it("renders nothing for null facts and no AI-paraphrased list (no empty skeleton)", () => {
    expect(renderToStaticMarkup(<ProjectFacts facts={null} recurringFilesTools={[]} />)).toBe("");
  });

  it("renders nothing when every bucket is empty and the AI list is empty (defensive)", () => {
    expect(renderToStaticMarkup(<ProjectFacts facts={EMPTY_FACTS} recurringFilesTools={[]} />)).toBe("");
  });

  it("renders the collapsed 'Activity details' disclosure with file/tool chips and count suffixes", () => {
    const facts: ShapedProjectFacts = {
      files: bucket([{ key: "src/App.tsx", label: "src/App.tsx", sessionCount: 4 }]),
      tools: bucket([{ key: "Edit", label: "Edit", sessionCount: 9 }]),
      subagents: bucket([]),
    };
    const html = renderToStaticMarkup(<ProjectFacts facts={facts} recurringFilesTools={[]} />);
    expect(html).toContain("Activity details");
    expect(html).toContain("counts are a floor");
    expect(html).toContain("src/App.tsx");
    expect(html).toContain("×4");
    expect(html).toContain("Edit");
    expect(html).toContain("×9");
  });

  it("caps the visible files/tools row at 8 and folds the remainder into a '+K more' count", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ key: `f${i}.ts`, label: `f${i}.ts`, sessionCount: 3 }));
    const facts: ShapedProjectFacts = { files: bucket(files), tools: bucket([]), subagents: bucket([]) };
    const html = renderToStaticMarkup(<ProjectFacts facts={facts} recurringFilesTools={[]} />);
    expect(html).toContain("+4 more");
  });

  it("adds a trueCounts-derived moreCount on top of the 8-cap for tools", () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ key: `t${i}`, label: `t${i}`, sessionCount: 2 }));
    const facts: ShapedProjectFacts = { files: bucket([]), tools: bucket(tools, 3), subagents: bucket([]) };
    const html = renderToStaticMarkup(<ProjectFacts facts={facts} recurringFilesTools={[]} />);
    // 5 items shown (under the 8 cap) + 3 more from moreCount = 3, not folded away.
    expect(html).toContain("+3 more");
  });

  it("renders a sub-agent 'show all' toggle only when sub-agent facts exist", () => {
    const withoutSubagents: ShapedProjectFacts = { ...EMPTY_FACTS, files: bucket([{ key: "a.ts", label: "a.ts", sessionCount: 2 }]) };
    expect(renderToStaticMarkup(<ProjectFacts facts={withoutSubagents} recurringFilesTools={[]} />)).not.toContain("sub-agent");

    const withSubagents: ShapedProjectFacts = {
      files: bucket([]),
      tools: bucket([]),
      subagents: bucket([{ key: "explore-1", label: "Explore", sessionCount: 2 }]),
    };
    const html = renderToStaticMarkup(<ProjectFacts facts={withSubagents} recurringFilesTools={[]} />);
    expect(html).toContain("1 sub-agent");
    expect(html).toContain("show all");
    expect(html).toContain("Explore");
  });

  it("NEGATIVE: two fragmented keys sharing the same basename render as TWO distinct chips, not merged", () => {
    const facts: ShapedProjectFacts = {
      files: bucket([
        { key: "/home/alice/repo/src/App.tsx", label: "/home/alice/repo/src/App.tsx", sessionCount: 1 },
        { key: "/home/bob/repo/src/App.tsx", label: "/home/bob/repo/src/App.tsx", sessionCount: 1 },
      ]),
      tools: bucket([]),
      subagents: bucket([]),
    };
    const html = renderToStaticMarkup(<ProjectFacts facts={facts} recurringFilesTools={[]} />);
    // Both full paths still live in the `title` attribute (shortened only in
    // the visible label) and each has a distinct shortened display too.
    expect(html).toContain('title="/home/alice/repo/src/App.tsx"');
    expect(html).toContain('title="/home/bob/repo/src/App.tsx"');
    expect((html.match(/App\.tsx/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("a singleton (session_count 1) chip never shows a ×1 suffix", () => {
    const facts: ShapedProjectFacts = {
      files: bucket([{ key: "a.ts", label: "a.ts", sessionCount: 1 }]),
      tools: bucket([]),
      subagents: bucket([]),
    };
    const html = renderToStaticMarkup(<ProjectFacts facts={facts} recurringFilesTools={[]} />);
    expect(html).not.toContain("×1");
  });

  it("groups a memory/scratchpad path under a collapsed '+N scratch/notes' toggle, separate from source files", () => {
    const facts: ShapedProjectFacts = {
      files: bucket([
        { key: "src/App.tsx", label: "src/App.tsx", sessionCount: 3 },
        {
          key: "/Users/alice/.claude/projects/-repo/memory/MEMORY.md",
          label: "/Users/alice/.claude/projects/-repo/memory/MEMORY.md",
          sessionCount: 5,
        },
      ]),
      tools: bucket([]),
      subagents: bucket([]),
    };
    const html = renderToStaticMarkup(<ProjectFacts facts={facts} recurringFilesTools={[]} />);
    expect(html).toContain("src/App.tsx");
    expect(html).toContain("+1 scratch/notes");
    expect(html).toContain("memory/MEMORY.md");
  });

  it("renders the AI-paraphrased 'Notable' list when rollup.recurring_files_tools is non-empty, even with no graph facts", () => {
    const html = renderToStaticMarkup(<ProjectFacts facts={null} recurringFilesTools={["src/factory.ts", "vitest"]} />);
    expect(html).toContain("Notable");
    expect(html).toContain("AI summary");
    expect(html).toContain("src/factory.ts");
    expect(html).toContain("vitest");
  });
});
