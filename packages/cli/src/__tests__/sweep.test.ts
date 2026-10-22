import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSweepState, readSweepState, type SweepState, validateSweepState, writeSweepState } from "../sweep.js";

describe("validateSweepState", () => {
  it("passes through a well-formed state", () => {
    const raw = { last_success_at: "2026-08-24T12:00:00Z", run_count: 7, runs_since_full_walk: 2 };
    expect(validateSweepState(raw)).toEqual(raw);
  });

  it("defaults every field when raw isn't an object", () => {
    expect(validateSweepState(null)).toEqual(defaultSweepState());
    expect(validateSweepState("nonsense")).toEqual(defaultSweepState());
  });

  it("drops a last_success_at that doesn't match the expected ISO shape", () => {
    const state = validateSweepState({ last_success_at: "not-iso", run_count: 3, runs_since_full_walk: 1 });
    expect(state.last_success_at).toBe("");
    expect(state.run_count).toBe(3);
  });

  it("resets a negative or non-integer counter to 0", () => {
    expect(validateSweepState({ run_count: -5 }).run_count).toBe(0);
    expect(validateSweepState({ run_count: 1.5 }).run_count).toBe(0);
    expect(validateSweepState({ runs_since_full_walk: "3" }).runs_since_full_walk).toBe(0);
  });
});

describe("readSweepState / writeSweepState round-trip", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "membral-sweep-state-"));
    statePath = join(dir, "nested", "sweep-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the default state when the file doesn't exist", async () => {
    expect(await readSweepState(statePath)).toEqual(defaultSweepState());
  });

  it("writes then reads back the same state (creating parent dirs as needed)", async () => {
    const state: SweepState = { last_success_at: "2026-08-24T12:00:00Z", run_count: 4, runs_since_full_walk: 1 };
    await writeSweepState(statePath, state);
    expect(await readSweepState(statePath)).toEqual(state);
  });

  it("degrades to the default state on malformed JSON rather than throwing", async () => {
    await writeSweepState(statePath, defaultSweepState());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(statePath, "{ not valid json", "utf8");
    expect(await readSweepState(statePath)).toEqual(defaultSweepState());
  });
});
