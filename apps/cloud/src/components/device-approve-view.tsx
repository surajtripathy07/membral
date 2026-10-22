"use client";

import { useEffect, useState } from "react";

interface DeviceApproveViewProps {
  initialCode: string;
}

type Step =
  | { kind: "enter" } // typing/confirming the code
  | { kind: "checking" }
  | { kind: "found"; deviceName: string; devicePlatform: string | null }
  | { kind: "not_found" }
  | { kind: "approving" }
  | { kind: "denying" }
  | { kind: "approved"; deviceName: string }
  | { kind: "denied" }
  | { kind: "error"; message: string };

function formatCodeInput(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (cleaned.length <= 4) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

export function DeviceApproveView({ initialCode }: DeviceApproveViewProps) {
  const [code, setCode] = useState(formatCodeInput(initialCode));
  const [step, setStep] = useState<Step>({ kind: "enter" });

  async function checkCode(candidate: string) {
    if (candidate.replace("-", "").length !== 8) {
      setStep({ kind: "error", message: "Enter the full 8-character code from your terminal." });
      return;
    }
    setStep({ kind: "checking" });
    try {
      const res = await fetch(`/api/auth/device/status?code=${encodeURIComponent(candidate)}`);
      if (res.status === 404) {
        setStep({ kind: "not_found" });
        return;
      }
      if (!res.ok) {
        setStep({ kind: "error", message: "Something went wrong looking up that code." });
        return;
      }
      const data = await res.json();
      if (data.status !== "pending") {
        setStep({ kind: "not_found" });
        return;
      }
      setStep({ kind: "found", deviceName: data.deviceName || "CLI device", devicePlatform: data.devicePlatform });
    } catch {
      setStep({ kind: "error", message: "Network error — check your connection and try again." });
    }
  }

  // Auto-check once on load if a code arrived via ?code=... (the CLI's
  // verificationUriComplete link) — saves the user retyping what's already
  // filled in.
  useEffect(() => {
    if (initialCode && formatCodeInput(initialCode).replace("-", "").length === 8) {
      checkCode(formatCodeInput(initialCode));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approve() {
    setStep({ kind: "approving" });
    try {
      const res = await fetch("/api/auth/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStep({ kind: "error", message: data.error ?? "Failed to approve this device." });
        return;
      }
      setStep({ kind: "approved", deviceName: data.deviceName });
    } catch {
      setStep({ kind: "error", message: "Network error — check your connection and try again." });
    }
  }

  async function deny() {
    setStep({ kind: "denying" });
    try {
      const res = await fetch("/api/auth/device/deny", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStep({ kind: "error", message: data.error ?? "Failed to deny this device." });
        return;
      }
      setStep({ kind: "denied" });
    } catch {
      setStep({ kind: "error", message: "Network error — check your connection and try again." });
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Sign in to the Membral CLI</h1>
        <p className="mt-1 text-muted">
          Confirm the code shown in your terminal to connect this device to your Membral account.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-surface p-5 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="device-code" className="block text-sm font-medium text-muted">
            Code from your terminal
          </label>
          <input
            id="device-code"
            value={code}
            onChange={(e) => setCode(formatCodeInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") checkCode(code);
            }}
            disabled={step.kind === "found" || step.kind === "approving" || step.kind === "approved"}
            placeholder="XXXX-XXXX"
            className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-center font-mono text-lg tracking-widest text-ink placeholder-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus disabled:opacity-60"
          />
        </div>

        {step.kind === "enter" || step.kind === "checking" ? (
          <button
            type="button"
            onClick={() => checkCode(code)}
            disabled={step.kind === "checking"}
            className="w-full rounded-lg bg-accent px-4 py-2 font-medium text-accent-ink transition hover:opacity-90 disabled:opacity-50"
          >
            {step.kind === "checking" ? "Checking…" : "Continue"}
          </button>
        ) : null}

        {step.kind === "not_found" && (
          <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            That code wasn&apos;t found, or it has expired. Run <code className="font-mono">membral setup</code> again to
            get a new one.
          </div>
        )}

        {(step.kind === "found" || step.kind === "approving" || step.kind === "denying") && (
          <div className="space-y-4">
            <div className="rounded-lg border border-line bg-raised px-4 py-3">
              <p className="text-xs text-muted">This will sign in</p>
              <p className="text-ink">
                {step.kind === "found" ? step.deviceName : "device"}
                {step.kind === "found" && step.devicePlatform ? (
                  <span className="text-muted"> · {step.devicePlatform}</span>
                ) : null}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={approve}
                disabled={step.kind !== "found"}
                className="flex-1 rounded-lg bg-accent px-4 py-2 font-medium text-accent-ink transition hover:opacity-90 disabled:opacity-50"
              >
                {step.kind === "approving" ? "Approving…" : "Approve"}
              </button>
              <button
                type="button"
                onClick={deny}
                disabled={step.kind !== "found"}
                className="flex-1 rounded-lg border border-line bg-raised px-4 py-2 font-medium text-ink-2 transition hover:bg-raised disabled:opacity-50"
              >
                {step.kind === "denying" ? "Denying…" : "Deny"}
              </button>
            </div>
          </div>
        )}

        {step.kind === "approved" && (
          <div className="flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-500/10 px-4 py-3 text-sm text-green-300">
            <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>
              You&apos;re signed in on <strong>{step.deviceName}</strong>. Return to your terminal.
            </span>
          </div>
        )}

        {step.kind === "denied" && (
          <div className="rounded-lg border border-line bg-raised px-4 py-3 text-sm text-ink-2">
            Denied. That device will not be signed in.
          </div>
        )}

        {step.kind === "error" && (
          <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {step.message}
          </div>
        )}
      </div>
    </div>
  );
}
