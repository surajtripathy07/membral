import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, LOCK_FILE, lockPort } from "../lock";

const dirs: string[] = [];
const kids: ChildProcess[] = [];
const servers: net.Server[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "membral-lock-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  delete process.env.PORT;
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function listen(port: number, reply: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.end(reply));
    servers.push(s);
    s.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(s));
  });
}
function portOf(d: string): number {
  const st = fs.statSync(d, { bigint: true });
  return lockPort(`${st.dev}:${st.ino}`);
}

const SCRIPT = `
import { acquireLock } from ${JSON.stringify(path.resolve(__dirname, "../lock.ts"))};
try { await acquireLock(process.argv[2]); console.log("ACQUIRED " + process.pid); setInterval(() => {}, 1000).ref(); }
catch (e) { console.log("FAILED " + e.message); process.exit(3); }
`;
/** Runs the lock in a real child process; resolves with its first output line. */
function child(dir: string, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; line: string }> {
  const script = path.join(tmp(), "child.mts");
  fs.writeFileSync(script, SCRIPT);
  const proc = spawn(process.execPath, ["--import", "tsx", script, dir], {
    cwd: path.resolve(__dirname, "../../../../.."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  kids.push(proc);
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout?.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve({ proc, line: buf.slice(0, nl) });
    });
    proc.on("exit", () => buf.includes("\n") || reject(new Error(`child exited: ${buf}`)));
  });
}

describe("store lock (loopback listener)", () => {
  it("acquires, writes the informational file and releases", async () => {
    const d = tmp();
    const release = await acquireLock(d);
    expect(fs.readFileSync(path.join(d, LOCK_FILE), "utf8")).toBe(`pid:${process.pid}`);
    release();
    expect(fs.existsSync(path.join(d, LOCK_FILE))).toBe(false);
    release(); // idempotent
    (await acquireLock(d))(); // the port is free again
  });

  it("refuses a second acquire in the same process", async () => {
    const d = tmp();
    const release = await acquireLock(d);
    await expect(acquireLock(d)).rejects.toThrow(/already open in this process/);
    release();
  });

  it("refuses a second process, and the next acquire succeeds right after the holder is SIGKILLed", async () => {
    const d = tmp();
    const a = await child(d);
    expect(a.line).toMatch(/^ACQUIRED \d+$/);
    const b = await child(d);
    expect(b.line).toContain(`in use by pid ${a.line.split(" ")[1]}`);
    expect(b.line).toContain("membral down");
    const exited = new Promise((r) => a.proc.once("exit", r));
    a.proc.kill("SIGKILL");
    await exited;
    const release = await acquireLock(d); // stale .membral.lock is still on disk and does not matter
    release();
  }, 30_000);

  it("a foreign listener on the port says to stop the process on that port", async () => {
    const d = tmp();
    await listen(portOf(d), "hello\n");
    await expect(acquireLock(d)).rejects.toThrow(/not Membral.*Stop the process on port \d+/);
  });

  it("a hash collision with another store names the other store", async () => {
    const d = tmp();
    await listen(portOf(d), "membral-store-lock 1:2 4242 /somewhere/else\n");
    await expect(acquireLock(d)).rejects.toThrow(
      /another Membral store \(\/somewhere\/else\).*Stop the process on port/,
    );
  });

  it("a holder that accepts but stays silent is reported as busy, not as foreign", async () => {
    const d = tmp();
    const s = net.createServer((c) => c.on("error", () => undefined)); // never writes
    servers.push(s);
    await new Promise<void>((r) => s.listen({ host: "127.0.0.1", port: portOf(d), exclusive: true }, r));
    await expect(acquireLock(d)).rejects.toThrow(/did not answer, likely a busy Membral store.*membral down/);
  }, 10_000);

  it("a case variant and a symlink alias of a held data dir are refused (same device:inode)", async () => {
    const root = tmp();
    const d = path.join(root, "CaseDir");
    fs.mkdirSync(d);
    const link = path.join(root, "alias");
    fs.symlinkSync(d, link);
    const a = await child(d);
    expect(a.line).toMatch(/^ACQUIRED/);
    expect((await child(link)).line).toContain("in use by pid");
    const variant = path.join(root, "casedir");
    if (fs.existsSync(variant)) expect((await child(variant)).line).toContain("in use by pid");
  }, 30_000);

  it("refuses when the derived port equals the app PORT, and the port never depends on PORT", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-port-"));
    const st = fs.statSync(dir, { bigint: true });
    const base = lockPort(`${st.dev}:${st.ino}`);
    process.env.PORT = String(base);
    try {
      expect(lockPort(`${st.dev}:${st.ino}`)).toBe(base);
      await expect(acquireLock(dir)).rejects.toThrow(/equals the app PORT/);
    } finally {
      delete process.env.PORT;
    }
  });

  it("derives a stable port in the dynamic range", () => {
    const p = lockPort("1:2");
    expect(p).toBe(lockPort("1:2"));
    expect(p).toBeGreaterThanOrEqual(49152);
    expect(p).toBeLessThan(65152);
  });

  it("a stale .membral.lock naming a live pid does not block", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, LOCK_FILE), "pid:1");
    const release = await acquireLock(d);
    expect(fs.readFileSync(path.join(d, LOCK_FILE), "utf8")).toBe(`pid:${process.pid}`);
    release();
  });
});
