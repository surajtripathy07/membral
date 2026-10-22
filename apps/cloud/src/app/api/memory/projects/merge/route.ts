// POST /api/memory/projects/merge — the "Merge into..." action on the Memory
// browser's Projects facet (migration 060, goal 2026-08-26 W7/D8; fixed by
// migration 063 after a fresh adversarial review — see that migration's
// header for the full finding list). Cookie-bound Supabase client (same
// idiom as /api/memory/claims, /api/memory/facets): userId comes from the
// browser session; project_aliases' own RLS (owner read/write/update,
// migration 060 + 063 finding #1) enforces the same scoping as a second,
// belt-and-suspenders check.
//
// action: 'merge' upserts a source='manual' alias row — a manual merge
// always wins over an auto-seeded 'slug'/'remote-lineage' row for the same
// alias, AND over a prior manual/unmerged row (re-merge / change-of-mind is
// just another upsert — this requires the UPDATE RLS policy 063 finding #1
// added; PostgREST sends `.upsert(..., {onConflict})` as
// `INSERT ... ON CONFLICT DO UPDATE`, which needs UPDATE, not just INSERT,
// privileges on the conflict path).
//
// action: 'unmerge' upserts a self-referencing TOMBSTONE row instead of
// deleting (migration 063, findings #3/#7): `{alias, canonical: alias,
// source: 'unmerged'}`. A tombstone resolves to itself (project_alias_resolve
// treats alias === canonical as an immediate stop) and permanently protects
// this alias from project_alias_seed ever re-creating a real merge for it —
// deleting the row instead would let the NEXT seed run silently resurrect
// the exact merge the user just undid. Works for ANY prior source (manual,
// slug, remote-lineage, or no row at all) — "unmerge X" always means "X
// should never auto-merge, regardless of how it got merged before."
//
// Cycle guard (merge only): refused when `alias === canonical` (trivial
// self-alias — allowed for unmerge's tombstone, so this check is gated to
// action==='merge'), or when `canonical`, resolved through this user's
// EXISTING aliases, would already lead back to `alias` — inserting the new
// row would then create a cycle (alias -> canonical -> ... -> alias).
//
// GET lists EVERY current merge for this user, any source (migration 064,
// NEW-3 — previously filtered to source='manual' only, so a seeded
// slug/remote-lineage merge had no unmerge chip and the label it swallowed
// never appeared in the merge-source dropdown; unmerge already worked on
// any source server-side, it just wasn't reachable from the UI). Also, as a
// side effect, ensures project_alias_seed has run recently for this user
// (migration 063 finding #2 — one of the two real call sites that make the
// demo state reproducible from the repo instead of requiring a hand-run,
// spoofed-JWT psql call; the other is POST /api/code-sessions after an
// import). Awaited, not fire-and-forget: project_alias_seed is now
// self-throttled to at most once per 10 minutes per user (migration 064,
// NEW-4 — project_alias_seed_runs), so this call is cheap on every GET
// after the first, and a GET handler has no heavier work already in flight
// to protect latency for.
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/api/route";
import { canonicalize } from "@/lib/memory/project-aliases";

const BodySchema = z.object({
  alias: z.string().trim().min(1).max(500),
  canonical: z.string().trim().min(1).max(500),
  action: z.enum(["merge", "unmerge"]),
});

export const POST = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ req, user, supabase }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "alias, canonical (non-empty strings) and action ('merge'|'unmerge') are required" },
        { status: 400 },
      );
    }
    const { alias, canonical, action } = parsed.data;

    if (action === "unmerge") {
      // migration 063: a tombstone, not a delete — see this file's header.
      // canonical from the client is intentionally IGNORED here (previously a
      // stale chip's canonical could target the wrong row for a delete — moot
      // now, the tombstone is keyed on alias alone).
      const { error } = await supabase
        .from("project_aliases")
        .upsert({ user_id: user.id, canonical: alias, alias, source: "unmerged" }, { onConflict: "user_id,alias" });
      if (error) return NextResponse.json({ error: "Couldn't unmerge." }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // action === "merge": trivial self-alias refused first (also enforced by
    // the table's own CHECK constraint — checked here for a clean 400 instead
    // of a raw constraint-violation error).
    if (alias === canonical) {
      return NextResponse.json({ error: "alias and canonical must differ" }, { status: 400 });
    }

    // Cycle guard: canonical, resolved through this user's existing aliases,
    // must not already lead back to alias.
    const { data: existing, error: fetchError } = await supabase
      .from("project_aliases")
      .select("alias, canonical")
      .eq("user_id", user.id);
    if (fetchError) return NextResponse.json({ error: "Couldn't read existing merges." }, { status: 500 });

    const map = new Map<string, string>();
    for (const row of (existing ?? []) as { alias: string; canonical: string }[]) map.set(row.alias, row.canonical);
    if (canonicalize(canonical, map) === alias) {
      return NextResponse.json({ error: "That merge would create a cycle." }, { status: 400 });
    }

    const { error } = await supabase
      .from("project_aliases")
      .upsert({ user_id: user.id, canonical, alias, source: "manual" }, { onConflict: "user_id,alias" });
    if (error) return NextResponse.json({ error: "Couldn't merge." }, { status: 500 });
    return NextResponse.json({ ok: true });
  },
);

export const GET = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ user, supabase }) => {
    // migration 063, finding #2: a real, session-authenticated call site for
    // project_alias_seed — never let a seed failure break this endpoint's
    // actual purpose (listing manual merges).
    try {
      await supabase.rpc("project_alias_seed", { p_user: user.id });
    } catch {
      // best-effort — the facet/list still work off whatever's already seeded.
    }

    // migration 064, NEW-3: every source, not just 'manual' — an 'unmerged'
    // tombstone (alias === canonical) is deliberately included too, so the UI
    // can show "you unmerged this" rather than it just silently vanishing.
    const { data, error } = await supabase
      .from("project_aliases")
      .select("alias, canonical, source, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: "Couldn't load merges." }, { status: 500 });
    return NextResponse.json({ merges: data ?? [] });
  },
);
