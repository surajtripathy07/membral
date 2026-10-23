import type { Provider } from "@membral/core";

export const PROVIDERS: Record<string, Provider> = {
  claude: {
    id: "claude",
    name: "Claude.ai",
    domain: "claude.ai",
    baseUrl: "https://claude.ai",
    enabled: true,
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    domain: "chatgpt.com",
    baseUrl: "https://chatgpt.com",
    enabled: true,
  },
};

export const SYNC_ALARM_NAME = "membral-sync-daily";
export const SYNC_INTERVAL_MINUTES = 24 * 60;
export const DEFAULT_PAGE_SIZE = 50;
export const CHATGPT_REQUEST_DELAY_MS = 100;

/**
 * Sync window (#120): a first sync used to fetch a provider's ENTIRE
 * history (~10 hours for a large account). Instead, sync only conversations
 * updated within a rolling window, default 30 days back -- both for speed
 * and a smaller fetch surface. `days: null` ("All history") disables the
 * floor entirely, restoring the old full-history behavior. Kept as a short,
 * simple preset list per the issue's "keep it simple" call rather than a
 * free-form day picker.
 */
export interface SyncWindowPreset {
  label: string;
  days: number | null;
}

export const SYNC_WINDOW_PRESETS: SyncWindowPreset[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last year", days: 365 },
  { label: "All history", days: null },
];

export const DEFAULT_SYNC_WINDOW_DAYS = 30;

/**
 * Resolves a stored `Settings.syncWindowDays` to the value that should
 * actually be used: `undefined` (pre-#120 stored settings, or key never
 * saved) falls back to the default, but an explicit `null` ("All history"
 * selected) MUST be preserved as-is. Deliberately NOT `?? DEFAULT_SYNC_WINDOW_DAYS`
 * -- `??` treats `null` and `undefined` the same, which would silently
 * collapse an explicit "All history" choice back down to the 30-day
 * default. Shared by every reader (engine.ts, options.ts, popup.ts) so this
 * distinction is made exactly once.
 *
 * MINOR fix (adversarial review): also clamps a non-positive or non-finite
 * day count to the default, rather than passing it through. A stored value
 * of `0` (or a corrupted/negative value) is a real risk, not just
 * theoretical -- options.ts's optionValueToDays() previously produced
 * exactly this from `Number("")` when the persisted day count didn't match
 * any preset `<select>` option (its value silently resolves to the empty
 * string). computeSyncWindowCutoff(0) resolves to "now," which excludes
 * every conversation from every future sync until the user notices and
 * manually fixes it -- a silent, durable, hard-to-diagnose full stop.
 */
export function resolveSyncWindowDays(syncWindowDays: number | null | undefined): number | null {
  if (syncWindowDays === undefined) return DEFAULT_SYNC_WINDOW_DAYS;
  if (syncWindowDays === null) return null;
  return Number.isFinite(syncWindowDays) && syncWindowDays > 0 ? syncWindowDays : DEFAULT_SYNC_WINDOW_DAYS;
}

/**
 * Encodes/decodes the "Sync window" `<select>`'s value (options.ts) --
 * pulled out here (rather than living as private functions in options.ts)
 * so they're plain, DOM-free pure functions: options.ts's top-level `const
 * el = document.getElementById(...)` calls make importing that module
 * directly from a `node`-environment test crash immediately (no `document`
 * global), so this is also what test gap (d) (adversarial review, #120)
 * imports to cover the round-trip, "all"<->null included, without needing a
 * jsdom environment this package doesn't otherwise configure.
 */
export const ALL_HISTORY_OPTION_VALUE = "all";

export function daysToOptionValue(days: number | null): string {
  return days === null ? ALL_HISTORY_OPTION_VALUE : String(days);
}

/**
 * MINOR fix (adversarial review): a `<select>` silently resets to no
 * selection (`.value === ""`) when `daysToOptionValue` produces a value
 * that doesn't match any current `<option>` -- e.g. a stored non-preset day
 * count, or a preset list that changed since the value was saved. Without
 * this guard, the next auto-save would read back `optionValueToDays("")` =
 * `Number("") = 0`, persist `syncWindowDays: 0`, and computeSyncWindowCutoff
 * would resolve that to "now" -- silently excluding every conversation from
 * every future sync until someone notices. Any value that isn't a finite
 * positive number falls back to the default instead of being written
 * through as-is.
 */
export function optionValueToDays(value: string): number | null {
  if (value === ALL_HISTORY_OPTION_VALUE) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_WINDOW_DAYS;
}

export const STORAGE_KEYS = {
  CONVERSATIONS: "membral_conversations",
  SYNC_STATE: "membral_state",
  SETTINGS: "membral_settings",
  AUTH_STATE: "membral_auth",
  API_KEY: "membral_api_key",
  CLOUD_URL: "membral_cloud_url",
  CLOUD_MANIFEST: "membral_cloud_manifest",
  CLOUD_SYNC_STATUS: "membral_cloud_sync_status",
  FIRST_RUN_HINT_DISMISSED: "membral_first_run_hint_dismissed",
} as const;
