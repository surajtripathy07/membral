/*
 * SOURCES — every claim on this page, and where it is true (paths from the repo root).
 *
 * What we collect
 * - Email; password via Supabase Auth; Google sign-in: apps/cloud/src/app/(auth)/actions.ts
 * - Uploads at session end / `membral sessions`; harnesses: packages/core/src/sessions/registry.ts,
 *   packages/cli/src/help.ts
 * - Stored per session (prompts, replies, reasoning text, tools, files, repo/branch, times, models, tokens,
 *   sub-agents): packages/core/src/sessions/types.ts, claude-code.ts
 * - Text written to files kept, capped at 8,000 chars, Edit's old text not kept: claude-code.ts
 * - Last 30 days by default, `--all` / `--since`: packages/cli/src/import-window.ts, help.ts
 * - Per-project allowlist ~/.membral/sync.json, new projects sync by default: packages/cli/src/sync-allowlist.ts
 * - Prompt hook: prompts of 4+ words, first 2,000 chars, not stored, hook.log never holds the prompt:
 *   packages/cli/src/prompt-hook.ts; apps/cloud/src/app/api/memory/prompt-recall/route.ts
 * - memory_search stores the query and the served record ids: apps/cloud/src/lib/memory/search.ts,
 *   apps/cloud/supabase/migrations/084_memory_v1.sql
 * - Chats via the extension or `membral import`: packages/extension/manifest.json, packages/cli/src/help.ts
 * - No analytics library in the web app: apps/cloud/package.json
 *
 * What we do not keep
 * - Tool output elided: claude-code.ts; codex.ts; copilot-cli.ts; agy.ts;
 *   opencode.ts (no tool_result turn)
 * - Only git/gh/glab and test-runner commands kept, redacted and capped: types.ts,
 *   packages/core/src/sessions/forge-actions/types.ts, claude-code.ts
 * - Pattern-based secret redaction: packages/core/src/sessions/redact.ts; claude-code.ts
 * - Sensitive file basenames keep no text (path kept): claude-code.ts
 * - Phone numbers and email addresses removed from extracted records: redact.ts,
 *   apps/cloud/src/lib/memory/merge.ts
 * - API keys stored as a SHA-256 hash: apps/cloud/src/lib/api-keys.ts
 * - Extension cookies only in provider fetch code: packages/extension/src/providers/claude.ts,
 *   providers/chatgpt.ts (no cookie use in src/sync, src/auth, src/common, background.ts)
 *
 * Where it is stored
 * - Supabase Postgres + row-level security: apps/cloud/supabase/migrations/029_code_sessions.sql,
 *   084_memory_v1.sql; docs/DEPLOY.md
 * - Server reads with the service-role key, filtered by user id: apps/cloud/src/lib/db/clients.ts,
 *   apps/cloud/src/lib/memory/search.ts
 * - Supabase database in Singapore: confirmed by the maintainer on 2026-10-12.
 * - Vercel hosting, functions region sin1: the Vercel project setting resourceConfig.functionDefaultRegions =
 *   ["sin1"] (vercel.json "regions" is ignored under Fluid compute; set by API patch, recorded in docs/HANDOFF.md,
 *   2026-10-02 W1 session note); x-vercel-id header sin1 observed at the 2026-10-09 deploy (docs/HANDOFF.md, DEPLOYED
 *   line). The project setting is not in the repo, so the page says "observed".
 * - Keys per account, optionally scoped to one code project: apps/cloud/src/app/api/keys/route.ts
 *
 * Who processes it
 * - Model provider on membral.me today: OpenRouter, extraction on a Google Gemma model; embeddings and chat through
 *   the same key. Source: Vercel Production env MEMBRAL_MODEL (value starts google/gemma), recorded 2026-10-12, and
 *   the docs/HANDOFF.md hosted-production note. MAINTAINER ANSWERED "whatever we have in production, might change".
 *   Self-hosters choose their own: apps/cloud/src/lib/llm/config.ts
 * - Extraction reads session turns: apps/cloud/src/lib/memory/extract.ts; on by default:
 *   apps/cloud/src/lib/feature-flags.ts; queued on upload: apps/cloud/src/app/api/code-sessions/route.ts;
 *   last 30 days only: apps/cloud/src/lib/memory/extraction-queue.ts
 * - Embeddings of records, search queries and prompt-hook prompts: apps/cloud/src/lib/memory/embed.ts;
 *   search.ts; apps/cloud/src/lib/memory/prompt-recall.ts; embedding-client.ts
 * - claude-code provider refuses on Vercel: apps/cloud/src/lib/llm/claude-code-provider.ts
 * - Google for Google sign-in: actions.ts
 *
 * What you can delete
 * - Retention: no purge rule exists; data stays until the user deletes it (maintainer answer 2026-10-12).
 * - Delete account cascades every user row: apps/cloud/src/app/api/account/delete/route.ts;
 *   Settings control: apps/cloud/src/app/(dashboard)/settings/settings-view.tsx
 * - Revoke a device key: apps/cloud/src/app/api/keys/devices/[id]/route.ts
 * - Export = profile, chat conversations, accepted chat memories (no coding sessions):
 *   apps/cloud/src/app/api/account/export/route.ts
 * - No route deletes one session or one record (the only DELETE handler is api/mcp/route.ts); blocker
 *   "Ignore" retires a record: apps/cloud/src/lib/memory/blocker-dismiss.ts
 *
 * Run it fully local
 * - `membral local up`, Docker, loopback-only ports: README.md, packages/cli/src/local-stack.ts
 * - Only model calls leave; claude-code uses your Claude login; Ollama; no model = no extraction:
 *   README.md; docs/SELF-HOSTING.md
 *
 * Cookies
 * - Supabase auth cookies: apps/cloud/src/middleware.ts
 * - membral_theme: apps/cloud/src/lib/theme.ts; membral_tz: apps/cloud/src/lib/util/timezone.ts
 *
 * README link: apps/cloud/src/app/_landing/content.ts (REPO_URL)
 * Contact: apps/cloud/src/lib/contact.ts
 */
import type { Metadata } from "next";
import { REPO_URL } from "../_landing/content";
import { LandingFooter, LandingNav } from "../_landing/sections";
import { getContactEmail } from "@/lib/contact";
import { code, H3, Section, textLink } from "../_legal/parts";

export const metadata: Metadata = {
  title: "Privacy Policy — Membral",
  description: "How Membral handles your data",
};

export default function PrivacyPage() {
  const contact = getContactEmail();
  return (
    <main className="min-h-screen bg-canvas text-ink">
      <LandingNav />
      <article className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-16">
        <p className="section-label">Privacy</p>
        <h1 className="mt-2 text-h1 tracking-tight text-ink">Privacy Policy</h1>
        <p className="mt-2 text-body-sm text-muted">Last updated: 2026-10-20</p>

        <p className="mt-6 text-lead text-ink-2">
          This page says what Membral sends off your machine, what it keeps, where that lives and who else
          handles it. It covers the hosted service at membral.me, the <code className={code}>membral</code> CLI
          and the Chrome extension. See also the{" "}
          <a href="/terms" className={textLink}>
            Terms of Service
          </a>
          .
        </p>

        <Section id="collect" title="What we collect">
          <H3>Your account</H3>
          <p>
            Hosted accounts are existing-only; new sign-ups are closed, and local mode needs no account. For an existing account, we hold your email address, and you sign in with a password, which Supabase Auth handles, or with Google.
          </p>

          <H3>Coding sessions</H3>
          <p>
            When a session ends, or when you run <code className={code}>membral sessions</code>, the CLI
            uploads the transcripts of the coding agents it supports (Claude Code, opencode, Copilot, Codex and
            others). For each session it keeps:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>what you typed and what the agent wrote back, including its reasoning text when the transcript holds it;</li>
            <li>which tools the agent called and which files it touched;</li>
            <li>
              text the agent wrote into files, up to 8,000 characters per write (the text an edit replaced is
              not kept);
            </li>
            <li>short digests of git, gh, glab and test-runner commands;</li>
            <li>
              the repo path, git remote URL and branch, start and end times, the models used, token counts, and
              which sub-agents ran.
            </li>
          </ul>
          <p>
            By default only the last 30 days are uploaded. Older sessions go up only if you ask with{" "}
            <code className={code}>--all</code> or <code className={code}>--since</code>.
          </p>
          <p>
            At setup you choose which projects sync; the choice is saved in{" "}
            <code className={code}>~/.membral/sync.json</code>. A project you switch off is skipped. A project
            that is not in the list yet syncs by default, unless you set{" "}
            <code className={code}>defaultNewProjects</code> to false.
          </p>

          <H3>Prompts, for recall</H3>
          <p>
            Before each Claude Code prompt of four or more words, a hook sends the first 2,000 characters of the
            prompt to the server, which looks up past records about it. The prompt text is not stored. The
            hook&apos;s local log, <code className={code}>~/.membral/hook.log</code>, never holds the prompt.
          </p>
          <p>
            When your agent searches with <code className={code}>memory_search</code>, the server stores the
            search text and which records it returned.
          </p>

          <H3>Chats</H3>
          <p>
            If you use the Chrome extension or <code className={code}>membral import</code>, your ChatGPT and
            Claude.ai conversations are uploaded too.
          </p>

          <H3>No analytics</H3>
          <p>The web app includes no analytics or tracking library.</p>
        </Section>

        <Section id="not-kept" title="What we do not keep">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              The output of the tools the agent ran (file reads, command output) is dropped before upload, for
              every supported agent. Only whether the call succeeded is kept.
            </li>
            <li>
              Shell commands other than git, gh, glab and test runners are not kept, only the tool name.
            </li>
            <li>
              Text shaped like a key, token or password is replaced with{" "}
              <code className={code}>[REDACTED]</code> before it is stored. This works by known patterns, so a
              secret in an unusual shape can get through.
            </li>
            <li>
              When the agent writes to a file that looks like a secret store (<code className={code}>.env</code>,
              private keys, <code className={code}>.npmrc</code>, <code className={code}>.netrc</code>,
              credentials files and similar), no text is kept, only the path.
            </li>
            <li>Phone numbers and email addresses are removed from the records extracted from your sessions.</li>
            <li>API keys are stored only as a SHA-256 hash.</li>
            <li>
              The Chrome extension reads your claude.ai and chatgpt.com session cookies only to fetch your
              conversations from those sites. Its sync code does not send them to Membral.
            </li>
          </ul>
        </Section>

        <Section id="stored" title="Where it is stored">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              In a hosted Postgres database on Supabase. Tables have row-level security, so a signed-in account
              can read only its own rows. Server code that reads with the database&apos;s admin key filters by
              your account id.
            </li>
            <li>
              We run the service and hold that admin key, so we can technically read stored data. Nothing in the
              product shows your data to another account.
            </li>
            <li>The Supabase database is deployed in Singapore.</li>
            <li>
              The web app and its API run on Vercel. Their functions have been observed running in
              Vercel&apos;s Singapore region (<code className={code}>sin1</code>).
            </li>
            <li>
              Each API key or device key belongs to one account, and a key can be limited to one code project.
            </li>
          </ul>
        </Section>

        <Section id="processors" title="Who processes it">
          <dl className="divide-y divide-line-soft rounded-card border border-line bg-surface">
            <Processor name="Supabase">Hosts the database and handles sign-in.</Processor>
            <Processor name="Vercel">Hosts the web app and the API.</Processor>
            <Processor name="OpenRouter">
              Today, on membral.me, the server sends model calls through OpenRouter: session text goes to a
              Google Gemma model to extract decisions and findings, and record text, search text and recall
              prompts go through the same OpenRouter key to build embeddings for search and to answer chat. You
              set up no key. Extraction is on by default for every account and covers sessions from the last 30
              days. The operator may change providers, and this page is updated when that happens. Running
              extraction through a Claude Code login is refused on the hosted service. If you run Membral
              yourself, you choose the model provider (see &quot;Run it fully local&quot;).
            </Processor>
            <Processor name="Google">Only if you choose to sign in with Google.</Processor>
          </dl>
        </Section>

        <Section id="delete" title="What you can delete">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="font-medium text-ink">Your account.</strong> In{" "}
              <a href="/settings" className={textLink}>
                Settings
              </a>
              , &quot;Delete my account&quot; deletes the account and every row tied to it. This cannot be
              undone.
            </li>
            <li>
              <strong className="font-medium text-ink">A device key.</strong> Revoke it in Settings.
            </li>
            <li>
              <strong className="font-medium text-ink">Export.</strong> &quot;Export my data&quot; in Settings
              gives an NDJSON file with your profile, your chat conversations and the memories taken from them.
            </li>
          </ul>
          <p className="mt-4">Not available yet:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>Deleting one coding session or one extracted record. Only deleting the whole account removes them.</li>
            <li>Exporting your coding sessions or the records extracted from them.</li>
          </ul>
          <p>
            Retention: your data is kept until you delete it. Deleting your account deletes your data. There is
            no automatic deletion after a number of days yet.
          </p>
          <p>
            Switching a project off in <code className={code}>~/.membral/sync.json</code> stops future uploads;
            what was already uploaded stays until you delete the account.
          </p>
        </Section>

        <Section id="local" title="Run it fully local">
          <p>
            <code className={code}>membral local up</code> runs the whole service in Docker on your machine,
            with its ports open only on 127.0.0.1. Nothing leaves the machine except the calls extraction makes
            to the model you choose:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              your Claude Code login (<code className={code}>claude-code</code>): session text goes to Anthropic
              under your own account;
            </li>
            <li>a hosted model with your own API key: session text goes to that provider;</li>
            <li>a local Ollama model: nothing leaves your machine;</li>
            <li>no model: import, session pages, keyword search and MCP still work, and nothing is extracted.</li>
          </ul>
          <p>
            The setup is in the{" "}
            <a href={`${REPO_URL}#run-it-locally`} className={textLink}>
              README
            </a>
            .
          </p>
        </Section>

        <Section id="cookies" title="Cookies">
          <ul className="list-disc space-y-2 pl-5">
            <li>Supabase Auth cookies keep you signed in.</li>
            <li>
              <code className={code}>membral_theme</code> remembers your light, dark or system choice.
            </li>
            <li>
              <code className={code}>membral_tz</code> remembers your time zone, so dates show in your local
              time.
            </li>
          </ul>
          <p>No tracking or advertising cookies.</p>
        </Section>

        <Section id="contact" title="Contact">
          <p>
            Questions:{" "}
            <a href={`mailto:${contact}`} className={textLink}>
              {contact}
            </a>
            .
          </p>
        </Section>
      </article>
      <LandingFooter />
    </main>
  );
}

function Processor({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-5 py-3 sm:grid sm:grid-cols-4 sm:gap-4">
      <dt className="section-label">{name}</dt>
      <dd className="mt-1 sm:mt-0 sm:col-span-3 text-body text-ink-2">{children}</dd>
    </div>
  );
}
