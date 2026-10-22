import { describe, expect, it } from "vitest";
import { detectExportProvider } from "../../importers/detect.js";

describe("detectExportProvider", () => {
  it("detects a ChatGPT export by mapping + current_node shape", () => {
    const json = [{ id: "c1", mapping: {}, current_node: "n1" }];
    expect(detectExportProvider(json)).toBe("chatgpt");
  });

  it("detects a Claude export by chat_messages + uuid shape", () => {
    const json = [{ uuid: "u1", chat_messages: [] }];
    expect(detectExportProvider(json)).toBe("claude");
  });

  it("samples past a leading degenerate/empty entry", () => {
    const json = [{}, null, { id: "c1", mapping: {}, current_node: "n1" }];
    expect(detectExportProvider(json)).toBe("chatgpt");
  });

  it("returns null for an empty array", () => {
    expect(detectExportProvider([])).toBeNull();
  });

  it("returns null for a non-array root", () => {
    expect(detectExportProvider({ mapping: {} })).toBeNull();
    expect(detectExportProvider(null)).toBeNull();
    expect(detectExportProvider("not json")).toBeNull();
  });

  it("returns null when neither shape is recognized within the sample window", () => {
    const json = [{ foo: "bar" }, { another: "thing" }];
    expect(detectExportProvider(json)).toBeNull();
  });
});
