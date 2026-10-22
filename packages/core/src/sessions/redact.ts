// Conservative secret redaction applied to user-prose turn text before storage.
// Goal: catch obvious credential leaks (AWS keys, API keys, bearer tokens,
// password= assignments, long hex/base64 secrets with a key-like label) without
// mangling ordinary prose or code identifiers (variable names, git SHAs, etc).

const REDACTED = "[REDACTED]";

/** One redaction rule: a global regex and what replaces each match. Adding a rule is one line in a table below. */
type Rule = readonly [pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)];

function applyRules(text: string, rules: readonly Rule[]): string {
  let out = text;
  for (const [pattern, replacement] of rules) {
    out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

// Keep the label (group 1) and the separator (group 2), redact the value.
const keepLabel = (_m: string, label: string, sep: string) => `${label}${sep}${REDACTED}`;

/**
 * Prose-safe rules (`redactSecrets`): each needs a credential-shaped token or an explicit secret label, so ordinary
 * prose and code identifiers are left alone. Order matters where rules overlap.
 */
const SECRET_RULES: readonly Rule[] = [
  // AWS access key ids: long-term (AKIA) and temporary (ASIA).
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // AWS secret access key, only when labelled (a bare 40-char string is too easy to confuse with a hash).
  [/\b(aws[_-]?secret[_-]?access[_-]?key)(\s*[:=]\s*)['"]?([A-Za-z0-9/+=]{30,})['"]?/gi, keepLabel],
  // OpenAI/Anthropic-style keys: sk-...
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // Stripe-style keys, live and test (a test key is still a credential).
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  // Membral keys: lls_/llk_ with base64url bodies (`-`/`_` are legitimate).
  [/\bllk_[A-Za-z0-9_-]{16,}|\blls_[A-Za-z0-9_-]{16,}/g, REDACTED],
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, and fine-grained github_pat_.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // Code-host personal access tokens.
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Slack tokens.
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  // npm tokens.
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  // `Authorization: Basic|Bearer <x>` of any length (also quoted JSON/YAML header maps).
  [
    /\b(Authorization["']?\s*:\s*["']?)(Basic|Bearer)\s+[^\s'"]+/gi,
    (_m: string, head: string, scheme: string) => `${head}${scheme} ${REDACTED}`,
  ],
  // API-key headers: `X-Api-Key: <x>`, `Api-Key: <x>`, `X-Auth-Token: <x>`.
  [/\b((?:X-)?Api-Key|X-Auth-Token)(["']?\s*:\s*["']?)[^\s'"]+/gi, keepLabel],
  // Any other `Bearer <token>`.
  [/\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9\-._~+/]{16,}=*/gi, `Bearer ${REDACTED}`],
  // password=/passwd=/pwd= assignments.
  [/\b(password|passwd|pwd)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, keepLabel],
  // Generic labelled secrets with a long value: secret=, token=, api_key=, access_key=, credentials=.
  [
    /\b(secrets?|tokens?|api[_-]?keys?|access[_-]?keys?|credentials?)(\s*[:=]\s*)['"]?([A-Za-z0-9/+_.\-=]{16,})['"]?/gi,
    keepLabel,
  ],
  // PEM private-key blocks, BEGIN through END (or the end of the text when END is missing, e.g. a cut file).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // JWTs: three base64url segments, the first starting `eyJ` (`{"`).
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  // URL credentials: `scheme://user:pass@host` and `scheme://:pass@host` keep the user, redact the password.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s/@]+@/gi, (_m: string, head: string) => `${head}${REDACTED}@`],
  // Quoted JSON/YAML secret keys: `"api_key": "value"`.
  [
    /("(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)"\s*:\s*)"[^"]+"/gi,
    (_m: string, head: string) => `${head}"${REDACTED}"`,
  ],
];

// Shell-command credential shapes — COMMAND DIGESTS and written file text only, never prose: in prose "the --token
// flag;" or `sort_key=created_at` is talk about a flag or a column, and eating the next word corrupts stored text,
// search and quotes (review S3).
const COMMAND_RULES: readonly Rule[] = [
  // `--token X`, `--token=X`, `--password X`, `--api-key X`, …
  [
    /(--(?:token|auth-token|access-token|password|passwd|pass|secret|client-secret|api-key|apikey|api_key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
    (_m: string, flag: string) => `${flag}${REDACTED}`,
  ],
  // `mysql -pS3cret!`: a password glued to `-p`. Needs a digit or symbol so `-pthread`-style flags are left alone;
  // never a port (`-p8080:80`, `-p2222`, `-p127.0.0.1:5432:5432/tcp`) or a known flag word (`-print0`).
  [
    /(^|\s)-p(?=[^\s-])(?![\d.:]+(?:\/(?:tcp|udp|sctp))?(?=\s|$))(?!(?:rint0|rintf|rune|erm|ath|edantic|thread|ipe)(?=\s|$))(?=\S*[\d!@#$%^&*+=])("[^"]*"|'[^']*'|\S+)/g,
    (_m: string, lead: string) => `${lead}-p${REDACTED}`,
  ],
  // `PGPASSWORD=x`, `STRIPE_KEY=x`, `GH_TOKEN=x`, `APP_SECRET=x`. Upper-case names only here: `sort_key=created_at`
  // in a command is code, not an env var.
  [
    /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|_PASS|_KEY|_TOKEN|_SECRET))=("[^"]*"|'[^']*'|\S+)/g,
    (_m: string, name: string) => `${name}=${REDACTED}`,
  ],
];

// A key that names a secret: contains one of these words (case-insensitive), or ends with `_key`/`Key`.
// `author` contains `auth` but names a person (package.json, front matter), so it is not a secret key.
const SECRET_KEY_WORD =
  /secret|token|passw(?:or)?d|pwd|private_?key|api_?key|access_?key|auth(?!or)|credential|client_secret/i;
const SECRET_KEY_SUFFIX = /_key$/i;
// Unquoted values that are a type, a literal, an auth scheme an earlier rule already handled, or a redaction: not a
// secret (`password: string;` in a TS interface, `Authorization: Bearer [REDACTED]`).
const NOT_A_VALUE = /^(?:string|number|boolean|null|undefined|true|false|Basic|Bearer|\[REDACTED\])$/;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_WORD.test(key) || SECRET_KEY_SUFFIX.test(key) || key.endsWith("Key");
}

/**
 * Written file text only (`redactFileSecrets`): config and dotfile shapes. Too broad for prose or command digests,
 * where `sort_key=created_at` is a column; in a written config file a `*_key` value is redacted.
 */
const FILE_RULES: readonly Rule[] = [
  // npmrc: `//registry/:_authToken=x`, `_auth=x`.
  [/(\b_auth(?:Token)?)(\s*=\s*)\S+/g, keepLabel],
  // netrc: `machine <host> login <x> password <x>` (also `default`), values on the same line.
  [
    /^([ \t]*(?:machine|default)\b.*)$/gm,
    (line: string) => line.replace(/\b(login|password|account)([ \t]+)\S+/g, (_m, kw, sp) => `${kw}${sp}${REDACTED}`),
  ],
  // netrc: a standalone `password <x>` / `login <x>` line.
  [/^([ \t]*(?:password|login))([ \t]+)\S+[ \t]*$/gm, keepLabel],
  // pgpass: `host:port:db:user:password`, the last field.
  [/^([^\s:#]+:(?:\d+|\*):[^\s:]+:[^\s:]+:)(\S+)$/gm, (_m: string, head: string) => `${head}${REDACTED}`],
  // Key/value assignments: env `KEY=v`, YAML/TS/JSON `key: v`, quotes optional on key and value. Keeps the key.
  [
    /(?<![A-Za-z0-9_$.-])(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1([ \t]*(?:=|:)[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;}'"]+)/g,
    (m: string, q: string, key: string, sep: string, value: string) => {
      if (!isSecretKey(key)) return m;
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
      if (!quote) {
        if (NOT_A_VALUE.test(value) || /^[=>]/.test(value)) return m;
        // An unquoted `=` value is an env/dotenv shape only when nothing is spaced: `token = await f()` is code.
        if (sep.includes("=") && sep.trim() !== sep) return m;
      }
      return `${q}${key}${q}${sep}${quote}${REDACTED}${quote}`;
    },
  ],
];

/** Credential shapes that are safe to redact in prose: user turns, assistant text, descriptions. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return applyRules(text, SECRET_RULES);
}

/**
 * `redactSecrets` plus the shell-command shapes (`--token X`, `-pS3cret!`,
 * `API_TOKEN=x`). For a Bash command digest only — prose goes through
 * `redactSecrets`, which never applies these.
 */
export function redactCommandSecrets(command: string): string {
  if (!command) return command;
  return applyRules(command, [...SECRET_RULES, ...COMMAND_RULES]);
}

/**
 * Every rule: prose, command and config/dotfile shapes. For text a session wrote to a file (Write/Edit/MultiEdit),
 * where `client_secret: abc`, `_authToken=x` and pgpass lines are credentials, not talk.
 */
export function redactFileSecrets(text: string): string {
  if (!text) return text;
  return applyRules(text, [...SECRET_RULES, ...COMMAND_RULES, ...FILE_RULES]);
}

// --- Memory v1, finding F (docs/goals/2026-09-13_memory-v1-build_goal.md
// step 2b; step2b-brief.md finding F): "PII in records" — a phone number
// leaked into stored `session_memories` rows. `redactSecrets` above only
// ever looked for credential-shaped strings; this widens the guard to
// personal-identifying shapes so hook (B) and agent (A) records get the
// same protection as extractor (C) records for free, per the brief's own
// instruction to put this "next to redactSecrets".
//
// step2d finding 2 (docs/goals/2026-09-13_memory-v1-build_goal.md, issue
// #151; maintainer reframe 2026-09-13: "why is home directory an issue
// anyway... isn't that just the path"): this module used to ALSO redact
// absolute home-directory paths (`/Users/<name>/...`, `~/...`) as if they
// were PII. They aren't — `code_session_turns.file_path` already stores
// every one of them verbatim for every turn, so scrubbing them out of a
// `session_memories` record protected nothing and cost a verifiable quote
// (a redacted "[redacted]" substring can never match the turn's real text).
// Path handling is now a CORRECTNESS concern (repo-relative vs. off-repo),
// handled by `apps/cloud/src/lib/memory/paths.ts` instead — this function
// redacts phone numbers and email addresses only.
const PII_REDACTED = "[redacted]";

// International "+<country> <groups>" shapes, spaced/dashed or not
// ("+15551234567", "+1 55512 34567", "+1-555-123-4567"), and common
// US-style separated local shapes ("555-123-4567", "(555) 123-4567",
// "555.123.4567"). Deliberately requires a `+` prefix or an explicit
// separator so a bare 7-40 digit run (which would collide with a git sha or
// an issue-range number) is never touched.
const PHONE_INTL = /\+\d{1,3}(?:[ -]?\d{2,5}){1,4}\b/g;
const PHONE_PAREN = /\(\d{3}\)[ -]?\d{3}[-.]\d{4}\b/g;
const PHONE_DASHED = /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Phone/email redaction for memory v1's `text`/`quote`/`ref`/`thread` fields
 * (finding F, narrowed by step2d finding 2 — see the block comment above).
 * Never throws; empty/falsy input is returned unchanged, matching
 * `redactSecrets`'s own contract.
 */
export function redactPii(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(PHONE_INTL, PII_REDACTED);
  out = out.replace(PHONE_PAREN, PII_REDACTED);
  out = out.replace(PHONE_DASHED, PII_REDACTED);
  out = out.replace(EMAIL, PII_REDACTED);
  return out;
}
