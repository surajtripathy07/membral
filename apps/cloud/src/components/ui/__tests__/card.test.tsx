// G3 3D-6 — the base rounded-card literal in one place.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card } from "../card";

describe("Card", () => {
  it("renders p-4 with the base classes and no extra className", () => {
    const html = renderToStaticMarkup(<Card padding={4}>content</Card>);
    expect(html).toContain('class="rounded-card border border-line bg-surface p-4"');
    expect(html).toContain("content");
  });

  it("renders p-6 with the base classes and no extra className", () => {
    const html = renderToStaticMarkup(<Card padding={6}>content</Card>);
    expect(html).toContain('class="rounded-card border border-line bg-surface p-6"');
  });

  it("appends className after the base classes", () => {
    const html = renderToStaticMarkup(
      <Card padding={6} className="text-sm text-muted">
        content
      </Card>,
    );
    expect(html).toContain('class="rounded-card border border-line bg-surface p-6 text-sm text-muted"');
  });

  it("forwards div props like data-testid and id", () => {
    const html = renderToStaticMarkup(
      <Card padding={4} data-testid="my-card" id="card-1">
        content
      </Card>,
    );
    expect(html).toContain('data-testid="my-card"');
    expect(html).toContain('id="card-1"');
  });
});
