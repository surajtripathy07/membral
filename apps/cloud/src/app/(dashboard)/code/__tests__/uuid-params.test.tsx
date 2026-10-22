// /code/[projectId] and /code/session/[sessionId]: a non-uuid segment is a
// 404 before any query runs (it used to reach Postgres and 500 on the uuid cast).
import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: (...a: unknown[]) => createClient(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

import CodeProjectPage from "../[projectId]/page";
import ConversationDetailPage from "../../conversations/[id]/page";
import CodeSessionPage from "../session/[sessionId]/page";

const UUID = "3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f";

describe("code routes validate their uuid param", () => {
  beforeEach(() => {
    createClient.mockReset();
    createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null } }) } });
  });

  it("/code/issues and friends are notFound(), with no query", async () => {
    for (const bad of ["issues", "not-a-uuid", `${UUID}x`, "' or 1=1"]) {
      await expect(CodeProjectPage({ params: Promise.resolve({ projectId: bad }) })).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(
        CodeSessionPage({ params: Promise.resolve({ sessionId: bad }), searchParams: Promise.resolve({}) }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
    }
    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: "issues" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("a uuid proceeds to the normal path (here: signed out → /login)", async () => {
    await expect(CodeProjectPage({ params: Promise.resolve({ projectId: UUID }) })).rejects.toThrow("NEXT_REDIRECT /login");
    await expect(
      CodeSessionPage({ params: Promise.resolve({ sessionId: UUID }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT /login");
  });
});
