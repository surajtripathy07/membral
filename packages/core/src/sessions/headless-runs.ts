// Membral's own headless `claude -p` runs (the cloud's claude-code extraction provider and the eval harness) execute
// in a throwaway OS temp dir named `membral-claude-<random>` or `membral-lab-claude-<random>`. Claude Code writes their
// transcripts under ~/.claude/projects like any other session, so without this check they are uploaded and imported as
// if the user had worked there (one code project per run). Shared so the CLI sweep and the cloud import agree.

const HEADLESS_RUN_SEGMENT = /^membral-(lab-)?claude-[A-Za-z0-9]+$/;
// A directory segment that marks an OS temp location: macOS `.../T`, Linux `/tmp`, Windows `...\Temp`. Matched by
// segment, not by a hard-coded absolute path, so the per-user random folder names do not matter.
const TEMP_SEGMENT = /^(t|tmp|temp)$/i;

/** True when `path` is an OS temp dir whose last segment is a Membral headless-run name. Never throws; non-strings are false. */
export function isMembralHeadlessRunDir(path: string | null | undefined): boolean {
  if (typeof path !== "string") return false;
  const segments = path
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1];
  if (!HEADLESS_RUN_SEGMENT.test(last)) return false;
  return segments.slice(0, -1).some((s) => TEMP_SEGMENT.test(s));
}
