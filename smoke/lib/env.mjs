// Tiny KEY=VALUE parser for apps/cloud/.env.local — no dotenv dependency
// needed for three lines. Ignores blank lines and `#` comments; strips a
// matching pair of surrounding quotes; does NOT expand `$VAR` references
// (this repo's .env.local doesn't use them).
import { readFileSync } from "node:fs";

export function loadEnvFile(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Drop inline `# comment` suffixes some lines in this repo's .env.local
    // carry (e.g. "MEMBRAL_KG_MONTHLY_CEILING_USD=8  # note") — only outside
    // quotes, so a real `#` inside a quoted value survives.
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Supabase + app config the smoke run needs, resolved as:
 * process.env (real shell/CI export) > apps/cloud/.env.local (local dev).
 * This mirrors the CLI's own "env wins" precedence posture and means CI can
 * export these directly with no .env.local file on disk at all.
 */
export function resolveSmokeConfig(repoRoot) {
  const fileEnv = loadEnvFile(`${repoRoot}/apps/cloud/.env.local`);
  const pick = (key) => process.env[key] ?? fileEnv[key];
  return {
    supabaseUrl: pick("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: pick("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: pick("SUPABASE_SERVICE_ROLE_KEY"),
    // P10 re-review N-m2: whether the dev server can build an LLM client
    // (kg/types.ts resolveModelConfig: OPENAI_API_KEY, or a local
    // MEMBRAL_MODEL_BASE_URL). Same precedence as next dev: an exported
    // value — even an empty one — wins over .env.local.
    cronSecret: pick("CRON_SECRET")?.trim() || undefined,
    serverHasModelKey: Boolean(pick("OPENAI_API_KEY")?.trim() || pick("MEMBRAL_MODEL_BASE_URL")?.trim()),
  };
}
