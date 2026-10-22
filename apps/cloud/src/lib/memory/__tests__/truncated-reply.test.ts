import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isArrayClosed, salvageArrayElements } from "../truncated-reply";

const A = { kind: "decision", text: "use exponential backoff" };
const B = { kind: "learning", text: 'a {brace} and [bracket] and "quote" inside', nested: { deep: [1, { x: "}" }] } };
const C = { kind: "outcome", text: "café \\ backslash" };
const whole = JSON.stringify({ records: [A, B, C], issues: [{ ref: "#1" }] });

describe("salvageArrayElements (issue #339)", () => {
  const cases: Array<{ name: string; text: string; want: unknown[] }> = [
    { name: "a complete reply returns every record", text: whole, want: [A, B, C] },
    {
      name: "cut mid-string in the last record",
      text: `{"records": [${JSON.stringify(A)}, {"kind": "decision", "text": "half a sent`,
      want: [A],
    },
    { name: "cut mid-key", text: `{"records": [${JSON.stringify(A)}, {"ki`, want: [A] },
    { name: "cut right after a comma", text: `{"records": [${JSON.stringify(A)},`, want: [A] },
    {
      name: "cut inside a nested object",
      text: `{"records": [${JSON.stringify(A)}, {"kind": "x", "nested": {"deep": [1, {"x": 2`,
      want: [A],
    },
    {
      name: "braces, brackets and escaped quotes inside strings",
      text: `{"records": [${JSON.stringify(B)}, ${JSON.stringify(C)}, {"text": "cut \\"here`,
      want: [B, C],
    },
    {
      name: "a unicode escape split by the cut",
      text: `{"records": [${JSON.stringify(A)}, {"text": "caf\\u00`,
      want: [A],
    },
    { name: "cut right after a backslash", text: `{"records": [${JSON.stringify(A)}, {"text": "a\\`, want: [A] },
    { name: "an empty array", text: '{"records": []}', want: [] },
    { name: "an empty array, cut", text: '{"records": [', want: [] },
    { name: "cut before the first record completes", text: '{"records": [{"kind": "decision", "te', want: [] },
    { name: "cut inside the key itself", text: '{"reco', want: [] },
    {
      name: "whitespace and newlines everywhere",
      text: `{\n  "records" :\n [\n ${JSON.stringify(A)} ,\n\t${JSON.stringify(C)}\n , {`,
      want: [A, C],
    },
    { name: "records after issues", text: `{"issues": [{"ref": "]"}], "records": [${JSON.stringify(A)}, {`, want: [A] },
    {
      name: "a nested records key is not the top-level one",
      text: `{"other": {"records": [${JSON.stringify(A)}]}}`,
      want: [],
    },
    { name: "records is not an array", text: '{"records": "nope"}', want: [] },
    { name: "garbage input", text: "}}]]not json at all{{[[", want: [] },
    { name: "a non-object top level", text: `[${JSON.stringify(A)}]`, want: [] },
    { name: "an empty string", text: "", want: [] },
    {
      name: "a malformed element is dropped, later ones kept",
      text: `{"records": [{"a": 1 "b": 2}, ${JSON.stringify(A)}, {`,
      want: [A],
    },
    {
      name: "primitives complete only when terminated",
      text: '{"records": [1, "two", true, 12',
      want: [1, "two", true],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(salvageArrayElements(c.text, "records")).toEqual(c.want);
    });
  }

  it("salvages another key the same way", () => {
    expect(salvageArrayElements(whole, "issues")).toEqual([{ ref: "#1" }]);
  });

  it("never throws, whatever it is given", () => {
    const inputs: unknown[] = [null, undefined, 42, {}, "{", '{"records":', '{"records": [{"a": "\\', "\u0000￿"];
    for (const input of inputs) {
      expect(() => salvageArrayElements(input as string, "records")).not.toThrow();
      expect(salvageArrayElements(input as string, "records")).toEqual([]);
    }
    // Every prefix of a real reply is safe and yields only whole records.
    for (let i = 0; i <= whole.length; i++) {
      const got = salvageArrayElements(whole.slice(0, i), "records");
      expect([A, B, C].slice(0, got.length)).toEqual(got);
    }
  });
});

describe("isArrayClosed (records closed before the cut)", () => {
  const cases: Array<{ name: string; text: string; key?: string; want: boolean }> = [
    { name: "closed empty array", text: '{"records": [], "issues": [{"ref": "codehub-org/app!1", "wor', want: true },
    { name: "closed non-empty array", text: `{"records": [${JSON.stringify(A)}], "issues": [{"re`, want: true },
    { name: "cut inside the array", text: `{"records": [${JSON.stringify(A)}, {"kind": "dec`, want: false },
    { name: "cut right after the last element, no bracket", text: `{"records": [${JSON.stringify(A)}`, want: false },
    { name: "key absent", text: '{"issues": []}', want: false },
    { name: "issues closed is reported for its own key", text: '{"records": [{"a":1', key: "issues", want: false },
    {
      name: "] inside a string value is not the closing bracket",
      text: '{"records": [{"text": "a ] b", "q": "]"}, {"text": "cut',
      want: false,
    },
    { name: "garbage", text: "not json at all ]]] [[[", want: false },
    { name: "empty string", text: "", want: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(isArrayClosed(c.text, c.key ?? "records")).toBe(c.want);
    });
  }

  it("never throws on non-string input", () => {
    expect(isArrayClosed(undefined as unknown as string, "records")).toBe(false);
    expect(isArrayClosed("{}", undefined as unknown as string)).toBe(false);
  });
});

describe("captured production reply: empty closed records, issues cut mid-entry", () => {
  const raw = readFileSync(join(__dirname, "fixtures", "cutoff-reply-empty-records.txt"), "utf8");

  it("records is closed and empty, and 29 complete issues are salvaged", () => {
    expect(isArrayClosed(raw, "records")).toBe(true);
    expect(salvageArrayElements(raw, "records")).toEqual([]);
    expect(salvageArrayElements(raw, "issues")).toHaveLength(29);
    expect(isArrayClosed(raw, "issues")).toBe(false);
  });
});
