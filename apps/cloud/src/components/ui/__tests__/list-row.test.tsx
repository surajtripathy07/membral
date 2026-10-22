// UX audit B0: ListRow is a divider, not a per-item card.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListRow } from "../list-row";

describe("ListRow", () => {
  it("renders a div with the divider classes by default", () => {
    const html = renderToStaticMarkup(<ListRow>row content</ListRow>);
    expect(html).toContain("border-line-soft");
    expect(html).toContain("row content");
    expect(html).not.toContain("<a ");
  });

  it("renders as a link when href is given", () => {
    const html = renderToStaticMarkup(<ListRow href="/code/session/1">row content</ListRow>);
    expect(html).toContain('href="/code/session/1"');
    expect(html).toContain("border-line-soft");
  });
});
