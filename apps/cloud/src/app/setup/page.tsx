import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { getContactEmail } from "@/lib/contact";
import { getAppUrl } from "@/lib/env";
import { installCommand } from "@/lib/install-command";
import { CopyCommand } from "./copy-command";

// /setup — public, no auth required (src/middleware.ts's publicExactPaths),
// same visual language as the landing page (app/page.tsx). Issue #127
// (onboarding audit A1-A4): the ONE place a stranger on a public deployment
// can self-serve the extension download, the CLI's install
// command, and the MCP config — linked from the landing page, the sidebar
// footer, and every empty state that used to dead-end on
// `npx @membral/cli setup` / `membral start`.
//
// Round-3 review HIGH 11: this page used to `existsSync` the zip itself at
// RENDER time, with a comment claiming that was deliberate ("checked at
// request/render time, not assumed"). That was only ever correct by
// accident — this component has no `dynamic`/`revalidate` export and
// touches no dynamic API, so Next prerenders it once at BUILD time (right
// after `prebuild` writes the zip), and the existsSync call happens to run
// in that build environment where `public/downloads/` really is on disk.
// If anything ever forced this page dynamic, Vercel would run it inside a
// serverless function whose filesystem does NOT include `public/` (that's
// served straight from the CDN) — existsSync would return false forever,
// even on a deploy that shipped a working zip, with no error anywhere.
// `dynamic = "force-static"` below pins the build-time evaluation
// explicitly (so this can never silently regress), and the availability
// fact itself now comes from `public/downloads/manifest.json` — written by
// scripts/package-extension.mjs at the SAME build-time moment, not probed
// from this component at all.
export const dynamic = "force-static";

interface DownloadsManifest {
  available: boolean;
  builtAt: string | null;
  cloudUrl: string | null;
}

function readDownloadsManifest(): DownloadsManifest {
  const manifestPath = join(process.cwd(), "public", "downloads", "manifest.json");
  try {
    if (!existsSync(manifestPath)) return { available: false, builtAt: null, cloudUrl: null };
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return {
      available: parsed?.available === true,
      builtAt: typeof parsed?.builtAt === "string" ? parsed.builtAt : null,
      cloudUrl: typeof parsed?.cloudUrl === "string" ? parsed.cloudUrl : null,
    };
  } catch {
    // A missing/malformed manifest (e.g. a checkout that never ran
    // `prebuild`) degrades to "not available" — same as the zip genuinely
    // being absent — never a build failure over a download-page detail.
    return { available: false, builtAt: null, cloudUrl: null };
  }
}

export default async function SetupPage() {
  const extensionZipAvailable = readDownloadsManifest().available;
  const contact = getContactEmail();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <nav className="border-b border-line-soft bg-canvas">
        <div className="mx-auto max-w-3xl flex items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-bold">
            Membral
          </Link>
          <Link href="/login" className="text-sm text-muted hover:text-ink transition-colors">
            Sign in
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-6 py-16 space-y-16">
        <div>
          <h1 className="text-4xl font-bold tracking-tight mb-3">Set up Membral</h1>
          <p className="text-muted text-lg">
            Claude Code users: install the plugin. Other harnesses, or no plugin: install the CLI.
            The Chrome extension syncs ChatGPT and Claude.ai chats.
          </p>
        </div>

        {/* 1. Claude Code plugin */}
        <section className="space-y-4" id="plugin">
          <h2 className="text-2xl font-semibold">1. Claude Code plugin</h2>
          <p className="text-muted">
            Needs Node 22.5 or newer on your PATH. The plugin hooks run Node, and without it every session
            shows a hook error.
          </p>
          <ol className="space-y-4 rounded-card border border-line bg-surface p-6 text-sm text-ink">
            <li className="space-y-2">
              <p>
                Sign in to your Membral server (an existing account, or your local one), then open{" "}
                <Link href="/settings#keys" className="text-accent hover:underline">
                  Settings, Keys
                </Link>{" "}
                and click Generate API Key. Copy the key.
              </p>
            </li>
            <li className="space-y-2">
              <p>Inside Claude Code, add the marketplace:</p>
              <CopyCommand command="/plugin marketplace add surajtripathy07/membral-plugin" />
            </li>
            <li className="space-y-2">
              <p>Install the plugin. It asks for your API key and masks it:</p>
              <CopyCommand command="/plugin install membral@membral" />
            </li>
          </ol>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Or from your shell</h3>
            <CopyCommand command="claude plugin marketplace add surajtripathy07/membral-plugin" />
            <CopyCommand command="claude plugin install membral@membral --config api_key=<your key>" />
            <p className="text-sm text-muted">This form leaves your key in your shell history.</p>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">What happens next</h3>
            <ul className="space-y-2 rounded-card border border-line bg-sunken p-4 text-sm text-muted">
              <li>On your first session, the last 30 days of Claude Code and opencode sessions import in the background.</li>
              <li>Every session is saved when it ends, including sessions you end with ctrl+c.</li>
              <li>If a session&apos;s upload fails, the plugin catches up once a day.</li>
              <li>
                Your agent can call <code className="font-mono text-xs text-ink">memory_search</code> and{" "}
                <code className="font-mono text-xs text-ink">memory_recall</code>.
              </li>
            </ul>
          </div>
        </section>

        {/* 2. Chrome extension */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">2. Chrome extension</h2>
          <p className="text-muted">
            Syncs your ChatGPT and Claude.ai conversations into Membral automatically.
          </p>
          <p className="text-sm text-muted">
            Not on the Chrome Web Store — load it unpacked instead; it takes under a minute.
          </p>
          {extensionZipAvailable ? (
            <a
              href="/downloads/membral-extension.zip"
              className="inline-flex items-center gap-2 bg-accent text-accent-ink hover:opacity-90 px-6 py-2.5 rounded-sm text-sm font-medium transition-colors"
            >
              Download membral-extension.zip
            </a>
          ) : (
            <p className="rounded-sm border border-line bg-sunken px-4 py-3 text-sm text-muted">
              Download not available on this deployment — the extension zip wasn&apos;t built for this
              deploy. Ask whoever runs this deployment to set{" "}
              <code className="rounded bg-sunken px-1 py-0.5 font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
              <code className="rounded bg-sunken px-1 py-0.5 font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>,
              and <code className="rounded bg-sunken px-1 py-0.5 font-mono text-xs">NEXT_PUBLIC_APP_URL</code> and
              rebuild.
            </p>
          )}
          <ol className="space-y-4 text-left rounded-card border border-line bg-surface p-6 mt-2">
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                1
              </span>
              <p className="text-sm text-ink-2">
                Download the zip above and unzip it somewhere you&apos;ll keep it (it needs to stay
                put — Chrome loads it from that folder).
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                2
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink-2 mb-2">
                  Open Chrome&apos;s extensions page and turn on <span className="font-medium text-ink">Developer mode</span> (top right)
                </p>
                <div className="rounded-sm bg-sunken border border-line p-2.5 font-mono text-xs">
                  <span className="text-accent">chrome://extensions</span>
                </div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                3
              </span>
              <p className="text-sm text-ink-2">
                Click <span className="font-medium text-ink">Load unpacked</span> and select the
                unzipped folder.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                4
              </span>
              <p className="text-sm text-ink-2">
                Click the Membral icon, sign in with the same account you use here. The cloud
                URL is already preset to this site — nothing to configure.
              </p>
            </li>
          </ol>
        </section>

        {/* 3. CLI */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">3. Command-line tool</h2>
          <p className="text-muted">
            Use this for opencode, Copilot, Codex, or Claude Code without the plugin. Setup finds the harnesses
            on your machine and wires hooks and MCP for each.
          </p>
          <CopyCommand command={installCommand(getAppUrl())} />
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink-2">What happens next</h3>
            <ol className="space-y-2 text-sm text-ink-2 list-decimal list-inside rounded-card border border-line bg-surface p-6">
              <li>Your browser opens so you can approve this device.</li>
              <li>
                Setup scans this machine for Claude Code, Codex, opencode and Copilot CLI sessions and asks
                what to sync.
              </li>
              <li>Session hooks are installed for the coding harnesses it finds.</li>
              <li>Your agent is connected to Membral over MCP.</li>
              <li>Your existing sessions are imported.</li>
            </ol>
          </div>
          <p className="text-sm text-muted">
            To check it worked, run{" "}
            <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink-2">membral status</code>. To
            update later, run the install command again.
          </p>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">GitHub Copilot</h3>
            <ul className="space-y-2 rounded-card border border-line bg-sunken p-4 text-sm text-muted">
              <li>
                Plain <code className="font-mono text-xs text-ink">membral setup</code> covers Copilot CLI and VS
                Code in every repo: hooks, the MCP server and a short instructions file.
              </li>
              <li>
                Optional: <code className="font-mono text-xs text-ink">membral setup --copilot</code> inside a repo
                also commits <code className="font-mono text-xs text-ink">.vscode/mcp.json</code> and{" "}
                <code className="font-mono text-xs text-ink">.github/copilot-instructions.md</code> for teammates.
              </li>
            </ul>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Codex CLI</h3>
            <ul className="space-y-2 rounded-card border border-line bg-sunken p-4 text-sm text-muted">
              <li>
                Plain <code className="font-mono text-xs text-ink">membral setup</code> writes the Membral MCP server
                into <code className="font-mono text-xs text-ink">~/.codex/config.toml</code> (no key in the file), a
                SessionStart hook for the preamble, and a short marked block in{" "}
                <code className="font-mono text-xs text-ink">~/.codex/AGENTS.md</code> that tells Codex to call{" "}
                <code className="font-mono text-xs text-ink">memory_search</code> first.
              </li>
              <li>
                Codex asks you to approve the hook once. Until you do, the AGENTS.md rule still gives recall.
              </li>
            </ul>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">opencode</h3>
            <ul className="space-y-2 rounded-card border border-line bg-sunken p-4 text-sm text-muted">
              <li>The plugin injects the preamble into the system prompt at session start.</li>
            </ul>
          </div>
        </section>

        {/* 4. MCP */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">4. MCP (Claude Desktop, Claude Code, Cursor)</h2>
          <p className="text-muted">
            Lets an AI assistant search and read your synced conversations directly, instead of you
            copy-pasting context by hand. Fully self-service, no build step:
          </p>
          <ol className="space-y-2 text-sm text-ink-2 list-decimal list-inside rounded-card border border-line bg-surface p-6">
            <li>
              Sign in and open{" "}
              <Link href="/settings" className="text-accent hover:underline">
                Settings
              </Link>
              .
            </li>
            <li>Under API Key, click Generate API Key.</li>
            <li>Copy the MCP config snippet for your client and paste it into that app&apos;s config file.</li>
          </ol>
          <p className="text-sm text-muted">
            Search and conversation tools work right away. The identity/context tools that read
            extracted memories stay empty until memory extraction is enabled for your account —
            email {contact} to ask.
          </p>
        </section>
      </main>
    </div>
  );
}
