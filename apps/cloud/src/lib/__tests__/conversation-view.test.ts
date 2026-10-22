// Fixtures use a fictional tool ("CodeHub") per CLAUDE.md's scrub-list
// convention — never a real product name in example data.
import { describe, expect, it } from "vitest";
import { classifyMessage, isLongMessage, LONG_MESSAGE_CLAMP_CHARS } from "../conversation-view";

describe("classifyMessage", () => {
  it("a plain user message is conversational, not noise", () => {
    expect(classifyMessage("user", "How do I deploy CodeHub to staging?")).toEqual({ isNoise: false });
  });

  it("a plain assistant reply is conversational, not noise", () => {
    expect(classifyMessage("assistant", "Run `codehub deploy --env staging` from the repo root.")).toEqual({
      isNoise: false,
    });
  });

  it("Claude's legacy 'human' role is treated as conversational (pre-normalizer rows)", () => {
    expect(classifyMessage("human", "hey there")).toEqual({ isNoise: false });
  });

  it("a ChatGPT memory/system-context blob (content_type: user_editable_context) is noise", () => {
    const content = JSON.stringify({
      content_type: "user_editable_context",
      user_profile: "Works at CodeHub, prefers TypeScript.",
      user_instructions: "Be concise.",
    });
    expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "json-payload" });
  });

  it("a tool-call/tool-result JSON payload (no content_type, but tool marker keys) is noise", () => {
    const content = JSON.stringify({ tool_use_id: "toolu_01abc", is_error: false, output: "build succeeded" });
    expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "json-payload" });
  });

  it("the bracket-tagged tool_use/tool_result fallback shape is noise", () => {
    expect(classifyMessage("assistant", '[tool_use: Bash]\n{"command":"npm test"}')).toEqual({
      isNoise: true,
      reason: "bracket-tag",
    });
    expect(classifyMessage("assistant", "[tool_result]\nbuild succeeded")).toEqual({
      isNoise: true,
      reason: "bracket-tag",
    });
  });

  it("a fresh import's explicit closing marker (claude-export.ts) doesn't change the noise classification", () => {
    expect(classifyMessage("assistant", '[tool_use: Bash]\n{"command":"npm test"}\n[/tool_use]')).toEqual({
      isNoise: true,
      reason: "bracket-tag",
    });
    expect(classifyMessage("assistant", "[tool_result]\nbuild succeeded\n[/tool_result]")).toEqual({
      isNoise: true,
      reason: "bracket-tag",
    });
  });

  it("a lone unrecognized content part ([part: {...}] fragment) is noise", () => {
    expect(classifyMessage("assistant", '[part: {"asset_pointer":"file-service://abc"}]')).toEqual({
      isNoise: true,
      reason: "bracket-tag",
    });
  });

  it("an empty or whitespace-only message is noise", () => {
    expect(classifyMessage("user", "")).toEqual({ isNoise: true, reason: "empty" });
    expect(classifyMessage("user", "   \n\t  ")).toEqual({ isNoise: true, reason: "empty" });
  });

  it("a role outside (user, assistant, human) is noise regardless of content", () => {
    expect(classifyMessage("system", "You are CodeHub's support assistant.")).toEqual({
      isNoise: true,
      reason: "role",
    });
    expect(classifyMessage("unknown", "some content")).toEqual({ isNoise: true, reason: "role" });
  });

  it("role check is case-insensitive", () => {
    expect(classifyMessage("USER", "hello")).toEqual({ isNoise: false });
  });

  it("a real message that merely starts with '{' but isn't a noise-shaped object stays conversational", () => {
    // e.g. the user pasted a JSON snippet as part of a real question.
    const content = '{"foo": "bar", "count": 3}';
    expect(classifyMessage("user", content)).toEqual({ isNoise: false });
  });

  it("content starting with '{' that isn't valid JSON at all stays conversational (falls through, not thrown)", () => {
    expect(classifyMessage("user", "{ this is not json, just a brace in prose")).toEqual({ isNoise: false });
  });

  it("a real fenced code block (from ChatGPT's code-interpreter content_type) is NOT noise", () => {
    expect(classifyMessage("assistant", "```python\nprint('hello')\n```")).toEqual({ isNoise: false });
  });

  it("a hoisted artifact block (Claude tool_use with real file content) is NOT noise", () => {
    expect(
      classifyMessage("assistant", "[artifact: text/typescript — router.ts]\n```typescript\nexport {}\n```"),
    ).toEqual({
      isNoise: false,
    });
  });

  // Real shapes below found via a read-only corpus scan (psql, SELECT-only)
  // after browser-verifying a ChatGPT export; values scrubbed to fictional CodeHub content.
  describe("real corpus shapes (bracket-tag line followed by a JSON dump)", () => {
    it("ChatGPT's internal '[thoughts]' content_type (plural, distinct from Claude's [thinking]) is noise", () => {
      const content = [
        "[thoughts]",
        JSON.stringify({
          content_type: "thoughts",
          thoughts: [{ summary: "Weighing CodeHub's licensing question", content: "The user is asking about..." }],
        }),
      ].join("\n");
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "bracket-tag" });
    });

    it("ChatGPT's '[reasoning_recap]' card ('Thought for Ns') is noise", () => {
      const content = '[reasoning_recap]\n{"content_type":"reasoning_recap","content":"Thought for 12s"}';
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "bracket-tag" });
    });

    it("ChatGPT's '[tether_browsing_display]' internal browsing-tool state is noise", () => {
      const content =
        '[tether_browsing_display]\n{"content_type":"tether_browsing_display","result":"","summary":"","assets":null,"tether_id":null}';
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "bracket-tag" });
    });

    it("ChatGPT's '[app_pairing_content]' desktop app-pairing context is noise", () => {
      const content =
        '[app_pairing_content]\n{"content_type":"app_pairing_content","workspaces":[{"app_name":"iTerm2","title":"user@laptop:~/dev/codehub"}]}';
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "bracket-tag" });
    });

    it("ChatGPT's '[convo search]' internal memory-retrieval scratchpad is noise, even though the body is NOT JSON", () => {
      const content =
        "[convo search]\n[USER_FACT] [c0] U@2026-07-25T21:59:27Z, -4mo: user was discussing timelines at CodeHub; no stored dates about their own leave appear in retrieved context";
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "bracket-tag" });
    });

    it("a known noise tag is still noise even if its JSON body got cut off mid-object (the extension's 4000-char JSON.stringify slice)", () => {
      const truncated =
        '[thoughts]\n{"content_type":"thoughts","thoughts":[{"summary":"partial","content":"cut off here and no closing brace';
      expect(classifyMessage("assistant", truncated)).toEqual({ isNoise: true, reason: "bracket-tag" });
    });

    it("an UNENUMERATED bracket tag whose body parses as JSON is still noise (forward defense against a content_type we haven't seen yet)", () => {
      const content = '[some_future_content_type]\n{"content_type":"some_future_content_type","foo":"bar"}';
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: true, reason: "bracket-tag" });
    });

    it("exemptions still hold: [quote: ...] real document excerpts stay visible", () => {
      const content =
        "[quote: CodeHub_Pricing_Breakdown.pdf — https://codehub.example/files/1]\nCodeHub Pro is $29/mo per seat.";
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: false });
    });

    it("exemptions still hold: [asset: ...] inline attachment references stay visible", () => {
      expect(classifyMessage("assistant", "[asset: file-service://file-abc123]")).toEqual({ isNoise: false });
    });

    it("exemptions still hold: an unrelated bracket-prefixed message (e.g. tool output) with a non-JSON body stays visible", () => {
      expect(classifyMessage("assistant", "[eslint]\nsrc/components/TodoModal.js\n  12:3  warning  ...")).toEqual({
        isNoise: false,
      });
    });

    it("exemptions still hold: '[system_error]' plain-text diagnostic (not JSON) stays visible", () => {
      const content = "[system_error]\nEncountered exception: <class 'aiohttp.client_exceptions.ClientResponseError'>.";
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: false });
    });

    it("Claude's own '[thinking]' extended-reasoning transcript stays visible (plain text, not a system/memory blob)", () => {
      const content = "[thinking]\nThe user is asking whether the CodeHub Pro plan includes seat pooling...";
      expect(classifyMessage("assistant", content)).toEqual({ isNoise: false });
    });
  });
});

describe("isLongMessage", () => {
  it("false for a short message", () => {
    expect(isLongMessage("short")).toBe(false);
  });

  it("false right at the clamp boundary", () => {
    expect(isLongMessage("a".repeat(LONG_MESSAGE_CLAMP_CHARS))).toBe(false);
  });

  it("true just past the clamp boundary", () => {
    expect(isLongMessage("a".repeat(LONG_MESSAGE_CLAMP_CHARS + 1))).toBe(true);
  });

  it("false for empty/undefined-ish content", () => {
    expect(isLongMessage("")).toBe(false);
  });
});
