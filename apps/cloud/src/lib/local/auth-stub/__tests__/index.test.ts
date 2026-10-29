import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/clients", () => ({ getServiceClient: vi.fn(() => ({})) }));
vi.mock("../store", () => ({ createRpcStore: vi.fn(() => ({})) }));

import { handleLocalAuth } from "../index";

afterEach(() => vi.unstubAllEnvs());

const get = (host: string) => handleLocalAuth(new Request("http://x/auth/v1/user", { headers: { host } }), ["user"]);

describe("handleLocalAuth wiring", () => {
  it("with PORT unset still requires a loopback hostname, on any port", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", "test-secret");
    vi.stubEnv("PORT", "");
    expect((await get("evil.example:3001")).status).toBe(403);
    expect((await get("127.0.0.1:9999")).status).toBe(401);
    expect((await get("localhost")).status).toBe(401);
  });

  it("with PORT set also pins the port", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", "test-secret");
    vi.stubEnv("PORT", "3001");
    expect((await get("127.0.0.1:9999")).status).toBe(403);
    expect((await get("127.0.0.1:3001")).status).toBe(401);
  });
});
