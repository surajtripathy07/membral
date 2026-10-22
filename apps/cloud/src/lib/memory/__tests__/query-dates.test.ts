import { describe, expect, it } from "vitest";
import { parseQueryDates } from "../query-dates";

const NOW = new Date("2026-10-03T12:00:00Z"); // a Saturday

describe("parseQueryDates: unambiguous phrases are stripped and boosted", () => {
  it.each([
    ["what did we decide about caching last week", "what did we decide about caching", "2026-09-26", "2026-10-03"],
    ["yesterday the auth bug", "the auth bug", "2026-10-02", "2026-10-03"],
    ["login 3 days ago", "login", "2026-09-30", "2026-10-01"],
    ["production outage recovery Oct 1", "production outage recovery", "2026-10-01", "2026-10-02"],
    ["deploy on 2026-09-20", "deploy", "2026-09-20", "2026-09-21"],
    ["cache since Monday", "cache", "2026-09-28", "2026-10-04"],
  ])("%s", (query, text, from, to) => {
    const r = parseQueryDates(query, NOW);
    expect(r.text).toBe(text);
    expect(r.window?.from.slice(0, 10)).toBe(from);
    expect(r.window?.to.slice(0, 10)).toBe(to);
  });
});

describe("parseQueryDates: ambiguous words stay in the query and give no window", () => {
  it.each([
    ["can we use march for the release"], // bare month
    ["8/10 tests passing"], // slash ratio
    ["the mon process restarts"], // weekday abbreviation
    ["today's plan"], // possessive
    ["rate limit in September"], // bare month with a preposition
    ["may"], // bare month alone
    ["sunday"], // bare weekday alone
  ])("%s", (query) => {
    expect(parseQueryDates(query, NOW)).toEqual({ text: query, window: null });
  });
});

describe("parseQueryDates: never empties the query", () => {
  it("a query that is only a date keeps its own text and still gets the window", () => {
    const r = parseQueryDates("last week", NOW);
    expect(r.text).toBe("last week");
    expect(r.window?.phrase).toBe("last week");
  });
});
