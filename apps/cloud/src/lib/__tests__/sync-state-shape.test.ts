import { describe, expect, it } from "vitest";
import {
  type RawChatSourceSignal,
  type RawCodeHarnessSignal,
  shapeChatSource,
  shapeCodeHarness,
  shapeSyncState,
} from "../sync-state-shape";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const isoMinutesAgo = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function chatSignal(overrides: Partial<RawChatSourceSignal> = {}): RawChatSourceSignal {
  return {
    source: "claude",
    conversations: 0,
    lastItemAt: null,
    lastRunAt: null,
    hasEverSeen: false,
    ...overrides,
  };
}

describe("shapeChatSource", () => {
  it("never-synced source: never state, no note", () => {
    const out = shapeChatSource(chatSignal(), NOW);
    expect(out.state).toBe("never");
    expect(out.note).toBeUndefined();
    expect(out.conversations).toBe(0);
  });

  it("quiet source gets an explanatory note", () => {
    const out = shapeChatSource(
      chatSignal({ hasEverSeen: true, lastRunAt: isoMinutesAgo(10), lastItemAt: null, conversations: 3 }),
      NOW,
    );
    expect(out.state).toBe("quiet");
    expect(out.note).toMatch(/no new items/);
  });

  it("idle source: no note", () => {
    const out = shapeChatSource(
      chatSignal({
        hasEverSeen: true,
        lastRunAt: isoMinutesAgo(120),
        lastItemAt: isoMinutesAgo(120),
        conversations: 40,
      }),
      NOW,
    );
    expect(out.state).toBe("idle");
    expect(out.note).toBeUndefined();
  });
});

describe("shapeCodeHarness", () => {
  it("hasEverSeen derives from hasHeartbeat OR sessions > 0 (pre-heartbeat data still counts)", () => {
    const raw: RawCodeHarnessSignal = {
      harness: "claude-code",
      projects: 2,
      sessions: 5,
      lastSessionAt: isoMinutesAgo(5000), // old — no heartbeat, so this must read stale, not never
      lastRunAt: null,
      hasHeartbeat: false,
    };
    const out = shapeCodeHarness(raw, NOW);
    expect(out.state).toBe("stale");
  });

  it("zero sessions and no heartbeat: never", () => {
    const raw: RawCodeHarnessSignal = {
      harness: "claude-code",
      projects: 0,
      sessions: 0,
      lastSessionAt: null,
      lastRunAt: null,
      hasHeartbeat: false,
    };
    expect(shapeCodeHarness(raw, NOW).state).toBe("never");
  });
});

describe("shapeSyncState", () => {
  it("assembles the full response shape from raw signals", () => {
    const result = shapeSyncState(
      {
        chat: [
          chatSignal({
            source: "claude",
            hasEverSeen: true,
            conversations: 10,
            lastRunAt: isoMinutesAgo(1),
            lastItemAt: isoMinutesAgo(1),
          }),
        ],
        code: [],
      },
      NOW,
    );
    expect(result.chat).toHaveLength(1);
    expect(result.chat[0].source).toBe("claude");
    expect(result.code).toEqual([]);
  });
});
