// Shared helpers for the persona fixture scripts (membral-fwz / membral-b8w):
// service client, demo-user management, corpus load/import, and the
// graph-snapshot builder used by snapshot.ts and the multi-scale sweep.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Conversation } from "@membral/core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { validateConversations } from "../../apps/cloud/src/lib/sync-validator";

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(HERE, "../../apps/cloud/.env.local") });

export const CORPUS_DIR = resolve(HERE, "corpus");
export const DEFAULT_DEMO_EMAIL = "tusk-demo@membral.demo";
export const IMPORT_BATCH_SIZE = 50;
const PAGE = 1000;

export function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars (apps/cloud/.env.local)");
  return createClient(url, key);
}

/** Find or create an auth user by email (re-runnable). Returns the user id. */
export async function ensureUser(supabase: SupabaseClient, email: string): Promise<string> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email === email);
    if (hit) {
      console.log(`[persona] user exists: ${email} -> ${hit.id}`);
      return hit.id;
    }
    if (data.users.length < 100) break;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: randomBytes(24).toString("base64url"),
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  console.log(`[persona] created user: ${email} -> ${data.user.id}`);
  return data.user.id;
}

/** Read + validate the whole fixture corpus, sorted by filename (= source_id order). */
export function loadCorpus(): Conversation[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const raw = files.map((f) => JSON.parse(readFileSync(resolve(CORPUS_DIR, f), "utf8")));
  const { valid, errors } = validateConversations(raw);
  if (errors.length > 0) {
    throw new Error(`[persona] ${errors.length} invalid conversations:\n${errors.join("\n")}`);
  }
  return valid;
}

/** Upsert conversations for a user — same rows and conflict target as the import route. */
export async function importConversations(
  supabase: SupabaseClient,
  userId: string,
  convs: Conversation[],
): Promise<number> {
  let imported = 0;
  for (let i = 0; i < convs.length; i += IMPORT_BATCH_SIZE) {
    const batch = convs.slice(i, i + IMPORT_BATCH_SIZE);
    const rows = batch.map((c) => ({
      user_id: userId,
      source: c.source,
      source_id: c.source_id,
      title: c.title || "Untitled",
      created_at: c.created_at,
      updated_at: c.updated_at,
      model: c.model,
      messages: c.messages,
      metadata: c.metadata,
      synced_at: c.synced_at,
    }));
    const { error } = await supabase.from("conversations").upsert(rows, {
      onConflict: "user_id,source,source_id",
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`batch ${Math.floor(i / IMPORT_BATCH_SIZE) + 1} upsert failed: ${error.message}`);
    imported += batch.length;
  }
  return imported;
}

// ---------------------------------------------------------------------------
// Graph snapshot (extracted from snapshot.ts so the sweep can reuse it)
// ---------------------------------------------------------------------------

export interface NodeRow {
  id: string;
  type: string;
  kind: string | null;
  label: string;
  status: string | null;
  confidence: number | null;
  props: Record<string, unknown>;
  source_conversation_id: string | null;
}

export interface EdgeRow {
  src_id: string;
  dst_id: string;
  rel_type: string;
  confidence: number | null;
}

export interface SnapshotConversation {
  label: string;
  purpose: string;
  rel_type: string;
  source_id: string | null;
  entities: { label: string; type: string; rel_type: string }[];
}

export interface SnapshotItem {
  label: string;
  type: string;
  kind: string | null;
  status: string | null;
  items: SnapshotItem[];
  conversations: SnapshotConversation[];
}

export interface SnapshotOrphan {
  label: string;
  purpose: string;
  source_id: string | null;
  entities: { label: string; type: string; rel_type: string }[];
}

export interface SnapshotEntity {
  label: string;
  type: string;
  kind: string | null;
  mentions: number;
}

export interface GraphSnapshot {
  demo_persona: string;
  user_email: string;
  user_id: string;
  generated_at: string;
  stats: {
    nodes: number;
    edges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
    orphans: number;
  };
  life_areas: SnapshotItem[];
  orphans: SnapshotOrphan[];
  entities: SnapshotEntity[];
}

export async function selectAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(`query failed: ${JSON.stringify(error)}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** Query the kg_* tables for a user and build the areas/items/conversations/entities snapshot. */
export async function buildSnapshot(supabase: SupabaseClient, userId: string, email: string): Promise<GraphSnapshot> {
  const nodes = await selectAll<NodeRow>((from, to) =>
    supabase
      .from("kg_nodes")
      .select("id, type, kind, label, status, confidence, props, source_conversation_id")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("id")
      .range(from, to),
  );
  const edges = await selectAll<EdgeRow>((from, to) =>
    supabase
      .from("kg_edges")
      .select("src_id, dst_id, rel_type, confidence")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("id")
      .range(from, to),
  );
  const convSourceIds = await selectAll<{ id: string; source_id: string }>((from, to) =>
    supabase.from("conversations").select("id, source_id").eq("user_id", userId).order("id").range(from, to),
  );
  const sourceIdByConv = new Map(convSourceIds.map((c) => [c.id, c.source_id]));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const skeletonTypes = new Set(["LifeArea", "Item"]);
  const entityTypes = new Set(["Person", "Organization", "Tool", "Artifact"]);

  // contains edges among skeleton nodes -> tree
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    if (e.rel_type !== "contains") continue;
    const src = byId.get(e.src_id);
    const dst = byId.get(e.dst_id);
    if (!src || !dst || !skeletonTypes.has(src.type) || !skeletonTypes.has(dst.type)) continue;
    childrenOf.set(e.src_id, [...(childrenOf.get(e.src_id) ?? []), e.dst_id]);
    hasParent.add(e.dst_id);
  }

  // conversation attachments: conv node -> skeleton node
  const convsUnder = new Map<string, { conv: NodeRow; rel: string }[]>();
  for (const e of edges) {
    const src = byId.get(e.src_id);
    const dst = byId.get(e.dst_id);
    if (!src || !dst || src.type !== "Conversation" || !skeletonTypes.has(dst.type)) continue;
    convsUnder.set(e.dst_id, [...(convsUnder.get(e.dst_id) ?? []), { conv: src, rel: e.rel_type }]);
  }

  // entity mentions: conv node -> entity node
  const entitiesOfConv = new Map<string, { label: string; type: string; rel_type: string }[]>();
  const entityMentions = new Map<string, number>();
  for (const e of edges) {
    const src = byId.get(e.src_id);
    const dst = byId.get(e.dst_id);
    if (!src || !dst || src.type !== "Conversation" || !entityTypes.has(dst.type)) continue;
    entitiesOfConv.set(e.src_id, [
      ...(entitiesOfConv.get(e.src_id) ?? []),
      { label: dst.label, type: dst.type, rel_type: e.rel_type },
    ]);
    entityMentions.set(dst.id, (entityMentions.get(dst.id) ?? 0) + 1);
  }

  function buildItem(id: string, seen: ReadonlySet<string> = new Set()): SnapshotItem {
    const n = byId.get(id);
    if (!n) throw new Error(`dangling skeleton node ${id}`);
    // Guard against contains-cycles (observed in real output): never revisit an ancestor.
    const next = new Set(seen).add(id);
    return {
      label: n.label,
      type: n.type,
      kind: n.kind,
      status: n.status,
      items: (childrenOf.get(id) ?? []).filter((c) => !next.has(c)).map((c) => buildItem(c, next)),
      conversations: (convsUnder.get(id) ?? []).map(({ conv, rel }) => ({
        label: conv.label,
        purpose: String(conv.props?.purpose ?? "other"),
        rel_type: rel,
        source_id: conv.source_conversation_id ? (sourceIdByConv.get(conv.source_conversation_id) ?? null) : null,
        entities: entitiesOfConv.get(conv.id) ?? [],
      })),
    };
  }

  const lifeAreas = nodes.filter((n) => n.type === "LifeArea" && !hasParent.has(n.id)).map((n) => buildItem(n.id));
  const orphanNodes = nodes.filter((n) => n.type === "Conversation" && n.props?.orphan === true);
  const orphans = orphanNodes.map((n) => ({
    label: n.label,
    purpose: String(n.props?.purpose ?? "other"),
    source_id: n.source_conversation_id ? (sourceIdByConv.get(n.source_conversation_id) ?? null) : null,
    entities: entitiesOfConv.get(n.id) ?? [],
  }));

  const entities = nodes
    .filter((n) => entityTypes.has(n.type))
    .map((n) => ({ label: n.label, type: n.type, kind: n.kind, mentions: entityMentions.get(n.id) ?? 0 }))
    .sort((a, b) => b.mentions - a.mentions);

  const edgesByType: Record<string, number> = {};
  for (const e of edges) edgesByType[e.rel_type] = (edgesByType[e.rel_type] ?? 0) + 1;
  const nodesByType: Record<string, number> = {};
  for (const n of nodes) nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;

  return {
    demo_persona: "elon-tusk (synthetic — see fixtures/persona/README.md)",
    user_email: email,
    user_id: userId,
    generated_at: new Date().toISOString(),
    stats: { nodes: nodes.length, edges: edges.length, nodesByType, edgesByType, orphans: orphans.length },
    life_areas: lifeAreas,
    orphans,
    entities,
  };
}

/** Conversations in an item's whole subtree. */
export function countConvs(item: SnapshotItem): number {
  return item.conversations.length + item.items.reduce((s, i) => s + countConvs(i), 0);
}

/** Items in an item's whole subtree (excluding itself). */
export function countItems(item: SnapshotItem): number {
  return item.items.length + item.items.reduce((s, i) => s + countItems(i), 0);
}
