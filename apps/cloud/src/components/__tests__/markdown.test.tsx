// Shared Markdown: GFM pipe tables render as tables; a paragraph opening with
// an HTML-like tag (`<analysis>`) is literal text and the rest still formats.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { escapeLeadingHtmlTags, Markdown } from "../markdown";

describe("Markdown", () => {
  it("renders a GFM pipe table with token classes", () => {
    const html = renderToStaticMarkup(<Markdown content={"| Item | Cost |\n| --- | --- |\n| Milk | 40 |"} />);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain(">Milk</td>");
    expect(html).toContain("border-line");
    expect(html).not.toContain("| --- |");
  });

  it("formats a paragraph that opens with an HTML-like tag", () => {
    const html = renderToStaticMarkup(<Markdown content={"<analysis>\n**Key point** here\n</analysis>"} />);
    expect(html).toContain("&lt;analysis&gt;");
    expect(html).toContain("<strong>Key point</strong>");
    expect(html).not.toContain("**");
  });
});

describe("escapeLeadingHtmlTags", () => {
  it("escapes opening and closing tag lines outside code fences only", () => {
    const src = "<analysis>\ntext\n  </analysis>\n```xml\n<note>\n```\n~~~\n<b>\n~~~\n<x>";
    expect(escapeLeadingHtmlTags(src)).toBe(
      "\\<analysis>\ntext\n  \\</analysis>\n```xml\n<note>\n```\n~~~\n<b>\n~~~\n\\<x>",
    );
  });

  it("leaves non-tag angle brackets and indented code alone", () => {
    expect(escapeLeadingHtmlTags("< 5 items\n<-- arrow\n    <div>")).toBe("< 5 items\n<-- arrow\n    <div>");
  });
});
