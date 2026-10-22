import { STORAGE_KEYS } from "../common/constants.js";
import { fetchWithTimeout } from "../common/fetch.js";

export interface ManifestEntry {
  source: string;
  source_id: string;
  updated_at: string;
}

interface CloudManifest {
  conversations: ManifestEntry[];
  fetchedAt: string;
}

/** Cache TTL: 60 seconds (membral-4mr — shorter window between devices reduces the chance
 * of two devices pushing the same not-yet-visible-in-manifest conversation). */
const MANIFEST_TTL_MS = 60 * 1_000;

/**
 * Fetch the cloud manifest from the API.
 * Returns a list of conversation stubs: source, source_id, updated_at.
 *
 * Contract: GET {cloudUrl}/api/conversations/manifest
 * Header:   Authorization: Bearer <accessToken>
 * Response: { conversations: [{ source, source_id, updated_at }] }
 */
export async function fetchCloudManifest(accessToken: string, cloudUrl: string): Promise<ManifestEntry[]> {
  const response = await fetchWithTimeout(`${cloudUrl}/api/conversations/manifest`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Manifest fetch failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return (data.conversations ?? []) as ManifestEntry[];
}

/**
 * Returns a Map keyed "source:source_id" → cloud updated_at.
 *
 * Caches results for MANIFEST_TTL_MS. Forces a refetch when localConvCount
 * is 0 (fresh install / cleared storage) to guarantee dedup on first run.
 * Falls back to stale cache on fetch failure; returns empty Map if no cache.
 */
export async function getCloudIdMap(
  localConvCount: number,
  accessToken: string | null,
  cloudUrl: string,
): Promise<Map<string, string>> {
  if (!accessToken) return new Map();

  const cached = await getCachedManifest();
  const cacheAgeMs = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  const cacheExpired = cacheAgeMs > MANIFEST_TTL_MS;
  const forceRefetch = localConvCount === 0;

  if (!forceRefetch && cached && !cacheExpired) {
    return buildIdMap(cached.conversations);
  }

  try {
    const entries = await fetchCloudManifest(accessToken, cloudUrl);
    const manifest: CloudManifest = {
      conversations: entries,
      fetchedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.CLOUD_MANIFEST]: manifest });
    return buildIdMap(entries);
  } catch {
    // Fetch failed: serve stale cache if available, else empty map
    if (cached) return buildIdMap(cached.conversations);
    return new Map();
  }
}

async function getCachedManifest(): Promise<CloudManifest | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CLOUD_MANIFEST);
  return (result[STORAGE_KEYS.CLOUD_MANIFEST] as CloudManifest) ?? null;
}

function buildIdMap(entries: ManifestEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) {
    m.set(`${e.source}:${e.source_id}`, e.updated_at);
  }
  return m;
}
