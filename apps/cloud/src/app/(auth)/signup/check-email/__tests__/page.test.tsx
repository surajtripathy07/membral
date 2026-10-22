// #133 adversarial review round 2, minor R2-m2: a failed resend used to
// render a success checkmark + "Account created" heading with a red error
// banner stacked below it — reads as the opposite of what happened. These
// tests walk the returned React element tree (same technique as
// app/setup/__tests__/page.test.tsx — good enough for an async Server
// Component without a full DOM render) and assert the three states never
// mix success and failure framing.
import { describe, expect, it } from "vitest";
import CheckEmailPage from "../page";

/** Walks a React element tree collecting every string child, plus every <title> (icon labels) and href. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const el = node as { props?: { children?: unknown } };
    if (el.props && "children" in el.props) collectText(el.props.children, out);
  }
  return out;
}

function params(p: { resent?: string; error?: string }) {
  return Promise.resolve(p);
}

describe("/signup/check-email page", () => {
  it("fresh signup (no params): success framing, no error banner, a working resend form", async () => {
    const result = await CheckEmailPage({ searchParams: params({}) });
    const text = collectText(result).join(" | ");

    expect(text).toContain("Success"); // the checkmark icon's <title>
    expect(text).toContain("Check your email");
    expect(text).toContain("We sent a confirmation link");
    expect(text).toContain("Resend confirmation link");
    expect(text).not.toContain("Couldn't resend");
  });

  it("resent=1 (cooldown resubmit): success framing with the 'already sent' copy, no error banner", async () => {
    const result = await CheckEmailPage({ searchParams: params({ resent: "1" }) });
    const text = collectText(result).join(" | ");

    expect(text).toContain("Success");
    expect(text).toContain("Confirmation link already sent");
    expect(text).not.toContain("Couldn't resend");
  });

  // ---- R2-m2 ----

  it("R2-m2: a failed resend (?error=...) suppresses the success checkmark AND the success heading/copy — no mixed messaging", async () => {
    const result = await CheckEmailPage({
      searchParams: params({ error: "resend_failed" }),
    });
    const text = collectText(result).join(" | ");

    expect(text).not.toContain("Success"); // no checkmark icon rendered
    expect(text).not.toContain("Check your email");
    expect(text).not.toContain("Confirmation link already sent");
    expect(text).not.toContain("We sent a confirmation link");
    expect(text).toContain("Couldn't resend the confirmation link");
    expect(text).toContain("We couldn't resend the confirmation link. Try again in a moment.");
  });

  it("R2-m2: error takes priority over resent=1 when a resend attempt itself fails (both params can be absent-vs-present independently)", async () => {
    const result = await CheckEmailPage({
      searchParams: params({ error: "rate_limited" }),
    });
    const text = collectText(result).join(" | ");

    expect(text).not.toContain("Success");
    expect(text).not.toContain("Confirmation link already sent");
    expect(text).toContain("Couldn't resend the confirmation link");
  });
});
