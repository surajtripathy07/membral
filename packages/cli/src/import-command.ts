// `membral import <file.zip|conversations.json>` (deliverable 5) — imports a
// ChatGPT or Claude.ai data export directly, for the onboarding nudge
// ("your chats aren't in Membral yet"). Detects the provider from the
// parsed JSON shape (core's detectExportProvider), normalizes via
// parseChatGptExport/parseClaudeExport, and POSTs the result to the
// existing POST /api/import route in batches, printing a progress line.
//
// DEVIATION (per the task brief): a `.zip` export archive is NOT unzipped
// in-process — `fflate` isn't a dependency anywhere in this workspace today,
// and the brief says to require conversations.json directly rather than add
// a new dependency for this stopgap. A `.zip` argument prints instructions
// to extract it and re-run with the JSON file inside instead of failing
// silently.
import { readFile } from "node:fs/promises";
import { type Conversation, detectExportProvider, parseChatGptExport, parseClaudeExport } from "@membral/core";
import { createUploadClient, resolveUploadConfig, type UploadFlags } from "./code-session-upload.js";
import type { ApiClient, ApiRetryInfo } from "./lib/api-client.js";

export const IMPORT_BATCH_SIZE = 100;

// Every batch goes through ONE policy client per run (endpoint "import",
// design note §4/§5; closes #170): 310 s per attempt, 3 network / 3 5xx /
// 6 rate-limited tries, Retry-After honoured, pacing after a 429, and the
// rule-4 delay decays across batches instead of restarting per batch. An
// import is not idempotent, so a timeout or a 504 is never re-sent.

export interface ImportCommandOptions extends UploadFlags {
  file?: string;
}

interface ImportBatchResponse {
  imported: number;
  total: number;
  errors: string[];
}

/** 402 body from POST /api/import: `{ error: "conversation_limit", limit, count }`. */
function conversationLimitMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; limit?: unknown; count?: unknown };
    if (body.error === "conversation_limit" && typeof body.limit === "number" && typeof body.count === "number") {
      return `Conversation limit reached (402): ${body.count} of ${body.limit} conversations stored; nothing in this batch was imported.`;
    }
    if (typeof body.error === "string") return `Import refused (402): ${body.error}`;
  } catch {
    // not JSON — fall through to the raw text
  }
  return `Import refused (402)${text ? `: ${text}` : ""}`;
}

/** Thrown when every later batch would get the same answer (401, 402, 403): the run stops. */
class ImportStopError extends Error {}

function retryLine(r: ApiRetryInfo): string {
  if (r.kind === "rate_limited") {
    return `  rate limited (429, attempt ${r.attempt}/${r.max}) — waiting ${r.waitMs}ms${r.retryAfter ? " (Retry-After)" : ""}`;
  }
  if (r.kind === "http") {
    return `  import failed (${r.status}, attempt ${r.attempt}/${r.max}) — waiting ${r.waitMs}ms: ${r.detail}`;
  }
  return `  network error (attempt ${r.attempt}/${r.max}) — waiting ${r.waitMs}ms: ${r.detail}`;
}

async function postImportBatch(
  api: ApiClient,
  apiUrl: string,
  conversations: Conversation[],
): Promise<ImportBatchResponse> {
  const result = await api.call<Partial<ImportBatchResponse>>("import", {
    json: { conversations },
    onRetry: (r) => console.warn(retryLine(r)),
  });
  if (result.ok) {
    const body = result.data ?? {};
    return { imported: body.imported ?? 0, total: body.total ?? conversations.length, errors: body.errors ?? [] };
  }
  switch (result.kind) {
    case "auth":
      if (result.status === 401) {
        throw new ImportStopError("Invalid or missing API key (401) — run `membral login` or pass --api-key.");
      }
      throw new ImportStopError(
        'Scoped API keys cannot import (403) — in Settings → API Key, generate a key with scope "All of my memories" and pass it with --api-key.',
      );
    case "http":
      if (result.status === 402) throw new ImportStopError(conversationLimitMessage(result.detail));
      throw new Error(`Import failed: ${result.status} ${result.detail}`);
    case "rate_limited":
      throw new Error(`Rate limited (429) after ${result.attempts} attempts`);
    case "bad_json":
      throw new Error(`Import failed: ${result.status} response was not JSON`);
    case "network":
    case "timeout":
      throw new Error(`Network error uploading to ${apiUrl}/api/import: ${result.message}`);
    default:
      throw new Error("Import deferred past its deadline");
  }
}

export async function importCommand(opts: ImportCommandOptions, client?: ApiClient): Promise<void> {
  if (!opts.file) {
    console.error("Usage: membral import <file.zip|conversations.json>");
    process.exitCode = 1;
    return;
  }

  if (opts.file.toLowerCase().endsWith(".zip")) {
    console.error(
      `membral import: .zip archives aren't unzipped automatically in this build (no zip dependency in this workspace).\n` +
        `  Unzip the export yourself, then import the conversations.json file inside it:\n` +
        `    unzip "${opts.file}" -d ./membral-export && membral import ./membral-export/conversations.json`,
    );
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = await readFile(opts.file, "utf8");
  } catch (err) {
    console.error(`Could not read "${opts.file}": ${errMessage(err)}`);
    process.exitCode = 1;
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`"${opts.file}" is not valid JSON: ${errMessage(err)}`);
    process.exitCode = 1;
    return;
  }

  const provider = detectExportProvider(json);
  if (!provider) {
    console.error(
      `Could not detect the export format of "${opts.file}" — expected a ChatGPT or Claude.ai conversations.json export.`,
    );
    process.exitCode = 1;
    return;
  }

  const { conversations, skipped } = provider === "chatgpt" ? parseChatGptExport(json) : parseClaudeExport(json);
  console.log(
    `Detected ${provider === "chatgpt" ? "ChatGPT" : "Claude.ai"} export: ${conversations.length} conversation(s) parsed` +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
  );

  if (conversations.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  const config = resolveUploadConfig(opts);
  if (!config.apiKey) {
    console.error("Missing API key. Run `membral login`, pass --api-key, or set MEMBRAL_API_KEY.");
    process.exitCode = 1;
    return;
  }

  const api = client ?? createUploadClient(config, { log: (l) => console.warn(l) });
  let totalImported = 0;
  const allErrors: string[] = [];
  const batchCount = Math.ceil(conversations.length / IMPORT_BATCH_SIZE);

  for (let i = 0; i < conversations.length; i += IMPORT_BATCH_SIZE) {
    const batch = conversations.slice(i, i + IMPORT_BATCH_SIZE);
    const batchNum = Math.floor(i / IMPORT_BATCH_SIZE) + 1;
    console.log(`Uploading batch ${batchNum}/${batchCount} (${batch.length} conversation(s))...`);
    try {
      const result = await postImportBatch(api, config.apiUrl, batch);
      totalImported += result.imported;
      allErrors.push(...result.errors);
    } catch (err) {
      console.error(`  ! batch ${batchNum} failed: ${errMessage(err)}`);
      allErrors.push(errMessage(err));
      process.exitCode = 1;
      if (err instanceof ImportStopError) {
        const left = batchCount - batchNum;
        if (left > 0) console.error(`  stopping: the remaining ${left} batch(es) would get the same answer`);
        break;
      }
    }
  }

  console.log("");
  console.log(`{ imported: ${totalImported}, skipped: ${skipped.length} }`);
  if (allErrors.length > 0) {
    console.log(`${allErrors.length} error(s):`);
    for (const e of allErrors.slice(0, 10)) console.log(`  - ${e}`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
