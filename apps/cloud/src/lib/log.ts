// Minimal structured logger for the cloud app (issue #72).
//
// Dependency-free by design: a thin wrapper that emits ONE line of JSON per log
// via console. We deliberately avoid pino here —
//   - no extra dependency, matching the repo's minimal-infra posture;
//   - no Next.js edge/runtime transport pitfalls (pino's worker-thread transport
//     does not run on the edge and needs care in serverless);
//   - single-line JSON to stdout/stderr is exactly what Vercel log drains ingest.
//
// The ONLY console.* calls in app/api + lib/kg live here, on purpose: this module
// is the sink. Everything else logs through a Logger.
//
// Usage:
//   import { log, requestId } from "@/lib/log";
//   log.info("hello", { foo: 1 });
//   const rid = requestId(req);              // x-request-id passthrough or generated
//   const rlog = log.withContext({ request_id: rid, route: "/api/x" });
//   rlog.info("start");
//   rlog.error("failed", { err: message });  // child logger binds the context on every line

export type LogLevel = "info" | "warn" | "error";

/** Well-known context fields, plus arbitrary extras. */
export interface LogContext {
  request_id?: string;
  user_id?: string;
  route?: string;
  [key: string]: unknown;
}

export type LogFields = Record<string, unknown>;

/** console method per level — the single place we touch console. */
function emit(level: LogLevel, line: string): void {
  // This module is the single logging sink — the only console.* in app/api + lib/kg.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export class Logger {
  private readonly context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /** Return a child logger that binds `context` on every subsequent line. */
  withContext(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context });
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    // Field precedence: base < bound context < per-call fields. `level/msg/ts`
    // are reserved and always win so a stray field can't shadow them.
    const record: Record<string, unknown> = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...this.context,
      ...fields,
    };
    record.level = level;
    record.msg = msg;
    emit(level, JSON.stringify(record));
  }

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }
}

/** The root logger — no bound context. Prefer `withContext(...)` in request paths. */
export const log = new Logger();

/**
 * Resolve a request id: reuse an inbound `x-request-id` if the caller supplied one
 * (so a trace propagates across hops), else mint a fresh UUID. Accepts a Request /
 * NextRequest, a Headers, or nothing. The inbound value is echoed in response headers
 * and written to logs, so it is accepted only when it matches SAFE_REQUEST_ID
 * (1-128 of [A-Za-z0-9._-]); anything else gets a fresh id.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(source?: { headers?: Headers } | Headers | null): string {
  let headers: Headers | undefined;
  if (source instanceof Headers) headers = source;
  else if (source && "headers" in source && source.headers instanceof Headers) headers = source.headers;

  const inbound = headers?.get("x-request-id")?.trim();
  if (inbound && SAFE_REQUEST_ID.test(inbound)) return inbound;
  return crypto.randomUUID();
}
