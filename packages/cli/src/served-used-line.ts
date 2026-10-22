// `membral status` served/used line (recall-precision L7). Asks the server how
// many recalled records were served, and of those used (quoted or edited after
// serving: co-occurrence, not proof of help), ignored, still pending, or unlinked, over
// the last 7 days. Best-effort: any failure (old server 404, offline, bad
// JSON) yields null and status prints nothing extra. Never throws.
import { createUploadClient } from "./code-session-upload.js";
import type { ApiClient } from "./lib/api-client.js";

interface Counts {
  served: number;
  used: number;
  ignored: number;
  pending: number;
  unlinked: number;
}
interface Wire extends Partial<Counts> {
  surface?: unknown;
}

// Bounds the WHOLE call (incl. a 401 fallback retry), not each attempt.
const SERVED_USED_BUDGET_MS = 4_000;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const counts = (w: Wire): Counts => ({
  served: num(w.served),
  used: num(w.used),
  ignored: num(w.ignored),
  pending: num(w.pending),
  unlinked: num(w.unlinked),
});

/** One line, exact prefix `served `; null when the payload is not the expected shape. */
export function formatServedUsedLine(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { days?: unknown; totals?: unknown; surfaces?: unknown };
  if (typeof d.totals !== "object" || d.totals === null) return null;
  const t = counts(d.totals as Wire);
  const days = num(d.days) || 7;
  const surfaces = Array.isArray(d.surfaces) ? (d.surfaces as Wire[]) : [];
  const per = surfaces
    .filter((s) => typeof s?.surface === "string")
    .map((s) => {
      const c = counts(s);
      return `${s.surface} ${c.served}/${c.used}/${c.ignored}/${c.pending}/${c.unlinked}`;
    });
  const detail = per.length > 0 ? `; ${per.join(", ")}` : "";
  return `served ${t.served} · used ${t.used} · ignored ${t.ignored} · pending ${t.pending} · unlinked ${t.unlinked} (${days} days${detail})`;
}

export async function fetchServedUsedLine(
  config: {
    apiUrl: string;
    apiKey: string;
    apiKeySource?: Parameters<typeof createUploadClient>[0]["apiKeySource"];
    apiUrlSource?: Parameters<typeof createUploadClient>[0]["apiUrlSource"];
  },
  opts: {
    fetchImpl?: typeof fetch;
    client?: ApiClient;
    markerDir?: string;
    credsPath?: string;
    budgetMs?: number;
  } = {},
): Promise<string | null> {
  try {
    const client =
      opts.client ??
      createUploadClient(config, {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.markerDir ? { markerDir: opts.markerDir } : {}),
        ...(opts.credsPath ? { credsPath: opts.credsPath } : {}),
        log: () => {},
      });
    const result = await client.call<unknown>("servedUsed", {
      abortAt: Date.now() + (opts.budgetMs ?? SERVED_USED_BUDGET_MS),
    });
    if (!result.ok) return null;
    return formatServedUsedLine(result.data);
  } catch {
    return null;
  }
}
