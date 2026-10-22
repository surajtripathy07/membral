// L5 abstention floor: lexical-only evidence needs an absolute count of matched lexemes on a calibrated family.
import { describe, expect, it } from "vitest";
import { lexicalMinHits } from "@/lib/llm/embedding-family";
import { familyFloor, passesRelevanceFloor } from "../search";

const nomic = { sem: 0.66, mixed: 0.61, lexMinHits: 4 };

describe("passesRelevanceFloor lexMinHits (L5)", () => {
  it("is off by default: the L8 / hosted behaviour is unchanged", () => {
    // 2 of 4 words matched, cosine just under the mixed cut: served by rule (b)
    expect(passesRelevanceFloor({ similarity: 0.45, lex_hits: 2, query_lexemes: 4 })).toBe(true);
    expect(passesRelevanceFloor({ similarity: 0.62, lex_hits: 2, query_lexemes: 5 }, { sem: 0.66, mixed: 0.61 })).toBe(
      true,
    );
  });

  it("refuses a common-word match on a short query: 3 of 5 words, cosine under the semantic floor", () => {
    expect(passesRelevanceFloor({ similarity: 0.614, lex_hits: 3, query_lexemes: 5 }, nomic)).toBe(false);
    expect(passesRelevanceFloor({ similarity: 0.598, lex_hits: 2, query_lexemes: 4 }, nomic)).toBe(false);
  });

  it("serves lexical evidence once the count is met", () => {
    expect(passesRelevanceFloor({ similarity: 0.6, lex_hits: 4, query_lexemes: 7 }, nomic)).toBe(true);
    expect(passesRelevanceFloor({ similarity: 0.62, lex_hits: 4, query_lexemes: 11 }, nomic)).toBe(true); // rule (c)
  });

  it("never lowers the semantic rule: a cosine at the floor serves with no lexical hit", () => {
    expect(passesRelevanceFloor({ similarity: 0.66, lex_hits: 0, query_lexemes: 6 }, nomic)).toBe(true);
    expect(passesRelevanceFloor({ similarity: 0.857, lex_hits: 1, query_lexemes: 13 }, nomic)).toBe(true);
  });

  it("a query shorter than the minimum needs all of its lexemes", () => {
    expect(passesRelevanceFloor({ similarity: null, lex_hits: 3, query_lexemes: 3 }, nomic)).toBe(true);
    expect(passesRelevanceFloor({ similarity: null, lex_hits: 2, query_lexemes: 3 }, nomic)).toBe(false);
  });
});

describe("lexicalMinHits per family (L5)", () => {
  it("the hosted default family has no minimum, nomic-embed-text 4, an unlisted family none", () => {
    expect(lexicalMinHits("text-embedding-3-small")).toBe(0);
    expect(lexicalMinHits("nomic-embed-text")).toBe(4);
    expect(lexicalMinHits("some-other-model")).toBe(0);
  });

  it("familyFloor wires it into the nomic floor and leaves the default family's floor alone", () => {
    const row = { similarity: 0.614, lex_hits: 3, query_lexemes: 5 };
    const local = familyFloor({ MEMBRAL_EMBEDDING_MODEL: "nomic-embed-text" });
    expect(local.floor?.(row)).toBe(false);
    const hosted = familyFloor({});
    expect(hosted.floor?.({ similarity: 0.45, lex_hits: 3, query_lexemes: 5 })).toBe(true);
  });
});
