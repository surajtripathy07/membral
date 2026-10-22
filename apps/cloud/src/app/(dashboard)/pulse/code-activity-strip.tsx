// PulseRecentCodeSession — the shape /api/spike?op=pulse's
// recent_code_sessions rows take (getRecentCodeSessions, handoff 0024
// directive D). The CodeActivityStrip component that used to render these as
// its own horizontal strip was retired by ADR 0032 §3 module D ("merge the
// two existing strips" — ADR 0032, Addendum 2 renames the merged module
// "Your record"): the rows are now shaped into pulse-content.tsx's single
// merged list (buildRecordRows) instead, so this file keeps only the type
// both pulse-content.tsx and the API route share.
export interface PulseRecentCodeSession {
  id: string;
  code_project_id: string;
  title: string | null;
  summary: string | null;
  started_at: string | null;
  duration_seconds: number | null;
  turn_count: number;
  user_turn_count: number;
  project_display_name: string | null;
  project_repo_identity: string | null;
}
