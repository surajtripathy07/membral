// Postgres text/jsonb safety for code-session imports.
//
// Postgres rejects two things a JS string can legally hold:
//   - U+0000 (NUL): `text` cannot store it and jsonb refuses the `\u0000`
//     escape ("unsupported Unicode escape sequence"). Real transcripts carry
//     it — e.g. a tool call whose input literally contains "\u0000".
//   - a lone UTF-16 surrogate (U+D800–U+DFFF without its pair): JSON.stringify
//     emits it as a `\udXXX` escape that jsonb also rejects.
// NUL is stripped; a lone surrogate becomes U+FFFD (the replacement char).
// Well-formed surrogate pairs (emoji etc.) are left untouched.

const NUL = String.fromCharCode(0);
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizePgText(value: string): string {
  return value.split(NUL).join("").replace(LONE_SURROGATE_RE, "\uFFFD");
}

/** Recursively sanitizes every string (and object key) in a JSON-shaped value. */
export function sanitizePgDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizePgText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizePgDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizePgText(k)] = sanitizePgDeep(v);
    }
    return out as T;
  }
  return value;
}
