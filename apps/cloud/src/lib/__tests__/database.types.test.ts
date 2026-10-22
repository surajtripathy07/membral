import type { Conversation, Message } from "@membral/core";
import { describe, expect, it } from "vitest";
import type {
  ConversationInsert,
  ConversationRow,
  Database,
  ExtractedMetadata,
  MessageJson,
  Profile,
  SearchResult,
} from "../database.types";

describe("database types", () => {
  it("ConversationRow is structurally compatible with core Conversation", () => {
    // A ConversationRow should have every field a core Conversation has
    const row: ConversationRow = {
      id: "abc-123",
      user_id: "user-1",
      source: "chatgpt",
      source_id: "conv-ext-1",
      title: "Test conversation",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: "Hello",
          timestamp: "2025-01-01T00:00:00Z",
          metadata: {},
        },
      ],
      metadata: { foo: "bar" },
      synced_at: "2025-01-02T12:00:00Z",
      embedding: null,
      fts: null,
    };

    // Extract the core-compatible subset — must compile without errors
    const coreConversation: Conversation = {
      id: row.id,
      source: row.source,
      source_id: row.source_id,
      title: row.title,
      created_at: row.created_at,
      updated_at: row.updated_at,
      model: row.model,
      messages: row.messages,
      metadata: row.metadata,
      synced_at: row.synced_at,
    };

    expect(coreConversation.id).toBe(row.id);
    expect(coreConversation.source).toBe(row.source);
    expect(coreConversation.messages).toHaveLength(1);
  });

  it("MessageJson is structurally compatible with core Message", () => {
    const dbMessage: MessageJson = {
      role: "assistant",
      content: "Hi there!",
      timestamp: null,
      metadata: { model: "gpt-4o" },
    };

    const coreMessage: Message = dbMessage;

    expect(coreMessage.role).toBe("assistant");
    expect(coreMessage.content).toBe("Hi there!");
  });

  it("mock conversation satisfies ConversationInsert", () => {
    const insert: ConversationInsert = {
      user_id: "user-1",
      source: "claude",
      source_id: "conv-456",
      title: "My Claude chat",
      messages: [
        {
          role: "user",
          content: "Explain monads",
          timestamp: "2025-03-01T10:00:00Z",
          metadata: {},
        },
        {
          role: "assistant",
          content: "A monad is...",
          timestamp: "2025-03-01T10:00:01Z",
          metadata: {},
        },
      ],
      metadata: {},
    };

    expect(insert.user_id).toBe("user-1");
    expect(insert.source).toBe("claude");
    expect(insert.messages).toHaveLength(2);
    // Optional fields should be absent
    expect(insert.id).toBeUndefined();
    expect(insert.embedding).toBeUndefined();
  });

  it("Database type has expected table structure", () => {
    // Compile-time check: we can reference all tables
    type Tables = Database["public"]["Tables"];
    type ProfileRow = Tables["profiles"]["Row"];
    type _ConvoRow = Tables["conversations"]["Row"];
    type _MetaRow = Tables["extracted_metadata"]["Row"];

    // Runtime: verify the types resolve to concrete shapes
    // Pick: the generated Row also carries api-key columns this test ignores.
    const profile: Pick<
      ProfileRow,
      | "id"
      | "email"
      | "display_name"
      | "tier"
      | "conversation_limit"
      | "stripe_customer_id"
      | "stripe_subscription_id"
      | "created_at"
      | "updated_at"
    > = {
      id: "user-1",
      email: "test@example.com",
      display_name: "Test User",
      tier: "free",
      conversation_limit: 100,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    expect(profile.tier).toBe("free");
    expect(profile.conversation_limit).toBe(100);
  });

  it("Profile tier is constrained to free or pro", () => {
    const freeProfile: Profile = {
      id: "u1",
      email: null,
      display_name: null,
      tier: "free",
      conversation_limit: 100,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    const proProfile: Profile = {
      ...freeProfile,
      tier: "pro",
      conversation_limit: 10000,
    };

    expect(freeProfile.tier).toBe("free");
    expect(proProfile.tier).toBe("pro");
  });

  it("ExtractedMetadata has all expected array fields", () => {
    const meta: ExtractedMetadata = {
      id: "em-1",
      conversation_id: "conv-1",
      summary: "A discussion about TypeScript",
      topics: ["typescript", "types"],
      entities: ["TypeScript", "JavaScript"],
      questions: ["How do generics work?"],
      decisions: ["Use strict mode"],
      conversation_type: "coding",
      extracted_at: "2025-01-01T00:00:00Z",
    };

    expect(meta.topics).toContain("typescript");
    expect(meta.entities).toHaveLength(2);
    expect(meta.conversation_type).toBe("coding");
  });

  it("SearchResult matches expected hybrid search output", () => {
    const result: SearchResult = {
      id: "conv-1",
      source: "chatgpt",
      title: "Embedding discussion",
      created_at: "2025-01-01T00:00:00Z",
      summary: "Discussed vector embeddings",
      similarity: 0.87,
    };

    expect(result.similarity).toBeGreaterThan(0.3);
    expect(result.source).toBe("chatgpt");
  });
});
