// UX audit B0: SectionNav is a sticky anchor-link pill row.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SectionNav } from "../section-nav";

describe("SectionNav", () => {
  it("renders one anchor link per item, pointing at #id", () => {
    const html = renderToStaticMarkup(
      <SectionNav
        items={[
          { id: "connect", label: "Connect" },
          { id: "keys", label: "Keys" },
        ]}
      />,
    );
    expect(html).toContain('href="#connect"');
    expect(html).toContain('href="#keys"');
    expect(html).toContain("Connect");
    expect(html).toContain("Keys");
    expect(html).toContain("sticky");
  });
});
