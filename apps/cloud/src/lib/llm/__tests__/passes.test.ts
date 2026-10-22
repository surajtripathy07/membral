import { describe, expectTypeOf, it } from "vitest";
import type { PassName as KgPassName } from "@/lib/llm/passes";
import type { PassName } from "../passes";

// Type-level pin (refactor programme step 1.1, lock-extend): the PassName
// union is recorded on every cost row, so its literals must never drift.
describe("PassName", () => {
  it("is exactly the persisted pass literals", () => {
    expectTypeOf<PassName>().toEqualTypeOf<
      | "pass1"
      | "pass1_chunk"
      | "embed"
      | "stage_a_name"
      | "stage_a_consolidate"
      | "stage_b_attach"
      | "code_session_summary"
      | "code_session_title"
      | "code_project_rollup"
      | "conversation_embedding"
      | "query_embedding"
      | "chunk_embedding"
      | "pass1b_code"
      | "g3_retry"
      | "claims_verify"
      | "memory_backfill"
      | "session_assoc"
      | "memory_embedding"
    >();
    expectTypeOf<KgPassName>().toEqualTypeOf<PassName>();
  });
});
