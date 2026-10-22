import type { ForgeAction, ForgeVerb } from "./types.js";

// --- ranking -------------------------------------------------------------

// Highest first: the one action a turn is summarised by when a chain yields
// several. Closure beats delivery beats review beats bookkeeping.
const VERB_RANK: ForgeVerb[] = [
  "merged",
  "closed",
  "reopened",
  "opened_mr",
  "pushed",
  "committed",
  "approved",
  "commented",
  "triaged",
  "opened",
  "checked_out",
  "viewed",
  "rewrote",
  "tested",
  "referenced",
  "navigated",
];

/** The action a turn is summarised by (`RawTurn.action`) when it produced several. */
export function primaryAction(actions: ForgeAction[]): ForgeAction | undefined {
  let best: ForgeAction | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const a of actions) {
    const rank = VERB_RANK.indexOf(a.verb);
    if (rank !== -1 && rank < bestRank) {
      best = a;
      bestRank = rank;
    }
  }
  return best ?? actions[0];
}
