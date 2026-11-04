# membral

Your coding agent can answer from what your past sessions found. This is the Membral command line.

```
npx membral local up
```

## Prerequisites

- Node 22.5 or newer
- Docker with Compose 2.23 or newer (`up` starts Postgres, PostgREST and the Membral app)
- Optional: Ollama, for local extraction or embeddings (`--embeddings ollama`)

Put one extraction model choice in `~/.membral/local/.env` before `up`; see the repo README.

## Commands

- `npx membral local up` starts the local stack and prints a sign-in URL, password and API key (treat as secret).
- `npx membral local status` checks it.
- `npx membral mcp` runs the MCP server over stdio for clients that need it.

Run `npx membral --help` for the rest.

Source, docs and self-hosting guide: https://github.com/surajtripathy07/membral
