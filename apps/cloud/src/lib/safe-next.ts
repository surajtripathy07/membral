// Reads the "next" hidden field the login/signup forms carry through from
// middleware's ?next=... (see src/middleware.ts). Only ever a same-origin,
// root-relative path — "/foo", never "//evil.com" (protocol-relative) or an
// absolute URL — so a crafted `next` value can never turn login/signup into
// an open redirect. Falls back to "/" (the pre-existing default) for a
// missing/malformed value, exactly matching prior behaviour when no `next`
// field is present at all.
//
// NEW-5 (round-2 adversarial review): the M11 version enumerated specific
// dangerous characters/sequences (backslash, `//`, a colon in the first
// segment) — but WHATWG URL parsing strips raw TAB/CR/LF from a URL string
// BEFORE ever resolving it, so `/\t/evil.com` sailed straight past every one
// of those checks (no backslash, no literal `//`, no colon) and only became
// the open-redirect `//evil.com` once a browser actually parsed it. Rather
// than keep adding characters to the enumeration, this now: (1) rejects any
// raw C0 control character or DEL outright, (2) rejects a percent-encoded
// control char too (`/%09/evil.com` — some layers decode this before
// WHATWG's strip step), then (3) resolves the value against a placeholder
// origin with the real WHATWG URL parser and requires the result to still be
// on that placeholder origin — which is what actually determines whether a
// browser would treat it as same-origin, rather than us re-deriving that by
// hand. `//evil.com` and a bare scheme are rejected up front by the
// leading-slash / not-double-slash check before the parse even runs.
//
// Issue #134: pulled out of (auth)/actions.ts into its own module (rather
// than exported straight from there) because that file is a "use server"
// Server Actions module — every export from a "use server" file must be an
// async function (Next.js compiles each export into an RPC endpoint), and
// this is a plain synchronous helper. /auth/callback/route.ts needs the
// exact same same-origin validation for the `next` query param that
// survives the OAuth round trip, so both actions.ts and route.ts now import
// it from here instead of actions.ts defining and exporting its own copy.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0 controls/DEL to reject them — see comment above
const RAW_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const ENCODED_CONTROL_CHAR_RE = /%(0[0-9a-f]|1[0-9a-f]|7f)/i;
const SAFE_NEXT_BASE = "https://placeholder.invalid";

export function safeNext(raw: FormDataEntryValue | string | null): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (RAW_CONTROL_CHAR_RE.test(raw) || ENCODED_CONTROL_CHAR_RE.test(raw)) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(raw, SAFE_NEXT_BASE);
  } catch {
    return "/";
  }
  if (url.origin !== SAFE_NEXT_BASE) return "/";

  // NEW-6 (round-3 adversarial review): the checks above only validated the
  // INPUT string, then returned the WHATWG-normalized OUTPUT (pathname +
  // search + hash) unchecked. The parser collapses `..` segments and
  // duplicate slashes as part of normal resolution, so an input like
  // `/..//evil.com` — which passes every input check above (starts with a
  // single `/`, same-origin once resolved against the placeholder) —
  // normalizes to an output of `//evil.com`, a protocol-relative URL that
  // becomes a real cross-origin redirect once handed to `redirect()`. Fix:
  // validate the OUTPUT the same way, by re-parsing IT against the
  // placeholder origin and requiring both leading-slash shape and origin
  // containment on the re-parse — not just on the original input.
  const out = url.pathname + url.search + url.hash;
  if (!out.startsWith("/") || out.startsWith("//") || out.startsWith("/\\")) return "/";

  let reparsed: URL;
  try {
    reparsed = new URL(out, SAFE_NEXT_BASE);
  } catch {
    return "/";
  }
  if (reparsed.origin !== SAFE_NEXT_BASE) return "/";
  if (!reparsed.href.startsWith(`${SAFE_NEXT_BASE}/`)) return "/";

  return out;
}
