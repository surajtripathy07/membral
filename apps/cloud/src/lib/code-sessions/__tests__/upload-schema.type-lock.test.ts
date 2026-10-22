// Compile-only lock between the POST /api/code-sessions schema (payload.ts)
// and core's `RawCodeSession`, the type the CLI uploads (programme decision
// M6(a): checked in cloud; core keeps zero runtime deps). `tsc --noEmit`
// (npx turbo typecheck) is the check; the vitest case below only keeps the
// file a valid test module.
//
// #209: the schema is narrowed to core's unions (verb, source, refKind,
// nonOwner and the `true` literals come from core's own runtime lists), so the
// lock is now mutual: the schema's INPUT type equals core's type exactly. Its
// OUTPUT equals core's type minus the two LOCAL-ONLY ForgeAction fields (`dir`,
// `shownRepo`), which the schema accepts and strips so they are never stored.
import type { ForgeAction, RawCodeSession, RawTurn } from "@membral/core";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ForgeActionSchema, RawCodeSessionSchema, RawTurnSchema } from "../payload";

// Exact type equality (mutual assignability is too loose for optional/readonly
// differences; this form fails on any of them).
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertEqual = <A, B>(proof: Equals<A, B>): Equals<A, B> => proof;

type UploadedForgeAction = Omit<ForgeAction, "dir" | "shownRepo">;
type UploadedTurn = Omit<RawTurn, "action" | "actions"> & {
  action?: UploadedForgeAction;
  actions?: UploadedForgeAction[];
};

const inputLocks = [
  assertEqual<z.input<typeof ForgeActionSchema>, ForgeAction>(true),
  assertEqual<z.input<typeof RawTurnSchema>, RawTurn>(true),
  assertEqual<z.input<typeof RawCodeSessionSchema>, RawCodeSession>(true),
];

const outputLocks = [
  assertEqual<z.output<typeof ForgeActionSchema>, UploadedForgeAction>(true),
  assertEqual<Omit<z.output<typeof RawTurnSchema>, "action" | "actions">, Omit<UploadedTurn, "action" | "actions">>(
    true,
  ),
];

// What the importer receives is always something core could have produced.
const schemaSessionFitsCore = (s: z.output<typeof RawCodeSessionSchema>): RawCodeSession => s;
const schemaTurnFitsCore = (t: z.output<typeof RawTurnSchema>): RawTurn => t;

describe("upload schema type-lock (compile-only)", () => {
  it("is enforced by tsc; the assertions exist at type level", () => {
    expect([...inputLocks, ...outputLocks, schemaSessionFitsCore, schemaTurnFitsCore]).toHaveLength(7);
  });
});
