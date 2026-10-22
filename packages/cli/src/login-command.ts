// `membral login [--api-url <url>]` / `membral logout` / `membral whoami`
// (deliverable 1). The device-authorization flow: start -> print the code +
// try to open a browser -> poll until approved/expired -> save
// ~/.membral/credentials.json -> print confirmation. Ctrl-C cancels the poll
// loop cleanly (no partial credentials file is ever written on cancel).
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { DEFAULT_API_URL } from "./code-session-upload.js";
import {
  defaultCredentialsPath,
  describeKeySource,
  describeUrlSource,
  loadCredentials,
  maskApiKey,
  removeActiveProfile,
  resolveCredentials,
  resolveLoginUrl,
  saveCredentials,
} from "./credentials.js";
import { type DeviceIdentity, loadOrCreateDeviceIdentity } from "./device.js";
import {
  DeviceAuthError,
  type DeviceAuthPollResponse,
  type DeviceAuthStartResponse,
  openBrowser,
  pollDeviceAuth,
  startDeviceAuth,
} from "./device-auth.js";
import { deleteEnvKeyMarkers } from "./lib/api-client.js";

export interface LoginOptions {
  apiUrl?: string;
}

/** Injectable for unit testing — real callers rely on the defaults. */
export interface LoginDeps {
  startDeviceAuth: (apiUrl: string, device: DeviceIdentity) => Promise<DeviceAuthStartResponse>;
  pollDeviceAuth: (apiUrl: string, deviceCode: string) => Promise<DeviceAuthPollResponse>;
  openBrowser: (url: string) => void;
  loadOrCreateDeviceIdentity: (opts?: { deviceName?: string }) => DeviceIdentity;
  saveCredentials: typeof saveCredentials;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Overridable so tests never touch the real filesystem. */
  credentialsPath?: string;
}

const defaultDeps: LoginDeps = {
  startDeviceAuth,
  pollDeviceAuth,
  openBrowser: (url) => openBrowser(url, execFile),
  loadOrCreateDeviceIdentity,
  saveCredentials,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

interface PollResult {
  apiKey: string;
  email: string;
  userId: string;
}

async function pollUntilDone(
  apiUrl: string,
  start: DeviceAuthStartResponse,
  deps: LoginDeps,
): Promise<PollResult | null> {
  let cancelled = false;
  const onSigint = () => {
    cancelled = true;
  };
  process.on("SIGINT", onSigint);

  const deadline = deps.now() + start.expiresIn * 1000;
  let frame = 0;

  try {
    while (deps.now() < deadline) {
      if (cancelled) {
        if (isTty()) process.stdout.write("\n");
        console.log("Cancelled — not signed in.");
        return null;
      }

      let poll: DeviceAuthPollResponse;
      try {
        poll = await deps.pollDeviceAuth(apiUrl, start.deviceCode);
      } catch (err) {
        if (isTty()) process.stdout.write("\n");
        console.error(`Error polling for sign-in: ${errMessage(err)} — retrying...`);
        // A 429 from the poll limiter: wait what it asks, never less than the interval.
        const retryAfterMs = err instanceof DeviceAuthError ? (err.retryAfterMs ?? 0) : 0;
        await deps.sleep(Math.max(start.interval * 1000, retryAfterMs));
        continue;
      }

      if (poll.status === "approved") {
        if (isTty()) process.stdout.write("\n");
        return { apiKey: poll.apiKey, email: poll.email, userId: poll.userId };
      }
      if (poll.status === "expired" || poll.status === "denied" || poll.status === "consumed") {
        if (isTty()) process.stdout.write("\n");
        console.log(`Sign-in ${poll.status}.`);
        return null;
      }

      if (isTty()) {
        process.stdout.write(`\rWaiting for confirmation ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} `);
        frame++;
      }
      await deps.sleep(start.interval * 1000);
    }

    if (isTty()) process.stdout.write("\n");
    console.log("Sign-in timed out — run `membral login` again.");
    return null;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export async function loginCommand(opts: LoginOptions = {}, deps: Partial<LoginDeps> = {}): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const apiUrl = resolveLoginUrl(opts.apiUrl, process.env.MEMBRAL_API_URL);
  const device = d.loadOrCreateDeviceIdentity({ deviceName: process.env.MEMBRAL_DEVICE_NAME });

  console.log(`Signing in to ${apiUrl} as "${device.name}"...`);

  let start: DeviceAuthStartResponse;
  try {
    start = await d.startDeviceAuth(apiUrl, device);
  } catch (err) {
    console.error(`Could not start sign-in: ${errMessage(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nOpen ${start.verificationUriComplete} and confirm code ${start.userCode}\n`);
  d.openBrowser(start.verificationUriComplete);

  const result = await pollUntilDone(apiUrl, start, d);
  if (!result) {
    process.exitCode = 1;
    return;
  }

  d.saveCredentials(
    {
      apiUrl,
      apiKey: result.apiKey,
      email: result.email,
      userId: result.userId,
      createdAt: new Date().toISOString(),
    },
    d.credentialsPath,
  );

  console.log(`Signed in as ${result.email} on ${device.name}`);
}

export async function logoutCommand(credentialsPath?: string): Promise<void> {
  const path = credentialsPath ?? defaultCredentialsPath();
  // Env-key-rejected markers (design note §4) are auth state: a logout clears them.
  deleteEnvKeyMarkers(dirname(path));
  let result: ReturnType<typeof removeActiveProfile>;
  try {
    result = removeActiveProfile(path);
  } catch {
    result = null;
  }
  if (!result) {
    console.log("Not signed in — nothing to remove.");
    return;
  }
  if (result.nowActive === null) {
    console.log(`Signed out of "${result.removed}" — no profiles left, removed ${path}`);
  } else {
    console.log(`Signed out of "${result.removed}". Active profile is now "${result.nowActive}".`);
  }
}

export interface WhoamiOptions {
  apiUrl?: string;
  apiKey?: string;
  /** Overrides ~/.membral/credentials.json's default path (tests, and `whoamiCommand(credentialsPath)`-style direct callers). */
  credentialsPath?: string;
}

// Issue #136 req 5: goes through the shared resolveCredentials (flag > env
// > credentials.json) instead of reading credentials.json directly — a
// shell-exported MEMBRAL_API_KEY that's shadowing credentials.json is
// exactly the thing `membral whoami` needs to be able to reveal, not hide.
// The key itself is never printed beyond maskApiKey's short prefix.
export async function whoamiCommand(opts: WhoamiOptions = {}): Promise<void> {
  const resolved = resolveCredentials({
    flagKey: opts.apiKey,
    flagUrl: opts.apiUrl,
    envKey: process.env.MEMBRAL_API_KEY,
    envUrl: process.env.MEMBRAL_API_URL,
    defaultUrl: DEFAULT_API_URL,
    credsPath: opts.credentialsPath,
  });

  if (resolved.apiKeySource === "none") {
    console.log("Not signed in. Run `membral login` first.");
    process.exitCode = 1;
    return;
  }

  const creds = loadCredentials(opts.credentialsPath);
  if (resolved.apiKeySource === "credentials" && creds) {
    console.log(`Signed in as ${creds.email} (${resolved.apiUrl})`);
    console.log(`  user id: ${creds.userId}`);
    console.log(`  signed in: ${creds.createdAt}`);
  } else {
    console.log(`Using an API key from ${describeKeySource(resolved.apiKeySource)} — not from \`membral login\`.`);
  }
  console.log(`  api url: ${resolved.apiUrl} (from ${describeUrlSource(resolved.apiUrlSource)})`);
  console.log(`  api key: ${maskApiKey(resolved.apiKey)} (from ${describeKeySource(resolved.apiKeySource)})`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
