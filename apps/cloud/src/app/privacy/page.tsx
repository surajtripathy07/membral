/*
 * SOURCES: every statement on this page, and where it is true (paths from the repo root).
 *
 * Stored in the local Postgres, no Membral server, no telemetry
 * - Local stack (Postgres, app, loopback-only ports): README.md "Run it locally", packages/cli/src/local-stack.ts
 * - No analytics, tracking or error-reporting library or call: grep of the tree for posthog, segment, gtag,
 *   vercel analytics, sentry, plausible, mixpanel, amplitude (2026-10-23, no hits in code or package.json).
 *   The MCP tool-call counter writes only to your own database: apps/cloud/src/lib/mcp/telemetry.ts
 *
 * What is saved
 * - Uploads at session end / `membral sessions`: packages/core/src/sessions/registry.ts, packages/cli/src/help.ts
 * - Stored per session (prompts, replies, reasoning text, tools, files, repo/branch, times, models, tokens,
 *   sub-agents): packages/core/src/sessions/types.ts, claude-code.ts
 * - Text written to files kept, capped at 8,000 chars, Edit's old text not kept: claude-code.ts
 * - Last 30 days by default, `--all` / `--since`: packages/cli/src/import-window.ts, help.ts
 * - Per-project allowlist ~/.membral/sync.json: packages/cli/src/sync-allowlist.ts
 * - Prompt hook: prompts of 4+ words, first 2,000 chars, not stored, hook.log never holds the prompt:
 *   packages/cli/src/prompt-hook.ts; apps/cloud/src/app/api/memory/prompt-recall/route.ts
 * - memory_search stores the query and the served record ids: apps/cloud/src/lib/memory/search.ts
 * - Chats via the extension or `membral import`: packages/extension/manifest.json, packages/cli/src/help.ts
 *
 * What is not kept
 * - Tool output elided: claude-code.ts; codex.ts; copilot-cli.ts; agy.ts; opencode.ts (no tool_result turn)
 * - Only git/gh/glab and test-runner commands kept, redacted and capped: types.ts,
 *   packages/core/src/sessions/forge-actions/types.ts, claude-code.ts
 * - Pattern-based secret redaction: packages/core/src/sessions/redact.ts; claude-code.ts
 * - Sensitive file basenames keep no text (path kept): claude-code.ts
 * - Phone numbers and email addresses removed from extracted records: redact.ts, apps/cloud/src/lib/memory/merge.ts
 * - API keys stored as a SHA-256 hash: apps/cloud/src/lib/api-keys.ts
 *
 * What leaves the machine
 * - Provider choice and "no model = no extraction": README.md; docs/SELF-HOSTING.md; apps/cloud/src/lib/llm/config.ts
 * - Extraction reads session turns: apps/cloud/src/lib/memory/extract.ts
 * - Embeddings of records, search queries and prompt-hook prompts: apps/cloud/src/lib/memory/embed.ts;
 *   search.ts; apps/cloud/src/lib/memory/prompt-recall.ts; embedding-client.ts
 * - claude-code provider does no embeddings: README.md "Why embeddings"
 *
 * Deleting
 * - `membral local down` keeps data; `membral local down --wipe` deletes the database volume and the downloaded
 *   Claude Code volume, asks first, `--yes` skips the question: packages/cli/src/local-command.ts (localDown),
 *   packages/cli/src/help.ts
 *
 * README link: apps/cloud/src/app/_landing/content.ts (REPO_URL)
 */
import type { Metadata } from "next";
import { REPO_URL } from "../_landing/content";
import { LandingFooter, LandingNav } from "../_landing/sections";
import { code, H3, Section, textLink } from "../_legal/parts";

export const metadata: Metadata = {
  title: "Privacy - Membral",
  description: "What Membral stores on your machine and what leaves it",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-canvas text-ink">
      <LandingNav />
      <article className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-16">
        <p className="section-label">Privacy</p>
        <h1 className="mt-2 text-h1 tracking-tight text-ink">Privacy</h1>
        <p className="mt-2 text-body-sm text-muted">Last updated: 2026-10-23</p>

        <p className="mt-6 text-lead text-ink-2">
          Membral runs on your machine and keeps everything there. The Membral project runs no server that
          receives your data and collects no telemetry. The setup is in the{" "}
          <a href={`${REPO_URL}#run-it-locally`} className={textLink}>
            README
          </a>
          . See also the{" "}
          <a href="/terms" className={textLink}>
            Terms
          </a>
          .
        </p>

        <Section id="saved" title="What is saved">
          <p>
            Everything goes into the Postgres database inside the local stack on your machine. For each coding
            session it keeps:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>what you typed and what the agent wrote back, including its reasoning text when the transcript holds it;</li>
            <li>which tools the agent called and which files it touched;</li>
            <li>
              text the agent wrote into files, up to 8,000 characters per write (the text an edit replaced is
              not kept);
            </li>
            <li>short digests of git, gh, glab and test-runner commands;</li>
            <li>the repo path, git remote URL and branch, times, models used, token counts and sub-agents.</li>
          </ul>
          <p>
            By default only the last 30 days are imported. At setup you choose which projects sync; the choice is
            saved in <code className={code}>~/.membral/sync.json</code>. Chats you bring in with the Chrome
            extension or <code className={code}>membral import</code> are saved the same way. When your agent
            searches with <code className={code}>memory_search</code>, the search text and the records it
            returned are saved too.
          </p>

          <H3>Not saved</H3>
          <ul className="list-disc space-y-2 pl-5">
            <li>The output of the tools the agent ran (file reads, command output).</li>
            <li>Shell commands other than git, gh, glab and test runners, beyond the tool name.</li>
            <li>
              Text shaped like a key, token or password is replaced with{" "}
              <code className={code}>[REDACTED]</code>. This works by known patterns, so a secret in an unusual
              shape can get through.
            </li>
            <li>
              Text written to files that look like secret stores (<code className={code}>.env</code>, private
              keys, <code className={code}>.npmrc</code>, credentials files and similar); only the path is kept.
            </li>
            <li>
              Prompts the recall hook looks up (it reads the first 2,000 characters of prompts of four or more
              words) are not stored, and the hook&apos;s log never holds them.
            </li>
          </ul>
        </Section>

        <Section id="leaves" title="What leaves your machine">
          <p>
            Only model calls, to the provider you set up. Extraction sends session text to it, and so do
            embeddings if you use an API key instead of Ollama:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              a Claude login: session text goes to Anthropic under your own account (no embeddings, so use
              Ollama for those);
            </li>
            <li>an API key: session text, search text and recall prompts go to that provider;</li>
            <li>Ollama for both extraction and embeddings: nothing leaves your machine.</li>
          </ul>
          <p>
            With no extraction model, import, session pages, keyword search and MCP still work and nothing is
            sent. That provider&apos;s own privacy terms apply.
          </p>
          <p>The app sets only sign-in, theme and time zone cookies, on your own machine.</p>
        </Section>

        <Section id="delete" title="Deleting your data">
          <p>
            Take the stack down and delete its data with <code className={code}>membral local down --wipe</code>.
            It asks first; add <code className={code}>--yes</code> to skip the question. This deletes the local
            database and the downloaded Claude Code volume, and cannot be undone.
          </p>
          <p>
            <code className={code}>membral local down</code> alone stops the stack and keeps the data. Your
            settings and keys stay in <code className={code}>~/.membral/local</code> until you delete that
            folder.
          </p>
        </Section>
      </article>
      <LandingFooter />
    </main>
  );
}
