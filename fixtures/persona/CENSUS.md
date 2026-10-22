# Graph census — Tusk demo corpus through the real KG pipeline

> Eyeball-gate artifact for bead membral-fwz. Synthetic input, real pipeline output
> (`npm run kg:bootstrap`, unmodified, `gpt-4o-mini`), never hand-edited. `/map` and
> `/pulse` still read the old spike schema until membral-859 lands, so this census +
> `graph-snapshot.json` stand in for screenshots.

## Run

- Demo user: `tusk-demo@membral.demo` (`38af1bb3-3c9c-497b-b36a-42d4647e4264`, local Supabase)
- Corpus: 200 conversations / 1,998 messages (generation: $1.46 on `gpt-4o`)
- Bootstrap: pass1 200/200 done (0 failed) -> 200 embeddings -> Stage A (4 LifeAreas,
  49 blocks, 0 incoherent) -> promote (47 items, 48 contains edges) -> Stage B
  (175 attached, 25 orphans, 307 entity mentions, 0 failures, 0 pending conflicts)
- Bootstrap cost: **$0.0745**

## Headline numbers

| Metric | Value |
|---|---:|
| Nodes | 339 (4 LifeArea, 47 Item, 200 Conversation, 29 Person, 16 Organization, 34 Tool, 9 Artifact) |
| Edges | 528 (132 mentions_person, 104 discusses, 100 collaborates_with, 71 contributes_to, 55 uses_tool, 48 contains, 18 modifies) |
| Conversations attached | 175 / 200 (87.5%) |
| Orphans | 25 / 200 (12.5%) — 10 were *designed* noise one-offs |
| Distinct entities | 88 |

## Produced LifeAreas vs. the 8 design targets (PERSONA.md §4)

The pipeline consolidated the 8 designed areas into **4 broader LifeAreas**, with the
designed areas mostly appearing as Item sub-trees underneath. Not 1:1, but the mapping
is legible:

| Target LifeArea (design) | Where it landed |
|---|---|
| SpaceY (rockets) | Split: `Space and Engineering > Rocket Launch and Space Missions` (14+ convs) **plus** several SpaceY work-threads under `Work` (Leviathan engine count, Booster Catch Optimization, Positive Framing of Failures) |
| Tusla (EVs & factory) | Items under `Work` (Cyberwedge panel tolerances, automation vs humans, robotaxi/Optimist demos, record quarter, price wars) — no distinct Tusla cluster |
| The Dull Company (tunnels) | `Space and Engineering > Tunneling Projects and Innovations` (9 convs) |
| Zapp (social platform) | Items under `Work` (Zapp app development/launch, advertiser concerns, cage-match challenge, engagement strategies) |
| MechaMind / Groak (AI) | `Work > AI model development and ethics` + Groak item family (23+ convs) |
| Fatherhood & Co-Parenting | `Personal Development and Family` (12 convs) + cross-bleed items under Space ("Teaching rocketry to a child", "Co-parenting schedule adjustment for event") |
| Health, Sleep & Biohacking | `Health and Well-being` (14 convs) |
| Occupy Mars | `Space and Engineering > Mars Mission Planning / Mars Colonization Essentials / Governance / Naming the first city` + the "Considering a move to Mars" decision under `Personal Development and Family` — the designed Fatherhood<->Mars intersection genuinely surfaced |

Produced area sizes: `Work` 89 convs / 23 items · `Space and Engineering` 60 / 17 ·
`Health and Well-being` 14 / 3 · `Personal Development and Family` 12 / 4.

## Entity recurrence (the load-bearing design bet) — worked

Top mentioned entities are exactly the designed cast, spelled consistently:

SpaceY x26 · Tusla x17 · Zapp x17 · Groak x16 · Dahlia Frost x15 · Dr. Renata Voss x15 ·
Priya Chen x14 · Chad Vanguard x13 · Gary Puddle x12 · Marisol Vega x11 ·
The Dull Company x9 · MechaMind x9 · Leviathan x9 · Vanguard Dynamics x8 · Björn Kessler x7.

These recur across conversations attached to different areas, giving the graph its
cross-area connective tissue (100 `collaborates_with`, 132 `mentions_person` edges).

## Honest pipeline-behavior notes (for the eyeball gate)

1. **4 areas, not 8.** Stage A prefers broad umbrellas; the company-per-cluster shape the
   design hoped for became item sub-trees. `Work` is a grab-bag of 89 conversations
   spanning Tusla + Zapp + parts of SpaceY/MechaMind — a founder judgment call whether
   that's acceptable demo shape or needs Stage-A tuning.
2. **Near-duplicate sibling items.** Three Groak variants ("Groak AI Model Discussions",
   "Groak Integration and Launch Strategies", "Groak Integration Strategies") and 2-3 Mars
   planning variants ("Mars Mission Planning and Development", "Mars Mission Planning
   Conversations", "Mars Colonization Essentials") exist as separate items rather than
   merging.
3. **A `contains` cycle exists in the item tree** (snapshot.ts needed a cycle guard to
   serialize it). Worth a look in the pipeline's tree invariants.
4. **Orphans are reasonable.** 10/25 are the intentionally-designed noise one-offs
   (hot-dog sandwich, fitted sheet, red-wine stain, reheating pizza...). The other ~15 are
   single-shot deep-technical lookups (turbopump failure, COPV telemetry, gigacasting
   metallurgy, LFP-vs-NMC) that plausibly lacked a sibling to cluster with.
5. **Cross-bleed worked where designed:** the recital/static-fire co-parenting thread sits
   under the rocket item tree; the "do I personally move to Mars" thread sits under
   family — exactly the intersections PERSONA.md called for.
