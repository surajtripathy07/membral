import { describe, expect, it } from "vitest";
import { anchorHits, codeAnchorBoost, countAnchorHits, extractQueryAnchors, MAX_QUERY_ANCHORS } from "../query-anchors";

const values = (q: string) => extractQueryAnchors(q).map((a) => `${a.kind}:${a.value}`);

describe("extractQueryAnchors", () => {
  it("reads file paths, refs and backticked identifiers", () => {
    expect(values("lib/kg/queue.ts still reads process.env; see #157 and !12, and `getServerEnv`.")).toEqual([
      "code:getserverenv",
      "path:lib/kg/queue.ts",
      "ref:#157",
      "ref:!12",
    ]);
  });

  it("keeps bare file names with a code extension but not identifiers like process.env", () => {
    expect(values("fix queue.ts and README.md, not process.env")).toEqual(["file:queue.ts", "file:readme.md"]);
  });

  it("drops a bare file name a path anchor already covers, and two-segment words like and/or", () => {
    expect(values("queue.ts in lib/kg/queue.ts and/or client/server")).toEqual(["path:lib/kg/queue.ts"]);
  });

  it("keeps a three-segment directory and ignores URLs and fragments like a#1", () => {
    expect(values("apps/cloud/src changed, see https://example.com/a/b/c.ts and a#1")).toEqual(["path:apps/cloud/src"]);
  });

  it("returns nothing for plain prose and caps the count", () => {
    expect(values("convert it to the env accessors like the rest")).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(" ");
    expect(extractQueryAnchors(many)).toHaveLength(MAX_QUERY_ANCHORS);
  });
});

describe("countAnchorHits", () => {
  const anchors = extractQueryAnchors("lib/kg/queue.ts and #157");

  it("matches a path inside a longer path, in text, quote or paths", () => {
    expect(countAnchorHits({ text: "kept apps/cloud/src/lib/kg/queue.ts", quote: null }, anchors)).toBe(1);
    expect(countAnchorHits({ text: "x", paths: ["apps/cloud/src/lib/kg/queue.ts"] }, anchors)).toBe(1);
    expect(countAnchorHits({ text: "x", ref: "#157", quote: "lib/kg/queue.ts stays" }, anchors)).toBe(2);
  });

  it("matches a ref only whole", () => {
    expect(countAnchorHits({ text: "see #1570" }, anchors)).toBe(0);
    expect(countAnchorHits({ text: "see #157." }, anchors)).toBe(1);
  });

  it("is zero with no anchors", () => {
    expect(countAnchorHits({ text: "lib/kg/queue.ts" }, [])).toBe(0);
  });
});

describe("anchor false positives and strengths (ADV findings 2026-10-08)", () => {
  it("a backticked identifier matches on identifier boundaries only, and short or common words are dropped", () => {
    expect(values("set `id` to null in the handler")).toEqual([]);
    expect(values("rename `env` and `getServerEnv`")).toEqual(["code:getserverenv"]);
    const a = extractQueryAnchors("call `userId` in the handler");
    expect(anchorHits({ text: "we provide a fix for userIdentity" }, a)).toEqual({ strong: 0, weak: 0 });
    expect(anchorHits({ text: "pass userId through" }, a)).toEqual({ strong: 0, weak: 1 });
  });

  it("set `id` to null never hits 'we provide a fix'", () => {
    const a = extractQueryAnchors("set `id` to null in the handler");
    expect(countAnchorHits({ text: "we provide a fix" }, a)).toBe(0);
  });

  it("Node.js / Vue.js are product names, not files", () => {
    expect(values("upgrade Node.js and Vue.js in the app")).toEqual([]);
  });

  it("dates and prose slashes are not paths; known dirs and ./ ~/ are", () => {
    expect(values("on 2026/10/08 the client/server/database split")).toEqual([]);
    expect(values("look in ./scripts/release and ~/notes/today and src/lib/env")).toEqual([
      "path:scripts/release",
      "path:notes/today",
      "path:src/lib/env",
    ]);
  });

  it("hex colours and long numbers are not refs", () => {
    expect(values("make it #123456 or #fff, see #12345")).toEqual(["ref:#12345"]);
  });

  it("finds paths in **bold**, <angle brackets> and after =", () => {
    expect(values("edit **lib/kg/queue.ts** and <apps/cloud/x.ts> with FILE=docs/a.md")).toEqual([
      "path:lib/kg/queue.ts",
      "path:apps/cloud/x.ts",
      "path:docs/a.md",
    ]);
  });

  it("splits hits into strong (path, ref) and code", () => {
    const a = extractQueryAnchors("lib/kg/queue.ts #157 `rateLimiter`");
    expect(anchorHits({ text: "rateLimiter in lib/kg/queue.ts for #157" }, a)).toEqual({ strong: 2, weak: 1 });
  });

  it("codeAnchorBoost is bounded", () => {
    expect(codeAnchorBoost(1, 0)).toBe(1);
    expect(codeAnchorBoost(1, 5)).toBeCloseTo(1.2);
  });
});

describe("anchor boundaries and qualified refs (re-check 2026-10-08)", () => {
  it("reads six- and seven-digit MR refs, keeps issue refs at five digits", () => {
    expect(values("see !123456 and !1234567 and #12345 but not #123456 or !12345678")).toEqual([
      "ref:!123456",
      "ref:!1234567",
      "ref:#12345",
    ]);
  });

  it("reads qualified refs as the ref, and matches records with or without the qualifier", () => {
    expect(values("fix acme/app#12 and group/sub/repo!34")).toEqual(["ref:acme/app#12", "ref:group/sub/repo!34"]);
    const a = extractQueryAnchors("fix acme/app#12");
    expect(anchorHits({ text: "landed in acme/app#12" }, a).strong).toBe(1);
    expect(anchorHits({ text: "", ref: "acme/app#12" }, a).strong).toBe(1);
    expect(anchorHits({ text: "see #120 and a#12" }, a).strong).toBe(0);
  });

  it("keeps the repo on a qualified ref: a bare #12 or another repo's #12 does not match it", () => {
    const a = extractQueryAnchors("fix acme/app#12");
    expect(anchorHits({ text: "closes #12" }, a).strong).toBe(0);
    expect(anchorHits({ text: "landed in other/app#12" }, a).strong).toBe(0);
    expect(anchorHits({ text: "closes #12", repo: "github.com/acme/app" }, a).strong).toBe(1);
    expect(anchorHits({ text: "closes #12", ref: "#12", repo: "github.com/acme/other" }, a).strong).toBe(0);
    expect(anchorHits({ text: "closes #12" }, extractQueryAnchors("fix #12")).strong).toBe(1);
  });

  it("does not read 'page #1', 'step #2' and similar numbering as refs", () => {
    expect(values("see page #1, Step #2, item #3, line #4 and No #5")).toEqual([]);
    expect(values("section#6 and Q #7 and figure  #8")).toEqual([]);
    expect(values("fixes #12")).toEqual(["ref:#12"]);
    expect(values("#123 and owner/repo#9, but step #2")).toEqual(["ref:owner/repo#9", "ref:#123"]);
    expect(values("pipeline #12 and department #4")).toEqual(["ref:#12", "ref:#4"]);
  });

  it("path and file anchors match on path boundaries only", () => {
    const hit = (q: string, text: string) => countAnchorHits({ text }, extractQueryAnchors(q));
    expect(hit("fix queue.ts", "edited lib/myqueue.ts")).toBe(0);
    expect(hit("update README.md", "rewrote old-readme.md")).toBe(0);
    expect(hit("touch index.ts", "the reindex.ts job")).toBe(0);
    expect(hit("touch index.ts", "src/index.ts changed")).toBe(1);
    expect(hit("fix lib/kg/queue.ts", "kept apps/cloud/src/lib/kg/queue.ts")).toBe(1);
    expect(hit("fix lib/kg/queue.ts", "kept lib/kg/queue.tsx")).toBe(0);
  });

  it("bare file names are weak; paths with a directory and refs are strong", () => {
    const a = extractQueryAnchors("README.md, package.json and lib/kg/queue.ts for #157");
    expect(a.map((x) => x.kind)).toEqual(["path", "file", "file", "ref"]);
    expect(anchorHits({ text: "README.md and package.json" }, a)).toEqual({ strong: 0, weak: 2 });
    expect(anchorHits({ text: "lib/kg/queue.ts per #157" }, a)).toEqual({ strong: 2, weak: 0 });
  });
});
