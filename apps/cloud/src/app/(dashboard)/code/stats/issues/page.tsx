// /code/stats/issues — Issues tab (goal 2026-07-26 step 9 slice two; ADR
// 0032 §4 table). Thin server wrapper, same convention as pulse/page.tsx:
// the client component owns fetch/state.
import { IssuesPanel } from "./issues-panel";

export default function CodeStatsIssuesPage() {
  return <IssuesPanel />;
}
