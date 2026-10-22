// Shared, environment-agnostic MCP URL resolver.
//
// Browser-verify finding (2026-09-06, non-blocking): `components/mcp-config.tsx`
// used to compute this URL ITSELF, inside the client component, falling back
// on `window.location.origin` when no `NEXT_PUBLIC_MCP_URL` override was set.
// Server-side (no `window`) that produced a relative `/api/mcp`; client-side
// it produced an absolute `http://localhost:3001/api/mcp` — two different
// strings for the same render, which is a textbook React hydration mismatch
// (React logs a "Recoverable Error" and re-renders the subtree client-side to
// paper over it; not visibly broken, but a real console exception on every
// Settings page load).
//
// Fix: resolve the URL ONCE, on the server, from `getAppUrl()` (the same
// `NEXT_PUBLIC_APP_URL`-backed helper every other absolute-URL call site in
// this app already uses — see lib/env.ts) — never from `window.location` —
// and thread it down as a plain string prop. The settings page (a Server
// Component) computes it and passes it to `<McpConfig mcpUrl={...} />`;
// the client component renders that exact string on both the server-rendered
// HTML and the client hydration pass, so there is nothing left to mismatch.
import { getAppUrl } from "./env";

export function resolveMcpUrl(appUrl: string = getAppUrl()): string {
  const override = process.env.NEXT_PUBLIC_MCP_URL;
  if (override) return override;
  return `${appUrl.replace(/\/+$/, "")}/api/mcp`;
}
