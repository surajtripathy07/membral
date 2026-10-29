// The data-dir lock is a TCP listener on 127.0.0.1. The kernel gives exclusivity (bind fails with EADDRINUSE while
// another process holds the port) and frees the port when the holder dies by any means, so there are no stale files,
// no pid reuse and no timers. The port is derived from the data dir's identity (device:inode, so case variants,
// symlinks and the macOS firmlink alias all name the same lock). The listener answers each connection with one line,
// `membral-store-lock <dev:ino> <pid> <realpath>`, so a refused process can tell "this store is in use" from "a
// foreign process holds the port". `<dataDir>/.membral.lock` (`pid:<pid>`) is informational only.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { appPort } from "@/lib/env";

export const LOCK_FILE = ".membral.lock";
const PORT_BASE = 49152;
const PORT_SPAN = 16000;
const PROBE_TIMEOUT_MS = 1000;
const BANNER = "membral-store-lock";

/** Identities (dev:ino) this process holds. */
const held = new Set<string>();

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Port for a data-dir identity. Independent of the environment, so every opener of a dir derives the same port. */
export function lockPort(identity: string): number {
  return PORT_BASE + (fnv1a32(identity) % PORT_SPAN);
}

type Probe = { kind: "banner"; line: string } | { kind: "silent" } | { kind: "foreign" };

/** Connects to the port. banner: a line arrived. silent: connected, nothing within the timeout (busy or stopped
 *  holder). foreign: refused, reset, or closed without a line. */
function probe(port: number): Promise<Probe> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const sock = net.connect({ host: "127.0.0.1", port });
    const finish = (v: Probe) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS, () => finish({ kind: "silent" }));
    sock.on("error", () => finish({ kind: "foreign" }));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish({ kind: "banner", line: buf.slice(0, nl) });
    });
    sock.on("close", () => finish({ kind: "foreign" }));
  });
}

export async function acquireLock(dataDir: string): Promise<() => void> {
  fs.mkdirSync(dataDir, { recursive: true });
  const real = fs.realpathSync(dataDir);
  const st = fs.statSync(dataDir, { bigint: true });
  const identity = `${st.dev}:${st.ino}`;
  if (held.has(identity)) throw new Error(`The store at ${dataDir} is already open in this process.`);
  const port = lockPort(identity);
  if (String(port) === appPort()) throw new Error(`Lock port ${port} equals the app PORT; choose another PORT.`);
  held.add(identity); // reserve synchronously so two concurrent calls in one process cannot both bind
  const line = `${BANNER} ${identity} ${process.pid} ${real}\n`;
  const server = net.createServer((c) => {
    c.on("error", () => undefined);
    c.end(line);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // exclusive: no SO_REUSEPORT-style sharing of the port
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    held.delete(identity);
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    const answer = await probe(port);
    if (answer.kind === "silent") {
      throw new Error(
        `The store lock port ${port} is held by a process that did not answer, likely a busy Membral store for this data dir. Retry, or stop it with \`membral down\`.`,
      );
    }
    const m = answer.kind === "banner" ? new RegExp(`^${BANNER} (\\S+) (\\d+) (.*)$`).exec(answer.line) : null;
    if (m && m[1] === identity) {
      throw new Error(`The store at ${real} is in use by pid ${m[2]}. Stop it with \`membral down\`.`);
    }
    throw new Error(
      `The store lock port ${port} for ${real} is taken by ${m ? `another Membral store (${m[3]})` : "a process that is not Membral"}. Stop the process on port ${port} and retry.`,
    );
  }
  server.unref();

  const file = path.join(real, LOCK_FILE);
  const token = `pid:${process.pid}`;
  try {
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch {
    /* information only */
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(identity);
    server.close();
    try {
      if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}
