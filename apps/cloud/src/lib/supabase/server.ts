import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { serverSupabaseClientOptions, serverSupabaseUrl, sessionCookieOptions } from "./url";

export async function createClient() {
  const cookieStore = await cookies();

  const url = serverSupabaseUrl();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const cookieOptions = sessionCookieOptions();

  return createServerClient(url, anonKey, {
    ...serverSupabaseClientOptions(),
    ...(cookieOptions ? { cookieOptions } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // The `setAll` method is called from a Server Component.
          // This can be ignored if you have middleware refreshing sessions.
        }
      },
    },
  });
}
