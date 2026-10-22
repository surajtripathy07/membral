import { boolFlag, parseFlags, stringFlag } from "../args.js";
import { resolveUploadConfig } from "../code-session-upload.js";
import {
  appendCandidates,
  fetchCandidates,
  fetchDogfood,
  isoWeek,
  postDigest,
  readDogfoodConfig,
  renderDigest,
} from "../dogfood.js";
import { HELP } from "../help.js";
import type { Command } from "./types.js";

// `membral dogfood digest [--post] [--issue <n>] [--repo owner/name]` and
// `membral dogfood candidates --out <path>` (recall-precision W3b). Flags win
// over the config's `dogfood.*` keys. Never throws: a failure prints a message
// and sets exit code 1.
export const dogfoodCommand: Command = {
  name: "dogfood",
  async run(rest) {
    const [sub, ...args] = rest;
    const flags = parseFlags(args);
    const config = resolveUploadConfig({ apiUrl: stringFlag(flags, "api-url"), apiKey: stringFlag(flags, "api-key") });
    if (!config.apiKey) {
      console.error("membral dogfood: not signed in (run `membral login`)");
      process.exitCode = 1;
      return;
    }
    const conf = readDogfoodConfig();
    if (sub === "digest") {
      const data = await fetchDogfood(config, 7);
      if (!data) {
        console.error("membral dogfood: the server has no dogfood signals (old server, or unreachable)");
        process.exitCode = 1;
        return;
      }
      const body = renderDigest(data, { appUrl: config.apiUrl, week: isoWeek(new Date()) });
      if (!boolFlag(flags, "post")) {
        process.stdout.write(body);
        return;
      }
      const issue = Number(stringFlag(flags, "issue") ?? conf.issue);
      const repo = stringFlag(flags, "repo") ?? conf.repo;
      if (!Number.isInteger(issue) || issue <= 0 || !repo) {
        console.error(
          "membral dogfood digest --post needs --issue <n> and --repo owner/name (or config dogfood.issue/repo)",
        );
        process.exitCode = 1;
        return;
      }
      const r = postDigest(body, issue, repo);
      (r.ok ? console.log : console.error)(r.message);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (sub === "candidates") {
      const out = stringFlag(flags, "out") ?? conf.candidatesPath;
      if (!out) {
        console.error("membral dogfood candidates needs --out <path> (or config dogfood.candidatesPath)");
        process.exitCode = 1;
        return;
      }
      const days = Number(stringFlag(flags, "days") ?? 30);
      const list = await fetchCandidates(config, Number.isFinite(days) && days > 0 ? days : 30);
      if (!list) {
        console.error("membral dogfood: the server has no candidates view (old server, or unreachable)");
        process.exitCode = 1;
        return;
      }
      try {
        const n = appendCandidates(out, list, config.apiUrl);
        console.log(`${n} new candidate(s) appended to ${out} (${list.length} contradicted in window)`);
      } catch (err) {
        console.error(`membral dogfood: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
      return;
    }
    console.error(HELP.dogfood);
    process.exitCode = 1;
  },
  help: HELP.dogfood,
};
