import { describe, expect, it } from "vitest";
import { parseVector, toVectorString } from "../vector";

describe("toVectorString", () => {
  it("writes the pgvector text form", () => {
    expect(toVectorString([1, 2.5, -3])).toBe("[1,2.5,-3]");
    expect(toVectorString([])).toBe("[]");
  });
});

describe("parseVector (issue #188)", () => {
  it("keeps only the numbers of an array", () => {
    expect(parseVector([1, "x", null, 2])).toEqual([1, 2]);
  });

  it("parses a pgvector text string", () => {
    expect(parseVector("[0.1,0.2,3]")).toEqual([0.1, 0.2, 3]);
  });

  it("drops non-numbers inside a parsed string array", () => {
    expect(parseVector('[1,"a",2]')).toEqual([1, 2]);
  });

  it("a string that parses to something other than an array is []", () => {
    expect(parseVector('{"a":1}')).toEqual([]);
    expect(parseVector("42")).toEqual([]);
  });

  it("an unparseable string is []", () => {
    expect(parseVector("not json")).toEqual([]);
  });

  it("any other type is []", () => {
    expect(parseVector(null)).toEqual([]);
    expect(parseVector(undefined)).toEqual([]);
    expect(parseVector(7)).toEqual([]);
  });
});
