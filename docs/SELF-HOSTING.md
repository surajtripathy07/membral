# Run Membral locally

Membral on your machine, in Docker. Nothing leaves the machine unless you set an LLM key or use your
Claude login, and then only model calls go to that provider (the Claude login path also downloads Claude Code
from npm once, see below). The short version is in the
[README](../README.md#run-it-locally); this is the full guide.

**You need** Docker (Docker Desktop, Colima, or Linux Docker with Compose 2.23 or newer) and Node 22.5 or
newer. The CLI and its hooks run on Node.

**Disk.** Give the Docker VM at least 40 GiB. In a cold-machine run, a 20 GiB Colima VM (the default) was 100%
full after the image build and the stack could not start: Postgres failed with "No space left on device". The
log did not give a minimum, so 40 GiB is a conservative choice, not a measured floor. Check free space with
`docker system df`. Docker Desktop: Settings, Resources, Virtual disk limit. Colima: stop it and start it with a
larger disk (`colima stop && colima start --disk 40`; for an existing VM the disk can grow but not shrink).
If `up` says "Database or auth did not become healthy", run `membral local logs db` first: a full disk
shows up there, while the message points at the auth log.

## 1. Install the CLI

```
npm i -g https://membral.me/membral-cli.tgz
```

## 2. Pick how extraction runs (before the first `up`)

Without an LLM, import, session pages, keyword search and MCP work, but no memories are extracted
(decisions, learnings, outcomes). `up` ends with "Extraction is off" in that case, and you would need a
second `up` after adding one. Put your choice in `~/.membral/local/.env` first (create the folder with
`mkdir -p ~/.membral/local`); `up` reads it on the first run.

An API key (any one of `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`):

```
OPENAI_API_KEY=sk-...
```

Your Claude login, local only. Run `claude setup-token` and paste the token:

```
CLAUDE_CODE_OAUTH_TOKEN=...
MEMBRAL_LLM_PROVIDER=claude-code
```

Calls count against your Claude plan and are recorded at $0. The hosted app never runs this provider. It does
not do embeddings, so add Ollama or a key for those.

The Membral image does not include Claude Code. With this provider, the app's first start downloads Claude Code
from npm onto your machine (a pinned version, unmodified, into the `membral-local-claude-cli` Docker volume),
under Anthropic's terms, and later starts reuse it. The download is about 110 MB (about 235 MB on disk) and the app answers only
after it ends or gives up: it is capped at 4 minutes, inside the 5 minutes `membral local up` waits for the app.
Claude Code runs only on your machine, with your own
`claude setup-token` login. Membral is not affiliated with or endorsed by Anthropic. If the download fails
(offline, registry down, or slower than the cap), the app still starts, `membral local logs app` shows
"Claude Code could not be downloaded from npm", `membral local status` prints "Extraction is off" with that
reason, and extraction with this provider is off; fix the network and run
`docker restart membral-app-1` to retry.

Ollama, offline. Run `ollama pull qwen2.5:7b` and `ollama pull nomic-embed-text` first, then make sure Ollama
runs with a context window of at least 16k tokens (see below).

```
MEMBRAL_MODEL_BASE_URL=http://host.docker.internal:11434/v1
MEMBRAL_MODEL=qwen2.5:7b
MEMBRAL_EMBEDDINGS_BASE_URL=http://host.docker.internal:11434/v1
MEMBRAL_EMBEDDING_MODEL=nomic-embed-text
```

Ollama's default context of 4,096 tokens cuts off the start of the extraction prompt (about 4,300 tokens), and
the model then answers in the wrong JSON shape, so no memories are saved. Nothing in `up` or `status` says so;
the only trace is `json_parse_failed` in `membral local logs app`. Model size matters: qwen2.5:7b stored
the planted decision as a lasting memory and found it again; qwen2.5:3b extracted it but marked it session-only, so
search returned nothing, with no warning. Use a 7B or larger model, or the `claude-code` provider above. Calls to a model on this machine are recorded at $0.

- **Ollama not running yet (macOS):** `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`.
- **Ollama already running (the macOS app, or a service):** it keeps the context it started with, and a second
  `ollama serve` cannot take port 11434. Leave it alone and start a second instance on another port:
  `OLLAMA_HOST=127.0.0.1:11500 OLLAMA_CONTEXT_LENGTH=16384 ollama serve`. Models are shared on disk. Use
  `OLLAMA_HOST=127.0.0.1:11500 ollama pull ...` for pulls, and point both base URLs in `.env` at port 11500
  (`MEMBRAL_MODEL_BASE_URL=http://host.docker.internal:11500/v1` and `MEMBRAL_EMBEDDINGS_BASE_URL` the same).
- **Linux:** set it in the systemd override shown below and run `sudo systemctl restart ollama`. Do not start
  `ollama serve` by hand: it binds `127.0.0.1`, and the containers cannot reach it.

## 3. Start it

```
membral local up
```

`up` starts the stack (Postgres, auth, data API, a gateway, the app), makes its keys, applies the migrations,
creates one local user and an API key, saves and activates the `local` profile, and sets up the hooks and MCP.
A second run changes nothing. The app is on `127.0.0.1:3000` and the gateway on `127.0.0.1:54421`, loopback
only. Use `--port` and `--gateway-port` to change them.

`up` prints the new API key and, when `claude` is not on your PATH, a `claude mcp add-json` line that contains
it as a Bearer token. Treat that terminal output as a secret (do not paste it into a ticket or a recording).

**Sign in** at the printed URL with `you@membral.local` and the password printed once.
`membral local status --show-password` prints it again.

## The image

`up` pulls the app image from `ghcr.io/surajtripathy07/membral-cloud:main`. To run from source instead, build
the image from a clone of this repo and point `up` at it. If the pull fails and the image exists locally, `up`
uses the local copy and prints "pull failed, using the local copy".

```
git clone https://github.com/surajtripathy07/membral.git && cd membral
docker build -f apps/cloud/Dockerfile -t membral-cloud:dev .
membral local up --image membral-cloud:dev
```

`MEMBRAL_IMAGE` works the same way as `--image`, and `up` remembers the last one in `~/.membral/local/.env`.

The image contains no Claude Code; the `claude-code` provider downloads it on first start (section 2).

## On Linux (Ubuntu 22.04/24.04)

- Node: apt ships an older Node. Install Node 22 from NodeSource or with nvm.
- Docker: install Docker Engine and the `docker-compose-plugin` from Docker's apt repository. Check
  `docker compose version`; it must be 2.23 or newer.
- Run Docker without sudo: `sudo usermod -aG docker $USER`, then log out and back in.
- Ollama: the app container reaches the host as `host.docker.internal`, which Docker maps to the
  docker bridge, `172.17.0.1` on a default Docker Engine (`ip -4 addr show docker0` shows it). Bind
  Ollama there: run `sudo systemctl edit ollama`, add the two lines below (the second one is the 16k
  context window that extraction needs), then `sudo systemctl restart ollama`.

```
[Service]
Environment="OLLAMA_HOST=172.17.0.1"
Environment="OLLAMA_CONTEXT_LENGTH=16384"
```

- Ollama then no longer answers on `127.0.0.1`; use `OLLAMA_HOST=172.17.0.1 ollama pull ...` from your
  shell.
- With ufw enabled, allow the containers to reach Ollama, or the app cannot connect:
  `sudo ufw allow from 172.16.0.0/12 to 172.17.0.1 port 11434 proto tcp`.
  `OLLAMA_HOST=0.0.0.0` also works, but it listens on every interface: use the same allow rule and
  also deny port 11434 from your LAN (for example `sudo ufw deny from 192.168.0.0/16 to any port 11434 proto tcp`,
  inserted after the allow rule; adjust the range to your network). A bare `ufw deny 11434` is not enough, because it
  would block the containers too.
- The backstop sweep runs from a systemd user timer (`systemctl --user list-timers`), or from your
  crontab when user systemd is not available. `membral sweep --remove` takes it out.
- The systemd timer runs only while you are logged in; for headless machines run:
  `sudo loginctl enable-linger $USER`. With cron, the cron daemon must be running
  (`sudo service cron start`).

## Embeddings

Vector columns are 1,536 wide. Smaller models get zero-padded, and cosine similarity stays the same. Any model
of 1,536 dimensions or fewer fits: `nomic-embed-text` (768), `mxbai-embed-large` (1024),
`text-embedding-3-small` (1536). A store holds one embedding model. Switching later needs a re-embed, and that
is not built yet, so pick before you import much. The relevance floor is off for non-OpenAI models unless you
set `MEMBRAL_EMBEDDING_MIN_SIMILARITY`.

## Every day

```
membral local status        # service health and sign-in details
membral local logs app -f   # db, auth, rest, gateway or app; -f follows
membral local down          # stop, keep your data
membral local down --wipe   # stop and delete the database (asks first; --yes skips)
```

`down --wipe` deletes the database volume and the downloaded Claude Code volume (the next start downloads it
again) but keeps `~/.membral/local/.env` (your LLM settings and the stored
image). To start completely clean, delete that folder too.
