"use client";

import { PageFrame } from "@/components/ui/page-frame";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import {
  foldUploadResponse,
  INITIAL_STALL_STATE,
  MAX_STALL_RETRIES,
  nextStallState,
  type Provider,
  type Result,
  type UploadResponse,
} from "./upload-loop";

type Phase = "idle" | "uploading" | "done" | "error";

const SOURCE_STYLE: Record<Provider, { bg: string; text: string; label: string }> = {
  chatgpt: { bg: "bg-src-chatgpt/10", text: "text-src-chatgpt", label: "ChatGPT" },
  claude: { bg: "bg-orange-500/10", text: "text-orange-400", label: "Claude" },
};

export default function ImportPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [detectedProvider, setDetectedProvider] = useState<Provider | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(async (file: File) => {
    setPhase("uploading");
    setFileName(file.name);
    setDetectedProvider(null);
    setErrorMsg(null);
    setResult(null);
    setProgress(null);

    try {
      let offset = 0;
      let running: Result = {
        provider: null,
        total: 0,
        imported: 0,
        updated: 0,
        skipped: [],
        skippedCount: 0,
        errors: [],
        durationMs: 0,
      };
      let stallState = INITIAL_STALL_STATE;

      // Batches loop automatically: a batch that runs long returns
      // {partial: true, nextOffset}, and the client re-POSTs the SAME file
      // with that offset until the server reports partial: false.
      for (;;) {
        const form = new FormData();
        form.set("file", file);
        const res = await fetch(`/api/import/upload?offset=${offset}`, { method: "POST", body: form });
        const body = (await res.json().catch(() => ({}))) as UploadResponse;

        if (!res.ok) {
          // NEW-3: preserve whatever this loop already landed (from earlier
          // successful chunks/requests) before throwing — otherwise a
          // failure on a LATER request in the loop silently discards every
          // import/update/error the user already accumulated.
          setResult(running);
          throw new Error(body.error || `Upload failed (${res.status})`);
        }

        running = foldUploadResponse(running, body);
        if (body.provider) setDetectedProvider(body.provider);

        const conversationsTotal = body.conversationsTotal ?? body.total;
        const processed = body.partial ? (body.nextOffset ?? 0) : conversationsTotal;
        setProgress({ processed, total: conversationsTotal });

        if (!body.partial) break;

        const nextOffset = body.nextOffset ?? offset;
        stallState = nextStallState(stallState, offset, nextOffset);
        if (stallState.stallRetries >= MAX_STALL_RETRIES) {
          // NEW-3: same as above — don't lose everything already imported
          // in this run just because the last few retries made no progress.
          setResult(running);
          throw new Error("Import stalled");
        }
        offset = nextOffset;
      }

      setResult(running);
      setPhase("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Upload failed");
      setPhase("error");
    }
  }, []);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      void uploadFile(file);
    },
    [uploadFile],
  );

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0;

  return (
    <PageFrame width="read" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Import</h1>
        <p className="mt-1 text-sm text-muted">
          Bring in a ChatGPT or Claude.ai data export — everything lands in Membral in minutes.
        </p>
      </div>

      {/* Provider instruction cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div id="chatgpt" className="scroll-mt-24 rounded-xl border border-line bg-surface p-6">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-src-chatgpt" />
            <h2 className="text-sm font-medium text-src-chatgpt">ChatGPT</h2>
          </div>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Settings → Data controls</li>
            <li>Export data</li>
            <li>Wait for the emailed zip, then drop it below</li>
          </ol>
        </div>
        <div id="claude" className="scroll-mt-24 rounded-xl border border-line bg-surface p-6">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-orange-500" />
            <h2 className="text-sm font-medium text-orange-400">Claude</h2>
          </div>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Settings → Privacy</li>
            <li>Export data</li>
            <li>Wait for the emailed zip, then drop it below</li>
          </ol>
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragOver ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <UploadIcon className="h-8 w-8 text-muted" />
        <div>
          <p className="text-sm font-medium text-ink">Drop your export .zip or conversations.json here</p>
          <p className="mt-1 text-xs text-muted">
            or click to browse — up to 300MB zip (~500MB max as a bare conversations.json)
          </p>
        </div>
        {fileName && phase !== "idle" && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <span>{fileName}</span>
            {detectedProvider && (
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${SOURCE_STYLE[detectedProvider].bg} ${SOURCE_STYLE[detectedProvider].text}`}
              >
                {SOURCE_STYLE[detectedProvider].label}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Progress bar */}
      {phase === "uploading" && (
        <div className="rounded-xl border border-line bg-surface p-6">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-ink-2">Importing…</span>
            <span className="text-muted">
              {progress ? `${progress.processed} / ${progress.total}` : "Starting…"}
            </span>
          </div>
          <div className="h-2 rounded-full bg-raised">
            <div className="h-2 rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Error */}
      {phase === "error" && errorMsg && (
        <div className="rounded-xl border border-error/30 bg-error/5 p-6">
          <p className="text-sm font-medium text-error">Import failed</p>
          <p className="mt-1 text-sm text-muted">{errorMsg}</p>
          {/* NEW-3: a failure partway through (a stalled resume, or a later
              chunk request failing outright) must not hide what actually
              landed before the failure — the batch loop already sets
              `result` to its running total right before it throws. */}
          {result && (
            <>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Total" value={result.total} />
                <Stat label="Imported" value={result.imported} />
                <Stat label="Updated" value={result.updated} />
                <Stat label="Skipped" value={result.skippedCount} />
              </div>
              {result.errors.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-medium text-error">Errors before the failure</p>
                  <ul className="mt-1 space-y-1 text-xs text-muted">
                    {result.errors.slice(0, 20).map((e, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: error strings have no stable id
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Result summary */}
      {phase === "done" && result && (
        <div className="rounded-xl border border-line bg-surface p-6">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-ink">Import complete</p>
            {result.provider && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_STYLE[result.provider].bg} ${SOURCE_STYLE[result.provider].text}`}
              >
                {SOURCE_STYLE[result.provider].label}
              </span>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Total" value={result.total} />
            <Stat label="Imported" value={result.imported} />
            <Stat label="Updated" value={result.updated} />
            <Stat label="Skipped" value={result.skippedCount} />
          </div>
          {result.skipped.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-muted">
                Skipped entries{result.skippedCount > result.skipped.length ? ` (showing ${result.skipped.length} of ${result.skippedCount})` : ""}
              </p>
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {result.skipped.slice(0, 20).map((s) => (
                  <li key={s.id}>
                    <span className="text-muted">{s.id}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-error">Errors during import</p>
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {result.errors.slice(0, 20).map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: error strings have no stable id
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          <Link
            href="/conversations"
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors hover:opacity-90"
          >
            View conversations →
          </Link>
        </div>
      )}
    </PageFrame>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink">{value}</p>
    </div>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M7 16a4 4 0 01-1-7.874V8a4 4 0 018 0v.126A4 4 0 0113 16m-6-3l3-3m0 0l3 3m-3-3v9"
      />
    </svg>
  );
}
