import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { after } from "next/server";
import { withRoute } from "@/lib/api/route";
import { createCloudMcpServer } from "@/lib/mcp/server";
import { keyBucket, userBucket } from "@/lib/rate-limit";

// AUTH (withRoute "dual", R4 4.12): Bearer lls_ key or Supabase JWT. A failed
// key lookup always threads the client IP, so FAILED validations are throttled
// per IP (brute-force protection, issue #67). Scoped keys are ALLOWED here: this
// is the read surface they exist for.
// tokenScopeId is the per-key AREA bound (issue #83) and codeScopeId the per-key
// CODE-PROJECT bound (ADR 0021 Q7): each is null unless the key carries that
// scope. BOTH are ONLY ever set from the validated API key (withRoute's `key`
// principal) — never from the request body — and are passed to the MCP server as
// mandatory outer bounds. A JWT-authed caller (the dashboard's own session) is
// always unscoped on both: JWTs carry no key scope.
// Rate limit (issue #67): key-authed callers are limited PER KEY (by the display
// prefix == stored api_key_prefix); a JWT-authed caller per user_id.
const handle = withRoute(
  {
    auth: {
      kind: "dual",
      missing: "Missing authorization",
      invalidToken: "Invalid token",
      invalidKey: "Invalid API key",
      scoped: "allow",
    },
    rateLimit: {
      name: "mcp",
      bucket: ({ userId, key }) => (key ? keyBucket("mcp", key.prefix) : userBucket("mcp", userId)),
    },
  },
  async ({ req, userId, key }) => {
    // Tool-call telemetry (mcp_tool_calls): after() keeps the function alive
    // until the row lands without holding the response.
    const server = createCloudMcpServer(userId, key?.scopeNodeId ?? null, key?.scopeCodeProjectId ?? null, {
      apiKeyId: key?.apiKeyId ?? null,
      waitUntil: (p) => after(p),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    await server.connect(transport);

    return transport.handleRequest(req);
  },
);

export const POST = handle;
export const GET = handle;

export async function DELETE(_req: Request) {
  // Session termination — stateless mode, just acknowledge
  return new Response(null, { status: 200 });
}
