// Cloud UI text formatters: truncation and pluralization (G3 3D-1). The
// three `truncate` variants below were byte-different (trim vs no-trim,
// slice-inclusive vs exclusive of the max char) despite the same name and
// signature in their original files, so each keeps its own name here rather
// than collapsing to one, which could change a rendered string's length.

/**
 * Truncate a path from the LEFT, keeping the tail (the informative part of
 * a path — the filename and its nearest directories) — the opposite of the
 * CSS `truncate` utility's right-side ellipsis, which would show a long
 * shared prefix and hide the one part that actually distinguishes the file.
 * Moved from lib/code-sessions/view.ts's truncatePathLeft.
 */
export function truncatePathLeft(path: string, maxChars = 44): string {
  if (path.length <= maxChars) return path;
  return `…${path.slice(path.length - (maxChars - 1))}`;
}
