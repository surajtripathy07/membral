import { describe, expect, it } from "vitest";
import { parseQuoteParam, QUOTE_PARAM_MAX_CHARS, quoteForLink, splitAroundQuote } from "../quote-highlight";

describe("quoteForLink / parseQuoteParam", () => {
  it("squashes whitespace, caps the length, and drops quotes too short to mark", () => {
    expect(quoteForLink("  keep\n it   inline ")).toBe("keep it inline");
    expect(quoteForLink("ab")).toBeNull();
    expect(quoteForLink(null)).toBeNull();
    expect(quoteForLink("y".repeat(900))?.length).toBe(QUOTE_PARAM_MAX_CHARS);
  });

  it("parseQuoteParam takes the first of an array and applies the same rules", () => {
    expect(parseQuoteParam(["retry once", "ignored"])).toBe("retry once");
    expect(parseQuoteParam(undefined)).toBeNull();
    expect(parseQuoteParam("z".repeat(2000))?.length).toBe(QUOTE_PARAM_MAX_CHARS);
  });
});

describe("splitAroundQuote", () => {
  it("splits around the first case-insensitive match", () => {
    expect(splitAroundQuote("We agreed to Retry the import once, then stop.", "retry the import once")).toEqual([
      { text: "We agreed to ", match: false },
      { text: "Retry the import once", match: true },
      { text: ", then stop.", match: false },
    ]);
  });

  it("matches across line breaks and repeated spaces in the transcript", () => {
    const parts = splitAroundQuote("keep the vendor call\n   inline always", "keep the vendor call inline");
    expect(parts?.find((p) => p.match)?.text).toBe("keep the vendor call\n   inline");
  });

  it("treats regex metacharacters in the quote literally", () => {
    expect(splitAroundQuote("run (a+b)* now", "(a+b)*")?.find((p) => p.match)?.text).toBe("(a+b)*");
    expect(splitAroundQuote("run ab now", "(a+b)*")).toBeNull();
  });

  it("returns null when the quote is absent or too short", () => {
    expect(splitAroundQuote("nothing here", "missing quote")).toBeNull();
    expect(splitAroundQuote("nothing here", "no")).toBeNull();
    expect(splitAroundQuote("nothing here", null)).toBeNull();
  });
});
