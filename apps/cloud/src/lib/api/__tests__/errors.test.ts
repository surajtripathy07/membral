import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { apiError } from "../errors";

describe("apiError", () => {
  it("matches the inline NextResponse.json({ error }, { status }) pattern exactly", async () => {
    const inline = NextResponse.json({ error: "Invalid token" }, { status: 401 });
    const helper = apiError(401, "Invalid token");

    expect(helper.status).toBe(inline.status);
    expect(helper.headers.get("content-type")).toBe(inline.headers.get("content-type"));
    expect(await helper.json()).toEqual(await inline.json());
  });

  it("passes through extra ResponseInit fields, same as spreading into the inline call", async () => {
    const helper = apiError(500, "Database error", { headers: { "x-test": "1" } });
    expect(helper.status).toBe(500);
    expect(helper.headers.get("x-test")).toBe("1");
    expect(await helper.json()).toEqual({ error: "Database error" });
  });
});
