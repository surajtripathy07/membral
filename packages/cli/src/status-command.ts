// `membral status` (deliverable 6) — read-only summary of everything setup
// wires up: credentials, device identity, sync.json, and the last sweep.
// Never writes anything.
import { dirname } from "node:path";
import { DEFAULT_API_URL } from "./code-session-upload.js";
import {
  defaultCredentialsPath,
  describeKeySource,
  describeUrlSource,
  loadCredentials,
  loadProfiles,
  maskApiKey,
  resolveCredentials,
} from "./credentials.js";
import { defaultDeviceIdentityPath, loadOrCreateDeviceIdentity } from "./device.js";
import { fetchDogfoodStatusLine } from "./dogfood.js";
import { readEnvKeyMarker } from "./lib/api-client.js";
import { fetchServedUsedLine } from "./served-used-line.js";
import { defaultSweepStatePath, readSweepState } from "./sweep.js";
import { defaultSyncAllowlistPath, loadSyncAllowlist } from "./sync-allowlist.js";

function summarizeSync(allowlist: ReturnType<typeof loadSyncAllowlist>): string {
  if (!allowlist) return `not configured (${defaultSyncAllowlistPath()} not found — every project syncs)`;
  const lines: string[] = [];
  for (const [harness, cfg] of Object.entries(allowlist.harnesses)) {
    const projects = cfg?.projects ?? [];
    const enabled = projects.filter((p) => p.enabled).length;
    lines.push(`    ${harness}: ${enabled}/${projects.length} project(s) enabled`);
  }
  const defaultNote = allowlist.defaultNewProjects === false ? "new projects default OFF" : "new projects default ON";
  return `${defaultSyncAllowlistPath()} (updated ${allowlist.updatedAt}, ${defaultNote})\n${lines.join("\n")}`;
}

export interface StatusOptions {
  apiUrl?: string;
  apiKey?: string;
  /** `membral status --rename <name>` (issue #137) — persists a new name to this machine's device.json (same device id) without running the rest of `membral setup`. */
  rename?: string;
  /** Injected in tests; defaults to the global fetch (served/used line). */
  fetchImpl?: typeof fetch;
  /** Where env-key-rejected markers live (default: beside credentials.json). Tests. */
  markerDir?: string;
}

/** "12 min ago" / "3 h ago" for the env-key marker line. */
function formatAge(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
}

export async function statusCommand(_deps: Record<string, never> = {}, opts: StatusOptions = {}): Promise<void> {
  console.log("Membral status");
  console.log("");

  // Issue #136 req 5: go through the ONE shared resolver (not a bare
  // loadCredentials()) so this reports the ACTUAL key/URL every other
  // command would use right now — including a shell-exported
  // MEMBRAL_API_KEY that's shadowing credentials.json — with the key never
  // printed beyond a short masked prefix.
  const resolved = resolveCredentials({
    flagKey: opts.apiKey,
    flagUrl: opts.apiUrl,
    envKey: process.env.MEMBRAL_API_KEY,
    envUrl: process.env.MEMBRAL_API_URL,
    defaultUrl: DEFAULT_API_URL,
  });
  const creds = loadCredentials();
  console.log("Account:");
  if (resolved.apiKeySource === "none") {
    console.log(`  not signed in — run \`membral login\` (${defaultCredentialsPath()} not found)`);
  } else {
    if (resolved.apiKeySource === "credentials" && creds) {
      console.log(`  signed in as ${creds.email} (${resolved.apiUrl})`);
      console.log(`  since ${creds.createdAt}`);
    } else {
      console.log(`  using an API key from ${describeKeySource(resolved.apiKeySource)} — not from \`membral login\``);
    }
    console.log(`  api url: ${resolved.apiUrl} (from ${describeUrlSource(resolved.apiUrlSource)})`);
    console.log(`  api key: ${maskApiKey(resolved.apiKey)} (from ${describeKeySource(resolved.apiKeySource)})`);
    // The upload client leaves a marker when this env key got a 401 and the
    // credentials.json key then worked on the same server (design note §4).
    // Read from disk only: no network call.
    if (resolved.apiKeySource === "env") {
      const marker = readEnvKeyMarker(
        opts.markerDir ?? dirname(defaultCredentialsPath()),
        resolved.apiKey,
        resolved.apiUrl,
      );
      if (marker) {
        console.log(
          `  MEMBRAL_API_KEY was rejected by ${marker.url} (${formatAge(Date.now() - marker.at)} ago); using the key from ~/.membral/credentials.json — unset it`,
        );
      }
    }
  }
  const profiles = loadProfiles();
  if (profiles) {
    const others = Object.keys(profiles.profiles).filter((n) => n !== profiles.activeProfile);
    const otherNote = others.length > 0 ? ` (also: ${others.join(", ")} — \`membral use <profile>\`)` : "";
    console.log(`  profile: ${profiles.activeProfile}${otherNote}`);
  }
  console.log("");

  // Issue #137: `membral status --rename <name>` persists a new device.json
  // name without running the rest of `membral setup` — same id/platform,
  // just the name, same as loadOrCreateDeviceIdentity's existing
  // --device-name override/persist behavior. Picked up by every later
  // command that reads device.json — there is no separate immediate-push
  // call here.
  const renamedTo = opts.rename?.trim() || undefined;
  const device = loadOrCreateDeviceIdentity(renamedTo ? { deviceName: renamedTo } : {});
  console.log("Device:");
  if (renamedTo) {
    console.log(`  Renamed to "${device.name}" — used by every command that reads device.json from now on.`);
  }
  console.log(`  ${device.name} (${device.platform}) — id ${device.id}`);
  console.log(`  ${defaultDeviceIdentityPath()}`);
  console.log("");

  console.log("Sync:");
  console.log(`  ${summarizeSync(loadSyncAllowlist())}`);
  console.log("");

  console.log("Last sweep:");
  const sweepState = await readSweepState(defaultSweepStatePath());
  if (sweepState.last_success_at) {
    console.log(`  last success: ${sweepState.last_success_at}`);
    console.log(`  runs: ${sweepState.run_count} (${sweepState.runs_since_full_walk} since last full walk)`);
    if (sweepState.last_ref_checks !== undefined) {
      console.log(`  ref checks: ${sweepState.last_ref_checks} branch(es) checked against git last run`);
    }
  } else {
    console.log(`  no successful sweep yet (${defaultSweepStatePath()})`);
  }

  // Recall-precision L7: one line, only when signed in and the server knows
  // the route (an old server 404s and prints nothing).
  if (resolved.apiKeySource !== "none") {
    const line = await fetchServedUsedLine(
      {
        apiUrl: resolved.apiUrl,
        apiKey: resolved.apiKey,
        apiKeySource: resolved.apiKeySource,
        apiUrlSource: resolved.apiUrlSource,
      },
      {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        markerDir: opts.markerDir ?? dirname(defaultCredentialsPath()),
        credsPath: defaultCredentialsPath(),
      },
    );
    if (line) {
      console.log("");
      console.log(line);
    }
    // Recall-precision W3b: "membral on membral: …" (7 days); an old server prints nothing.
    const dogfood = await fetchDogfoodStatusLine(
      { apiUrl: resolved.apiUrl, apiKey: resolved.apiKey, apiKeySource: resolved.apiKeySource },
      opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
    );
    if (dogfood) {
      if (!line) console.log("");
      console.log(dogfood);
    }
  }
}
