/**
 * The Membral instance the extension talks to. The default comes from the build (see
 * build-manifest.ts and DEFAULT_CLOUD_URL in sync/cloud-push.ts); the options page can point it
 * somewhere else. A different origin needs a runtime host permission (the manifest only lists the
 * build's own target plus `optional_host_permissions`), and `chrome.permissions.request` only works
 * inside a user gesture, so the options page calls `applyCloudUrl` from a click handler.
 */
import { STORAGE_KEYS } from "./constants.js";

export type NormalizedCloudUrl =
  | { ok: true; cleared: true }
  | { ok: true; cleared: false; url: string; originPattern: string }
  | { ok: false; error: string };

/** Empty input clears the override; otherwise an http(s) URL reduced to its origin (no path, no trailing slash). */
export function normalizeCloudUrl(input: string): NormalizedCloudUrl {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cleared: true };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That is not a valid URL (include http:// or https://)" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "The URL must start with http:// or https://" };
  }
  // Match patterns carry no port-less ambiguity: "http://host:3000/*" matches that port only.
  return { ok: true, cleared: false, url: parsed.origin, originPattern: `${parsed.origin}/*` };
}

export type ApplyCloudUrlResult = { ok: true; url: string | null } | { ok: false; error: string };

/**
 * Validates `input`, asks the browser for host access to its origin (must run inside the click
 * handler that triggered it), and stores the override only when access was granted.
 */
export async function applyCloudUrl(input: string): Promise<ApplyCloudUrlResult> {
  const normalized = normalizeCloudUrl(input);
  if (!normalized.ok) return normalized;

  if (normalized.cleared) {
    await chrome.storage.local.remove(STORAGE_KEYS.CLOUD_URL);
    return { ok: true, url: null };
  }

  const request = { origins: [normalized.originPattern] };
  let granted = false;
  try {
    granted = (await chrome.permissions.contains(request)) || (await chrome.permissions.request(request));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not request access to ${normalized.url}: ${msg}` };
  }
  if (!granted) {
    return { ok: false, error: `Access to ${normalized.url} was refused, so the URL was not saved` };
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.CLOUD_URL]: normalized.url });
  return { ok: true, url: normalized.url };
}
