// The dismiss flow behind Open threads (goal 2026-09-26 W8 / P7): the row
// leaves the list the moment the button is pressed, the ref is POSTed to
// /api/threads/dismiss, and the row comes back when the server says no.
// Driven through the same state callbacks ThreadsPanel wires into React, so
// the behaviour is checked without a DOM (vitest's node environment).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@/lib/threads/open-threads";
import { ThreadsContent } from "../threads-content";
import {
  BLOCKER_DISMISS_ENDPOINT,
  type BlockerRowState,
  DISMISS_ENDPOINT,
  DISMISS_FAILED,
  dismissBlockerRow,
  dismissThread,
  loadDismissedBlockers,
  restoreBlockerIds,
  UNDO_FAILED,
  undoBlockerRow,
  withoutDismissed,
} from "../threads-panel";

function makeThread(ref: string, refKind: Thread["refKind"] = "issue"): Thread {
  return {
    ref,
    refKind,
    url: null,
    ladder: { review_verb: null, build_verb: "pushed", triaged: false, discussed: false },
    sessions: [
      {
        id: `s-${ref}`,
        started_at: "2026-09-26T09:00:00Z",
        turn_idx: 1,
        proof_session_id: `s-${ref}`,
        tier: "observed",
        role: "worked_on",
        review_verb: null,
        build_verb: "pushed",
        share: 1,
        cost_est: 1,
      },
    ],
    cost_est_total: 1,
    estimated: true,
    last_seen_at: "2026-09-26T09:00:00Z",
    open: true,
    closure: null,
  };
}

/** The panel's state, stood in by a plain Set. */
function stateHarness() {
  const dismissed = new Set<string>();
  return {
    dismissed,
    markDismissed: (ref: string) => dismissed.add(ref),
    unmarkDismissed: (ref: string) => dismissed.delete(ref),
  };
}

function renderOpen(open: Thread[], dismissed: Set<string>) {
  return renderToStaticMarkup(
    <ThreadsContent
      recentThreads={[]}
      openThreads={withoutDismissed(open, dismissed)}
      recurringBlockers={[]}
      statsLine={null}
      now={Date.parse("2026-09-26T12:00:00Z")}
      onDismiss={() => {}}
    />,
  );
}

describe("dismissing an open thread (W8 / P7)", () => {
  it("dismiss removes the row and posts the ref", async () => {
    const open = [makeThread("acme/billing#15178"), makeThread("acme/billing#16002")];
    const state = stateHarness();
    expect(renderOpen(open, state.dismissed)).toContain("acme/billing#15178");

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const ok = await dismissThread({ ref: "acme/billing#15178", kind: "issue", reason: "not_delivery_item", ...state, fetchImpl });

    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DISMISS_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ ref: "acme/billing#15178", kind: "issue", reason: "not_delivery_item" });

    const html = renderOpen(open, state.dismissed);
    expect(html).not.toContain("acme/billing#15178");
    expect(html).toContain("acme/billing#16002");
  });

  it("the row is hidden before the request resolves (optimistic)", async () => {
    const state = stateHarness();
    let seenWhilePending = false;
    const fetchImpl = vi.fn(async () => {
      seenWhilePending = state.dismissed.has("issue:acme/billing#1");
      return new Response("{}", { status: 200 });
    });
    await dismissThread({ ref: "acme/billing#1", kind: "issue", reason: "resolved_elsewhere", ...state, fetchImpl });
    expect(seenWhilePending).toBe(true);
  });

  it("restores the row when the POST fails or returns non-2xx", async () => {
    const open = [makeThread("acme/billing#15178")];
    const state = stateHarness();

    const rejected = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await dismissThread({ ref: "acme/billing#15178", kind: "issue", reason: "resolved_elsewhere", ...state, fetchImpl: rejected })).toBe(false);
    expect(renderOpen(open, state.dismissed)).toContain("acme/billing#15178");

    const denied = vi.fn(async () => new Response(JSON.stringify({ error: "no session" }), { status: 404 }));
    expect(await dismissThread({ ref: "acme/billing#15178", kind: "issue", reason: "resolved_elsewhere", ...state, fetchImpl: denied })).toBe(false);
    expect(renderOpen(open, state.dismissed)).toContain("acme/billing#15178");
  });

  it("F1: dismissing MR !17 keeps issue #17 of the same repo in the list", async () => {
    const ref = "codehub.example/acme/billing#17";
    const open = [makeThread(ref, "merge_request"), makeThread(ref, "issue")];
    const state = stateHarness();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await dismissThread({ ref, kind: "merge_request", reason: "resolved_elsewhere", ...state, fetchImpl });
    const left = withoutDismissed(open, state.dismissed);
    expect(left.map((t) => t.refKind)).toEqual(["issue"]);
    const html = renderOpen(open, state.dismissed);
    expect(html).toContain('data-kind="issue"');
    expect(html).not.toContain('data-kind="merge_request"');
  });
});

describe("dismissing a blocker (UX pass 2)", () => {
  function ops(fetchImpl: typeof fetch) {
    const states = new Map<string, BlockerRowState>();
    const errors = new Map<string, string>();
    return {
      states,
      errors,
      set: (id: string, s: BlockerRowState) => void states.set(id, s),
      clear: (id: string) => void states.delete(id),
      fail: (id: string, m: string | null) => void (m ? errors.set(id, m) : errors.delete(id)),
      fetchImpl,
    };
  }

  it("marks the row dismissed at once, POSTs {id, reason}, then keeps the server's ids for Undo", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, ids: ["b1", "b0"] }), { status: 200 }));
    const o = ops(fetchImpl as unknown as typeof fetch);
    const p = dismissBlockerRow("b1", "resolved", o);
    expect(o.states.get("b1")).toEqual({ ids: [], busy: true });
    expect(await p).toBe(true);
    expect(o.states.get("b1")).toEqual({ ids: ["b1", "b0"], busy: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BLOCKER_DISMISS_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ id: "b1", reason: "resolved" });
  });

  it("restores the row when the server says no", async () => {
    const o = ops((async () => new Response("{}", { status: 404 })) as unknown as typeof fetch);
    expect(await dismissBlockerRow("b1", "ignored", o)).toBe(false);
    expect(o.states.has("b1")).toBe(false);
    expect(o.errors.get("b1")).toBe(DISMISS_FAILED);
  });

  it("Undo DELETEs the retired ids and clears the row; a failed Undo leaves it dismissed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, ids: ["b1"] }), { status: 200 }));
    const o = ops(fetchImpl as unknown as typeof fetch);
    expect(await undoBlockerRow("b1", { ids: ["b1", "b0"], busy: false }, o)).toBe(true);
    expect(o.states.has("b1")).toBe(false);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["b1", "b0"] });

    const failing = ops((async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
    expect(await undoBlockerRow("b1", { ids: ["b1"], busy: false }, failing)).toBe(false);
    expect(failing.states.get("b1")).toEqual({ ids: ["b1"], busy: false });
    expect(failing.errors.get("b1")).toBe(UNDO_FAILED);
    // Nothing to undo until the POST answered.
    expect(await undoBlockerRow("b1", { ids: [], busy: true }, failing)).toBe(false);
  });
});

describe("the dismissed list (UX pass 2, S1)", () => {
  it("loads the caller's dismissals; any failure is an empty list", async () => {
    const item = { ids: ["b1"], text: "t", quote: null, reason: "ignored", dismissed_at: "2026-09-20T00:00:00Z" };
    const ok = vi.fn(async () => new Response(JSON.stringify({ dismissed: [item] }), { status: 200 }));
    expect(await loadDismissedBlockers(ok as unknown as typeof fetch)).toEqual([item]);
    expect((ok.mock.calls[0] as unknown as [string])[0]).toBe(BLOCKER_DISMISS_ENDPOINT);
    const denied = async () => new Response("{}", { status: 401 });
    expect(await loadDismissedBlockers(denied as unknown as typeof fetch)).toEqual([]);
    const thrown = async () => {
      throw new Error("offline");
    };
    expect(await loadDismissedBlockers(thrown as unknown as typeof fetch)).toEqual([]);
  });

  it("Restore DELETEs the click's ids; a failure resolves false, never throws", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await restoreBlockerIds(["b1", "b0"], fetchImpl as unknown as typeof fetch)).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["b1", "b0"] });
    expect(await restoreBlockerIds([], fetchImpl as unknown as typeof fetch)).toBe(false);
    const thrown = async () => {
      throw new Error("offline");
    };
    expect(await restoreBlockerIds(["b1"], thrown as unknown as typeof fetch)).toBe(false);
  });
});
