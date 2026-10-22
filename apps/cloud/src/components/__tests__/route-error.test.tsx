import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RouteError from "../route-error";

// The component has no hooks, so calling it returns its element tree; walk it
// to find the button and fire onClick without a DOM.
function findButton(node: ReactNode): ReactElement<{ onClick?: () => void }> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findButton(n);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (el.type === "button") return el;
  if (typeof el.type === "function") return findButton((el.type as (p: unknown) => ReactNode)(el.props));
  return findButton(el.props?.children);
}

describe("RouteError", () => {
  it("renders calm copy, the digest, and a link to /pulse, never the message", () => {
    const err = Object.assign(new Error("secret db password"), { digest: "abc123" });
    const html = renderToStaticMarkup(<RouteError error={err} reset={() => {}} />);
    expect(html).toContain("Something went wrong");
    expect(html).toContain("abc123");
    expect(html).toContain('href="/pulse"');
    expect(html).not.toContain("secret db password");
  });

  it("omits the reference line without a digest", () => {
    const html = renderToStaticMarkup(<RouteError error={new Error("x")} reset={() => {}} />);
    expect(html).not.toContain("Reference");
  });

  it("calls reset when Try again is clicked", () => {
    const reset = vi.fn();
    const button = findButton(RouteError({ error: new Error("x"), reset }));
    expect(button).not.toBeNull();
    button?.props.onClick?.();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
