// /code/stats "Membral on Membral" data (recall-precision W3b): the 7- and
// 30-day signals for the signed-in user, read through the cookie client
// (RLS: select-own on every table). Best-effort: a failed read renders the
// panel's empty state, never breaks the page.
import { type DogfoodSignals, getDogfoodSignalsWindows } from "@/lib/memory/dogfood-signals";
import { createClient } from "@/lib/supabase/server";

export interface DogfoodPanelData {
  week: DogfoodSignals;
  month: DogfoodSignals;
}

export async function loadDogfood(): Promise<DogfoodPanelData | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const now = new Date();
    // One read of the 30-day window; the 7-day view is the same rows filtered.
    const [week, month] = await getDogfoodSignalsWindows(supabase, user.id, [7, 30], now);
    if (!week || !month) return null;
    return { week, month };
  } catch {
    return null;
  }
}
