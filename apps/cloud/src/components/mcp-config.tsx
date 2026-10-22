"use client";

import { useState } from "react";
import { resolveMcpUrl } from "@/lib/mcp-url";

// Browser-verify finding, fixed: the MCP URL used to be computed HERE, via
// `window.location.origin` on the client vs. a bare "/api/mcp" fallback on
// the server — a hydration mismatch on every Settings page load (see
// lib/mcp-url.ts's header for the full story). It is now resolved ONCE by
// the server-rendered settings page and passed down as the `mcpUrl` prop —
// `getMcpConfig`'s `options.mcpUrl` below, and `resolveMcpUrl()` (imported,
// no `window` access) only remains as this function's OWN default so
// existing direct callers/tests of `getMcpConfig` that don't pass a URL
// keep working unchanged.

export interface McpClient {
  id: string;
  label: string;
  /** Human-readable "where does this go" instruction shown above the code block. */
  hint: string;
}

// mcp-local (the stdio-only `@membral/mcp` binary this component's old
// "Self-hosted" tab used to advertise) was removed in #40 — `/api/mcp` (this
// same HTTP route, just run against your own Postgres instead of the hosted
// one) is the only MCP surface now.
//
// #40 adversarial-review fix: each client below gets the shape it actually
// understands, not one generic `{ url, headers }` blob. Claude Desktop's
// config schema doesn't recognize a bare url-shape entry and silently drops
// the whole `mcpServers` key when it hits one — destructive. See
// getMcpConfig for the per-client shapes (mirrors packages/cli/src/configure.ts).
export const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    hint: "Add to ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Run in your shell (requires the claude CLI on PATH):",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "Add to ~/.cursor/mcp.json (not settings.json — that file has no mcpServers key), then reload Cursor.",
  },
];

// Shows enough of the key to recognize it, not enough to use it — for the
// on-screen preview only. `handleCopy` below always copies the unmasked
// config, so masking here never degrades what actually gets pasted.
function maskApiKey(key: string): string {
  if (key.length <= 10) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function getMcpConfig(
  clientId: string,
  apiKey?: string,
  options: { mask?: boolean; mcpUrl?: string } = {},
): string {
  const rawKey = apiKey || "YOUR_API_KEY";
  const key = options.mask ? maskApiKey(rawKey) : rawKey;
  const url = options.mcpUrl ?? resolveMcpUrl();

  if (clientId === "claude-code") {
    // Claude Code has no MCP config file to write — its own CLI owns that
    // store. `claude mcp add` is the documented way in (see the README's
    // "MCP Server" section). `--scope user` is required: `claude mcp add`
    // defaults to project-local scope, which would wire Membral into
    // whatever directory happens to be open instead of Claude Code globally.
    const entry = JSON.stringify({
      type: "http",
      url,
      headers: { Authorization: `Bearer ${key}` },
      alwaysLoad: true,
    });
    return `claude mcp add-json membral '${entry}' --scope user`;
  }

  if (clientId === "claude-desktop") {
    // Bridged via mcp-remote: Claude Desktop doesn't speak Streamable HTTP
    // natively. The header arg is mcp-remote's own env-var-expansion syntax
    // (expanded by mcp-remote from ITS env, not the shell's); the real
    // `Bearer <key>` value goes in this entry's `env` block, which Claude
    // Desktop passes through to the child process it spawns.
    return JSON.stringify(
      {
        mcpServers: {
          membral: {
            command: "npx",
            args: ["-y", "mcp-remote", url, "--header", `Authorization:\${MEMBRAL_AUTH_HEADER}`],
            env: { MEMBRAL_AUTH_HEADER: `Bearer ${key}` },
          },
        },
      },
      null,
      2,
    );
  }

  // cursor — reads { url, headers } natively, no bridge needed.
  return JSON.stringify(
    {
      mcpServers: {
        membral: {
          url,
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      },
    },
    null,
    2,
  );
}

type TestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; toolCount: number }
  | { status: "error"; message: string };

// UX W6: the snippet opens on Claude Code (the product's harness). `hasKey`
// says the account already has an active key that can't be shown again, so
// the copy asks for it to be pasted rather than generated; the Keys section
// sits BELOW this one on Settings, so every pointer says "below".
export const DEFAULT_MCP_TAB = "claude-code";

export function McpConfig({ apiKey, mcpUrl, hasKey = false }: { apiKey?: string; mcpUrl: string; hasKey?: boolean }) {
  const [activeTab, setActiveTab] = useState(DEFAULT_MCP_TAB);
  const [copied, setCopied] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  // The on-screen block shows a masked key (screenshots/screen-shares
  // shouldn't leak it); the copy button always copies the real, unmasked
  // config — see getMcpConfig's `mask` option and maskApiKey's doc comment.
  // `mcpUrl` is a required prop (resolved server-side, once, by the parent
  // settings page) rather than recomputed here — see this file's header.
  const displayConfig = getMcpConfig(activeTab, apiKey, { mask: true, mcpUrl });
  const copyConfig = getMcpConfig(activeTab, apiKey, { mcpUrl });
  const activeClient = MCP_CLIENTS.find((c) => c.id === activeTab)!;

  function handleCopy() {
    navigator.clipboard.writeText(copyConfig);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleTest() {
    if (!apiKey) return;
    setTest({ status: "loading" });
    try {
      const res = await fetch("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        toolCount?: number;
        error?: string;
      } | null;
      if (res.ok && data?.ok) {
        setTest({ status: "success", toolCount: typeof data.toolCount === "number" ? data.toolCount : 0 });
      } else {
        setTest({ status: "error", message: data?.error ?? "Connection failed." });
      }
    } catch {
      setTest({ status: "error", message: "Could not reach the server." });
    }
  }

  return (
    <div>
      {/* Tab pills */}
      <div className="flex flex-wrap gap-2 mb-3">
        {MCP_CLIENTS.map((client) => (
          <button
            key={client.id}
            onClick={() => {
              setActiveTab(client.id);
              setCopied(false);
              setTest({ status: "idle" });
            }}
            className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === client.id
                ? "text-accent border border-accent"
                : "text-ink-2 border border-line-strong hover:text-ink hover:border-ink"
            }`}
          >
            {client.label}
          </button>
        ))}
      </div>

      {/* Config location hint */}
      <p className="text-xs text-muted mb-2">{activeClient.hint}</p>

      {/* Code block */}
      <div className="relative group">
        <button
          onClick={handleCopy}
          className="absolute top-3 right-3 rounded-xs border border-line-strong bg-surface px-2.5 py-1 text-xs text-ink-2 opacity-0 group-hover:opacity-100 transition-opacity hover:opacity-90"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        <pre className="overflow-x-auto rounded-sm bg-sunken px-4 py-3 text-label leading-snug text-ink-2 font-mono border border-line">
          {displayConfig}
        </pre>
      </div>

      {/* Test connection */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={handleTest}
          disabled={!apiKey || test.status === "loading"}
          className="rounded-sm border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:border-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {test.status === "loading" ? "Testing…" : "Test connection"}
        </button>

        {test.status === "success" && (
          <span className="rounded-sm border border-line px-3 py-1.5 text-sm font-medium text-ok">
            Connected — {test.toolCount} tool{test.toolCount === 1 ? "" : "s"} available
          </span>
        )}
        {test.status === "error" && (
          <span className="rounded-sm border border-line px-3 py-1.5 text-sm font-medium text-error">
            {test.message}
          </span>
        )}
        {!apiKey && test.status === "idle" && (
          <span className="text-xs text-muted">
            {hasKey ? "Regenerate your key below to test from here." : "Generate an API key below to test."}
          </span>
        )}
      </div>
    </div>
  );
}
