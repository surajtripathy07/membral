// UX audit B0: Disclosure is the one way to hide depth — a styled <details>.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Disclosure } from "../disclosure";

describe("Disclosure", () => {
  it("renders a details/summary pair with the count appended", () => {
    const html = renderToStaticMarkup(
      <Disclosure summary="Sub-agents" count={28}>
        <p>agent list</p>
      </Disclosure>,
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Sub-agents");
    expect(html).toContain("(28)");
    expect(html).toContain("agent list");
    expect(html).not.toContain(" open");
  });

  it("opens by default when defaultOpen is set", () => {
    const html = renderToStaticMarkup(
      <Disclosure summary="By model" defaultOpen>
        <p>table</p>
      </Disclosure>,
    );
    expect(html).toContain("<details open");
  });
});
