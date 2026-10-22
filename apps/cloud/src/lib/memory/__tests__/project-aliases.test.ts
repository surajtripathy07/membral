import { describe, expect, it } from "vitest";
import { canonicalize, normalizeProjectSlug, projectOwnerSegment, resolveProjectCanonical } from "../project-aliases";

// Fixture list also checked live against project_alias_normalize() (migration
// 060) in psql on the founder-1k corpus (2026-08-27) — see the migration's own
// header and the W7 report for the exact SELECT and its output. Kept here as a
// plain unit test so a regression in either implementation is caught without a
// live DB.
const FIXTURES: [string, string][] = [
  ["dev/membral", "membral"],
  ["surajtripathy07/membral", "membral"],
  ["surajtripathy07/membral-personal", "membralpersonal"],
  ["acmewidgets.com", "acmewidgets"],
  ["Acme Widgets", "acmewidgets"],
  ["Acme WIDGETS", "acmewidgets"],
  ["acme/acme.github.io", "acmegithub"],
  ["  Dev/Membral  ", "membral"],
  ["acme/widgets", "widgets"],
  ["", ""],
];

describe("normalizeProjectSlug", () => {
  for (const [input, expected] of FIXTURES) {
    it(`normalizes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeProjectSlug(input)).toBe(expected);
    });
  }

  it("strips a trailing TLD suffix BEFORE removing punctuation (not after)", () => {
    // If punctuation stripping ran first, "acmewidgets.com" would become
    // "acmewidgetscom" instead of "acmewidgets" — the bug this ordering avoids.
    expect(normalizeProjectSlug("acmewidgets.com")).toBe("acmewidgets");
    expect(normalizeProjectSlug("acmewidgets.com")).not.toBe("acmewidgetscom");
  });

  it("only strips up to the LAST slash, not every slash", () => {
    expect(normalizeProjectSlug("host/owner/repo")).toBe("repo");
  });
});

// migration 063, finding #4: normalizeProjectSlug alone is NOT enough to
// decide a merge is safe — "acme/web" and "beta/web" both normalize to
// "web". projectOwnerSegment is the second signal project_alias_seed's SQL
// side consults (owner agreement, or one side ownerless) before creating a
// slug edge. Fixture list also checked live against project_alias_owner()
// (migration 063) in psql (2026-08-27) — see that migration's own header.
const OWNER_FIXTURES: [string, string | null][] = [
  ["surajtripathy07/membral", "surajtripathy07"],
  ["dev/membral", "dev"], // deliberately NOT null — see migration 063's header: no special-case for "dev"
  ["acme/web", "acme"],
  ["beta/web", "beta"],
  ["acme/widgets", "acme"],
  ["widgets", null], // no slash at all
  ["", null],
  ["/leading-slash-only", null], // prefix before the last slash is empty
  ["host/owner/repo", null], // 2+ slashes -- ambiguous, treated as ownerless
  ["/Users/x/dev/membral", null], // absolute path -- 2+ slashes, ownerless
  ["ACME/Web", "acme"], // casefolded
  ["acme-org/web", "acmeorg"], // punctuation stripped, same as the bare-name normalizer
];

describe("projectOwnerSegment", () => {
  for (const [input, expected] of OWNER_FIXTURES) {
    it(`extracts owner of ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(projectOwnerSegment(input)).toBe(expected);
    });
  }

  it("different owners of the same bare name are distinguishable (acme/web vs beta/web)", () => {
    expect(projectOwnerSegment("acme/web")).not.toBe(projectOwnerSegment("beta/web"));
    expect(normalizeProjectSlug("acme/web")).toBe(normalizeProjectSlug("beta/web")); // same bare name -- owner is the ONLY thing telling them apart
  });

  it("dev/membral and surajtripathy07/membral get different (non-null) owners -- no slug edge, only lineage can merge them", () => {
    // See migration 063's header: this pair's real founder-corpus merge came
    // entirely from the (unchanged) remote-lineage/repo_path heuristic, not
    // slug equality -- this fixture documents that project_alias_owner is
    // NOT supposed to treat "dev" as ownerless.
    const devOwner = projectOwnerSegment("dev/membral");
    const suOwner = projectOwnerSegment("surajtripathy07/membral");
    expect(devOwner).not.toBeNull();
    expect(suOwner).not.toBeNull();
    expect(devOwner).not.toBe(suOwner);
  });
});

describe("canonicalize", () => {
  it("returns the label unchanged when it has no alias entry", () => {
    const map = new Map<string, string>();
    expect(canonicalize("dev/membral", map)).toBe("dev/membral");
  });

  it("resolves a single alias hop", () => {
    const map = new Map([["surajtripathy07/membral", "dev/membral"]]);
    expect(canonicalize("surajtripathy07/membral", map)).toBe("dev/membral");
  });

  it("resolves a multi-hop chain (alias -> canonical -> canonical)", () => {
    const map = new Map([
      ["a", "b"],
      ["b", "c"],
      ["c", "final"],
    ]);
    expect(canonicalize("a", map)).toBe("final");
  });

  it("caps resolution at depth 5", () => {
    // A 6-hop chain: a->b->c->d->e->f->g. Depth-capped at 5 hops means
    // resolution stops at "f" (5 hops from "a"), never reaching "g".
    const map = new Map([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
      ["e", "f"],
      ["f", "g"],
    ]);
    expect(canonicalize("a", map)).toBe("f");
  });

  // migration 063, finding #7: project_alias_resolve (SQL) used to guard
  // only an IMMEDIATE self-hop, not a revisit of any earlier label in the
  // walk — so a cycle of length >= 4 resolved to a DIFFERENT label than
  // this function, meaning the Memory facet and the /code list could group
  // the same projects under different canonicals. Every value asserted
  // below was cross-checked live against project_alias_resolve() in psql
  // (2026-08-27, rolled back) after the 063 fix — see that migration's
  // header. 2- and 3-member cycles already agreed before the fix (by
  // coincidence of the old 5-hop cap); 4- is where they diverged.
  describe("cycle parity with project_alias_resolve (migration 063, finding #7)", () => {
    it("2-cycle (a<->b): resolves to the immediate neighbor", () => {
      const map = new Map([
        ["a", "b"],
        ["b", "a"],
      ]);
      expect(canonicalize("a", map)).toBe("b");
      expect(canonicalize("b", map)).toBe("a");
    });

    it("3-cycle (a->b->c->a): resolves to the last label before the revisit", () => {
      const map = new Map([
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ]);
      expect(canonicalize("a", map)).toBe("c");
    });

    it("4-cycle (a->b->c->d->a): resolves to the last label before the revisit -- verified live to match the fixed SQL side exactly (previously diverged)", () => {
      const map = new Map([
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "a"],
      ]);
      expect(canonicalize("a", map)).toBe("d");
    });

    it("terminates deterministically on any cycle rather than hanging", () => {
      const map = new Map([
        ["a", "b"],
        ["b", "a"],
      ]);
      expect(() => canonicalize("a", map)).not.toThrow();
    });
  });

  it("treats a self-referencing hop as a stop, not an infinite loop", () => {
    const map = new Map([["a", "a"]]);
    expect(canonicalize("a", map)).toBe("a");
  });

  it("trims whitespace before resolving, matching the SQL side's btrim", () => {
    const map = new Map([["dev/membral", "canonical"]]);
    expect(canonicalize("  dev/membral  ", map)).toBe("canonical");
  });

  it("passes an empty label through unchanged", () => {
    const map = new Map<string, string>();
    expect(canonicalize("", map)).toBe("");
  });
});

describe("resolveProjectCanonical", () => {
  function makeSupabase(rows: { alias: string; canonical: string }[] | null, error: { message: string } | null = null) {
    const eq = () => Promise.resolve({ data: rows, error });
    return {
      from: () => ({
        select: () => ({ eq }),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double, not a real SupabaseClient
    } as any;
  }

  it("builds a flat alias -> canonical map from project_aliases rows", async () => {
    const supabase = makeSupabase([
      { alias: "surajtripathy07/membral", canonical: "dev/membral" },
      { alias: "surajtripathy07/membral-personal", canonical: "dev/membral" },
    ]);
    const map = await resolveProjectCanonical(supabase, "user-1");
    expect(map.get("surajtripathy07/membral")).toBe("dev/membral");
    expect(map.get("surajtripathy07/membral-personal")).toBe("dev/membral");
    expect(map.size).toBe(2);
  });

  it("returns an empty map when there are no rows", async () => {
    const supabase = makeSupabase([]);
    const map = await resolveProjectCanonical(supabase, "user-1");
    expect(map.size).toBe(0);
  });

  it("throws a clean error when the query fails", async () => {
    const supabase = makeSupabase(null, { message: "permission denied" });
    await expect(resolveProjectCanonical(supabase, "user-1")).rejects.toThrow(/project_aliases fetch failed/);
  });
});

// migration 064, NEW-2: 063's claims_browse_entity_labels fix (resolve the
// GROUP's shared prefix_canonical) went too far — a label with its OWN
// alias row (e.g. a manual merge on `surajtripathy07/membral-personal`,
// which has a shorter prefix sibling `surajtripathy07/membral` in the same
// raw-label pool) had that alias silently ignored by the facet, while the
// /code list's TS `canonicalize` (which has always resolved each row's own
// raw label directly, with no prefix-collapse concept at all) still honored
// it — so the two disagreed. The SQL fix (064) gives a label's own alias
// precedence, falling back to the prefix group only when the label has none
// of its own. TS needed NO production code change for this — canonicalize
// already had that precedence, since it has nothing else to fall back to.
// This test locks in that the TS side, unmodified, matches exactly what
// live psql now returns from claims_browse_entity_labels for this scenario
// (verified 2026-08-27, see migration 064's own header / the W7 report's
// "Round 3" section for the exact SQL and its output).
describe("canonicalize / project_alias_resolve parity (migration 064, NEW-2)", () => {
  it("a label's OWN alias wins over its prefix-group siblings' shared canonical", () => {
    // Real founder shape: surajtripathy07/membral -> dev/membral (seeded,
    // remote-lineage); surajtripathy07/membral-personal manually re-pointed
    // to Acme Hub (its own row, independent of its prefix sibling).
    const map = new Map([
      ["surajtripathy07/membral", "dev/membral"],
      ["surajtripathy07/membral-personal", "Acme Hub"],
    ]);
    // Live SQL result for the same setup:
    //   surajtripathy07/membral          -> dev/membral
    //   surajtripathy07/membral-personal -> Acme Hub   (its own alias wins)
    expect(canonicalize("surajtripathy07/membral", map)).toBe("dev/membral");
    expect(canonicalize("surajtripathy07/membral-personal", map)).toBe("Acme Hub");
  });

  it("unmerging one label does not drag its prefix-group sibling along", () => {
    // surajtripathy07/membral tombstoned (unmerged); its sibling
    // surajtripathy07/membral-personal keeps its own unrelated row.
    const map = new Map([
      ["surajtripathy07/membral", "surajtripathy07/membral"], // tombstone: resolves to itself
      ["surajtripathy07/membral-personal", "dev/membral"],
    ]);
    // Live SQL result for the same setup:
    //   surajtripathy07/membral          -> surajtripathy07/membral (un-merged)
    //   surajtripathy07/membral-personal -> dev/membral              (untouched)
    expect(canonicalize("surajtripathy07/membral", map)).toBe("surajtripathy07/membral");
    expect(canonicalize("surajtripathy07/membral-personal", map)).toBe("dev/membral");
  });

  // migration 066, RESIDUAL-1: the INVERSE of the case above — tombstoning
  // the label that HAS the shorter prefix sibling (surajtripathy07/membral
  // is a prefix of surajtripathy07/membral-personal). 064's SQL fix decided
  // "does this label have its own alias" via
  // `nullif(resolve(raw), raw)` — a tombstone resolves a label TO ITSELF,
  // so that nullif went NULL exactly like "no alias row at all," and the
  // facet silently fell through to the group's prefix_canonical
  // (`dev/membral`, via the untouched sibling), while project_alias_resolve
  // and this TS function both correctly returned the label itself. 066
  // fixed the SQL side to decide by ROW EXISTENCE instead — verified live
  // (see migration 066's header / the W7 report's "Round 4" section for the
  // exact SQL and its output, since it now matches this test exactly). TS
  // needed no change: canonicalize already treats `next === current` (a
  // tombstone's map entry) as an immediate stop, which was always the
  // question `nullif` was proxying for on the SQL side — a pure row-lookup
  // was never subject to the string-equality confusion.
  it("tombstoning the label WITH a shorter prefix sibling resolves to itself, not the sibling's group", () => {
    const map = new Map([
      ["surajtripathy07/membral", "dev/membral"], // sibling, untouched
      ["surajtripathy07/membral-personal", "surajtripathy07/membral-personal"], // tombstone: resolves to itself
    ]);
    // Live SQL result for the same setup (post-066):
    //   surajtripathy07/membral          -> dev/membral                        (untouched)
    //   surajtripathy07/membral-personal -> surajtripathy07/membral-personal   (un-merged, NOT dragged into dev/membral)
    expect(canonicalize("surajtripathy07/membral", map)).toBe("dev/membral");
    expect(canonicalize("surajtripathy07/membral-personal", map)).toBe("surajtripathy07/membral-personal");
  });
});
