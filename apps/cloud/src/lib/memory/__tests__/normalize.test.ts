import { describe, expect, it } from "vitest";
import { normalizeQuote, quoteMatchesTurnText, snapQuoteToSource } from "../normalize";

describe("normalizeQuote (step2c residual 2, issue #151)", () => {
  it("collapses whitespace and trims, same as the old whitespace-only normalizer", () => {
    expect(normalizeQuote("  fixed   the   flaky\ntest  ")).toBe("fixed the flaky test");
  });

  it("unifies curly/smart apostrophes to straight", () => {
    expect(normalizeQuote("it’s the owner‘s call")).toBe("it's the owner's call");
  });

  it("unifies curly/smart double quotes into the one quote class (D3 decision A1)", () => {
    // trailing punctuation (including a trailing quote mark) is stripped by
    // design (see the trailing-punctuation tests below), so the closing
    // quote here sits mid-sentence, not at the very end.
    expect(normalizeQuote("said “no extra services” and left")).toBe("said 'no extra services' and left");
  });

  it("unifies en/em dash variants to a hyphen", () => {
    expect(normalizeQuote("2013 – the retry — backoff")).toBe("2013 - the retry - backoff");
  });

  it("collapses a real ellipsis character to the same form as three literal dots", () => {
    expect(normalizeQuote("the plan is… done")).toBe(normalizeQuote("the plan is... done"));
  });

  it("collapses runs of dots (2+) to one", () => {
    expect(normalizeQuote("wait....... really")).toBe("wait. really");
  });

  it("strips trailing punctuation added when a mid-sentence quote is closed off", () => {
    // live case (session_memories id 28fa04a1, project 9aacaea8): the model
    // quoted "...never appear for anyone." with a false trailing period; the
    // transcript actually continues "...never appear for anyone because...".
    const quote = normalizeQuote("memories never appear for anyone.");
    const text = normalizeQuote("memories never appear for anyone because the daemon never ran");
    expect(text.includes(quote)).toBe(true);
  });

  it("strips a trailing ellipsis the model appends to a truncated quote", () => {
    // live case (session_memories id 91406e3f): quote ends "...just wrote..."
    // while the transcript continues past that point.
    const quote = normalizeQuote("shadows the valid key that login just wrote...");
    const text = normalizeQuote("shadows the valid key that login just wrote, so every path after it failed");
    expect(text.includes(quote)).toBe(true);
  });

  it("does NOT treat a mid-quote ellipsis as a wildcard over omitted words (genuine paraphrase stays unmatched)", () => {
    // A quote stitching two non-adjacent spans together with "..." in the
    // middle must NOT verify against a source that has different words in
    // the gap — that is a real paraphrase, not a formatting difference.
    const quote = normalizeQuote("the repo is not heavy in dependencies... the good news is X");
    const text = normalizeQuote(
      "the repo is not heavy in dependencies. It is heavy in documents. Anyway, the good news is X",
    );
    expect(text.includes(quote)).toBe(false);
  });

  it("case-folds (D3 decision A1) — a re-cased first word of a mid-sentence quote still matches", () => {
    const quote = normalizeQuote("I want the website to act like everything is public.");
    const text = normalizeQuote("nahh.. i want the website to act like everything is public.. so that");
    expect(text.includes(quote)).toBe(true);
  });

  it("case-folding never masks a paraphrase — different words stay unmatched", () => {
    const quote = normalizeQuote("I want the site to behave as if everything were public");
    const text = normalizeQuote("nahh.. i want the website to act like everything is public.. so that");
    expect(text.includes(quote)).toBe(false);
  });

  it("treats ASCII ' \" ` and their curly/prime variants as ONE class (D3 decision A1)", () => {
    const a = normalizeQuote('run `make test` before the "release" tag, it\'s required');
    const b = normalizeQuote("run ‘make test’ before the “release” tag, it’s required");
    const c = normalizeQuote("run 'make test' before the 'release' tag, it's required");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("is language-agnostic — case-folds and unifies quotes in non-Latin scripts too", () => {
    expect(normalizeQuote("ΤΟ ΑΡΧΕΙΟ είναι “έτοιμο” τώρα")).toBe("το αρχειο είναι 'έτοιμο' τώρα");
    expect(normalizeQuote("Привет, “Мир” снова")).toBe("привет, 'мир' снова");
  });
});

describe("quoteMatchesTurnText (step2d finding 12, issue #151)", () => {
  it("grounds a quote whose phone number was redacted at write time against the turn's raw (unredacted) text", () => {
    const turnText = "call me at 555-123-4567 today to confirm";
    const redactedQuote = "call me at [redacted] today to confirm"; // what redactRecordPii stored
    expect(quoteMatchesTurnText(redactedQuote, turnText)).toBe(true);
  });

  it("grounds a quote whose email was redacted at write time against the turn's raw text", () => {
    const turnText = "ping jane.doe@example.com about it";
    const redactedQuote = "ping [redacted] about it";
    expect(quoteMatchesTurnText(redactedQuote, turnText)).toBe(true);
  });

  it("still fails a genuinely unrelated quote", () => {
    expect(quoteMatchesTurnText("this text is nowhere in the turn", "call me at 555-123-4567 today")).toBe(false);
  });

  it("still matches a plain quote with no PII at all (unaffected by the redaction pass)", () => {
    expect(quoteMatchesTurnText("exponential backoff", "Switched to exponential backoff for retries")).toBe(true);
  });
});

describe("snapQuoteToSource (step2e finding 3, issue #151)", () => {
  it("snaps a quote that dropped the source's ** markdown to the real, markdown-intact source slice (live case caef326d)", () => {
    const turnText =
      "Both done:\n\n- **CI retriggered** — amended the commit (content unchanged, new hash `e617ee5a6f`) and force-pushed. The full pipeline is running fresh.";
    const quote = "CI retriggered — amended the commit (content unchanged, new hash `e617ee5a6f`) and force-pushed.";
    const snap = snapQuoteToSource(quote, turnText);
    expect(snap).not.toBeNull();
    expect(snap?.coverage).toBeGreaterThanOrEqual(0.9);
    expect(snap?.snapped).toBe(
      "**CI retriggered** — amended the commit (content unchanged, new hash `e617ee5a6f`) and force-pushed.",
    );
    // The snapped result is now a REAL verbatim substring — it grounds.
    expect(quoteMatchesTurnText(snap?.snapped ?? "", turnText)).toBe(true);
  });

  it("re-snaps a stale '[redacted]' quote (from the since-undone home-path redaction rule) to the turn's real value (live case 551371f2)", () => {
    const turnText = "The daemon reads its state from ~/.local/share/opencode/opencode.db on every poll.";
    const staleQuote = "reads its state from [redacted] on every poll";
    const snap = snapQuoteToSource(staleQuote, turnText);
    expect(snap).not.toBeNull();
    expect(snap?.snapped).toContain("~/.local/share/opencode/opencode.db");
    expect(snap?.snapped).not.toContain("[redacted]");
    expect(quoteMatchesTurnText(snap?.snapped ?? "", turnText)).toBe(true);
  });

  it("rejects a quote stitched from two non-adjacent spans (live case 1d8a659a) — coverage below 90%, never accepted", () => {
    const turnText =
      "Nothing closes until it passes review, no matter how urgent the deadline feels. We also agreed to keep the changelog short.";
    const stitched = "Nothing closes until it passes review. We also agreed to keep the changelog short.";
    expect(snapQuoteToSource(stitched, turnText)).toBeNull();
  });

  it("rejects a quote with a dropped mid-sentence parenthetical (live case a69dc3bb) — coverage below 90%", () => {
    const turnText = "The loop stops at first connects (per the retry budget agreed earlier) and never retries.";
    const droppedParenthetical = "The loop stops at first connects and never retries.";
    expect(snapQuoteToSource(droppedParenthetical, turnText)).toBeNull();
  });

  it("rejects a quote containing a phrase never present in the source at all (live case c1920399)", () => {
    const turnText = "The owner prefers a strict review gate before anything passess to production.";
    // Same case as the source (normalizeQuote never folds case) but with a
    // fabricated middle clause AND the source's typo silently corrected —
    // two independent, disjoint short runs, neither close to 90% coverage.
    const fabricated = "The owner prefers an A/B quality gate before anything passes to production.";
    expect(snapQuoteToSource(fabricated, turnText)).toBeNull();
  });

  it("returns null when there is no overlap at all", () => {
    expect(snapQuoteToSource("completely unrelated text", "something else entirely")).toBeNull();
  });
});
