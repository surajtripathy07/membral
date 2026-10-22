// Attribution v4 (items 3 and 4): text that is not a command is never parsed as one,
// and harness-injected context is never the owner's words. Fictional repo `acme/billing`.
import { describe, expect, it } from "vitest";
import { claudeCodeParser, ownerTextOf, stripHarnessContext } from "../../sessions/claude-code.js";
import { deriveToolActions } from "../../sessions/forge-actions.js";

const verbsOf = (command: string, result = "") =>
  deriveToolActions({ toolName: "Bash", input: { command }, result }).map(
    (a) => `${a.verb}:${a.ref ?? a.branch ?? ""}`,
  );

describe("v4 item 3: heredoc bodies and quoted arguments are never commands", () => {
  const notCommands: Array<[string, string]> = [
    ["a heredoc written to a file", "cat > /tmp/audit.md <<'EOF'\ngh pr checkout 52169\ngh pr create --title x\nEOF"],
    ["an unquoted heredoc marker", "cat > notes.md <<EOF\ngh pr merge 12\ngit push origin main\nEOF"],
    ["a heredoc piped into psql", "cat <<'SQL' | psql \"$DB\"\n-- gh pr checkout 52169\nselect 1;\nSQL"],
    ["python -c", "python3 -c \"import os; os.system('gh pr checkout 52169')\""],
    ["python stdin heredoc", "python3 - <<'PY'\nimport os\nos.system('gh pr merge 52169')\nPY"],
    ["psql -c", 'psql "$U" -c "select \'gh pr checkout 52169\'"'],
    ["node -e", "node -e \"require('child_process').execSync('gh pr checkout 52169')\""],
    ["echo", 'echo "gh pr checkout 52169 && git push"'],
    ["printf", "printf '%s\\n' \"gh pr merge 52169\""],
    ["grep pattern", 'grep -rn "gh pr merge 52169" .'],
    ["here-string", "jq -r '.x' <<< \"gh pr checkout 11\""],
    ["command substitution inside a heredoc body", "cat > f.sh <<'EOF'\n$(gh pr checkout 1)\n`gh pr checkout 2`\nEOF"],
  ];
  for (const [name, command] of notCommands) {
    it(`${name}: no action`, () => {
      expect(verbsOf(command)).toEqual([]);
    });
  }

  it("a real command after the heredoc still counts (only the body is text)", () => {
    expect(verbsOf("cat > a.md <<'EOF'\ngh pr checkout 5\nEOF\ngh pr view 10 -R acme/billing")).toEqual([
      "viewed:github.com/acme/billing!10",
    ]);
  });

  it("a real command chained after a quoted argument still counts", () => {
    expect(verbsOf("echo 'gh pr merge 3'; gh pr view 7 -R acme/billing")).toEqual(["viewed:github.com/acme/billing!7"]);
  });

  it("a commit message heredoc naming other commands yields only the commit", () => {
    const out = verbsOf(
      "git commit -m \"$(cat <<'EOF'\nfix\n\ngh pr merge 7 && git push origin main\nEOF\n)\"",
      "[main abc1234] fix\n 1 file changed",
    );
    expect(out).toEqual(["committed:main"]);
  });
});

describe("v4 item 4: harness-injected context is never owner text", () => {
  const CARD = [
    "## About this user",
    "",
    "The owner is planning a trip. (×3)",
    "",
    "## Code projects",
    "",
    "- acme/billing — ledger work (last active 2026-08-31)",
    "",
    "User's message:",
    "/pending_decisions",
  ].join("\n");

  it("a leading Membral context card is cut up to its `User's message:` line", () => {
    expect(stripHarnessContext(CARD).trim()).toBe("/pending_decisions");
    expect(ownerTextOf(CARD)?.trim()).toBe("/pending_decisions");
  });

  it("review B3: a user typing the heading (no handover line) keeps every word", () => {
    const typed = "## About this user\nI am a backend dev, please remember I prefer pnpm. Fix #12 today.";
    expect(stripHarnessContext(typed)).toBe(typed);
    expect(ownerTextOf(typed)).toBeUndefined();
    expect(stripHarnessContext("## Code projects\n- billing: move to pnpm")).toBe(
      "## Code projects\n- billing: move to pnpm",
    );
  });

  it("a closed system-reminder block on its own lines is removed", () => {
    const text = "fix the ledger\n<system-reminder>\nSessionStart context: open threads …\n</system-reminder>\nthanks";
    expect(ownerTextOf(text)).toBe("fix the ledger\n\nthanks");
  });

  it("review B3: an unclosed tag, or a tag quoted inside the owner's sentence, keeps the owner's text", () => {
    const unclosed = "why does <system-reminder> show up in my transcript? strip it in the parser and fix #12";
    expect(stripHarnessContext(unclosed)).toBe(unclosed);
    expect(ownerTextOf(unclosed)).toBeUndefined();
    const quoted = "The hook emits `<system-reminder>ctx</system-reminder>` in the prompt. Then fix #12";
    expect(stripHarnessContext(quoted)).toBe(quoted);
    const unclosedBlock = "fix #12\n<system-reminder>\nnever closed";
    expect(stripHarnessContext(unclosedBlock)).toBe(unclosedBlock);
  });

  it("a plain prompt (or a heading the owner wrote) is untouched", () => {
    expect(stripHarnessContext("## Plan\nfix #12")).toBe("## Plan\nfix #12");
    expect(ownerTextOf("fix #12 please")).toBeUndefined();
  });

  it("the parser stores the owner's text beside the full prompt", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-26T10:00:00.000Z",
      sessionId: "s",
      cwd: "/home/dev/billing",
      message: { role: "user", content: CARD },
    });
    const s = claudeCodeParser.parse({ source: "claude-code", sourceSessionId: "s", path: "n/a" }, `${line}\n`);
    const t = s.turns.find((x) => x.role === "user");
    expect(t?.text).toContain("## About this user");
    expect(t?.ownerText?.trim()).toBe("/pending_decisions");
  });
});
