// The one service-role Supabase client factory for apps/cloud (G1 step 1.2).
// Every call builds a fresh client: no memoization, matching the per-file
// factories this replaces. Service-role clients bypass RLS, so callers must
// scope every query to the authenticated user themselves.
import { createClient } from "@supabase/supabase-js";
import { supabaseServiceRoleKey } from "@/lib/env";
import { serverSupabaseUrl } from "@/lib/supabase/url";
import type { Db } from "./types";

export type { Db } from "./types";

export interface ServiceClientOptions {
  /** Error message thrown when env is missing. Some call sites keep a historical message. */
  message?: string;
}

const DEFAULT_MESSAGE = "Missing Supabase env vars";

/** The historical "env missing" text several routes and workers pass to getServiceClient; one copy, byte-identical. */
export const SUPABASE_ENV_MISSING_MESSAGE =
  "Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)";

function readEnv(): { url: string; key: string } | null {
  const url = serverSupabaseUrl();
  const key = supabaseServiceRoleKey();
  if (!url || !key) return null;
  return { url, key };
}

/** Service-role client; throws when env is missing. Default message is the string most call sites used. */
export function getServiceClient(opts: ServiceClientOptions = {}): Db {
  const env = readEnv();
  if (!env) throw new Error(opts.message ?? DEFAULT_MESSAGE);
  return createClient(env.url, env.key);
}

/** Service-role client or null when env is missing. */
export function tryServiceClient(): Db | null {
  const env = readEnv();
  if (!env) return null;
  return createClient(env.url, env.key);
}
