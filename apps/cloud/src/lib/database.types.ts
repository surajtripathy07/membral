// `Database` and the generic helpers come from the generated schema
// (`npm run db:types -w @membral/cloud` -> database.generated.ts). The
// hand-written row/insert/update shapes below are standalone domain types
// (they are no longer wired into a hand-written `Database`).
export type {
  CompositeTypes,
  Database,
  Enums,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "./database.generated";

// --- Profiles ---

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  tier: "free" | "pro";
  conversation_limit: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileInsert {
  id: string;
  email?: string | null;
  display_name?: string | null;
  tier?: "free" | "pro";
  conversation_limit?: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileUpdate {
  id?: string;
  email?: string | null;
  display_name?: string | null;
  tier?: "free" | "pro";
  conversation_limit?: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  updated_at?: string;
}

// --- Conversations ---

export interface ConversationRow {
  id: string;
  user_id: string;
  source: string;
  source_id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  model: string | null;
  messages: MessageJson[];
  metadata: Record<string, unknown>;
  synced_at: string;
  embedding: string | null; // vector serialized as string
  /** Set once generateEmbedding exhausts its halving budget (issue #90) — retires the row from future embed selection. NULL = never permanently failed. */
  embedding_failed_at?: string | null;
  fts: string | null;
}

export interface ConversationInsert {
  id?: string;
  user_id: string;
  source: string;
  source_id: string;
  title?: string;
  created_at?: string | null;
  updated_at?: string | null;
  model?: string | null;
  messages?: MessageJson[];
  metadata?: Record<string, unknown>;
  synced_at?: string;
  embedding?: string | null;
}

export interface ConversationUpdate {
  id?: string;
  user_id?: string;
  source?: string;
  source_id?: string;
  title?: string;
  created_at?: string | null;
  updated_at?: string | null;
  model?: string | null;
  messages?: MessageJson[];
  metadata?: Record<string, unknown>;
  synced_at?: string;
  embedding?: string | null;
  embedding_failed_at?: string | null;
}

// --- Extracted Metadata ---

export interface ExtractedMetadata {
  id: string;
  conversation_id: string;
  summary: string | null;
  topics: string[];
  entities: string[];
  questions: string[];
  decisions: string[];
  conversation_type: string | null;
  extracted_at: string;
}

export interface ExtractedMetadataInsert {
  id?: string;
  conversation_id: string;
  summary?: string | null;
  topics?: string[];
  entities?: string[];
  questions?: string[];
  decisions?: string[];
  conversation_type?: string | null;
  extracted_at?: string;
}

export interface ExtractedMetadataUpdate {
  id?: string;
  conversation_id?: string;
  summary?: string | null;
  topics?: string[];
  entities?: string[];
  questions?: string[];
  decisions?: string[];
  conversation_type?: string | null;
  extracted_at?: string;
}

// --- Search ---

export interface SearchResult {
  id: string;
  source: string;
  title: string;
  created_at: string | null;
  summary: string | null;
  similarity: number;
}

// --- Memories ---

export type MemoryType = "decision" | "preference" | "pattern" | "insight";

export interface MemoryRow {
  id: string;
  user_id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  source_conversation_ids: string[];
  tags: string[];
  embedding: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryInsert {
  id?: string;
  user_id: string;
  type: MemoryType;
  content: string;
  confidence?: number;
  source_conversation_ids?: string[];
  tags?: string[];
  embedding?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MemoryUpdate {
  id?: string;
  user_id?: string;
  type?: MemoryType;
  content?: string;
  confidence?: number;
  source_conversation_ids?: string[];
  tags?: string[];
  embedding?: string | null;
  updated_at?: string;
}

// --- Shared JSON shapes ---

export interface MessageJson {
  role: "user" | "assistant" | "system" | "unknown";
  content: string;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}
