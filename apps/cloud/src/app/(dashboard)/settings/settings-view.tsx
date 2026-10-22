"use client";

import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { PageFrame } from "@/components/ui/page-frame";
import Link from "next/link";
import { useState } from "react";
import { AccountExportButton } from "@/components/account-export-button";
import { ApiKeyManager } from "@/components/api-key-manager";
import { DeleteAccountControl } from "@/components/delete-account-control";
import { type DeviceKeyRow, DeviceKeysList } from "@/components/device-keys-list";
import { McpConfig } from "@/components/mcp-config";
import { SectionNav } from "@/components/ui/section-nav";
import type { CheckFeatureResult } from "@/lib/feature-flags";

const NAV_ITEMS = [
  { id: "connect", label: "Connect" },
  { id: "keys", label: "Keys" },
  { id: "devices", label: "Devices" },
  { id: "account", label: "Account" },
] as const;

interface ScopeOption {
  id: string;
  label: string;
}

interface SettingsViewProps {
  email: string;
  apiKeyPrefix: string | null;
  apiKeyScopeNodeId: string | null;
  apiKeyScopeCodeProjectId: string | null;
  lifeAreas: ScopeOption[];
  codeProjects: ScopeOption[];
  deviceKeys: DeviceKeyRow[];
  accessToken: string;
  /** issue #128 (ADR 0047 v2) — server-computed checkFeature results for the "AI features" card below; no client fetch of flags. */
  embeddingsCheck: CheckFeatureResult;
  llmCheck: CheckFeatureResult;
  /** Browser-verify finding (2026-09-06): resolved server-side once (lib/mcp-url.ts, via getAppUrl()) and threaded down to McpConfig as a plain prop — never recomputed client-side from window.location, which used to cause a hydration mismatch on every load of this page. */
  mcpUrl: string;
}

/** issue #128 (ADR 0047 v2) short status word — matches feature-disabled-notice.tsx's copy. */
function featureStatusText(check: CheckFeatureResult): string {
  if (check.allowed) return "enabled";
  if (check.reason === "disabled") return "not enabled";
  if (check.reason === "budget_exhausted") return "trial exhausted";
  return "daily allowance reached";
}

export function SettingsView({
  email,
  apiKeyPrefix,
  apiKeyScopeNodeId,
  apiKeyScopeCodeProjectId,
  lifeAreas,
  codeProjects,
  deviceKeys,
  accessToken,
  embeddingsCheck,
  llmCheck,
  mcpUrl,
}: SettingsViewProps) {
  // The freshly-minted API key is only available in the browser at generation
  // time. We hold it in client state so the MCP config snippet can include it
  // verbatim instead of leaving a "YOUR_API_KEY" placeholder.
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  // issue #128 (ADR 0047 v2), UX audit B9: the two-row "AI features" card
  // collapses to one status line under the header — this is status, not a
  // setting, so it no longer earns its own section. Budget/spend detail
  // (still computed server-side, in page.tsx) drops out of this summary;
  // anyone blocked still gets a way to act, via the contact mailto.
  const blockedContacts = [...new Set([embeddingsCheck, llmCheck].filter((c) => !c.allowed).map((c) => c.contact))];

  return (
    <PageFrame width="read" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Settings</h1>
        {/* UX W5 (settings height): subtitle and feature status share one line. */}
        <p className="mt-1 text-sm text-muted">
          Manage your account, API keys, and MCP integration · Embeddings {featureStatusText(embeddingsCheck)} · Memory {featureStatusText(llmCheck)}
          {blockedContacts.map((contact) => (
            <span key={contact}>
              {" · "}
              <a href={`mailto:${contact}`} className="text-accent hover:underline">
                email {contact}
              </a>
            </span>
          ))}
        </p>
      </div>

      {/* Round-2 review MED 8: the flagged-off notice is now rendered once,
          in (dashboard)/layout.tsx, covering every dashboard page including
          this one — do not re-render it here (it used to show twice). */}

      {/* UX audit B9: Connect -> Keys -> Devices -> Context card -> Account,
          destructive actions last. MCP config used to be 5th of 6 sections;
          it's the T1 (harness-first) action, so it leads now and sits in the
          first viewport. */}
      <SectionNav items={NAV_ITEMS} />

      {/* MCP Configuration ("Connect") */}
      <section id="connect" className="space-y-3 scroll-mt-14">
        <h2 className="text-lg font-semibold text-ink">MCP Configuration</h2>
        <p className="text-sm text-muted">
          Copy this snippet into your MCP client.
          {!generatedKey && (
            <>
              {" "}
              <span className="text-warn">
                {apiKeyPrefix
                  ? "Paste your API key in place of YOUR_API_KEY (it is shown only once), or regenerate it below to fill it in."
                  : "Generate an API key below to fill it in."}
              </span>
            </>
          )}
        </p>
        {/* UX W5 (settings height): the explainer is one click away, not dropped. */}
        <Disclosure summary="What is MCP?">
          <p className="text-sm text-muted">
            MCP (Model Context Protocol) lets AI assistants like Claude read your Membral memories directly, instead of
            you copy-pasting context by hand. Pick the tab below that matches the app you&apos;re connecting — most
            desktop apps use the URL-based config, while self-hosted setups run the server locally over stdio instead.
          </p>
        </Disclosure>
        <Card padding={4}>
          <McpConfig apiKey={generatedKey ?? undefined} mcpUrl={mcpUrl} hasKey={!!apiKeyPrefix} />
        </Card>
      </section>

      {/* API Key ("Keys") */}
      <section id="keys" className="space-y-3 scroll-mt-14">
        <h2 className="text-lg font-semibold text-ink">API Key</h2>
        <p className="text-sm text-muted">
          Use this key to authenticate requests from the browser extension and MCP clients.
        </p>
        <Card padding={4}>
          <ApiKeyManager
            initialPrefix={apiKeyPrefix}
            initialScopeNodeId={apiKeyScopeNodeId}
            initialScopeCodeProjectId={apiKeyScopeCodeProjectId}
            lifeAreas={lifeAreas}
            codeProjects={codeProjects}
            accessToken={accessToken}
            onGenerated={setGeneratedKey}
          />
        </Card>
      </section>

      {/* Device keys (migration 052) — CLI sign-ins via /device, separate
          from the single legacy key above. */}
      <section id="devices" className="space-y-3 scroll-mt-14">
        <h2 className="text-lg font-semibold text-ink">Device Sign-ins</h2>
        <p className="text-sm text-muted">
          CLI <code className="font-mono">membral setup</code> sign-ins (
          <Link href="/setup" className="text-accent hover:underline">
            install steps
          </Link>
          ). Revoke any device you don&apos;t recognize.
        </p>
        <Card padding={4}>
          <DeviceKeysList initialKeys={deviceKeys} accessToken={accessToken} />
        </Card>
      </section>

      {/* Account — housekeeping, comes after the harness/keys
          sections above. UX audit B9: the Import Conversations drop zone
          that used to live here is gone (that surface already exists at
          /import); this is the one link left pointing at it. */}
      <section id="account" className="space-y-3 scroll-mt-14">
        <h2 className="text-lg font-semibold text-ink">Account</h2>
        {/* UX W5 (settings height): email and export share one card. */}
        <div className="divide-y divide-line-soft rounded-card border border-line bg-surface">
          <div className="px-4 py-3">
            <p className="text-sm text-muted">Email</p>
            <p className="text-ink">{email}</p>
          </div>
          <div className="px-4 py-3">
            <AccountExportButton accessToken={accessToken} />
          </div>
        </div>
        <p className="text-sm text-muted">
          Working in ChatGPT or Claude.ai too?{" "}
          <Link href="/import" className="text-accent hover:underline">
            Import a chat export →
          </Link>
        </p>
      </section>

      {/* Danger zone — destructive actions last, per the audit's explicit
          ordering rule (this used to be the SECOND card on the page). */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">Danger zone</h2>
        {/* UX W5 (settings height): the delete form sits one deliberate click away. */}
        <Disclosure summary="Delete my account…">
          <DeleteAccountControl accessToken={accessToken} />
        </Disclosure>
      </section>
    </PageFrame>
  );
}
