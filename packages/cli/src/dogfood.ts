// "Membral on Membral" on the CLI (goal 2026-10-10 recall-precision, box 9,
// §W3b bullets 3-5). Reads GET /api/memory/dogfood (apps/cloud
// lib/memory/dogfood-signals.ts defines every count) and turns it into:
//   - the `membral status` line (formatDogfoodStatusLine),
//   - the weekly digest markdown (`membral dogfood digest`, renderDigest),
//     optionally posted as a comment on the rolling issue via `gh`,
//   - the contradicted-record candidates file (`membral dogfood candidates`).
// The sweep runs digest+candidates at most once per ISO week when the config
// keys are set (runWeeklyDogfood). Everything here is best-effort: a 404 (old
// server), no key, no `gh`, a network error — print a message or nothing,
// never throw, never fail the caller.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { loadCliConfig } from "./cli-config.js";
import { createUploadClient } from "./code-session-upload.js";
import type { ApiClient } from "./lib/api-client.js";

export interface DogfoodTotals {
  served: number;
  used: number;
  ignored: number;
  contradicted: number;
  confirmed: number;
  empty: number;
  empty_below_floor: number;
  empty_no_match: number;
  hook: { calls: number; injected: number; empty: number; budget_hit: number; timeout: number; errors: number };
  feedback: { total: number; [sentiment: string]: number };
}
export interface DogfoodQuote {
  id: string;
  sentiment: string;
  surface: string | null;
  quote: string;
  code_session_id: string;
  turn_idx: number;
  created_at: string;
}
/** Self-report vs judge agreement per question (0..1, null when no session has both), over `sessions`. */
export interface DogfoodAgreement {
  sessions: number;
  q1: number | null;
  q2: number | null;
  q3: number | null;
  q4: number | null;
}

export interface DogfoodData {
  /** Absent from an older server. */
  agreement?: DogfoodAgreement;
  days: number;
  since: string;
  totals: DogfoodTotals;
  quotes: DogfoodQuote[];
}
export interface DogfoodCandidateWire {
  id: string;
  text: string;
  record_quote: string | null;
  quote: string | null;
  code_session_id: string;
  turn_idx: number | null;
  contradicted_at: string;
}

type ClientConfig = {
  apiUrl: string;
  apiKey: string;
  apiKeySource?: Parameters<typeof createUploadClient>[0]["apiKeySource"];
};
export interface DogfoodFetchOpts {
  fetchImpl?: typeof fetch;
  client?: ApiClient;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Normalizes the wire payload; null when it is not the expected shape. Pure. */
export function parseDogfood(data: unknown): DogfoodData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!d.totals || typeof d.totals !== "object") return null;
  const t = obj(d.totals);
  const h = obj(t.hook);
  const f = obj(t.feedback);
  const feedback: DogfoodTotals["feedback"] = { total: num(f.total) };
  for (const [k, v] of Object.entries(f)) feedback[k] = num(v);
  const quotes = Array.isArray(d.quotes)
    ? (d.quotes as unknown[]).filter(
        (q): q is DogfoodQuote =>
          !!q &&
          typeof (q as DogfoodQuote).quote === "string" &&
          typeof (q as DogfoodQuote).code_session_id === "string",
      )
    : [];
  return {
    days: num(d.days) || 7,
    since: typeof d.since === "string" ? d.since : "",
    totals: {
      served: num(t.served),
      used: num(t.used),
      ignored: num(t.ignored),
      contradicted: num(t.contradicted),
      confirmed: num(t.confirmed),
      empty: num(t.empty),
      empty_below_floor: num(t.empty_below_floor),
      empty_no_match: num(t.empty_no_match),
      hook: {
        calls: num(h.calls),
        injected: num(h.injected),
        empty: num(h.empty),
        budget_hit: num(h.budget_hit),
        timeout: num(h.timeout),
        errors: num(h.errors),
      },
      feedback,
    },
    quotes,
    ...parseAgreement(obj(d.agreement).totals),
  };
}

function parseAgreement(v: unknown): { agreement?: DogfoodAgreement } {
  if (!v || typeof v !== "object") return {};
  const a = v as Record<string, unknown>;
  const q = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return { agreement: { sessions: num(a.sessions), q1: q(a.q1), q2: q(a.q2), q3: q(a.q3), q4: q(a.q4) } };
}

/** "Self-report vs judge agreement: q1 x% · q2 x% · q3 x% · q4 x% (n sessions)". Pure. */
export function formatAgreementLine(a: DogfoodAgreement | undefined): string {
  if (!a || a.sessions === 0) return "Self-report vs judge agreement: n/a (0 sessions)";
  const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  return `Self-report vs judge agreement: q1 ${pct(a.q1)} · q2 ${pct(a.q2)} · q3 ${pct(a.q3)} · q4 ${pct(a.q4)} (${a.sessions} session${a.sessions === 1 ? "" : "s"})`;
}

function clientFor(config: ClientConfig, opts: DogfoodFetchOpts): ApiClient {
  return (
    opts.client ??
    createUploadClient(config, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), log: () => {} })
  );
}

/** GET /api/memory/dogfood?days=N. Null on any failure (404, offline, bad JSON). Never throws. */
export async function fetchDogfood(
  config: ClientConfig,
  days: number,
  opts: DogfoodFetchOpts = {},
): Promise<DogfoodData | null> {
  try {
    const result = await clientFor(config, opts).call<unknown>("dogfood", {
      query: new URLSearchParams({ days: String(days) }),
    });
    return result.ok ? parseDogfood(result.data) : null;
  } catch {
    return null;
  }
}

/** GET /api/memory/dogfood?view=candidates. Null on any failure. Never throws. */
export async function fetchCandidates(
  config: ClientConfig,
  days: number,
  opts: DogfoodFetchOpts = {},
): Promise<DogfoodCandidateWire[] | null> {
  try {
    const result = await clientFor(config, opts).call<unknown>("dogfood", {
      query: new URLSearchParams({ days: String(days), view: "candidates" }),
    });
    if (!result.ok) return null;
    const list = obj(result.data).candidates;
    if (!Array.isArray(list)) return null;
    return list.filter((c): c is DogfoodCandidateWire => !!c && typeof (c as DogfoodCandidateWire).id === "string");
  } catch {
    return null;
  }
}

/** `membral status` line. Exact prefix `membral on membral: served N · used N · contradicted N`. Pure. */
export function formatDogfoodStatusLine(d: DogfoodData): string {
  const t = d.totals;
  return (
    `membral on membral: served ${t.served} · used ${t.used} · contradicted ${t.contradicted}` +
    ` · feedback ${t.feedback.total} · empty ${t.empty} · budget-hit ${t.hook.budget_hit + t.hook.timeout}` +
    ` (${d.days} days)`
  );
}

export async function fetchDogfoodStatusLine(
  config: ClientConfig,
  opts: DogfoodFetchOpts = {},
): Promise<string | null> {
  const d = await fetchDogfood(config, 7, opts);
  return d ? formatDogfoodStatusLine(d) : null;
}

/** Dashboard link to a session turn (same shape as the cloud's sessionHref). */
export function sessionLink(appUrl: string, sessionId: string, turnIdx?: number | null): string {
  const base = appUrl.replace(/\/+$/, "");
  return turnIdx === null || turnIdx === undefined
    ? `${base}/code/session/${sessionId}`
    : `${base}/code/session/${sessionId}?turn=${turnIdx}#turn-${turnIdx}`;
}

/** ISO-8601 week, e.g. "2026-W41" (UTC). Same rule as the cloud's isoWeek. Pure. */
export function isoWeek(at: Date): string {
  const day = at.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const oneLine = (s: string, max = 240): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const ZWSP = "\u200b";
/** Max chars of one quote in the digest. */
const DIGEST_QUOTE_MAX = 200;

/**
 * Quoted session text is untrusted in a GitHub comment: break `@mention`s and
 * `#123` / `owner/repo#123` back-links with a zero-width space, defuse markdown
 * links, images and HTML, and cap the length. Pure.
 */
export function neutralizeQuote(text: string, max = DIGEST_QUOTE_MAX): string {
  return oneLine(text, max)
    .replace(/@/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/[<>[\]`]/g, (c) => `\\${c}`)
    .replace(/\bGH-(?=\d)/gi, (m) => `${m}${ZWSP}`);
}

/** The weekly digest as markdown. Pure. */
export function renderDigest(d: DogfoodData, opts: { appUrl: string; week: string }): string {
  const t = d.totals;
  const lines = [
    `## Membral on Membral — ${opts.week}`,
    "",
    `Last ${d.days} days. Served ${t.served} records: used ${t.used}, ignored ${t.ignored}; confirmed ${t.confirmed}, contradicted ${t.contradicted}.`,
    `Searches that returned nothing: ${t.empty} (below the floor ${t.empty_below_floor}, no match ${t.empty_no_match}).`,
    `Prompt hook: ${t.hook.calls} calls, ${t.hook.injected} injected, ${t.hook.empty} empty, ${t.hook.budget_hit} budget hit, ${t.hook.timeout} timed out, ${t.hook.errors} errors.`,
    `Feedback: ${t.feedback.total}${feedbackBreakdown(t.feedback)}.`,
    formatAgreementLine(d.agreement),
    "",
  ];
  if (d.quotes.length === 0) {
    lines.push("No session said anything about Membral this week.");
  } else {
    lines.push("### Feedback");
    for (const q of d.quotes.slice(0, 10)) {
      lines.push(
        `- **${q.sentiment}**${q.surface ? ` (${q.surface})` : ""}: “${neutralizeQuote(q.quote)}” — [session](${sessionLink(opts.appUrl, q.code_session_id, q.turn_idx)})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function feedbackBreakdown(f: DogfoodTotals["feedback"]): string {
  const parts = Object.entries(f)
    .filter(([k, v]) => k !== "total" && v > 0)
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export interface PostResult {
  ok: boolean;
  message: string;
}
export type GhRunner = (
  args: string[],
  input: string,
) => { status: number | null; stderr: string; stdout?: string; error?: Error };

const defaultGh: GhRunner = (args, input) => {
  const r = spawnSync("gh", args, { input, encoding: "utf8", timeout: 30_000 });
  return {
    status: r.status,
    stderr: String(r.stderr ?? ""),
    stdout: String(r.stdout ?? ""),
    ...(r.error ? { error: r.error } : {}),
  };
};

/** True only when `gh repo view --json isPrivate` says the repo is private. Anything else (public, error, odd output) is false: fail closed. */
export function repoIsPrivate(repo: string, gh: GhRunner = defaultGh): boolean {
  try {
    const r = gh(["repo", "view", repo, "--json", "isPrivate"], "");
    if (r.error || r.status !== 0) return false;
    return (JSON.parse(r.stdout ?? "") as { isPrivate?: unknown } | null)?.isPrivate === true;
  } catch {
    return false;
  }
}

/** `gh issue comment <n> --repo <r> --body-file -`. Soft-fails: never throws. */
export function postDigest(body: string, issue: number, repo: string, gh: GhRunner = defaultGh): PostResult {
  try {
    if (!repoIsPrivate(repo, gh)) return { ok: false, message: `${repo} is not confirmed private — digest not posted` };
    const r = gh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], body);
    if (r.error) {
      const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
      return {
        ok: false,
        message: missing ? "gh is not on PATH — digest not posted" : `gh failed: ${r.error.message}`,
      };
    }
    if (r.status !== 0) return { ok: false, message: `gh exited ${r.status}: ${oneLine(r.stderr, 200)}` };
    return { ok: true, message: `digest posted to ${repo}#${issue}` };
  } catch (err) {
    return { ok: false, message: `gh failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The frozen benchmark set, relative to the repo root (scripts/eval/recall-precision). */
export const FROZEN_BENCH_REL = join("scripts", "eval", "recall-precision", "bench.json");

/** realpath of `path`, or of its nearest existing ancestor plus the rest when it does not exist yet. */
function realPathOf(path: string): string {
  const abs = resolve(path);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * True when `path` resolves (symlinks followed) to the frozen bench set:
 * `scripts/eval/recall-precision/bench.json` in any checkout, or any
 * `bench.json` under a directory named `recall-precision`. Candidates never go
 * there.
 */
export function isFrozenBenchPath(path: string): boolean {
  const real = realPathOf(path);
  if (real.endsWith(`${sep}${FROZEN_BENCH_REL}`)) return true;
  return basename(real) === "bench.json" && real.split(sep).slice(0, -1).includes("recall-precision");
}

export interface CandidateEntry {
  id: string;
  text: string;
  quote: string | null;
  record_quote: string | null;
  session_link: string;
  contradicted_at: string;
}

/** Appends new contradicted records to the JSON array at `path`, deduped by id. Returns how many were added. */
export function appendCandidates(path: string, candidates: DogfoodCandidateWire[], appUrl: string): number {
  if (!isAbsolute(path)) throw new Error(`refusing to write candidates to ${path}: the path must be absolute`);
  if (isFrozenBenchPath(path))
    throw new Error(`refusing to write candidates to ${path}: looks like the frozen bench set`);
  let existing: CandidateEntry[] = [];
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error(`${path} is not a JSON array`);
    existing = raw as CandidateEntry[];
  }
  const seen = new Set(existing.map((c) => c?.id));
  const added: CandidateEntry[] = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    added.push({
      id: c.id,
      text: c.text,
      quote: c.quote,
      record_quote: c.record_quote,
      session_link: sessionLink(appUrl, c.code_session_id, c.turn_idx),
      contradicted_at: c.contradicted_at,
    });
  }
  if (added.length === 0 && existsSync(path)) return 0;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify([...existing, ...added], null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return added.length;
}

/** Config keys under `dogfood` in ~/.membral/config.json. */
export interface DogfoodConfig {
  issue?: number;
  repo?: string;
  candidatesPath?: string;
}

export function readDogfoodConfig(path?: string): DogfoodConfig {
  const d = obj(loadCliConfig(path).dogfood);
  const out: DogfoodConfig = {};
  const issue = Number(d.issue);
  if (Number.isInteger(issue) && issue > 0) out.issue = issue;
  if (typeof d.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(d.repo)) out.repo = d.repo;
  // Relative paths are rejected: the sweep's cwd is not the user's.
  if (typeof d.candidatesPath === "string" && isAbsolute(d.candidatesPath.trim()))
    out.candidatesPath = d.candidatesPath.trim();
  return out;
}

export interface WeeklyDeps {
  config: ClientConfig;
  dogfood: DogfoodConfig;
  now: Date;
  /** The ISO week the sweep last ran this step (sweep-state.json `dogfood_last_week`). */
  lastWeek: string | undefined;
  log: (line: string) => void;
  gh?: GhRunner;
  fetch?: DogfoodFetchOpts;
}

/**
 * The sweep's weekly step: digest (when issue+repo are set) and candidates
 * (when candidatesPath is set), at most once per ISO week. Returns the week
 * to store as `dogfood_last_week`, or undefined when nothing ran (off, already
 * ran this week, or the server could not be read — retried next run).
 */
export async function runWeeklyDogfood(deps: WeeklyDeps): Promise<string | undefined> {
  const { dogfood, now } = deps;
  const digestOn = dogfood.issue !== undefined && dogfood.repo !== undefined;
  const candidatesOn = dogfood.candidatesPath !== undefined;
  if (!digestOn && !candidatesOn) return undefined;
  const week = isoWeek(now);
  if (deps.lastWeek === week) return undefined;
  let ran = false;
  if (digestOn) {
    try {
      const d = await fetchDogfood(deps.config, 7, deps.fetch ?? {});
      if (d) {
        // Attempted: the week is recorded even if the post or the candidates
        // step below fails, so the digest is never re-posted every sweep.
        ran = true;
        const r = postDigest(
          renderDigest(d, { appUrl: deps.config.apiUrl, week }),
          dogfood.issue as number,
          dogfood.repo as string,
          deps.gh,
        );
        deps.log(`dogfood: ${r.message}`);
      } else {
        deps.log("dogfood: signals unavailable — digest skipped");
      }
    } catch (err) {
      deps.log(`dogfood: digest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (candidatesOn) {
    try {
      const list = await fetchCandidates(deps.config, candidateWindowDays(deps.lastWeek, now), deps.fetch ?? {});
      if (list) {
        const n = appendCandidates(dogfood.candidatesPath as string, list, deps.config.apiUrl);
        deps.log(`dogfood: ${n} new candidate(s) → ${dogfood.candidatesPath}`);
        ran = true;
      }
    } catch (err) {
      deps.log(`dogfood: candidates failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ran ? week : undefined;
}

/** First run: 14 days. Otherwise since the Monday of the last run's ISO week (whole days, 7–90). Pure. */
export function candidateWindowDays(lastWeek: string | undefined, now: Date): number {
  const m = /^(\d{4})-W(\d{2})$/.exec(lastWeek ?? "");
  if (!m) return 14;
  // ISO week 1 holds Jan 4; its Monday is Jan 4 minus (weekday - 1).
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const jan4Day = new Date(jan4).getUTCDay() || 7;
  const monday = jan4 - (jan4Day - 1) * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000;
  const days = Math.ceil((now.getTime() - monday) / 86_400_000);
  return Math.min(90, Math.max(7, days));
}
