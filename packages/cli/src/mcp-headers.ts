// `membral mcp-headers --api-url <url>` (W9 D4): the `http_headers_helper`
// that `membral setup` writes into Codex's `[mcp_servers.membral]`
// (codex-setup.ts). Codex runs it through `sh -c` with a cleared environment
// (HOME, PATH, USER, ... only) and reads one JSON object of header strings
// from stdout (codex-rs/rmcp-client/src/http_headers.rs, run_helper /
// parse_helper_output). This keeps the API key out of ~/.codex/config.toml,
// a dotfile people sync and commit: the key is read from
// ~/.membral/credentials.json each time Codex connects.
//
// The key is only printed for the profile whose server is the baked
// `--api-url`, so after `membral use local` Codex's prod entry never receives
// the local key (or the other way round). No match prints nothing and exits
// 1; Codex then reports the server as failed to start.
import { loadProfiles } from "./credentials.js";

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The key for the profile signed in to `apiUrl` (the active one first), or null. */
export function keyForApiUrl(apiUrl: string, credentialsPath?: string): string | null {
  const state = loadProfiles(credentialsPath);
  if (!state) return null;
  const want = normalizeUrl(apiUrl);
  const active = state.profiles[state.activeProfile];
  if (active && normalizeUrl(active.apiUrl) === want && active.apiKey) return active.apiKey;
  for (const p of Object.values(state.profiles)) {
    if (normalizeUrl(p.apiUrl) === want && p.apiKey) return p.apiKey;
  }
  return null;
}

/** The exact stdout line, or null when there is no key for that server. */
export function buildMcpHeaders(apiUrl: string | undefined, credentialsPath?: string): string | null {
  if (!apiUrl) return null;
  const key = keyForApiUrl(apiUrl, credentialsPath);
  if (!key) return null;
  return `${JSON.stringify({ Authorization: `Bearer ${key}` })}\n`;
}
