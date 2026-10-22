/**
 * Pulse: async Server Component wrapper that reads `searchParams` and hands
 * them to the "use client" page (fetch/useState-driven) in pulse-page-client.tsx.
 */
import { PulsePageClient } from "./pulse-page-client";

export default async function PulsePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // UX pass 2: Open threads and Yesterday group by latest session; `?group=repo` keeps the repo grouping.
  const sp = await searchParams;
  const group = sp?.group;
  // `?day=YYYY-MM-DD` picks the day section's calendar day; parsed client-side in the viewer's timezone.
  const day = typeof sp?.day === "string" ? sp.day : null;

  return <PulsePageClient grouping={group === "repo" ? "repo" : "session"} day={day} />;
}
