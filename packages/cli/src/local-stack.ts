// The files `membral local up` writes under ~/.membral/local (W7, design
// docs/design/w7-one-command-local.md §4-§5): the .env holding generated
// secrets and settings, and docker-compose.yml. The gateway Caddyfile and the
// db role-password init script ride inside the compose file as inline
// `configs` (Compose >= 2.23), not bind mounts: a bind mount needs the
// host path shared into the Docker VM (Colima shares only $HOME by default,
// remote daemons share nothing), and a missing share silently mounts an
// empty directory. Everything here is pure or plain-fs and
// deterministic, so a second `up` with the same inputs writes nothing.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_IMAGE = "ghcr.io/surajtripathy07/membral-cloud:main";
export const DEFAULT_APP_PORT = 3000;
/** Gateway (GoTrue + PostgREST behind Caddy) host port; 54421 sits next to the Supabase CLI's 5432x range without colliding. */
export const DEFAULT_GATEWAY_PORT = 54421;
export const DEFAULT_EMAIL = "you@membral.local";
export const COMPOSE_PROJECT = "membral";
export const DB_VOLUME = "membral-local-db";
/** Claude Code, downloaded from npm on first start when the claude-code provider is chosen; never in the image. */
export const CLAUDE_CLI_VOLUME = "membral-local-claude-cli";

export const IMAGES = {
  db: "public.ecr.aws/supabase/postgres:17.6.1.166",
  auth: "public.ecr.aws/supabase/gotrue:v2.196.0",
  rest: "public.ecr.aws/supabase/postgrest:v14.5",
  gateway: "public.ecr.aws/docker/library/caddy:2-alpine",
} as const;

/** LLM settings passed through to the app only when set in .env. */
export const LLM_PASSTHROUGH = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "MEMBRAL_MODEL_BASE_URL",
  "MEMBRAL_MODEL",
  "MEMBRAL_MODEL_FREE",
  "MEMBRAL_EMBEDDINGS_BASE_URL",
  "MEMBRAL_EMBEDDING_MODEL",
  "MEMBRAL_EMBEDDING_MIN_SIMILARITY",
  "MEMBRAL_LLM_PROVIDER",
  "MEMBRAL_LLM_TIMEOUT_MS",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** A custom compose project name (--project / MEMBRAL_LOCAL_PROJECT): lowercase, compose- and volume-safe. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface LocalPaths {
  dir: string;
  /** Custom compose project; unset = the default stack ("membral"). */
  project?: string;
  env: string;
  compose: string;
  migrations: string;
}

export function localPaths(dir: string = join(homedir(), ".membral", "local"), project?: string): LocalPaths {
  return {
    dir,
    ...(project ? { project } : {}),
    env: join(dir, ".env"),
    compose: join(dir, "docker-compose.yml"),
    migrations: join(dir, "migrations"),
  };
}

/** The default stack dir, or ~/.membral/local-<project> for a custom project. */
export function localDirFor(project?: string): string {
  return join(homedir(), ".membral", project ? `local-${project}` : "local");
}

export function projectName(paths: Pick<LocalPaths, "project">): string {
  return paths.project ?? COMPOSE_PROJECT;
}

export function dbVolumeName(project?: string): string {
  return project ? `${DB_VOLUME}-${project}` : DB_VOLUME;
}

export function claudeCliVolumeName(project?: string): string {
  return project ? `${CLAUDE_CLI_VOLUME}-${project}` : CLAUDE_CLI_VOLUME;
}

// --- keys --------------------------------------------------------------------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

const TEN_YEARS_S = 10 * 365 * 24 * 60 * 60;

/** HS256 JWT in the shape Supabase uses for its anon/service_role keys. */
export function signSupabaseJwt(role: "anon" | "service_role", secret: string, iat: number): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ role, iss: "supabase", iat, exp: iat + TEN_YEARS_S }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export interface GeneratedSecrets {
  POSTGRES_PASSWORD: string;
  JWT_SECRET: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
  MEMBRAL_LOCAL_PASSWORD: string;
  /** Bearer for /api/internal/cron/*; the kicker service sends it. Not tied to the database, so it can be added later. */
  CRON_SECRET: string;
}

export function generateSecrets(nowS: number = Math.floor(Date.now() / 1000)): GeneratedSecrets {
  const jwtSecret = randomBytes(48).toString("base64url");
  return {
    // hex: safe unescaped inside the postgres:// URLs below.
    POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
    JWT_SECRET: jwtSecret,
    ANON_KEY: signSupabaseJwt("anon", jwtSecret, nowS),
    SERVICE_ROLE_KEY: signSupabaseJwt("service_role", jwtSecret, nowS),
    MEMBRAL_LOCAL_PASSWORD: randomBytes(18).toString("base64url"),
    CRON_SECRET: randomBytes(32).toString("hex"),
  };
}

// --- .env --------------------------------------------------------------------

export type EnvMap = Record<string, string>;

export function parseEnv(text: string): EnvMap {
  const out: EnvMap = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const ENV_HEADER = `# Membral local stack — written by \`membral local up\`. Keep this file private (mode 600).
# Generated secrets below are created once and reused on every run; do not change them
# unless you also wipe the stack (\`membral local down --wipe\`).
#
# Optional LLM settings: uncomment one, then run \`membral local up\` again.
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=
# MEMBRAL_LLM_PROVIDER=claude-code
# MEMBRAL_MODEL_BASE_URL=http://host.docker.internal:11434/v1
# MEMBRAL_MODEL=
# MEMBRAL_EMBEDDINGS_BASE_URL=http://host.docker.internal:11434/v1
# MEMBRAL_EMBEDDING_MODEL=nomic-embed-text
# MEMBRAL_LLM_TIMEOUT_MS=180000
# Ollama on Linux: set OLLAMA_HOST=172.17.0.1 for the Ollama service (the docker bridge IP that host.docker.internal maps to) so the container can reach it (see README).
`;

export interface EnsureEnvResult {
  env: EnvMap;
  written: boolean;
}

/**
 * Reads .env, fills any missing generated secret (never replaces one), sets
 * the given settings, and rewrites the file only when something changed.
 * Mode 600 every time; the directory is 700.
 */
export function ensureEnv(
  paths: LocalPaths,
  settings: EnvMap,
  gen: () => GeneratedSecrets = generateSecrets,
  opts: { keepPasswordAbsent?: boolean } = {},
): EnsureEnvResult {
  ensurePrivateDir(paths.dir);
  const existingText = existsSync(paths.env) ? readFileSync(paths.env, "utf8") : "";
  const env = parseEnv(existingText);
  const wanted: EnvMap = {};
  const secretKeys: (keyof GeneratedSecrets)[] = [
    "POSTGRES_PASSWORD",
    "JWT_SECRET",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "MEMBRAL_LOCAL_PASSWORD",
    "CRON_SECRET",
  ];
  if (secretKeys.some((k) => !env[k])) {
    const fresh = gen();
    if (!env.JWT_SECRET) {
      // Keys signed with a lost secret are useless: replace all three together.
      wanted.JWT_SECRET = fresh.JWT_SECRET;
      wanted.ANON_KEY = fresh.ANON_KEY;
      wanted.SERVICE_ROLE_KEY = fresh.SERVICE_ROLE_KEY;
    } else {
      const now = Math.floor(Date.now() / 1000);
      if (!env.ANON_KEY) wanted.ANON_KEY = signSupabaseJwt("anon", env.JWT_SECRET, now);
      if (!env.SERVICE_ROLE_KEY) wanted.SERVICE_ROLE_KEY = signSupabaseJwt("service_role", env.JWT_SECRET, now);
    }
    if (!env.POSTGRES_PASSWORD) wanted.POSTGRES_PASSWORD = fresh.POSTGRES_PASSWORD;
    if (!env.MEMBRAL_LOCAL_PASSWORD && !opts.keepPasswordAbsent)
      wanted.MEMBRAL_LOCAL_PASSWORD = fresh.MEMBRAL_LOCAL_PASSWORD;
    if (!env.CRON_SECRET) wanted.CRON_SECRET = fresh.CRON_SECRET;
  }
  for (const [k, v] of Object.entries(settings)) {
    if (env[k] !== v) wanted[k] = v;
  }

  let text = existingText || ENV_HEADER;
  for (const [k, v] of Object.entries(wanted)) {
    const re = new RegExp(`^(?:export\\s+)?${k}\\s*=.*$`, "m");
    if (re.test(text)) text = text.replace(re, () => `${k}=${v}`);
    else text = `${text.endsWith("\n") ? text : `${text}\n`}${k}=${v}\n`;
    env[k] = v;
  }
  const written = text !== existingText;
  if (written) {
    // Atomic: a temp file created 600 (never readable by others, even briefly), then rename.
    const tmp = `${paths.env}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, paths.env);
  }
  chmodSync(paths.env, 0o600);
  return { env, written };
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Writes `content` only when it differs. Returns true when written. */
export function writeIfChanged(path: string, content: string, mode = 0o644): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeFileSync(path, content, { encoding: "utf8", mode });
  chmodSync(path, mode);
  return true;
}

// --- rendered files ------------------------------------------------------------

export interface StackSettings {
  appPort: number;
  gatewayPort: number;
  image: string;
  /** Names from LLM_PASSTHROUGH that are set in .env. */
  llmKeys: string[];
  /** Custom compose project (names the project and suffixes the volumes). */
  project?: string;
}

export function appUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function gatewayUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** Same role set Supabase self-host's roles.sql sets; runs once, when the db volume is first initialised. */
export const ROLES_SQL = `-- Written by \`membral local up\`. Runs once on first database init.
\\set pgpass \`echo "$POSTGRES_PASSWORD"\`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
`;

/**
 * Path router in front of GoTrue and PostgREST. supabase-js calls
 * <url>/auth/v1/... and <url>/rest/v1/... with `apikey` and `Authorization`
 * headers; both services verify the JWT themselves, so the gateway only
 * routes, strips the prefix and answers CORS for the app's origin.
 */
export function renderCaddyfile(appPort: number): string {
  return `# Written by \`membral local up\`.
{
\tadmin off
\tauto_https off
}

:8000 {
\t@app_origin header_regexp Origin ^http://(localhost|127\\.0\\.0\\.1):${appPort}$
\theader @app_origin {
\t\tAccess-Control-Allow-Origin {http.request.header.Origin}
\t\tAccess-Control-Allow-Credentials true
\t\tAccess-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
\t\tAccess-Control-Allow-Headers "authorization, apikey, content-type, accept, accept-profile, content-profile, prefer, range, x-client-info, x-supabase-api-version"
\t\tAccess-Control-Expose-Headers "content-range, content-location, x-supabase-api-version"
\t\tAccess-Control-Max-Age 86400
\t\tVary Origin
\t\tdefer
\t}
\t@preflight method OPTIONS
\thandle @preflight {
\t\trespond 204
\t}
\thandle /healthz {
\t\trespond "ok" 200
\t}
\thandle_path /auth/v1/* {
\t\treverse_proxy auth:9999
\t}
\thandle_path /rest/v1/* {
\t\treverse_proxy rest:3000
\t}
\trespond 404
}
`;
}

/** A YAML block-scalar body for an inline compose config; `$` doubled so compose does not interpolate it. */
function inlineConfig(text: string): string {
  return text
    .replace(/\$/g, "$$$$")
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => (l ? `      ${l}` : ""))
    .join("\n");
}

/** A compose `${NAME}` interpolation, filled from .env via --env-file. */
function envRef(name: string): string {
  return "$" + "{" + name + "}";
}

function q(s: string): string {
  return JSON.stringify(s);
}

/** Seconds between kicks; the hosted kicker runs every 2 minutes too. */
export const KICK_INTERVAL_S = 120;

/**
 * The kicker's script. Hosted extraction is restarted by an outside
 * scheduler calling /api/internal/cron/memory-extraction?kick=1 with
 * CRON_SECRET; a plain `next start` has no scheduler, so a session left
 * pending (no model yet, a failed window, a run cut short) would wait for
 * the next upload. Uses only `node` from the app image; no `$` (compose would interpolate it).
 */
export function kickerScript(appPort: number): string {
  return [
    `const u = "http://app:${appPort}/api/internal/cron/memory-extraction?kick=1";`,
    `const kick = () => fetch(u, { headers: { authorization: "Bearer " + process.env.CRON_SECRET } })`,
    `  .then((r) => console.log(new Date().toISOString(), "kick", r.status), (e) => console.log(new Date().toISOString(), "kick failed", e.message));`,
    `kick();`,
    `setInterval(kick, ${KICK_INTERVAL_S * 1000});`,
  ].join("\n");
}

export function renderCompose(s: StackSettings): string {
  const app = appUrl(s.appPort);
  const gw = gatewayUrl(s.gatewayPort);
  const pg = envRef("POSTGRES_PASSWORD");
  const llm = s.llmKeys.map((k) => `      ${k}: ${q(envRef(k))}\n`).join("");
  return `# Written by \`membral local up\` — rewritten on every run; edit .env instead.
name: ${s.project ?? COMPOSE_PROJECT}

services:
  db:
    image: ${IMAGES.db}
    restart: unless-stopped
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "log_min_messages=fatal"]
    environment:
      POSTGRES_HOST: /var/run/postgresql
      POSTGRES_PORT: "5432"
      POSTGRES_DB: postgres
      POSTGRES_PASSWORD: ${q(pg)}
      JWT_SECRET: "\${JWT_SECRET}"
      JWT_EXP: "3600"
    volumes:
      - db-data:/var/lib/postgresql/data
    configs:
      - source: membral_roles
        target: /docker-entrypoint-initdb.d/init-scripts/99-membral-roles.sql
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres", "-h", "localhost"]
      interval: 5s
      timeout: 5s
      retries: 30

  auth:
    image: ${IMAGES.auth}
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: "9999"
      API_EXTERNAL_URL: ${q(gw)}
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: ${q(`postgres://supabase_auth_admin:${pg}@db:5432/postgres`)}
      GOTRUE_SITE_URL: ${q(app)}
      GOTRUE_URI_ALLOW_LIST: ${q(`${app}/**`)}
      GOTRUE_DISABLE_SIGNUP: "true"
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: "3600"
      GOTRUE_JWT_SECRET: "\${JWT_SECRET}"
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_EXTERNAL_PHONE_ENABLED: "false"
      GOTRUE_MAILER_AUTOCONFIRM: "true"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9999/health"]
      interval: 5s
      timeout: 5s
      retries: 30

  rest:
    image: ${IMAGES.rest}
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      PGRST_DB_URI: ${q(`postgres://authenticator:${pg}@db:5432/postgres`)}
      PGRST_DB_SCHEMAS: public
      PGRST_DB_EXTRA_SEARCH_PATH: public,extensions
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: "\${JWT_SECRET}"
      PGRST_DB_USE_LEGACY_GUCS: "false"
    # No healthcheck: the image has no shell or HTTP client, and \`postgrest
    # --ready\` refuses the default server-host ("!4"). The app's own
    # healthcheck exercises PostgREST through the gateway instead.

  gateway:
    image: ${IMAGES.gateway}
    restart: unless-stopped
    depends_on:
      - auth
      - rest
    ports:
      - "127.0.0.1:${s.gatewayPort}:8000"
    configs:
      - source: caddyfile
        target: /etc/caddy/Caddyfile
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8000/healthz"]
      interval: 5s
      timeout: 5s
      retries: 30

  app:
    image: ${s.image}
    restart: unless-stopped
    depends_on:
      auth:
        condition: service_healthy
      rest:
        condition: service_started
      gateway:
        condition: service_started
    # The app listens on the same port inside the container as on the host:
    # NEXT_PUBLIC_APP_URL (localhost:<port>) is also where the app POSTs its
    # own extraction trigger (lib/memory/extraction-trigger.ts), so that URL
    # must reach the app from inside the container too.
    ports:
      - "127.0.0.1:${s.appPort}:${s.appPort}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    # Empty unless MEMBRAL_LLM_PROVIDER=claude-code: the entrypoint then downloads
    # the pinned Claude Code from npm into it once and reuses it on later starts.
    volumes:
      - claude-cli:/claude-cli
    environment:
      NEXT_PUBLIC_SUPABASE_URL: ${q(gw)}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "\${ANON_KEY}"
      SUPABASE_SERVICE_ROLE_KEY: "\${SERVICE_ROLE_KEY}"
      NEXT_PUBLIC_APP_URL: ${q(app)}
      PORT: "${s.appPort}"
      SUPABASE_INTERNAL_URL: http://gateway:8000
      MEMBRAL_LOCAL: "1"
      CRON_SECRET: "\${CRON_SECRET}"
${llm}    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${s.appPort}/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 5s
      timeout: 5s
      retries: 60

  kicker:
    image: ${s.image}
    restart: unless-stopped
    depends_on:
      app:
        condition: service_healthy
    entrypoint: ["node", "-e", ${q(kickerScript(s.appPort))}]
    command: []
    environment:
      CRON_SECRET: "\${CRON_SECRET}"

volumes:
  db-data:
    name: ${dbVolumeName(s.project)}
  claude-cli:
    name: ${claudeCliVolumeName(s.project)}

configs:
  membral_roles:
    content: |
${inlineConfig(ROLES_SQL)}
  caddyfile:
    content: |
${inlineConfig(renderCaddyfile(s.appPort))}
`;
}
