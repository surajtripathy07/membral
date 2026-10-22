// /code/stats "Served and used" data. Kept out of load.ts so that loader's
// recorded call-log tests stay untouched. Best-effort: a failed read renders
// the block's empty state, never breaks the page.
import { getServedAndUsed, type ServedUsedSummary } from "@/lib/memory/served-used";
import { createClient } from "@/lib/supabase/server";

export async function loadServedUsed(): Promise<ServedUsedSummary | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    return await getServedAndUsed(supabase, user.id);
  } catch {
    return null;
  }
}
