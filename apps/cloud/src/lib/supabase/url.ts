// Which Supabase URL server-side code talks to (W7 7.1).
//
// NEXT_PUBLIC_SUPABASE_URL is the browser-facing URL. Inside the self-hosted
// container that is e.g. http://localhost:54321, which the container itself
// cannot reach. SUPABASE_INTERNAL_URL (server-only, never inlined into the
// browser bundle) is the container-network URL, e.g. http://gateway:8000.
// Unset (the hosted path), server code uses NEXT_PUBLIC_SUPABASE_URL as before.
import { supabaseInternalUrl } from "@/lib/env";

/** URL for server-side Supabase clients: SUPABASE_INTERNAL_URL when set, else NEXT_PUBLIC_SUPABASE_URL. */
export function serverSupabaseUrl(): string | undefined {
  const internal = supabaseInternalUrl();
  return internal || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

/**
 * Cookie options for cookie-session clients built on the internal URL.
 *
 * supabase-js names the auth cookie after the client URL's first hostname
 * label (`sb-<label>-auth-token`). The browser client uses the public URL, so a
 * server client on the internal URL must pin the public name or it would not
 * see the browser's session. Returns undefined when no internal URL is set, so
 * the hosted path passes no extra option.
 */
export function sessionCookieOptions(): { name: string } | undefined {
  const internal = supabaseInternalUrl();
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!internal || !publicUrl) return undefined;
  return { name: `sb-${new URL(publicUrl).hostname.split(".")[0]}-auth-token` };
}
