/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** "1" builds for the hosted instance (https://membral.me); anything else targets a local Membral. */
  readonly VITE_MEMBRAL_PROD?: string;
  /** Overrides the default target of either build flavour. */
  readonly VITE_CLOUD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
