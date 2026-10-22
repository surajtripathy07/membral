import { describe, expect, it } from "vitest";
import { parseExcludeList } from "../parse-exclude-list.js";

describe("parseExcludeList", () => {
  it("parses a comma-separated number list", () => {
    expect(parseExcludeList("3,7")).toEqual(new Set([3, 7]));
  });
  it("tolerates spaces and drops garbage", () => {
    expect(parseExcludeList(" 3 , x, 7 ")).toEqual(new Set([3, 7]));
  });
  it("returns an empty set for blank/undefined input", () => {
    expect(parseExcludeList(undefined)).toEqual(new Set());
    expect(parseExcludeList("")).toEqual(new Set());
    expect(parseExcludeList("   ")).toEqual(new Set());
  });
});
