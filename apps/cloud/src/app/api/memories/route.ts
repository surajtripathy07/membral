import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import type { MemoryType } from "@/lib/database.types";
import { insertMemories, listMemoriesByConfidence } from "@/lib/memory/queries";
import { userBucket } from "@/lib/rate-limit";

const VALID_TYPES = ["decision", "preference", "pattern", "insight"] as const;

export const GET = withRoute(
  {
    auth: { kind: "bearer", missing: "Unauthorized", invalid: "Unauthorized" },
    rateLimit: { name: "memories", bucket: ({ user }) => userBucket("memories", user.id) },
  },
  async ({ req, user, supabase }) => {
    const { searchParams } = new URL(req.url);

    const type = searchParams.get("type");
    const minConfidence = searchParams.get("min_confidence");
    const search = searchParams.get("q");
    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;

    const validType = type && VALID_TYPES.includes(type as (typeof VALID_TYPES)[number]) ? type : null;

    let validMinConfidence: number | null = null;
    if (minConfidence) {
      const mc = parseFloat(minConfidence);
      if (!Number.isNaN(mc)) {
        validMinConfidence = mc;
      }
    }

    const { data, error } = await listMemoriesByConfidence(
      supabase,
      user.id,
      limit,
      validType,
      validMinConfidence,
      search,
    );

    if (error) {
      return NextResponse.json({ error: "Failed to fetch memories", detail: error.message }, { status: 500 });
    }

    return NextResponse.json({
      memories: data,
      count: data?.length ?? 0,
    });
  },
);

export const POST = withRoute(
  {
    auth: { kind: "bearer", missing: "Unauthorized", invalid: "Unauthorized" },
    rateLimit: { name: "memories", bucket: ({ user }) => userBucket("memories", user.id) },
  },
  async ({ req, user, supabase }) => {
    let body: {
      memories: Array<{
        type: string;
        content: string;
        confidence?: number;
        tags?: string[];
        source_conversation_ids?: string[];
      }>;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.memories || !Array.isArray(body.memories) || body.memories.length === 0) {
      return NextResponse.json({ error: "Request body must contain a non-empty 'memories' array" }, { status: 400 });
    }

    const rows = body.memories
      .filter((m) => m.type && VALID_TYPES.includes(m.type as (typeof VALID_TYPES)[number]) && m.content)
      .map((m) => ({
        user_id: user.id,
        type: m.type as MemoryType,
        content: m.content,
        confidence: Math.min(1, Math.max(0, m.confidence ?? 0.5)),
        tags: m.tags ?? [],
        source_conversation_ids: m.source_conversation_ids ?? [],
      }));

    if (rows.length === 0) {
      return NextResponse.json({ error: "No valid memories in request" }, { status: 400 });
    }

    const { data, error } = await insertMemories(supabase, rows);

    if (error) {
      return NextResponse.json({ error: "Failed to store memories", detail: error.message }, { status: 500 });
    }

    return NextResponse.json({ memories: data, count: data?.length ?? 0 }, { status: 201 });
  },
);
