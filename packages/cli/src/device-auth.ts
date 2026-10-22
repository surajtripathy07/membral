// HTTP client for the device-authorization sign-in flow (deliverable 1).
// CONTRACT (cloud, being built in parallel — code against this verbatim):
//   POST {api}/api/auth/device/start
//     body {deviceName, devicePlatform, deviceId}
//     -> 200 {deviceCode, userCode (XXXX-XXXX), verificationUri,
//             verificationUriComplete, expiresIn: 600, interval: 3}
//   POST {api}/api/auth/device/poll
//     body {deviceCode}
//     -> 200 {status:'pending'}
//          | {status:'approved', apiKey, email, userId}   (once)
//          | {status:'expired'|'denied'|'consumed'}
import { STATUS_CODES } from "node:http";
import type { DeviceIdentity } from "./device.js";
import { type ApiClient, type ApiResult, createApiClient } from "./lib/api-client.js";

export interface DeviceAuthStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DeviceAuthPollResponse =
  | { status: "pending" }
  | { status: "approved"; apiKey: string; email: string; userId: string }
  | { status: "expired" | "denied" | "consumed" };

/** Every non-ok device-auth answer. `status` 0: no HTTP answer (network, timeout). */
export class DeviceAuthError extends Error {
  readonly status: number;
  /** 429 only: the server's raw Retry-After, when it sent one. */
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "DeviceAuthError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

// Both calls go through the policy client (endpoints "deviceStart" and
// "devicePoll": no key, 15 s, never retried — a poll is answered "approved"
// only once, so a re-send could lose the key; a lost reply shows "consumed").
function deviceClient(apiUrl: string, client?: ApiClient): ApiClient {
  return client ?? createApiClient({ credentials: { apiKey: "", apiKeySource: "none", apiUrl, apiUrlSource: "flag" } });
}

function deviceAuthError(result: Exclude<ApiResult<unknown>, { ok: true }>): DeviceAuthError {
  const reason = (status: number, detail: string) => detail || `${status} ${STATUS_CODES[status] ?? ""}`.trim();
  switch (result.kind) {
    case "auth":
    case "http":
      return new DeviceAuthError(result.status, reason(result.status, result.detail));
    case "rate_limited": {
      const wait = result.retryAfterMs !== undefined ? ` — retry in ${Math.ceil(result.retryAfterMs / 1000)}s` : "";
      return new DeviceAuthError(429, `rate limited (429)${wait}`, result.retryAfterMs);
    }
    case "bad_json":
      return new DeviceAuthError(result.status, "response was not JSON");
    case "network":
    case "timeout":
      return new DeviceAuthError(0, result.message);
    default:
      return new DeviceAuthError(0, "request deferred past its deadline");
  }
}

export async function startDeviceAuth(
  apiUrl: string,
  device: DeviceIdentity,
  client?: ApiClient,
): Promise<DeviceAuthStartResponse> {
  const result = await deviceClient(apiUrl, client).call<DeviceAuthStartResponse>("deviceStart", {
    json: { deviceName: device.name, devicePlatform: device.platform, deviceId: device.id },
  });
  if (!result.ok) throw deviceAuthError(result);
  return result.data as DeviceAuthStartResponse;
}

export async function pollDeviceAuth(
  apiUrl: string,
  deviceCode: string,
  client?: ApiClient,
): Promise<DeviceAuthPollResponse> {
  const result = await deviceClient(apiUrl, client).call<DeviceAuthPollResponse>("devicePoll", {
    json: { deviceCode },
  });
  if (!result.ok) throw deviceAuthError(result);
  return result.data as DeviceAuthPollResponse;
}

/**
 * Best-effort browser open — macOS `open`, Linux `xdg-open`, no-op
 * everywhere else (including on failure: the printed URL is always the
 * fallback, so a failed spawn must never throw or block).
 */
export function openBrowser(url: string, execFileFn: typeof import("node:child_process").execFile): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!cmd) return;
  try {
    execFileFn(cmd, [url], () => {
      // Intentionally ignored — the printed URL is always the fallback.
    });
  } catch {
    // no-op
  }
}
