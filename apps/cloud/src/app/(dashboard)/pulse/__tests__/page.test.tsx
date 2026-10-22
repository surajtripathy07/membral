// page.tsx is a thin async Server Component that reads `searchParams` and
// mounts the client page. No DOM needed: calling the function returns the
// React element, whose props can be asserted on directly (same precedent as
// (dashboard)/__tests__/layout.test.tsx).
import { describe, expect, it } from "vitest";
import PulsePage from "../page";
import { PulsePageClient } from "../pulse-page-client";

describe("PulsePage (server wrapper)", () => {
  it("mounts PulsePageClient with session grouping and no day by default", async () => {
    const el = await PulsePage({});
    expect(el.type).toBe(PulsePageClient);
    expect(el.props).toEqual({ grouping: "session", day: null });
  });

  it("passes ?group=repo and ?day= through", async () => {
    const el = await PulsePage({ searchParams: Promise.resolve({ group: "repo", day: "2026-10-01" }) });
    expect(el.props).toEqual({ grouping: "repo", day: "2026-10-01" });
  });
});
