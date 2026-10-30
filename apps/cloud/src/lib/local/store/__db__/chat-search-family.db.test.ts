// Migration 139: chat search by embedding family. A null family is the old behaviour; a set family
// restricts the vector legs to that family's rows and cuts them at p_min_similarity.
import { beforeAll, describe, expect, it } from "vitest";
import { type DbEnv, openDb } from "../../../../../test/db-store";

let env: DbEnv;
let svc: ReturnType<DbEnv["client"]>;
let user: string;
const ids: Record<string, string> = {};

const vec = (...head: number[]) => `[${[...head, ...new Array(1536 - head.length).fill(0)].join(",")}]`;
const QUERY = JSON.parse(vec(1));

beforeAll(async () => {
  env = await openDb();
  svc = env.client(env.keys.service);
  user = await env.newUser();
  // cosine to the query [1,0,...]: exact = 1.0, near = 0.8, far = 0.5
  const rows: [string, string, string | null, string][] = [
    ["nomic-exact", "n-exact", "nomic-embed-text", vec(1)],
    ["nomic-near", "n-near", "nomic-embed-text", vec(0.8, 0.6)],
    ["nomic-far", "n-far", "nomic-embed-text", vec(0.5, Math.sqrt(0.75))],
    ["default-exact", "d-exact", null, vec(1)],
  ];
  for (const [key, srcId, model, v] of rows) {
    const r = await env.query(
      "insert into conversations(user_id,source,source_id,title,embedding,embedding_model) values ($1,'chatgpt',$2,$3,$4::vector,$5) returning id",
      [user, srcId, key, v, model],
    );
    ids[key] = String(r[0]?.id);
  }
}, 300_000);

const titles = async (extra: Record<string, unknown>) => {
  const r = await svc.rpc(
    "search_conversations" as never,
    {
      query_text: "zzzunmatchedkeyword",
      query_embedding: QUERY,
      match_count: 20,
      search_user_id: user,
      p_lane: "all",
      ...extra,
    } as never,
  );
  expect(r.error, JSON.stringify(r.error)).toBeNull();
  return ((r.data ?? []) as { title: string }[]).map((x) => x.title).sort();
};

describe("search_conversations family args (139)", () => {
  it("null family: every row over the 0.3 default cut, any model (unchanged)", async () => {
    expect(await titles({})).toEqual(["default-exact", "nomic-exact", "nomic-far", "nomic-near"]);
  });
  it("nomic family at 0.68: only nomic rows at or above the cut", async () => {
    expect(await titles({ p_embedding_model: "nomic-embed-text", p_min_similarity: 0.68 })).toEqual([
      "nomic-exact",
      "nomic-near",
    ]);
  });
  it("nomic family without a cut keeps the 0.3 default", async () => {
    expect(await titles({ p_embedding_model: "nomic-embed-text" })).toEqual(["nomic-exact", "nomic-far", "nomic-near"]);
  });
  it("a null-model row counts as the default family", async () => {
    expect(await titles({ p_embedding_model: "text-embedding-3-small", p_min_similarity: 0.68 })).toEqual([
      "default-exact",
    ]);
  });
  it("a keyword hit is kept whatever its cosine", async () => {
    await env.query("update conversations set title = 'zzzunmatchedkeyword far' where id = $1", [ids["nomic-far"]]);
    const t = await titles({ p_embedding_model: "nomic-embed-text", p_min_similarity: 0.68 });
    expect(t).toContain("zzzunmatchedkeyword far");
    expect(t).toHaveLength(3);
  });
});

describe("mcp_search_unified family args (139)", () => {
  const unified = async (extra: Record<string, unknown>) => {
    const r = await svc.rpc(
      "mcp_search_unified" as never,
      {
        p_user_id: user,
        p_query: "qqqnothingmatches",
        p_query_embedding: QUERY,
        p_limit: 20,
        p_scope_id: null,
        p_include_code: false,
        p_since: null,
        ...extra,
      } as never,
    );
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return JSON.stringify(r.data ?? []);
  };
  it("restricts the vector legs to the family and cuts at p_min_similarity", async () => {
    const all = await unified({});
    expect(all).toContain(ids["default-exact"]);
    expect(all).toContain(ids["nomic-far"]);
    const nomic = await unified({ p_embedding_model: "nomic-embed-text", p_min_similarity: 0.68 });
    expect(nomic).toContain(ids["nomic-exact"]);
    expect(nomic).toContain(ids["nomic-near"]);
    expect(nomic).not.toContain(ids["nomic-far"]);
    expect(nomic).not.toContain(ids["default-exact"]);
  });
});
