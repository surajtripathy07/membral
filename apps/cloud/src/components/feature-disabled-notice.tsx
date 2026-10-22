import { type CheckFeatureResult, formatUsdSpend } from "@/lib/feature-flags";

/**
 * Unobtrusive notice for an account whose `llm` feature is not fully
 * allowed right now (issue #126/#128, ADR 0047 v2) — rendered server-side
 * on the dashboard shell via `checkFeature`. Non-LLM functionality (sync,
 * browse, keyword search, embeddings-backed semantic search) keeps working
 * regardless; this is informational, not a blocking gate in the UI itself
 * (the gate is server-side, at every LLM-spending choke point).
 *
 * Takes the FULL `checkFeature` result (not just a boolean) so the copy can
 * distinguish "never enabled" from "trial allowance used up" — same
 * reason/contact shape `featureDisabledResponse` uses for the API's own 403
 * body, so the UI and the API never say something different for the same
 * account state.
 */
export function FeatureDisabledNotice({ check }: { check: CheckFeatureResult }) {
  if (check.allowed) return null;

  const budgetLine =
    check.reason !== "disabled" && check.budgetUsd !== null
      ? ` (used $${formatUsdSpend(check.spentUsd)} of $${check.budgetUsd.toFixed(2)})`
      : "";

  const message =
    check.reason === "disabled"
      ? "Memory features are not enabled for this account. Extracting memories from your conversations costs real money"
      : check.reason === "budget_exhausted"
        ? `Your memory allowance is used up${budgetLine}`
        : `Daily memory allowance reached${budgetLine}; try again tomorrow`;

  return (
    <div className="mb-6 rounded-card border border-line bg-surface p-4 text-sm text-muted">
      {message} — email{" "}
      <a href={`mailto:${check.contact}`} className="text-accent hover:underline">
        {check.contact}
      </a>{" "}
      to {check.reason === "disabled" ? "enable it" : "extend it"}.
    </div>
  );
}
