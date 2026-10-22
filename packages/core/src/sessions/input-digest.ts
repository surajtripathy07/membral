// Tool-input digest shared by the claude-code, opencode and copilot-cli parsers
// (R3 3.7, #208). Structured-fields-only digest of a tool_use's input (ADR 0026 D10) —
// never a regex over prose, never applied to non-allowlisted tools. Returns
// undefined for anything off the allowlist, so no digest is stored by default.
// Each parser supplies only its own tool-name → kind map.

import { digestBashCommand, MAX_DIGEST_CHARS } from "./forge-actions.js";
import { redactSecrets } from "./redact.js";

export type DigestKind = "bash" | "agent" | "webfetch";

export interface InputDigestConfig {
  /** Exact tool name → what to digest. Names absent here get no digest. */
  kinds: Readonly<Record<string, DigestKind>>;
  /** Also treat any casing of "bash" as the bash kind (claude-code only). */
  bashAnyCase?: boolean;
  /** An empty-string description counts as absent, so `prompt` is used instead (copilot-cli only). */
  agentSkipEmpty?: boolean;
}

export function buildInputDigest(
  config: InputDigestConfig,
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) return undefined;
  const kind = Object.hasOwn(config.kinds, toolName)
    ? config.kinds[toolName]
    : config.bashAnyCase && toolName.toLowerCase() === "bash"
      ? "bash"
      : undefined;
  if (kind === "bash") return digestBashCommand(input.command);
  if (kind === "agent") {
    const ok = (v: unknown): v is string => typeof v === "string" && (!config.agentSkipEmpty || v.length > 0);
    const desc = ok(input.description) ? input.description : ok(input.prompt) ? input.prompt : undefined;
    return desc ? redactSecrets(desc).slice(0, MAX_DIGEST_CHARS) : undefined;
  }
  if (kind === "webfetch") {
    const url = typeof input.url === "string" ? input.url : undefined;
    return url ? redactSecrets(url).slice(0, MAX_DIGEST_CHARS) : undefined;
  }
  return undefined;
}
