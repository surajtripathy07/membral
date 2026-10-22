// D-065 (R3 3.4, #169): ONE label rule for an issue/MR chip, shared by Today
// (pulse/threads-content.tsx) and Issues (code/stats/issues). The chip text
// and the chip's link come from the same host check (`linkFamilyOf`, the one
// `forgeUrl` uses), so a chip never reads as a known forge's item while its
// link builder declines that host.
//
//   github.com                          -> `#N` (issue or pull request — one number space)
//   glab-family host: the hosted .com   -> `#N` issue, `!N` merge request (the forge's own
//   by name, a self-hosted one only        spelling; `#5` and `!5` are different items there)
//   when data proves it
//   any other host, or no host          -> `owner/repo#N` issue, `owner/repo!N` merge request
//                                          (unknown family: no link, so the label carries the
//                                          repo; `!` keeps MR vs issue distinguishable)
//
// A spelling that is not ref syntax (a bare `#12` with no repo) comes back as written.
import { type ForgeUrlOptions, forgeRefParts, linkFamilyOf } from "./forge-url";

export function refLabel(ref: string, opts: ForgeUrlOptions = {}): string {
  const parts = forgeRefParts(ref, opts);
  if (!parts || parts.path.length === 0) return ref;
  const family = linkFamilyOf(parts.host, opts);
  if (family === "github") return `#${parts.number}`;
  if (family === "glab") return `${parts.kind === "merge_request" ? "!" : "#"}${parts.number}`;
  return `${parts.path.join("/")}${parts.kind === "merge_request" ? "!" : "#"}${parts.number}`;
}
