import { describe, expect, expectTypeOf, it } from "vitest";
import * as writeModule from "@/lib/memory/write";
import {
  CROSS_SESSION_DUP_COSINE_THRESHOLD,
  RECURRENCE_COSINE_THRESHOLD,
  RECURRENCE_KINDS,
  RECURRENCE_OFFER_SCAN_LIMIT,
} from "../recurrence";

describe("domain/recurrence (G2 2.2d)", () => {
  it("pins every value", () => {
    expect(CROSS_SESSION_DUP_COSINE_THRESHOLD).toBe(0.94);
    expect(RECURRENCE_COSINE_THRESHOLD).toBe(0.8);
    expect(RECURRENCE_KINDS).toEqual(["blocker"]);
    expect(RECURRENCE_OFFER_SCAN_LIMIT).toBe(200);
  });

  it("pins the types", () => {
    expectTypeOf(RECURRENCE_KINDS).toEqualTypeOf<readonly string[]>();
    expectTypeOf(RECURRENCE_COSINE_THRESHOLD).toEqualTypeOf<number>();
  });

  it("write.ts re-exports the same bindings it exported before", () => {
    expect(writeModule.CROSS_SESSION_DUP_COSINE_THRESHOLD).toBe(CROSS_SESSION_DUP_COSINE_THRESHOLD);
    expect(writeModule.RECURRENCE_COSINE_THRESHOLD).toBe(RECURRENCE_COSINE_THRESHOLD);
    expect(writeModule.RECURRENCE_KINDS).toBe(RECURRENCE_KINDS);
  });
});
