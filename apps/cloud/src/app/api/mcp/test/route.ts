import { type NextRequest, NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { validateApiKey } from "@/lib/api-keys";
import { getAppUrl } from "@/lib/env";
import { log } from "@/lib/log";
import { clientIp, ipOrFallbackBucket, rateLimited } from "@/lib/rate-limit";

interface JsonRpcResponse {
  result?: { tools?: unknown[] };
  error?: { message?: string };
}

// The /api/mcp transport runs in SSE mode, so a successful response is framed as
// `event: message\ndata: {json}\n\n`. Pull the JSON-RPC payload out of the last
// valid `data:` line; fall back to parsing the whole body as plain JSON.
function parseMcpResponse(raw: string): JsonRpcResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      // not plain JSON — try SSE framing below
    }
  }

  const dataPayloads = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (let i = dataPayloads.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataPayloads[i]) as JsonRpcResponse;
    } catch {
      // keep scanning earlier frames
    }
  }
  return null;
}

function extractKey(req: NextRequest, body: unknown): string | null {
  if (body && typeof body === "object" && "apiKey" in body) {
    const candidate = (body as { apiKey?: unknown }).apiKey;
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return null;
}

// POST /api/mcp/test -- verify an API key actually works against the MCP
// endpoint. Body { ok, toolCount?, error? }; the dashboard reads `ok`/`error`.
// #172 (ruling D-067): withRoute kind "none" (the key arrives in the body,
// which the wrapper never reads) plus a per-IP `mcpTest` limit on EVERY call;
// validation threads clientIp so failed keys count against keyValidationFail
// (its 429 carries Retry-After); an invalid key is 401 with the same body shape.
export const POST = withRoute(
  { auth: { kind: "none" }, rateLimit: { name: "mcpTest", bucket: ({ req }) => ipOrFallbackBucket("mcpTest", req) } },
  async ({ req }) => {
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      // key may still arrive via the Authorization header
    }

    const apiKey = extractKey(req, body);
    if (!apiKey || !apiKey.startsWith("lls_")) {
      return NextResponse.json({ ok: false, error: "Provide an lls_ API key to test." }, { status: 400 });
    }

    const validation = await validateApiKey(apiKey, clientIp(req));
    if (validation.rateLimited) return rateLimited(validation.retryAfter ?? 60);
    if (!validation.valid) {
      return NextResponse.json({ ok: false, error: "API key is not valid." }, { status: 401 });
    }

    // Loopback target from NEXT_PUBLIC_APP_URL, never the request's Host header
    // (caller-controlled: an SSRF lever on a self-hosted deployment).
    const mcpUrl = `${getAppUrl()}/api/mcp`;
    let mcpRes: Response;
    try {
      mcpRes = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Streamable HTTP requires the client to accept both content types.
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    } catch (err) {
      log.warn("mcp/test: MCP endpoint unreachable", { err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ ok: false, error: "Could not reach the MCP endpoint." });
    }

    if (mcpRes.status !== 200) {
      return NextResponse.json({ ok: false, error: `MCP endpoint returned HTTP ${mcpRes.status}.` });
    }

    const parsed = parseMcpResponse(await mcpRes.text());
    const tools = parsed?.result?.tools;
    if (!parsed || parsed.error || !Array.isArray(tools)) {
      return NextResponse.json({
        ok: false,
        error: parsed?.error?.message ?? "MCP endpoint did not return a valid tools list.",
      });
    }

    return NextResponse.json({ ok: true, toolCount: tools.length });
  },
);
