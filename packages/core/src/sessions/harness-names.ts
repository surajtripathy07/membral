// One display-name map for harness ids (`code_sessions.source`), shared by the CLI's first-run report
// and the cloud's "Your history" card. Unknown ids render as themselves.
const HARNESS_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  opencode: "opencode",
  "copilot-cli": "Copilot CLI",
  codex: "Codex",
  agy: "Antigravity",
};

export function harnessDisplayName(id: string): string {
  return HARNESS_DISPLAY_NAMES[id] ?? id;
}
