import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { STORAGE_KEYS } from "../common/constants.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export interface StoredAuthState {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: number; // Unix timestamp in seconds
}

export interface AuthState {
  isLoggedIn: boolean;
  email?: string;
  accessToken?: string;
  /** "api-key" when an lls_ key is stored (it wins over any Supabase session); "password" for a Supabase session. */
  kind?: "api-key" | "password";
}

/** Password sign-in needs a Supabase project baked in at build time; a local-only build has none. */
export function passwordSignInAvailable(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/** What the options page accepts as an API key: the local stack and `membral login` issue `lls_` keys. */
export function isValidApiKeyFormat(key: string): boolean {
  return /^lls_\S{8,}$/.test(key);
}

export async function getApiKey(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  const key = result?.[STORAGE_KEYS.API_KEY];
  return typeof key === "string" && key ? key : null;
}

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!isValidApiKeyFormat(trimmed)) {
    throw new Error("That does not look like a Membral API key (it starts with lls_)");
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: trimmed });
}

export async function clearApiKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.API_KEY);
}

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables");
    }
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  return supabaseClient;
}

async function getStoredAuth(): Promise<StoredAuthState | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.AUTH_STATE);
  return (result[STORAGE_KEYS.AUTH_STATE] as StoredAuthState) || null;
}

function isTokenExpired(expiresAt: number): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= expiresAt;
}

export async function getAuthState(): Promise<AuthState> {
  // A stored API key wins and never touches Supabase: it is sent as the bearer token as-is.
  const apiKey = await getApiKey();
  if (apiKey) return { isLoggedIn: true, accessToken: apiKey, kind: "api-key" };

  const stored = await getStoredAuth();

  if (!stored || !stored.accessToken) {
    return { isLoggedIn: false };
  }

  if (isTokenExpired(stored.expiresAt)) {
    if (stored.refreshToken) {
      try {
        const client = getSupabaseClient();
        const { data, error } = await client.auth.refreshSession({
          refresh_token: stored.refreshToken,
        });
        if (!error && data.session) {
          const refreshed: StoredAuthState = {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            email: data.session.user?.email || stored.email,
            expiresAt: data.session.expires_at!,
          };
          await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_STATE]: refreshed });
          return {
            isLoggedIn: true,
            email: refreshed.email,
            accessToken: refreshed.accessToken,
            kind: "password",
          };
        }
      } catch {}
    }
    return { isLoggedIn: false };
  }

  return {
    isLoggedIn: true,
    email: stored.email,
    accessToken: stored.accessToken,
    kind: "password",
  };
}

export async function login(email: string, password: string): Promise<void> {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error) {
    throw new Error(error.message);
  }

  if (!data.session) {
    throw new Error("Login succeeded but no session returned");
  }

  const authState: StoredAuthState = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    email: data.session.user?.email || email,
    expiresAt: data.session.expires_at!,
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_STATE]: authState });
}

export async function logout(): Promise<void> {
  // Best-effort remote sign out (a local-only build has no Supabase project to sign out of)
  if (passwordSignInAvailable()) {
    await getSupabaseClient()
      .auth.signOut()
      .catch(() => {});
  }

  // Always clear local auth data
  await chrome.storage.local.remove(STORAGE_KEYS.AUTH_STATE);
}

export async function getAccessToken(): Promise<string | null> {
  const state = await getAuthState();
  return state.isLoggedIn ? (state.accessToken ?? null) : null;
}
