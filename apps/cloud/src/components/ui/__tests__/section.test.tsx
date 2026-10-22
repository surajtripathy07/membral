// UX audit B0: Section's one label/count/action rhythm.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Section } from "../section";

describe("Section", () => {
  it("renders the label and children", () => {
    const html = renderToStaticMarkup(
      <Section label="Open threads">
        <p>row</p>
      </Section>,
    );
    expect(html).toContain("Open threads");
    expect(html).toContain("row");
    expect(html).toContain("section-label");
  });

  it("renders a count when given", () => {
    const html = renderToStaticMarkup(
      <Section label="Blockers" count={3}>
        <p>row</p>
      </Section>,
    );
    expect(html).toContain(">3<");
  });

  it("omits the count node when not given", () => {
    const html = renderToStaticMarkup(
      <Section label="Blockers">
        <p>row</p>
      </Section>,
    );
    expect(html).not.toContain("ml-1.5");
  });

  it("renders the action link when given", () => {
    const html = renderToStaticMarkup(
      <Section label="Sessions" action={{ label: "All sessions →", href: "/code" }}>
        <p>row</p>
      </Section>,
    );
    expect(html).toContain("All sessions →");
    expect(html).toContain('href="/code"');
  });
});
