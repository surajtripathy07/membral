// UX audit B0: PageFrame replaces the five ad-hoc content widths with two.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageFrame } from "../page-frame";

describe("PageFrame", () => {
  it("uses max-w-3xl for the read width", () => {
    const html = renderToStaticMarkup(
      <PageFrame width="read">
        <p>hello</p>
      </PageFrame>,
    );
    expect(html).toContain("max-w-3xl");
    expect(html).not.toContain("max-w-6xl");
  });

  it("uses max-w-6xl for the data width", () => {
    const html = renderToStaticMarkup(
      <PageFrame width="data">
        <p>hello</p>
      </PageFrame>,
    );
    expect(html).toContain("max-w-6xl");
    expect(html).not.toContain("max-w-3xl");
  });

  it("renders children", () => {
    const html = renderToStaticMarkup(
      <PageFrame width="read">
        <p>hello</p>
      </PageFrame>,
    );
    expect(html).toContain("hello");
  });
});

describe("PageFrame padding (UX W5)", () => {
  it("owns the page padding, since the dashboard layout's <main> adds none", () => {
    const html = renderToStaticMarkup(
      <PageFrame width="data">
        <p>x</p>
      </PageFrame>,
    );
    expect(html).toContain("px-4");
    expect(html).toContain("pt-8");
    expect(html).toContain("lg:px-6");
  });
});
