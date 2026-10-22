// The one alias for a Supabase client type across apps/cloud (G3 step 3B-1).
// Every data-layer function should annotate its client parameter as `Db`
// rather than the bare `SupabaseClient` from @supabase/supabase-js, so a
// future switch to a typed client (e.g. SupabaseClient<Database>) is a
// one-line change here instead of a repo-wide find/replace.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export type Db = SupabaseClient;

// G3 step 3B-5: the client typed against the generated schema. Repository
// modules flip from `Db` to `TypedDb` one at a time so their query chains are
// compiler-checked. Untyped `Db` clients stay assignable, so callers are
// unchanged. `Database` is the generated schema, re-exported by database.types.ts.
export type TypedDb = SupabaseClient<Database>;
