// The one door to Docker for `membral local` (W7). Every docker call goes
// through a DockerRunner so tests pass a fake and assert the call list; the
// real runner spawns `docker <args>` and never throws.
import { spawn } from "node:child_process";

export interface DockerResult {
  /** Process exit code; 127 when `docker` is not on PATH. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  /** Pass the terminal through (logs -f); stdout/stderr come back empty. */
  inherit?: boolean;
}

export interface DockerRunner {
  run(args: string[], opts?: DockerRunOptions): Promise<DockerResult>;
}

export const DOCKER_NOT_FOUND = 127;

export function createDockerRunner(bin = "docker"): DockerRunner {
  return {
    run(args, opts = {}) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const done = (r: DockerResult) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        const child = spawn(bin, args, {
          stdio: opts.inherit ? "inherit" : [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        child.stdout?.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
          done({ code: err.code === "ENOENT" ? DOCKER_NOT_FOUND : 1, stdout, stderr: err.message });
        });
        child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
        if (opts.input !== undefined && child.stdin) {
          child.stdin.on("error", () => {});
          child.stdin.end(opts.input);
        }
      });
    },
  };
}
