// The terms and privacy pages describe only the local, self-hosted product (hosted sign-up is closed).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "../privacy/page";
import TermsPage from "../terms/page";

const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ");

describe("legal pages", () => {
  it("terms: MIT, own machine, nothing hosted", () => {
    const html = renderToStaticMarkup(TermsPage());
    const t = text(TermsPage());
    expect(t).toContain("MIT license");
    expect(t).toContain("your own machine");
    expect(html).not.toContain("membral.me");
    expect(html).not.toMatch(/Supabase|Vercel/);
  });

  it("privacy: local storage, exact delete command, README anchor, nothing hosted", () => {
    const html = renderToStaticMarkup(PrivacyPage());
    const t = text(PrivacyPage());
    expect(t).toContain("on your machine");
    expect(t).toContain("membral local down --wipe");
    expect(html).toContain("#run-it-locally");
    expect(html).not.toMatch(/Supabase/);
    // The one hosted thing the page may name is the website's page-view counter, and only in its own section.
    const start = html.indexOf('id="website"');
    const end = html.indexOf('id="delete"');
    expect(start).toBeGreaterThan(-1);
    const rest = html.slice(0, start) + html.slice(end);
    expect(rest).not.toMatch(/Vercel/);
    expect(rest.replace(/membral\.me website counts/, "")).not.toContain("membral.me");
    expect(html.slice(start, end)).toContain("never loads this script and");
  });
});
