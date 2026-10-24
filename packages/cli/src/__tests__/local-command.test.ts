// `membral local up|down|status|logs` against a fake Docker runner and a
// fake fetch. Nothing touches real Docker, the real HOME or the network.
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfiles, profileNameForUrl, saveProfiles } from "../credentials.js";
import type { DockerRunner, DockerRunOptions } from "../docker-runner.js";
import {
  acquireUpLock,
  defaultIsPortFree,
  EXTRACTION_OFF_LINE,
  type LocalDeps,
  localDown,
  localLogs,
  localStatus,
  localUp,
  migrationVersion,
} from "../local-command.js";
import { KICK_INTERVAL_S, kickerScript, localPaths, parseEnv, renderCompose, signSupabaseJwt } from "../local-stack.js";

interface Call {
  args: string[];
  opts?: DockerRunOptions;
}

const MIGRATIONS: Record<string, string> = {
  "001_conversations.sql": "create table t1 (id int);",
  "002_rls_policies.sql": "create table t2 (id int);",
};

function makeFakeDocker(
  opts: {
    versionCode?: number;
    versionStderr?: string;
    composeCode?: number;
    composeVersion?: string;
    volumeExists?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const applied = new Set<string>();
  const running = new Map<string, number[]>(); // service -> published ports
  const runner: DockerRunner = {
    async run(args, o) {
      calls.push({ args, opts: o });
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (args[0] === "version")
        return { code: opts.versionCode ?? 0, stdout: "27.0", stderr: opts.versionStderr ?? "boom" };
      if (args[0] === "compose" && args[1] === "version")
        return { code: opts.composeCode ?? 0, stdout: `${opts.composeVersion ?? "2.29.1"}\n`, stderr: "" };
      if (args[0] === "create") return ok("cid123\n");
      if (args[0] === "volume") return { code: opts.volumeExists ? 0 : 1, stdout: "", stderr: "no such volume" };
      if (args[0] === "cp") {
        const dest = args[2];
        mkdirSync(dest, { recursive: true });
        for (const [f, body] of Object.entries(MIGRATIONS)) writeFileSync(join(dest, f), body);
        return ok();
      }
      if (args[0] !== "compose") return ok();
      const sub = args.slice(7);
      if (sub[0] === "ps") {
        return ok(
          [...running.entries()]
            .map(([svc, ports]) =>
              JSON.stringify({
                Service: svc,
                State: "running",
                Health: "healthy",
                Publishers: ports.map((p) => ({ PublishedPort: p })),
              }),
            )
            .join("\n"),
        );
      }
      if (sub[0] === "up") {
        for (const svc of sub.filter((s) => ["db", "auth", "rest", "gateway", "app", "kicker"].includes(s))) {
          running.set(svc, svc === "app" ? [3000] : svc === "gateway" ? [54421] : []);
        }
        return ok();
      }
      if (sub[0] === "exec") {
        const joined = sub.join(" ");
        if (joined.includes("select version")) return ok([...applied].join("\n"));
        if (sub.includes("-f") && o?.input) {
          const m = /values \('([^']+)'/.exec(o.input);
          if (m) applied.add(m[1]);
        }
        return ok();
      }
      return ok();
    },
  };
  return { runner, calls, applied, running };
}

interface FetchState {
  userExists: boolean;
  minted: number;
  provisionBodies: Record<string, unknown>[];
  extraction: "on" | "off";
  reason?: string;
}

function makeFetch(state: FetchState): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/health")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          llm: { configured: state.extraction === "on", extraction: state.extraction, reason: state.reason },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/api/internal/local/provision")) {
      const body = JSON.parse(String(init?.body));
      state.provisionBodies.push({ ...body, auth: (init?.headers as Record<string, string>).Authorization });
      const created = !state.userExists;
      state.userExists = true;
      const apiKey = body.mintKey ? `lls_minted_${++state.minted}` : null;
      return new Response(JSON.stringify({ userId: "u-local", email: body.email, created, apiKey }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("membral local", () => {
  let dir: string;
  let logs: string[];
  let errors: string[];
  let docker: ReturnType<typeof makeFakeDocker>;
  let fstate: FetchState;
  let deps: LocalDeps;
  let runSetup: ReturnType<typeof vi.fn>;
  let activate: ReturnType<typeof vi.fn>;
  let validKeys: Set<string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-local-"));
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    docker = makeFakeDocker();
    fstate = { userExists: false, minted: 0, provisionBodies: [], extraction: "off" };
    runSetup = vi.fn(async () => {});
    activate = vi.fn(async () => {});
    validKeys = new Set();
    deps = {
      runner: docker.runner,
      paths: localPaths(join(dir, "local")),
      credentialsPath: join(dir, "credentials.json"),
      fetchImpl: makeFetch(fstate),
      isPortFree: async () => true,
      sleep: async () => {},
      hostname: () => "testhost",
      env: {},
      validateKey: async (_u, k) => ({ status: validKeys.has(k) ? "valid" : "invalid" }),
      runSetup,
      activate,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const out = () => [...logs, ...errors].join("\n");
  const verbs = () =>
    docker.calls.map((c) => (c.args[0] === "compose" ? `compose ${c.args.slice(7).join(" ")}` : c.args.join(" ")));

  it("first up: files, image, fresh migrations, migrate loop, provision with mintKey, profile write + activate + setup", async () => {
    await localUp({}, deps);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();

    const v = verbs();
    const idx = (prefix: string) => v.findIndex((s) => s.startsWith(prefix));
    expect(idx("version")).toBe(0);
    expect(idx("pull ghcr.io/surajtripathy07/membral-cloud:main")).toBeGreaterThan(0);
    expect(idx("create ghcr.io/surajtripathy07/membral-cloud:main")).toBeGreaterThan(idx("pull"));
    expect(v[idx("cp")]).toBe(`cp cid123:/app/migrations ${deps.paths!.migrations}`);
    expect(idx("rm -f cid123")).toBeGreaterThan(idx("cp"));
    const upBase = idx("compose up -d --wait --wait-timeout 300 db auth");
    expect(upBase).toBeGreaterThan(idx("rm -f cid123"));
    const firstMigration = v.findIndex((s, i) => i > upBase && s.includes("-f -"));
    const notify = v.findIndex((s) => s.includes("NOTIFY pgrst"));
    const upRest = idx("compose up -d --wait --wait-timeout 300 rest gateway app");
    expect(firstMigration).toBeGreaterThan(upBase);
    expect(notify).toBeGreaterThan(firstMigration);
    expect(upRest).toBeGreaterThan(notify);

    // compose is always addressed by project, file and env file
    const composeCall = docker.calls.find((c) => c.args[0] === "compose" && c.args[1] !== "version")!;
    expect(composeCall.args.slice(0, 7)).toEqual([
      "compose",
      "-p",
      "membral",
      "-f",
      deps.paths!.compose,
      "--env-file",
      deps.paths!.env,
    ]);

    // migrations in filename order, each in one transaction with its version row
    const migs = docker.calls.filter((c) => c.args.includes("-f") && c.opts?.input);
    expect(migs).toHaveLength(2);
    expect(migs[0].opts!.input).toMatch(/^begin;\ncreate table t1/);
    expect(migs[0].opts!.input).toContain("values ('001', 'conversations', '{}');\ncommit;");
    expect(migs[1].opts!.input).toContain("values ('002', 'rls_policies'");
    expect([...docker.applied]).toEqual(["001", "002"]);

    // provision
    const env = parseEnv(readFileSync(deps.paths!.env, "utf8"));
    expect(fstate.provisionBodies).toEqual([
      {
        email: "you@membral.local",
        password: env.MEMBRAL_LOCAL_PASSWORD,
        deviceName: "local-testhost",
        mintKey: true,
        auth: `Bearer ${env.SERVICE_ROLE_KEY}`,
      },
    ]);

    // profile
    const state = loadProfiles(deps.credentialsPath)!;
    expect(state.activeProfile).toBe("local");
    expect(state.profiles.local).toMatchObject({
      apiUrl: "http://localhost:3000",
      apiKey: "lls_minted_1",
      email: "you@membral.local",
      userId: "u-local",
    });
    expect(runSetup).toHaveBeenCalledWith({ apiUrl: "http://localhost:3000", yes: false, profile: "local" });
    expect(activate).not.toHaveBeenCalled();

    // output: password once, key never, extraction-off line once
    expect(out()).toContain(env.MEMBRAL_LOCAL_PASSWORD);
    expect(out()).not.toContain("lls_minted_1");
    expect(out()).not.toContain(env.SERVICE_ROLE_KEY);
    expect(logs.filter((l) => l === EXTRACTION_OFF_LINE)).toHaveLength(1);

    // modes
    expect(statSync(deps.paths!.env).mode & 0o777).toBe(0o600);
    expect(statSync(deps.paths!.dir).mode & 0o777).toBe(0o700);
  });

  it("second up is a no-op: no new key, no migrations re-applied, files unchanged, no password", async () => {
    await localUp({}, deps);
    const p = deps.paths!;
    const files = [p.env, p.compose];
    const before = files.map((f) => ({ body: readFileSync(f, "utf8"), mtime: statSync(f).mtimeMs }));
    const credsBefore = readFileSync(deps.credentialsPath!, "utf8");
    validKeys.add("lls_minted_1");
    docker.calls.length = 0;
    logs.length = 0;
    runSetup.mockClear();

    await localUp({}, deps);
    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
    expect(fstate.provisionBodies[1]).toMatchObject({ mintKey: false });
    expect(fstate.minted).toBe(1);
    expect(docker.calls.filter((c) => c.args.includes("-f") && c.opts?.input)).toHaveLength(0);
    expect(files.map((f) => ({ body: readFileSync(f, "utf8"), mtime: statSync(f).mtimeMs }))).toEqual(before);
    expect(readFileSync(deps.credentialsPath!, "utf8")).toBe(credsBefore);
    expect(runSetup).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    const env = parseEnv(before[0].body);
    expect(out()).not.toContain(env.MEMBRAL_LOCAL_PASSWORD);
    expect(out()).toContain("Migrations: up to date (2)");
  });

  it("re-activates local (membral use local) when another profile became active", async () => {
    await localUp({}, deps);
    const s = loadProfiles(deps.credentialsPath)!;
    s.profiles.prod = { apiUrl: "https://membral.me", apiKey: "lls_prod", createdAt: "" };
    s.activeProfile = "prod";
    saveProfiles(s, deps.credentialsPath);
    validKeys.add("lls_minted_1");
    await localUp({}, deps);
    expect(activate).toHaveBeenCalledWith("local");
    expect(fstate.minted).toBe(1);
  });

  it("mints a new key when the stored one is rejected", async () => {
    await localUp({}, deps);
    await localUp({}, deps); // lls_minted_1 not in validKeys -> invalid
    expect(fstate.provisionBodies[1]).toMatchObject({ mintKey: true });
    expect(loadProfiles(deps.credentialsPath)!.profiles.local.apiKey).toBe("lls_minted_2");
  });

  it("renames an existing local profile at another URL to local-previous", async () => {
    saveProfiles(
      {
        activeProfile: "local",
        profiles: { local: { apiUrl: "http://localhost:3005", apiKey: "lls_old", createdAt: "" } },
      },
      deps.credentialsPath,
    );
    await localUp({}, deps);
    const s = loadProfiles(deps.credentialsPath)!;
    expect(s.profiles["local-previous"]).toMatchObject({ apiUrl: "http://localhost:3005", apiKey: "lls_old" });
    expect(s.profiles.local).toMatchObject({ apiUrl: "http://localhost:3000", apiKey: "lls_minted_1" });
    expect(s.activeProfile).toBe("local");
    expect(fstate.provisionBodies[0]).toMatchObject({ mintKey: true });
    expect(logs.filter((l) => l.includes('as "local-previous"'))).toHaveLength(1);
    expect(s.profiles.local.source).toBe("local-stack");
  });

  it("never overwrites local-previous: the next free name is used", async () => {
    saveProfiles(
      {
        activeProfile: "local",
        profiles: {
          local: { apiUrl: "http://localhost:3005", apiKey: "lls_old", createdAt: "" },
          "local-previous": { apiUrl: "http://localhost:3006", apiKey: "lls_older", createdAt: "" },
        },
      },
      deps.credentialsPath,
    );
    await localUp({}, deps);
    const s = loadProfiles(deps.credentialsPath)!;
    expect(s.profiles["local-previous"].apiKey).toBe("lls_older");
    expect(s.profiles["local-previous-2"].apiKey).toBe("lls_old");
  });

  it("moves aside an unmarked local profile at the SAME URL (e.g. a dev server), without validating its key", async () => {
    saveProfiles(
      {
        activeProfile: "local",
        profiles: { local: { apiUrl: "http://localhost:3000", apiKey: "lls_dev", createdAt: "" } },
      },
      deps.credentialsPath,
    );
    validKeys.add("lls_dev");
    await localUp({}, deps);
    const s = loadProfiles(deps.credentialsPath)!;
    expect(fstate.provisionBodies[0]).toMatchObject({ mintKey: true });
    expect(s.profiles["local-previous"].apiKey).toBe("lls_dev");
    expect(s.profiles.local).toMatchObject({ apiKey: "lls_minted_1", source: "local-stack" });
    expect(s.activeProfile).toBe("local");
  });

  it("activates exactly local even when another profile (local-3001) holds the same URL", async () => {
    saveProfiles(
      {
        activeProfile: "local-3001",
        profiles: { "local-3001": { apiUrl: "http://localhost:3001", apiKey: "lls_x", createdAt: "" } },
      },
      deps.credentialsPath,
    );
    await localUp({ port: "3001" }, deps);
    const s = loadProfiles(deps.credentialsPath)!;
    expect(s.activeProfile).toBe("local");
    expect(s.profiles["local-3001"].apiKey).toBe("lls_x");
    expect(runSetup).toHaveBeenCalledWith({ apiUrl: "http://localhost:3001", yes: false, profile: "local" });
    expect(profileNameForUrl("http://localhost:3001", s)).toBe("local");
  });

  it("mints a new key when the user changed (email changed) even if the old key still validates", async () => {
    await localUp({}, deps);
    validKeys.add("lls_minted_1");
    const s = loadProfiles(deps.credentialsPath)!;
    s.profiles.local.userId = "someone-else";
    saveProfiles(s, deps.credentialsPath);
    await localUp({}, deps);
    expect(fstate.provisionBodies.slice(1).map((b) => b.mintKey)).toEqual([false, true]);
    expect(loadProfiles(deps.credentialsPath)!.profiles.local.apiKey).toBe("lls_minted_2");
  });

  it("refuses a second concurrent up, and takes over a stale lock", async () => {
    mkdirSync(deps.paths!.dir, { recursive: true });
    writeFileSync(join(deps.paths!.dir, "up.lock"), "424242");
    deps.pidAlive = () => true;
    await localUp({}, deps);
    expect(errors.at(-1)).toMatch(/Another `membral local up` is running \(pid 424242\)/);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    errors.length = 0;
    deps.pidAlive = () => false;
    await localUp({}, deps);
    expect(errors).toEqual([]);
    expect(existsSync(join(deps.paths!.dir, "up.lock"))).toBe(false);
  });

  it("up with the db volume present and only the sign-in password missing leaves it absent; status says it is unknown", async () => {
    await localUp({}, deps);
    const text = readFileSync(deps.paths!.env, "utf8").replace(/^MEMBRAL_LOCAL_PASSWORD=.*\n/m, "");
    writeFileSync(deps.paths!.env, text);
    deps.runner = makeFakeDocker({ volumeExists: true }).runner;
    errors.length = 0;
    await localUp({}, deps);
    expect(errors).toEqual([]);
    expect(parseEnv(readFileSync(deps.paths!.env, "utf8")).MEMBRAL_LOCAL_PASSWORD).toBeUndefined();
    logs.length = 0;
    await localStatus({ showPassword: true }, deps);
    expect(out()).toContain("password unknown");
    expect(out()).toContain("membral local down --wipe");
  });

  it("refuses to regenerate secrets when the db volume exists but .env lost them", async () => {
    deps.runner = makeFakeDocker({ volumeExists: true }).runner;
    await localUp({}, deps);
    expect(process.exitCode).toBe(1);
    expect(errors.at(-1)).toMatch(/membral-local-db exists but .* is missing its secrets/);
    expect(existsSync(deps.paths!.env)).toBe(false);
  });

  it("validates --image, MEMBRAL_IMAGE, --email and ports", async () => {
    for (const [o, env, re] of [
      [{ image: "--privileged" }, {}, /Invalid image reference/],
      [{}, { MEMBRAL_IMAGE: 'img"\nx' }, /Invalid image reference/],
      [{ email: "not an email" }, {}, /Invalid email/],
      [{ port: "80" }, {}, /pass a port from 1024 to 65535/],
      [{ gatewayPort: "70000" }, {}, /pass a port from 1024 to 65535/],
    ] as const) {
      deps.env = env;
      await localUp(o, deps);
      expect(errors.at(-1)).toMatch(re);
    }
    expect(verbs().some((s) => s.startsWith("compose up"))).toBe(false);
  });

  it("--port stores the actual URL in the local profile and in .env", async () => {
    await localUp({ port: "3101" }, deps);
    expect(loadProfiles(deps.credentialsPath)!.profiles.local.apiUrl).toBe("http://localhost:3101");
    expect(parseEnv(readFileSync(deps.paths!.env, "utf8")).MEMBRAL_APP_PORT).toBe("3101");
    expect(readFileSync(deps.paths!.compose, "utf8")).toContain('"127.0.0.1:3101:3101"');
  });

  it("fails with a one-line --port hint when the app port is busy", async () => {
    deps.isPortFree = async (p) => p !== 3000;
    await localUp({}, deps);
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["Port 3000 is in use. Run `membral local up --port <free port>`."]);
    expect(verbs().some((s) => s.startsWith("compose up"))).toBe(false);
  });

  it("explains a platform mismatch when the image pull finds no matching manifest", async () => {
    const run = docker.runner.run.bind(docker.runner);
    docker.runner.run = async (args, o) =>
      args[0] === "pull"
        ? { code: 1, stdout: "", stderr: "no matching manifest for linux/arm64/v8 in the manifest list entries" }
        : args[0] === "image"
          ? { code: 1, stdout: "", stderr: "No such image" }
          : run(args, o);
    await localUp({}, deps);
    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("no build for this platform") && e.includes("--image"))).toBe(true);
    expect(verbs().some((s) => s.startsWith("compose up"))).toBe(false);
  });

  it("does not call its own running stack's port busy", async () => {
    await localUp({}, deps);
    deps.isPortFree = async () => false; // 3000 and 54421 are held by our containers
    validKeys.add("lls_minted_1");
    await localUp({}, deps);
    expect(errors).toEqual([]);
  });

  it("fails early when docker is missing, the daemon is down, or compose is missing", async () => {
    deps.runner = makeFakeDocker({ versionCode: 127 }).runner;
    await localUp({}, deps);
    expect(errors.at(-1)).toBe("Docker is not installed (no `docker` on PATH). Install Docker, then run this again.");
    deps.runner = makeFakeDocker({ versionCode: 1 }).runner;
    await localStatus({}, deps);
    expect(errors.at(-1)).toMatch(/daemon is not running/);
    deps.runner = makeFakeDocker({ composeCode: 1 }).runner;
    await localDown({}, deps);
    expect(errors.at(-1)).toMatch(/`docker compose` is missing/);
    expect(errors).toHaveLength(3);
    expect(process.exitCode).toBe(1);
  });

  it("names the docker-group fix when the socket refuses this user", async () => {
    deps.runner = makeFakeDocker({
      versionCode: 1,
      versionStderr:
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
    }).runner;
    await localUp({}, deps);
    expect(errors.at(-1)).toContain("sudo usermod -aG docker $USER");
    expect(errors.at(-1)).toContain("log out and back in");
    expect(errors.at(-1)).not.toMatch(/daemon is not running/);
    expect(process.exitCode).toBe(1);
  });

  it("fails on Compose older than 2.23 and accepts 2.23+ (with or without a v prefix)", async () => {
    deps.runner = makeFakeDocker({ composeVersion: "2.21.0" }).runner;
    await localStatus({}, deps);
    expect(errors.at(-1)).toMatch(/Docker Compose 2\.21\.0 is too old; Membral needs 2\.23 or newer/);
    expect(errors.at(-1)).toContain("docker-compose-plugin");
    for (const ok of ["2.23.0", "v2.29.1-desktop.1", "3.0.0"]) {
      const d = makeFakeDocker({ composeVersion: ok });
      deps.runner = d.runner;
      await localStatus({}, deps);
      expect(d.calls.some((c) => c.args.join(" ") === "compose version --short")).toBe(true);
    }
    expect(errors.filter((e) => /too old/.test(e))).toHaveLength(1);
  });

  it("passes --no-sweep through to setup", async () => {
    await localUp({ noSweep: true }, deps);
    expect(runSetup).toHaveBeenCalledWith(expect.objectContaining({ noSweep: true }));
  });

  it("prints the extraction-off line only when health says off", async () => {
    fstate.extraction = "on";
    await localUp({}, deps);
    expect(out()).not.toContain("Extraction is off");
  });

  describe("--embeddings", () => {
    const withOllama = (models: string[] | "down") => {
      const base = makeFetch(fstate);
      const seen: string[] = [];
      deps.fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(":11434/api/tags")) {
          seen.push(url);
          if (models === "down") throw new Error("ECONNREFUSED");
          return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
        }
        return base(input, init);
      }) as typeof fetch;
      return seen;
    };
    const envFile = () => readFileSync(deps.paths!.env, "utf8");

    it("ollama: checks the host, writes the two .env lines (mode 600), passes them to the app, reports it", async () => {
      const seen = withOllama(["nomic-embed-text:latest"]);
      await localUp({ embeddings: "ollama" }, deps);
      expect(process.exitCode).toBeUndefined();
      expect(seen).toEqual(["http://127.0.0.1:11434/api/tags"]);
      const env = parseEnv(envFile());
      expect(env.MEMBRAL_EMBEDDINGS_BASE_URL).toBe("http://host.docker.internal:11434/v1");
      expect(env.MEMBRAL_EMBEDDING_MODEL).toBe("nomic-embed-text");
      expect(statSync(deps.paths!.env).mode & 0o777).toBe(0o600);
      const compose = readFileSync(deps.paths!.compose, "utf8");
      expect(compose).toContain("MEMBRAL_EMBEDDINGS_BASE_URL");
      expect(compose).toContain("MEMBRAL_EMBEDDING_MODEL");
      expect(out()).toContain("Embeddings: nomic-embed-text (Ollama)");
    });

    it("ollama unreachable: prints how to install and start it, exits 1, starts nothing", async () => {
      withOllama("down");
      await localUp({ embeddings: "ollama" }, deps);
      expect(process.exitCode).toBe(1);
      expect(out()).toContain("brew install ollama");
      expect(out()).toContain("ollama serve");
      expect(verbs().some((v) => v.startsWith("compose up"))).toBe(false);
    });

    it("model not pulled: prints the pull command, exits 1, starts nothing", async () => {
      withOllama(["llama3:8b"]);
      await localUp({ embeddings: "ollama" }, deps);
      expect(process.exitCode).toBe(1);
      expect(out()).toContain("ollama pull nomic-embed-text");
      expect(verbs().some((v) => v.startsWith("compose up"))).toBe(false);
    });

    it("honours OLLAMA_HOST and --embedding-model", async () => {
      const seen: string[] = [];
      const base = makeFetch(fstate);
      deps.env = { OLLAMA_HOST: "127.0.0.1:11500" };
      deps.fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          seen.push(url);
          return new Response(JSON.stringify({ models: [{ name: "mxbai-embed-large:latest" }] }), { status: 200 });
        }
        return base(input, init);
      }) as typeof fetch;
      await localUp({ embeddings: "ollama", embeddingModel: "mxbai-embed-large" }, deps);
      expect(seen).toEqual(["http://127.0.0.1:11500/api/tags"]);
      const env = parseEnv(envFile());
      expect(env.MEMBRAL_EMBEDDING_MODEL).toBe("mxbai-embed-large");
      expect(env.MEMBRAL_EMBEDDINGS_BASE_URL).toBe("http://host.docker.internal:11500/v1");
    });

    it("persists: a later plain up keeps the lines and still reports Ollama", async () => {
      withOllama(["nomic-embed-text"]);
      await localUp({ embeddings: "ollama" }, deps);
      const before = envFile();
      logs.length = 0;
      withOllama("down"); // a plain up must not need Ollama to be reachable
      await localUp({}, deps);
      expect(process.exitCode).toBeUndefined();
      expect(envFile()).toBe(before);
      expect(out()).toContain("Embeddings: nomic-embed-text (Ollama)");
    });

    it("is idempotent and keeps other lines", async () => {
      await localUp({}, deps);
      writeFileSync(deps.paths!.env, `${envFile()}OPENAI_API_KEY=sk-test\n`);
      withOllama(["nomic-embed-text"]);
      await localUp({ embeddings: "ollama" }, deps);
      const once = envFile();
      await localUp({ embeddings: "ollama" }, deps);
      expect(envFile()).toBe(once);
      expect(parseEnv(once).OPENAI_API_KEY).toBe("sk-test");
      expect(once.match(/^MEMBRAL_EMBEDDINGS_BASE_URL=/gm)).toHaveLength(1);
    });

    it("none: removes the two lines and reports keyword-only search", async () => {
      withOllama(["nomic-embed-text"]);
      await localUp({ embeddings: "ollama" }, deps);
      logs.length = 0;
      await localUp({ embeddings: "none" }, deps);
      const env = parseEnv(envFile());
      expect(env.MEMBRAL_EMBEDDINGS_BASE_URL).toBeUndefined();
      expect(env.MEMBRAL_EMBEDDING_MODEL).toBeUndefined();
      expect(env.JWT_SECRET).toBeTruthy();
      expect(out()).toContain("Embeddings: none — search is keyword only. Run: membral local up --embeddings ollama");
    });

    it("rejects an unknown mode, and --embedding-model without ollama", async () => {
      await localUp({ embeddings: "openai" }, deps);
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('Invalid --embeddings "openai"');
      process.exitCode = undefined;
      errors.length = 0;
      await localUp({ embeddingModel: "x" }, deps);
      expect(process.exitCode).toBe(1);
      expect(out()).toContain("--embedding-model only applies with --embeddings ollama");
    });

    it("status prints one embeddings line: none by default, Ollama once enabled", async () => {
      await localUp({}, deps);
      logs.length = 0;
      await localStatus({}, deps);
      expect(out()).toContain("Embeddings: none — search is keyword only. Run: membral local up --embeddings ollama");
      withOllama(["nomic-embed-text"]);
      await localUp({ embeddings: "ollama" }, deps);
      logs.length = 0;
      await localStatus({}, deps);
      expect(out()).toContain("Embeddings: nomic-embed-text (Ollama)");
    });
  });

  it("down keeps the volume; --wipe asks first; --yes skips the question", async () => {
    await localUp({}, deps);
    const downCalls = () => docker.calls.filter((c) => c.args[7] === "down").map((c) => c.args.slice(7));

    await localDown({}, deps);
    deps.confirm = async () => false;
    await localDown({ wipe: true }, deps);
    const confirm = vi.fn(async () => true);
    deps.confirm = confirm;
    await localDown({ wipe: true }, deps);
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockClear();
    await localDown({ wipe: true, yes: true }, deps);
    expect(confirm).not.toHaveBeenCalled();
    expect(downCalls()).toEqual([["down"], ["down"], ["down", "-v"], ["down", "-v"]]);
  });

  it("status shows the app's reason when extraction is off (Claude Code could not be downloaded)", async () => {
    await localUp({}, deps);
    fstate.reason =
      "Claude Code could not be downloaded from npm on this start;\nretry with `docker restart membral-app-1`.";
    logs.length = 0;
    await localStatus({}, deps);
    expect(out()).toContain(
      "Extraction is off: Claude Code could not be downloaded from npm on this start; retry with `docker restart membral-app-1`.",
    );
    expect(out()).not.toContain(EXTRACTION_OFF_LINE);
  });

  it("status: exit 0 when healthy, shows the password only with --show-password, exit 1 when not", async () => {
    await localUp({}, deps);
    const env = parseEnv(readFileSync(deps.paths!.env, "utf8"));
    logs.length = 0;
    await localStatus({}, deps);
    expect(process.exitCode).toBeUndefined();
    expect(out()).not.toContain(env.MEMBRAL_LOCAL_PASSWORD);
    expect(out()).toContain("Profile: local (active)");
    expect(out()).toContain(EXTRACTION_OFF_LINE);
    expect(docker.calls.at(-1)!.args.slice(7)).toEqual(["ps", "--all", "--format", "json"]);

    await localStatus({ showPassword: true }, deps);
    expect(out()).toContain(env.MEMBRAL_LOCAL_PASSWORD);
    expect(out()).toContain("(as set at creation; if you changed it in the app, use that)");

    docker.running.delete("rest");
    await localStatus({}, deps);
    expect(process.exitCode).toBe(1);
    expect(out()).toMatch(/rest\s+not created/);
  });

  it("status with no stack exits 1", async () => {
    await localStatus({}, deps);
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["No local stack yet. Run `membral local up`."]);
  });

  it("logs passes service and --follow through to compose logs, with the terminal attached", async () => {
    await localUp({}, deps);
    await localLogs({ service: "app", follow: true }, deps);
    await localLogs({}, deps);
    const logCalls = docker.calls.filter((c) => c.args[7] === "logs");
    expect(logCalls.map((c) => c.args.slice(7))).toEqual([["logs", "--follow", "app"], ["logs"]]);
    expect(logCalls.every((c) => c.opts?.inherit)).toBe(true);
    await localLogs({ service: "nope" }, deps);
    expect(process.exitCode).toBe(1);
  });

  it("generated JWTs verify with the stored secret and carry the Supabase claims", async () => {
    await localUp({}, deps);
    const env = parseEnv(readFileSync(deps.paths!.env, "utf8"));
    expect(Buffer.from(env.JWT_SECRET, "base64url").length).toBeGreaterThanOrEqual(32);
    for (const [key, role] of [
      [env.ANON_KEY, "anon"],
      [env.SERVICE_ROLE_KEY, "service_role"],
    ] as const) {
      const [h, p, sig] = key.split(".");
      expect(createHmac("sha256", env.JWT_SECRET).update(`${h}.${p}`).digest("base64url")).toBe(sig);
      expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      expect(claims).toMatchObject({ role, iss: "supabase" });
      expect(claims.exp - claims.iat).toBeGreaterThan(9 * 365 * 24 * 3600);
    }
    expect(signSupabaseJwt("anon", "s", 1)).toBe(signSupabaseJwt("anon", "s", 1));
    expect(env.CRON_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an existing stack's .env without CRON_SECRET gains one; the other secrets are kept", async () => {
    await localUp({}, deps);
    const before = parseEnv(readFileSync(deps.paths!.env, "utf8"));
    writeFileSync(deps.paths!.env, readFileSync(deps.paths!.env, "utf8").replace(/^CRON_SECRET=.*\n/m, ""));
    deps.runner = makeFakeDocker({ volumeExists: true }).runner;
    errors.length = 0;
    await localUp({}, deps);
    expect(errors).toEqual([]);
    const after = parseEnv(readFileSync(deps.paths!.env, "utf8"));
    expect(after.CRON_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(after.CRON_SECRET).not.toBe(before.CRON_SECRET);
    for (const k of ["POSTGRES_PASSWORD", "JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY", "MEMBRAL_LOCAL_PASSWORD"]) {
      expect(after[k]).toBe(before[k]);
    }
  });
});

describe("local stack files", () => {
  it("binds every published port to 127.0.0.1 and passes only the LLM keys that are set", () => {
    const yml = renderCompose({ appPort: 3000, gatewayPort: 54421, image: "img:x", llmKeys: ["OPENAI_API_KEY"] });
    const ports = yml.match(/- "[^"]*:\d+:\d+"/g) ?? [];
    expect(ports).toEqual(['- "127.0.0.1:54421:8000"', '- "127.0.0.1:3000:3000"']);
    expect(renderCompose({ appPort: 3940, gatewayPort: 54431, image: "img:x", llmKeys: [] })).toContain(
      '- "127.0.0.1:3940:3940"',
    );
    expect(yml).toContain(`OPENAI_API_KEY: "$` + `{OPENAI_API_KEY}"`);
    expect(yml).not.toContain("ANTHROPIC_API_KEY");
    expect(yml).toContain("image: img:x");
    expect(yml).toContain("name: membral-local-db");
  });

  it("mounts the claude-cli volume (Claude Code downloaded on first start) on the app only, never the kicker", () => {
    const yml = renderCompose({ appPort: 3940, gatewayPort: 54431, image: "img:x", llmKeys: [] });
    const app = yml.slice(yml.indexOf("\n  app:"), yml.indexOf("\n  kicker:"));
    const kicker = yml.slice(yml.indexOf("\n  kicker:"), yml.indexOf("\nvolumes:"));
    const volumes = yml.slice(yml.indexOf("\nvolumes:"), yml.indexOf("\nconfigs:"));
    expect(app).toContain("- claude-cli:/claude-cli");
    expect(kicker).not.toContain("claude-cli");
    expect(yml.match(/claude-cli:\/claude-cli/g)).toHaveLength(1);
    expect(volumes).toContain("  claude-cli:\n    name: membral-local-claude-cli");
    expect(volumes).toContain("  db-data:\n    name: membral-local-db");
  });

  it("the app listens on the host port inside the container, so NEXT_PUBLIC_APP_URL reaches it from there too", () => {
    const yml = renderCompose({ appPort: 3940, gatewayPort: 54431, image: "img:x", llmKeys: [] });
    expect(yml).toContain('NEXT_PUBLIC_APP_URL: "http://localhost:3940"');
    expect(yml).toContain('PORT: "3940"');
    expect(yml).toContain("fetch('http://127.0.0.1:3940/api/health')");
  });

  it("a kicker service on the app image calls the memory-extraction kick route with CRON_SECRET", () => {
    const yml = renderCompose({ appPort: 3940, gatewayPort: 54431, image: "img:x", llmKeys: [] });
    const kicker = yml.slice(yml.indexOf("\n  kicker:"), yml.indexOf("\nvolumes:"));
    expect(kicker).toContain("image: img:x");
    expect(kicker).toContain("condition: service_healthy");
    expect(kicker).toContain(`CRON_SECRET: "$` + `{CRON_SECRET}"`);
    expect(kicker).not.toContain("ports:");
    const script = kickerScript(3940);
    expect(script).toContain("http://app:3940/api/internal/cron/memory-extraction?kick=1");
    expect(script).toContain(`setInterval(kick, ${KICK_INTERVAL_S * 1000})`);
    expect(script).not.toContain("$");
    expect(kicker).toContain(`entrypoint: ["node", "-e", ${JSON.stringify(script)}]`);
    // The app gets the same secret, so the cron route accepts the kick.
    expect(yml.slice(yml.indexOf("\n  app:"), yml.indexOf("\n  kicker:"))).toContain(
      `CRON_SECRET: "$` + `{CRON_SECRET}"`,
    );
  });

  it("migration versions come from the filename prefix", () => {
    expect(migrationVersion("024_api_key_scope.sql")).toEqual({ version: "024", name: "api_key_scope" });
  });
});

describe("profileNameForUrl with existing profiles", () => {
  const state = (apiUrl: string) => ({
    activeProfile: "local",
    profiles: { local: { apiUrl, apiKey: "k", createdAt: "" } },
  });
  it("keeps the name of a profile that already holds the URL", () => {
    expect(profileNameForUrl("http://localhost:3101", state("http://localhost:3101"))).toBe("local");
  });
  it("does not let :3000 take over a local profile pointing elsewhere", () => {
    expect(profileNameForUrl("http://localhost:3000", state("http://localhost:3101"))).toBe("local-3000");
  });
  it("is unchanged for existing users whose local is :3000", () => {
    expect(profileNameForUrl("http://localhost:3000", state("http://localhost:3000"))).toBe("local");
    expect(profileNameForUrl("http://localhost:3000")).toBe("local");
    expect(profileNameForUrl("http://localhost:3101", null)).toBe("local-3101");
  });
});

describe("acquireUpLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const lock = () => join(dir, "up.lock");

  it("a lock held by a live pid is refused, and the file is untouched", () => {
    writeFileSync(lock(), "424242");
    const r = acquireUpLock(dir, () => true);
    expect(r).toMatch(/running \(pid 424242\)/);
    expect(readFileSync(lock(), "utf8")).toBe("424242");
    expect(readdirSync(dir)).toEqual(["up.lock"]); // temp file cleaned up
  });

  it("an empty fresh lock file is held, not stale", () => {
    writeFileSync(lock(), "");
    const r = acquireUpLock(dir, () => false);
    expect(typeof r).toBe("string");
    expect(readFileSync(lock(), "utf8")).toBe("");
  });

  it("an empty lock older than 60 s is taken over", () => {
    writeFileSync(lock(), "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock(), old, old);
    const r = acquireUpLock(dir, () => false);
    expect(typeof r).toBe("function");
    expect(readFileSync(lock(), "utf8")).toBe(String(process.pid));
  });

  it("a dead pid is taken over, and release only removes our own lock", () => {
    writeFileSync(lock(), "424242");
    const release = acquireUpLock(dir, () => false);
    expect(typeof release).toBe("function");
    expect(readFileSync(lock(), "utf8")).toBe(String(process.pid));
    expect(readdirSync(dir)).toEqual(["up.lock"]);
    writeFileSync(lock(), "999999"); // someone else took it since
    (release as () => void)();
    expect(readFileSync(lock(), "utf8")).toBe("999999");
    writeFileSync(lock(), String(process.pid));
    (release as () => void)();
    expect(existsSync(lock())).toBe(false);
  });

  it("the lock vanishing during takeover (ENOENT) is handled", () => {
    writeFileSync(lock(), "424242");
    const r = acquireUpLock(dir, () => {
      rmSync(lock()); // holder cleaned up right after we read it
      return false;
    });
    expect(typeof r).toBe("function");
    expect(readFileSync(lock(), "utf8")).toBe(String(process.pid));
  });
});

// 2026-10-08: a `next start` bound to `*:<port>` over IPv6 passed the old
// 127.0.0.1-only bind check (macOS lets a specific bind sit beside a
// wildcard one), and Node's `localhost` (::1 first) then reached it.
describe("defaultIsPortFree", () => {
  const listenOn = (host: string, port = 0) =>
    new Promise<Server>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(port, host, () => resolve(srv));
    });
  const portOf = (srv: Server) => (srv.address() as { port: number }).port;
  const close = (srv: Server) => new Promise<void>((resolve) => srv.close(() => resolve()));
  /** A port nothing holds: bound once, then released. */
  const releasedPort = async () => {
    const srv = await listenOn("127.0.0.1");
    const port = portOf(srv);
    await close(srv);
    return port;
  };

  it("is false when a server holds the port on ::1", async () => {
    let srv: Server;
    try {
      srv = await listenOn("::1");
    } catch {
      return; // no IPv6 loopback on this host: nothing to hold
    }
    try {
      expect(await defaultIsPortFree(portOf(srv))).toBe(false);
    } finally {
      await close(srv);
    }
  });

  it("is false when a server holds the port on 0.0.0.0", async () => {
    const srv = await listenOn("0.0.0.0");
    try {
      expect(await defaultIsPortFree(portOf(srv))).toBe(false);
    } finally {
      await close(srv);
    }
  });

  it("is false when the port is held on 127.0.0.1, and true once released", async () => {
    const srv = await listenOn("127.0.0.1");
    const port = portOf(srv);
    expect(await defaultIsPortFree(port)).toBe(false);
    await close(srv);
    expect(await defaultIsPortFree(port)).toBe(true);
  });

  it("is true when nothing listens on the port", async () => {
    expect(await defaultIsPortFree(await releasedPort())).toBe(true);
  });

  it("is true on a host without IPv6 (the ::1 connect fails with EAFNOSUPPORT)", async () => {
    const port = await releasedPort();
    const hosts: string[] = [];
    const free = await defaultIsPortFree(port, {
      connect: async (host) => {
        hosts.push(host);
        // The real probe resolves false when connect() fails with EAFNOSUPPORT (no IPv6).
        return false;
      },
      bind: async () => true,
    });
    expect(free).toBe(true);
    expect(hosts.sort()).toEqual(["127.0.0.1", "::1"]);
  });

  it("is false when only the injected ::1 connect succeeds, without trying the bind", async () => {
    const bind = vi.fn(async () => true);
    const free = await defaultIsPortFree(1, { connect: async (host) => host === "::1", bind });
    expect(free).toBe(false);
    expect(bind).not.toHaveBeenCalled();
  });
});
