// A ?turn=N load renders only [N-15, N+50]; the edge links reach the windows either side.
import { describe, expect, it } from "vitest";
import { windowEdgeLinks } from "../window-edges";

describe("windowEdgeLinks", () => {
  it("near 0: no earlier link; later lands on the next turn", () => {
    expect(windowEdgeLinks("s", { from: 0, to: 55, hasLater: true })).toEqual({
      earlier: null,
      later: "/code/session/s?turn=71#turn-56",
    });
  });
  it("middle: both links land on the turn next to the window", () => {
    expect(windowEdgeLinks("s", { from: 96, to: 161, hasLater: true })).toEqual({
      earlier: "/code/session/s?turn=45#turn-95",
      later: "/code/session/s?turn=177#turn-162",
    });
  });
  it("near the end: no later link when no row exists past the window", () => {
    expect(windowEdgeLinks("s", { from: 1105, to: 1131, hasLater: false }).later).toBeNull();
    expect(windowEdgeLinks("s", { from: 10, to: 40, hasLater: false }).earlier).toBe("/code/session/s?turn=0#turn-9");
  });
});
