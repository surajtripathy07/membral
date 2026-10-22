# Membral plugin for Claude Code and Antigravity (agy)

Your coding agent can answer from what your past sessions found.

This plugin connects Claude Code and Antigravity to Membral. It carries its own copy of the Membral CLI, so there is nothing else to
install. It adds:

- **SessionStart:** fetches a short memory preamble for the current repo and hands it to Claude as context (4 s
  budget). In the background it also uploads your last 30 days of sessions: once on the first session after install,
  then a catch-up at most once a day. For plugin-only users the catch-up does the job of the CLI's 20-minute backstop
  sweep: a session whose SessionEnd upload was missed is picked up within a day.
- **SessionEnd:** hands the transcript of the session that just ended to a background child process, which uploads
  it after Claude Code exits, and returns in well under a second. The entry sets `"timeout": 10` because Claude Code
  otherwise cancels SessionEnd hooks after 1.5 s.
- **MCP server `membral`** at `https://membral.me/api/mcp`, so Claude can search and recall your past sessions.

The hooks run `node`. Without Node on the `PATH` Claude Code sees, every session shows a hook error: install Node.js
22.5 or newer.

### Antigravity

The same directory is also an Antigravity plugin: `plugin.json`, `hooks.json` and `mcp_config.json` at the root are
Antigravity's files; Claude Code reads only `.claude-plugin/`, `hooks/hooks.json` and `.mcp.json`. The Antigravity
hooks run on `PreInvocation` (preamble) and `Stop` (session upload) and call the same bundled CLI. Antigravity has no
plugin options, so the key comes from `MEMBRAL_API_KEY` in your environment, or, if unset, from
`~/.membral/credentials.json` (`membral login`). Antigravity's MCP file documents only stdio and bare-URL servers, so
`mcp_config.json` bridges through `mcp-remote` and reads the bearer from `MEMBRAL_AUTH_HEADER`
(`export MEMBRAL_AUTH_HEADER="Bearer <your key>"`). Antigravity's docs define no header or variable substitution for plugin MCP entries,
so the plugin cannot supply that variable itself, and the key must not be written into this tracked file. Without it the MCP server
fails to authenticate (the PreInvocation hook prints a warning to stderr when it is unset). `membral setup --agy` avoids the
requirement by writing a user-level entry with the key in an `env` block (file mode 0600). Antigravity runs each hook with its
working directory set to the directory that holds `hooks.json` (its hooks docs), so `hooks.json` uses the relative
`node scripts/run.mjs ...`; keep that file and `scripts/` together. If you ran `membral setup`, its `~/.gemini/config/hooks.json`
entry wins and the plugin's hooks stand down, so nothing runs twice.

Membral remembers what your sessions did, decided and found, even a few hours ago. It is not a live view of your forge: it hands Claude the PR or issue, and Claude checks its current state live.

## Install

Create an API key at [membral.me/settings](https://membral.me/settings). Then, inside Claude Code:

```
/plugin marketplace add surajtripathy07/membral-plugin
/plugin install membral@membral
```

The install dialog asks for your API key and masks it as you paste.

From a shell instead (this puts the key in your shell history):

```sh
claude plugin marketplace add surajtripathy07/membral-plugin
claude plugin install membral@membral --config api_key=<your key from membral.me/settings>
```

Restart Claude Code. Check with `claude plugin list` and `claude mcp list` (the server shows as
`plugin:membral:membral`). To change the key later: `claude plugin configure membral@membral`.

The key is stored by Claude Code as a sensitive plugin option. The hooks pass it to the bundled CLI as
`MEMBRAL_API_KEY` and always talk to `https://membral.me`. If no key is set, both hooks print one line to stderr and
exit 0, so your session is never blocked.

Background uploads log to `import.log` in the plugin's data directory. Delete `first-import.done` and
`last-import.json` there to run the first import again.

## If you already ran `membral setup`

`membral setup` writes the same two hooks into `~/.claude/settings.json` and a user-scoped MCP server named `membral`.
While those hooks are present and the CLI they point at still exists, the plugin's hooks do nothing, so each session
is uploaded once. A `membral setup` run after the plugin is installed at user scope (and enabled) sees it and skips
writing Claude Code hooks and MCP.

To move fully to the plugin, remove what an earlier setup wrote:

```sh
membral install-session-hook --remove
claude mcp remove membral --scope user
```

## Without the plugin

Install the CLI and let it configure Claude Code (and Antigravity, Codex, opencode and Copilot) for you:

```sh
npm i -g https://membral.me/membral-cli.tgz
membral setup
```

## Uninstall

```sh
claude plugin uninstall membral@membral
claude plugin marketplace remove membral
```

This removes the hooks and the MCP server. Your uploaded sessions stay in your Membral account.
