# Persona fixtures — "Elon Tusk" demo corpus

> **Parody persona. Not affiliated with, endorsed by, or depicting any real person or
> company. All events, companies, and characters are fictional.**

This directory defines **Elon Tusk**, the demo persona that is the public face of Membral —
used for the hosted demo, launch video, README/gallery imagery, dev fixtures, and eval
golden sets. Tusk is an affectionate comedic parody of a chaotic multi-company tech founder.

## The honesty rule

**Synthetic input, real pipeline output, always labeled as a demo.**

- The **input** (Tusk's AI-conversation history) is fabricated from the plan in this folder.
- The **output** (LifeAreas, item tree, relationships) is produced by Membral's **real,
  unmodified** knowledge-graph pipeline (`apps/cloud/src/lib/kg/`).
- We never pass off synthetic conversations as real, and we never hand-edit the graph. The
  persona exists so the founder's real personal data never appears in public assets.

## Files

| File | What it is |
|---|---|
| `PERSONA.md` | The life bible: biography, prompting voice, fictional cast, 15-month timeline of intersecting arcs, the 8 target LifeAreas, and the validated distribution summary. |
| `seed-plan.json` | The load-bearing artifact: 200 planned conversations the generator consumes to synthesize transcripts. |
| `generate.ts` | Generator: seed plan -> 200 common-format conversations via the OpenAI API. Resumable (skips existing corpus files), $15 hard cost cap, CLAUDE.md rate-limit conventions, every output validated against `apps/cloud/src/lib/sync-validator.ts`. |
| `corpus/` | The generated corpus: 200 `tusk-####.json` files (1,998 messages, ~1.2 MB), each labeled `"synthetic": true` in metadata. |
| `import.ts` | Creates/finds the demo auth user (`tusk-demo@membral.demo`) and upserts the corpus for that user — same rows and conflict target as `/api/import`. Re-runnable. |
| `snapshot.ts` | Queries the `kg_*` tables for the demo user, prints a census, writes `graph-snapshot.json`. |
| `lib.ts` | Shared helpers for the scripts above: service client, user management, corpus load/import, snapshot builder. |
| `sweep.ts` | Multi-scale clustering eval (membral-b8w): deterministically subsamples the corpus at several sizes, re-bootstraps each through the real pipeline under `tusk-sweep-<N>@membral.demo`, and scores no-blob / entity-home recall / duplicate-item / orphan-rate / area-count bands. Writes `sweep-results.json`. |
| `sweep-results.json` | Latest sweep run: per-scale metrics, checks, and cost. |
| `graph-snapshot.json` | The eyeball-gate artifact: areas -> items -> conversations -> entities tree from a real bootstrap run. |
| `CENSUS.md` | Human-readable summary of the produced graph vs. the 8 design targets. |
| `README.md` | This file. |

## How to run

Prereqs: repo root, local Supabase running (`cd apps/cloud && npx supabase start`),
`OPENAI_API_KEY` + Supabase keys in `apps/cloud/.env.local`.

```bash
npx tsx fixtures/persona/generate.ts   # 1. synthesize corpus (resumable; ~$1.50 on gpt-4o)
npx tsx fixtures/persona/import.ts     # 2. create demo user + import corpus (idempotent)
npm run kg:bootstrap --workspace=@membral/cloud -- --user-id <uuid printed by import.ts>
                                       # 3. REAL pipeline run (gpt-4o-mini)
npx tsx fixtures/persona/snapshot.ts   # 4. census to stdout + graph-snapshot.json
```

- Model override follows the repo convention: `MEMBRAL_MODEL=... npx tsx fixtures/persona/generate.ts`.
- Generator flags: `--limit N` generates at most N pending entries (smoke-testing).
- Malformed LLM outputs are retried once, then recorded in `failures.json` (deleted on a
  clean run); re-running the generator retries only missing ids.

### Multi-scale clustering sweep (membral-b8w, joint gate with membral-y13)

```bash
npx tsx fixtures/persona/sweep.ts [--scales 60,100,200] [--seed 42] [--metrics-only] [--baseline] [--fresh-pass1]
```

The sweep is the working definition of "scale-generic clustering": one knob rule
(`computeClusterOpts` in `apps/cloud/src/lib/kg/cluster-opts.ts`) plus the entity-aware
refinement (`refine.ts`, membral-y13) must satisfy every metric band at every scale with
zero per-corpus retuning. Subsampling is seeded, so runs are reproducible; pass1/embedding
caches persist per sweep user, so re-running after a knob change only re-spends on Stage A
naming + Stage B attach (~cents). `--metrics-only` re-scores the existing graphs with zero
LLM cost; `--baseline` scores the standing tusk-demo graph against the same bands (also
zero cost). `--fresh-pass1` drops each sweep user's pass1 + embedding caches first, forcing
a full re-classification — required whenever Pass 1's output schema gains fields the cached
rows predate (the membral-y13 `entities` tags: rows cached before the field parse as `[]`
and refinement silently no-ops); costs a full bootstrap per scale (~$0.02-0.08 each).

**Metric core** lives in `apps/cloud/src/lib/kg/sweep-metrics.ts` (unit-tested under the kg
suite, so CI covers it — `fixtures/` is not a workspace); `sweep.ts` only wires Supabase +
bootstrap around it. Entity-home recall (membral-x34): the home-eligible entity types are
`{Organization, Tool, Artifact}` — People are excluded (a person anchors relationships, not
a body of work), and project/artifact anchors (a researcher's thesis/paper/course) are now
credited, not just orgs. Before scoring, entity labels are canonicalized
(`canonicalizeEntityTags`) so trivial variants that GraphWriter stored as separate nodes
("Vanguard" / "Vanguard Dynamics") collapse to one entity instead of fragmenting its
support below the mention floor. Top-K candidates are ranked by attached-conversation
support (>= 3), and an entity has a "home" iff some subtree holds >= 60% of its attached
convs.

### Actual run results (2026-07)

- Generation: **200/200** conversations, 1,998 messages, ~1.2 MB, **$1.46** on `gpt-4o`,
  zero 429s (5 transient API timeouts recovered by the resumable re-run).
- Real `kg:bootstrap` run on demo user `tusk-demo@membral.demo`: **$0.0745** on
  `gpt-4o-mini`, 0 failures — 4 LifeAreas, 47 items, 175/200 attached, 25 orphans,
  88 entities. See `CENSUS.md` for the census vs. the 8 target LifeAreas and
  `graph-snapshot.json` for the full tree.

### `seed-plan.json` entry schema

```json
{
  "id": "tusk-0001",
  "provider": "chatgpt | claude",
  "date": "ISO date within 2025-04 .. 2026-06",
  "title": "realistic conversation title",
  "life_areas": ["primary", "secondary?"],
  "purpose": "problem-solving | learning | writing-help | decision-support | emotional-processing | planning | quick-lookup | brainstorm",
  "depth": "quick (2-6 turns) | medium (6-16 turns) | deep (16-40 turns)",
  "brief": "2-4 sentences telling the generator exactly what happens",
  "arc_refs": ["timeline arcs this advances; [] for noise one-offs"]
}
```

Notes for the generator:
- `life_areas[0]` is the primary cluster; additional entries are secondary bleed. Strings
  match the 8 LifeArea labels in `PERSONA.md` (plus `Finances` as a secondary-only theme).
- `arc_refs` uses short arc keys: `spacey`, `tusla`, `dull`, `zapp`, `mechamind`,
  `fatherhood`, `health`, `mars`, `feud`, `finances`. Empty array = intentional noise.
- **Entity recurrence is the point.** Keep names spelled consistently across transcripts —
  companies (SpaceY, Tusla, The Dull Company, Zapp, MechaMind, Groak, Vanguard Dynamics)
  and people (Priya Chen, Gary Puddle, Dr. Renata Voss, Chad Vanguard, Dahlia Frost, Björn
  Kessler, Marisol Vega, Rex Mountain, Mimi Tusk, Chip Halberd). Recurrence is what the
  graph pipeline latches onto to link LifeAreas.
- Match the **register** implied by the brief (manic / engineering-earnest / meme-
  deflection — see `PERSONA.md`). Deep + emotional/writing threads are the vulnerable ones.

## Tone guardrail

Affectionate parody that punches at the persona's ego and chaos. **No** depiction of real
private individuals (no real kids, partners, or family), **no** real legal matters, **no**
real company names as his ventures. Kids/co-parents are deliberately absurd and fictional.
