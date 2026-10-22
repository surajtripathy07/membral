// W6 review fix 1: the session page's refs line renders refs exactly as
// Today does (threadRefLabel, the shared D-065 refLabel) and its overflow is an expandable
// ShowAll button, not a dead "+N more" count.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Thread } from "@/lib/threads/open-threads";
import { REFS_SHOWN, SessionRefsLine } from "../session-refs-line";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    ref: "codehub.example/acme/billing#17",
    refKind: "issue",
    url: null,
    ladder: { review_verb: "viewed", build_verb: null, triaged: false, discussed: false },
    sessions: [],
    cost_est_total: null,
    estimated: true,
    last_seen_at: "2026-09-26T09:10:00Z",
    open: false,
    closure: null,
    ...overrides,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("SessionRefsLine", () => {
  it("renders nothing without refs", () => {
    expect(renderToStaticMarkup(<SessionRefsLine refs={[]} />)).toBe("");
  });

  it("prints a merge request as !N and an issue as #N, host dropped — the two never read as one ref", () => {
    const html = renderToStaticMarkup(
      <SessionRefsLine
        refs={[makeThread({ refKind: "merge_request", open: true }), makeThread({ refKind: "issue" })]}
      />,
    );
    const out = text(html);
    expect(out).toContain("acme/billing!17 open · no close seen");
    expect(out).toContain("acme/billing#17 viewed");
    expect(out).not.toContain("codehub.example/");
  });

  it("keeps #N for a GitHub pull request, as Today does", () => {
    const html = renderToStaticMarkup(
      <SessionRefsLine refs={[makeThread({ ref: "github.com/acme/billing#5", refKind: "merge_request" })]} />,
    );
    expect(text(html)).toContain("#5");
    expect(text(html)).not.toContain("!5");
  });

  it("an MR on a host no data proves glab-family reads owner/repo!N (D-065 + R3 ADV 6)", () => {
    const html = renderToStaticMarkup(
      <SessionRefsLine refs={[makeThread({ ref: "codehub.example/acme/billing#17", refKind: "merge_request" })]} />,
    );
    expect(text(html)).toContain("acme/billing!17");
  });

  it("shows the first 5, then an expandable +N more button", () => {
    const refs = Array.from({ length: REFS_SHOWN + 3 }, (_, i) => makeThread({ ref: `codehub.example/acme/billing#${i + 1}` }));
    const html = renderToStaticMarkup(<SessionRefsLine refs={refs} />);
    expect(html.match(/data-testid="session-ref"/g)).toHaveLength(REFS_SHOWN);
    expect(html).toMatch(/<button[^>]*>\+3 more<\/button>/);
  });
});
