export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          device_id: string | null
          id: string
          key_hash: string
          key_prefix: string
          label: string | null
          last_used_at: string | null
          revoked_at: string | null
          scope_code_project_id: string | null
          scope_node_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          scope_code_project_id?: string | null
          scope_node_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          scope_code_project_id?: string | null
          scope_node_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      code_cross_links: {
        Row: {
          code_project_id: string
          confidence: number | null
          conversation_id: string
          created_at: string
          dismissed_at: string | null
          id: string
          rel_type: string
          user_id: string
        }
        Insert: {
          code_project_id: string
          confidence?: number | null
          conversation_id: string
          created_at?: string
          dismissed_at?: string | null
          id?: string
          rel_type?: string
          user_id: string
        }
        Update: {
          code_project_id?: string
          confidence?: number | null
          conversation_id?: string
          created_at?: string
          dismissed_at?: string | null
          id?: string
          rel_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_cross_links_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_cross_links_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_cross_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      code_kg_edges: {
        Row: {
          code_project_id: string
          created_at: string
          dst_node_id: string
          id: string
          props: Json
          rel_type: string
          src_node_id: string
          user_id: string
          weight: number
        }
        Insert: {
          code_project_id: string
          created_at?: string
          dst_node_id: string
          id?: string
          props?: Json
          rel_type: string
          src_node_id: string
          user_id: string
          weight?: number
        }
        Update: {
          code_project_id?: string
          created_at?: string
          dst_node_id?: string
          id?: string
          props?: Json
          rel_type?: string
          src_node_id?: string
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "code_kg_edges_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_kg_edges_dst_node_id_fkey"
            columns: ["dst_node_id"]
            isOneToOne: false
            referencedRelation: "code_kg_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_kg_edges_src_node_id_fkey"
            columns: ["src_node_id"]
            isOneToOne: false
            referencedRelation: "code_kg_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_kg_edges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      code_kg_nodes: {
        Row: {
          code_project_id: string
          created_at: string
          first_seen_at: string | null
          id: string
          key: string
          label: string
          last_seen_at: string | null
          node_type: string
          props: Json
          ref_id: string | null
          session_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          code_project_id: string
          created_at?: string
          first_seen_at?: string | null
          id?: string
          key: string
          label: string
          last_seen_at?: string | null
          node_type: string
          props?: Json
          ref_id?: string | null
          session_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          code_project_id?: string
          created_at?: string
          first_seen_at?: string | null
          id?: string
          key?: string
          label?: string
          last_seen_at?: string | null
          node_type?: string
          props?: Json
          ref_id?: string | null
          session_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_kg_nodes_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_kg_nodes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      code_projects: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          last_active_at: string | null
          props: Json
          remote_url: string | null
          repo_identity: string
          repo_path: string | null
          session_count: number
          source: string | null
          summary: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          last_active_at?: string | null
          props?: Json
          remote_url?: string | null
          repo_identity: string
          repo_path?: string | null
          session_count?: number
          source?: string | null
          summary?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          last_active_at?: string | null
          props?: Json
          remote_url?: string | null
          repo_identity?: string
          repo_path?: string | null
          session_count?: number
          source?: string | null
          summary?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_projects_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      code_session_forge_refs: {
        Row: {
          action_ix: number
          branch: string | null
          host: string | null
          id: number
          item_key: string
          kind: string
          number: number | null
          observed_at: string
          observed_state: string | null
          project: string | null
          prose_ref: boolean
          session_id: string
          sha: string | null
          source: string
          target_kind: string | null
          title: string | null
          turn_idx: number
          url: string | null
          user_id: string
          verb: string
        }
        Insert: {
          action_ix: number
          branch?: string | null
          host?: string | null
          id?: never
          item_key: string
          kind: string
          number?: number | null
          observed_at: string
          observed_state?: string | null
          project?: string | null
          prose_ref?: boolean
          session_id: string
          sha?: string | null
          source: string
          target_kind?: string | null
          title?: string | null
          turn_idx: number
          url?: string | null
          user_id: string
          verb: string
        }
        Update: {
          action_ix?: number
          branch?: string | null
          host?: string | null
          id?: never
          item_key?: string
          kind?: string
          number?: number | null
          observed_at?: string
          observed_state?: string | null
          project?: string | null
          prose_ref?: boolean
          session_id?: string
          sha?: string | null
          source?: string
          target_kind?: string | null
          title?: string | null
          turn_idx?: number
          url?: string | null
          user_id?: string
          verb?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_session_forge_refs_session_fk"
            columns: ["session_id", "user_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      code_session_issues: {
        Row: {
          build_verb: string | null
          created_at: string
          evidence_quote: string
          id: number
          kind: string
          number: number
          ref: string
          related_to: string[] | null
          review_verb: string | null
          role: string
          segment_evidence: Json | null
          segment_reason: string | null
          session_id: string
          source: string | null
          tier: string | null
          turn_idx: number
          turn_share: number | null
          user_id: string
        }
        Insert: {
          build_verb?: string | null
          created_at?: string
          evidence_quote: string
          id?: never
          kind: string
          number: number
          ref: string
          related_to?: string[] | null
          review_verb?: string | null
          role: string
          segment_evidence?: Json | null
          segment_reason?: string | null
          session_id: string
          source?: string | null
          tier?: string | null
          turn_idx: number
          turn_share?: number | null
          user_id: string
        }
        Update: {
          build_verb?: string | null
          created_at?: string
          evidence_quote?: string
          id?: never
          kind?: string
          number?: number
          ref?: string
          related_to?: string[] | null
          review_verb?: string | null
          role?: string
          segment_evidence?: Json | null
          segment_reason?: string | null
          session_id?: string
          source?: string | null
          tier?: string | null
          turn_idx?: number
          turn_share?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_session_issues_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      code_session_turns: {
        Row: {
          file_path: string | null
          fts: unknown
          id: string
          idx: number
          kind: string
          props: Json
          role: string
          session_id: string
          text: string | null
          tool_name: string | null
          ts: string | null
          user_id: string
        }
        Insert: {
          file_path?: string | null
          fts?: unknown
          id?: string
          idx: number
          kind: string
          props?: Json
          role: string
          session_id: string
          text?: string | null
          tool_name?: string | null
          ts?: string | null
          user_id: string
        }
        Update: {
          file_path?: string | null
          fts?: unknown
          id?: string
          idx?: number
          kind?: string
          props?: Json
          role?: string
          session_id?: string
          text?: string | null
          tool_name?: string | null
          ts?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_session_turns_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_session_turns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      code_sessions: {
        Row: {
          code_project_id: string
          content_hash: string
          created_at: string
          cwd: string | null
          duration_seconds: number | null
          ended_at: string | null
          files_touched: string[]
          git_branch: string | null
          id: string
          model: string | null
          parent_source_session_id: string | null
          props: Json
          short_title: string | null
          source: string
          source_session_id: string
          started_at: string | null
          summary: string | null
          title: string | null
          tool_count: number
          turn_count: number
          user_id: string
          user_turn_count: number
        }
        Insert: {
          code_project_id: string
          content_hash: string
          created_at?: string
          cwd?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          files_touched?: string[]
          git_branch?: string | null
          id?: string
          model?: string | null
          parent_source_session_id?: string | null
          props?: Json
          short_title?: string | null
          source: string
          source_session_id: string
          started_at?: string | null
          summary?: string | null
          title?: string | null
          tool_count?: number
          turn_count?: number
          user_id: string
          user_turn_count?: number
        }
        Update: {
          code_project_id?: string
          content_hash?: string
          created_at?: string
          cwd?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          files_touched?: string[]
          git_branch?: string | null
          id?: string
          model?: string | null
          parent_source_session_id?: string | null
          props?: Json
          short_title?: string | null
          source?: string
          source_session_id?: string
          started_at?: string | null
          summary?: string | null
          title?: string | null
          tool_count?: number
          turn_count?: number
          user_id?: string
          user_turn_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "code_sessions_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_chunks: {
        Row: {
          chunk_idx: number
          conversation_id: string
          created_at: string
          embedding: string | null
          embedding_failed_at: string | null
          embedding_model: string | null
          fts: unknown
          id: string
          message_end_idx: number
          message_start_idx: number
          text: string
          user_id: string
        }
        Insert: {
          chunk_idx: number
          conversation_id: string
          created_at?: string
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          fts?: unknown
          id?: string
          message_end_idx: number
          message_start_idx: number
          text: string
          user_id: string
        }
        Update: {
          chunk_idx?: number
          conversation_id?: string
          created_at?: string
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          fts?: unknown
          id?: string
          message_end_idx?: number
          message_start_idx?: number
          text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_chunks_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_chunks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string | null
          embedding: string | null
          embedding_failed_at: string | null
          embedding_model: string | null
          fts: unknown
          id: string
          messages: Json | null
          metadata: Json | null
          model: string | null
          source: string
          source_id: string
          synced_at: string | null
          title: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          fts?: unknown
          id?: string
          messages?: Json | null
          metadata?: Json | null
          model?: string | null
          source: string
          source_id: string
          synced_at?: string | null
          title?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          fts?: unknown
          id?: string
          messages?: Json | null
          metadata?: Json | null
          model?: string | null
          source?: string
          source_id?: string
          synced_at?: string | null
          title?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      device_auth_requests: {
        Row: {
          api_key_id: string | null
          approved_at: string | null
          consumed_at: string | null
          created_at: string
          device_code_hash: string
          device_id: string | null
          device_name: string | null
          device_platform: string | null
          expires_at: string
          id: string
          pending_api_key: string | null
          status: string
          user_code: string
          user_id: string | null
        }
        Insert: {
          api_key_id?: string | null
          approved_at?: string | null
          consumed_at?: string | null
          created_at?: string
          device_code_hash: string
          device_id?: string | null
          device_name?: string | null
          device_platform?: string | null
          expires_at?: string
          id?: string
          pending_api_key?: string | null
          status?: string
          user_code: string
          user_id?: string | null
        }
        Update: {
          api_key_id?: string | null
          approved_at?: string | null
          consumed_at?: string | null
          created_at?: string
          device_code_hash?: string
          device_id?: string | null
          device_name?: string | null
          device_platform?: string | null
          expires_at?: string
          id?: string
          pending_api_key?: string | null
          status?: string
          user_code?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_auth_requests_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_auth_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          created_at: string
          id: string
          last_seen_at: string | null
          name: string
          platform: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id: string
          last_seen_at?: string | null
          name: string
          platform?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          platform?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      extracted_metadata: {
        Row: {
          conversation_id: string
          conversation_type: string | null
          decisions: string[] | null
          entities: string[] | null
          extracted_at: string | null
          id: string
          questions: string[] | null
          summary: string | null
          topics: string[] | null
        }
        Insert: {
          conversation_id: string
          conversation_type?: string | null
          decisions?: string[] | null
          entities?: string[] | null
          extracted_at?: string | null
          id?: string
          questions?: string[] | null
          summary?: string | null
          topics?: string[] | null
        }
        Update: {
          conversation_id?: string
          conversation_type?: string | null
          decisions?: string[] | null
          entities?: string[] | null
          extracted_at?: string | null
          id?: string
          questions?: string[] | null
          summary?: string | null
          topics?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "extracted_metadata_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          budget_usd: number | null
          created_at: string
          daily_usd: number | null
          enabled: boolean
          feature: string
          note: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          budget_usd?: number | null
          created_at?: string
          daily_usd?: number | null
          enabled?: boolean
          feature: string
          note?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          budget_usd?: number | null
          created_at?: string
          daily_usd?: number | null
          enabled?: boolean
          feature?: string
          note?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      llm_spend: {
        Row: {
          cost_usd: number
          id: string
          model: string
          pass: string
          run_id: string | null
          spent_at: string
          user_id: string
        }
        Insert: {
          cost_usd: number
          id?: string
          model: string
          pass: string
          run_id?: string | null
          spent_at?: string
          user_id: string
        }
        Update: {
          cost_usd?: number
          id?: string
          model?: string
          pass?: string
          run_id?: string | null
          spent_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_spend_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_tool_calls: {
        Row: {
          api_key_id: string | null
          args: Json | null
          client_name: string | null
          client_version: string | null
          created_at: string
          degraded: boolean
          error: string | null
          id: number
          latency_ms: number | null
          ok: boolean
          paged: boolean
          result_chars: number | null
          result_count: number | null
          result_ids: string[] | null
          tool: string
          user_id: string
        }
        Insert: {
          api_key_id?: string | null
          args?: Json | null
          client_name?: string | null
          client_version?: string | null
          created_at?: string
          degraded?: boolean
          error?: string | null
          id?: never
          latency_ms?: number | null
          ok: boolean
          paged?: boolean
          result_chars?: number | null
          result_count?: number | null
          result_ids?: string[] | null
          tool: string
          user_id: string
        }
        Update: {
          api_key_id?: string | null
          args?: Json | null
          client_name?: string | null
          client_version?: string | null
          created_at?: string
          degraded?: boolean
          error?: string | null
          id?: never
          latency_ms?: number | null
          ok?: boolean
          paged?: boolean
          result_chars?: number | null
          result_count?: number | null
          result_ids?: string[] | null
          tool?: string
          user_id?: string
        }
        Relationships: []
      }
      memories: {
        Row: {
          confidence: number
          content: string
          created_at: string
          embedding: string | null
          id: string
          source_conversation_ids: string[]
          tags: string[]
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          confidence?: number
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          source_conversation_ids?: string[]
          tags?: string[]
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          confidence?: number
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          source_conversation_ids?: string[]
          tags?: string[]
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      memory_branch_state: {
        Row: {
          branch: string
          branch_gone_at: string | null
          code_project_id: string
          last_seen_at: string
          last_seen_sha: string | null
          merged_at: string | null
          merged_into: string | null
          user_id: string
        }
        Insert: {
          branch: string
          branch_gone_at?: string | null
          code_project_id: string
          last_seen_at?: string
          last_seen_sha?: string | null
          merged_at?: string | null
          merged_into?: string | null
          user_id: string
        }
        Update: {
          branch?: string
          branch_gone_at?: string | null
          code_project_id?: string
          last_seen_at?: string
          last_seen_sha?: string | null
          merged_at?: string | null
          merged_into?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_branch_state_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_branch_state_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_extraction_queue: {
        Row: {
          attempts: number
          dirty: boolean
          last_reason: string | null
          lease_token: string | null
          lease_until: string | null
          queued_at: string
          session_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          dirty?: boolean
          last_reason?: string | null
          lease_token?: string | null
          lease_until?: string | null
          queued_at?: string
          session_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          dirty?: boolean
          last_reason?: string | null
          lease_token?: string | null
          lease_until?: string | null
          queued_at?: string
          session_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_extraction_queue_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_extraction_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_links: {
        Row: {
          created_at: string
          from_id: string
          id: string
          model: string | null
          prompt_version: string | null
          quote: string | null
          relation: string
          run_id: string | null
          session_id: string | null
          to_id: string
          turn_idx: number | null
          undone_at: string | null
          user_id: string
          verified: boolean
        }
        Insert: {
          created_at?: string
          from_id: string
          id?: string
          model?: string | null
          prompt_version?: string | null
          quote?: string | null
          relation: string
          run_id?: string | null
          session_id?: string | null
          to_id: string
          turn_idx?: number | null
          undone_at?: string | null
          user_id: string
          verified?: boolean
        }
        Update: {
          created_at?: string
          from_id?: string
          id?: string
          model?: string | null
          prompt_version?: string | null
          quote?: string | null
          relation?: string
          run_id?: string | null
          session_id?: string | null
          to_id?: string
          turn_idx?: number | null
          undone_at?: string | null
          user_id?: string
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "memory_links_from_id_fkey"
            columns: ["from_id"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_links_to_id_fkey"
            columns: ["to_id"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_merges: {
        Row: {
          id: string
          kept_id: string
          kind: string
          merged_at: string
          retired_id: string
          sim: number
          source: string
          user_id: string
        }
        Insert: {
          id?: string
          kept_id: string
          kind: string
          merged_at?: string
          retired_id: string
          sim: number
          source: string
          user_id: string
        }
        Update: {
          id?: string
          kept_id?: string
          kind?: string
          merged_at?: string
          retired_id?: string
          sim?: number
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_merges_kept_id_fkey"
            columns: ["kept_id"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_merges_retired_id_fkey"
            columns: ["retired_id"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_recall_events: {
        Row: {
          code_session_id: string | null
          empty_reason: string | null
          harness_session_id: string | null
          id: string
          influence_checked_at: string | null
          influenced_edit: boolean
          influenced_quote: boolean
          matched_turn_idx: number | null
          query: string | null
          recall_token: string | null
          record_ids: string[]
          served_at: string
          surface: string
          tool: string
          user_id: string
        }
        Insert: {
          code_session_id?: string | null
          empty_reason?: string | null
          harness_session_id?: string | null
          id?: string
          influence_checked_at?: string | null
          influenced_edit?: boolean
          influenced_quote?: boolean
          matched_turn_idx?: number | null
          query?: string | null
          recall_token?: string | null
          record_ids?: string[]
          served_at?: string
          surface?: string
          tool: string
          user_id: string
        }
        Update: {
          code_session_id?: string | null
          empty_reason?: string | null
          harness_session_id?: string | null
          id?: string
          influence_checked_at?: string | null
          influenced_edit?: boolean
          influenced_quote?: boolean
          matched_turn_idx?: number | null
          query?: string | null
          recall_token?: string | null
          record_ids?: string[]
          served_at?: string
          surface?: string
          tool?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_recall_events_code_session_id_fkey"
            columns: ["code_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_recall_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          api_key_hash: string | null
          api_key_prefix: string | null
          api_key_scope_code_project_id: string | null
          api_key_scope_node_id: string | null
          conversation_limit: number | null
          created_at: string | null
          display_name: string | null
          email: string | null
          id: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          tier: string | null
          updated_at: string | null
        }
        Insert: {
          api_key_hash?: string | null
          api_key_prefix?: string | null
          api_key_scope_code_project_id?: string | null
          api_key_scope_node_id?: string | null
          conversation_limit?: number | null
          created_at?: string | null
          display_name?: string | null
          email?: string | null
          id: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string | null
          updated_at?: string | null
        }
        Update: {
          api_key_hash?: string | null
          api_key_prefix?: string | null
          api_key_scope_code_project_id?: string | null
          api_key_scope_node_id?: string | null
          conversation_limit?: number | null
          created_at?: string | null
          display_name?: string | null
          email?: string | null
          id?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      project_alias_seed_runs: {
        Row: {
          ran_at: string
          user_id: string
        }
        Insert: {
          ran_at?: string
          user_id: string
        }
        Update: {
          ran_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_alias_seed_runs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_aliases: {
        Row: {
          alias: string
          canonical: string
          created_at: string
          source: string
          user_id: string
        }
        Insert: {
          alias: string
          canonical: string
          created_at?: string
          source: string
          user_id: string
        }
        Update: {
          alias?: string
          canonical?: string
          created_at?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_aliases_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_hits: {
        Row: {
          bucket_key: string
          hit_at: string
          id: number
        }
        Insert: {
          bucket_key: string
          hit_at?: string
          id?: never
        }
        Update: {
          bucket_key?: string
          hit_at?: string
          id?: never
        }
        Relationships: []
      }
      served_record_verdicts: {
        Row: {
          code_session_id: string
          created_at: string
          id: string
          memory_id: string
          prompt_version: string
          quote: string | null
          recall_event_id: string | null
          surface: string
          turn_idx: number | null
          updated_at: string
          user_id: string
          verdict: string
        }
        Insert: {
          code_session_id: string
          created_at?: string
          id?: string
          memory_id: string
          prompt_version: string
          quote?: string | null
          recall_event_id?: string | null
          surface: string
          turn_idx?: number | null
          updated_at?: string
          user_id: string
          verdict: string
        }
        Update: {
          code_session_id?: string
          created_at?: string
          id?: string
          memory_id?: string
          prompt_version?: string
          quote?: string | null
          recall_event_id?: string | null
          surface?: string
          turn_idx?: number | null
          updated_at?: string
          user_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "served_record_verdicts_code_session_id_fkey"
            columns: ["code_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "served_record_verdicts_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "served_record_verdicts_recall_event_id_fkey"
            columns: ["recall_event_id"]
            isOneToOne: false
            referencedRelation: "memory_recall_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "served_record_verdicts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_feedback: {
        Row: {
          about: string
          code_project_id: string
          code_session_id: string
          content_hash: string
          created_at: string
          id: string
          prompt_version: string
          quote: string
          sentiment: string
          surface: string | null
          text: string
          turn_idx: number
          turn_role: string
          user_id: string
        }
        Insert: {
          about?: string
          code_project_id: string
          code_session_id: string
          content_hash: string
          created_at?: string
          id?: string
          prompt_version: string
          quote: string
          sentiment: string
          surface?: string | null
          text: string
          turn_idx: number
          turn_role: string
          user_id: string
        }
        Update: {
          about?: string
          code_project_id?: string
          code_session_id?: string
          content_hash?: string
          created_at?: string
          id?: string
          prompt_version?: string
          quote?: string
          sentiment?: string
          surface?: string | null
          text?: string
          turn_idx?: number
          turn_role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_feedback_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_feedback_code_session_id_fkey"
            columns: ["code_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_memories: {
        Row: {
          agent_id: string | null
          branch: string | null
          chat_conversation_id: string | null
          code_project_id: string
          code_session_id: string
          confidence: number
          content_hash: string
          covered_by_handoff: boolean | null
          created_at: string
          durable: boolean
          embedding: string | null
          embedding_model: string | null
          extraction_pass: string | null
          head_sha: string | null
          id: string
          kind: string
          observed_durable: boolean
          paths: string[]
          priority: boolean
          quote: string | null
          quote_fts: unknown
          recurrence_count: number
          recurs_of: string | null
          ref: string | null
          ref_issue: string | null
          ref_issue_basis: string | null
          ref_kind: string | null
          ref_title: string | null
          resolution_quote: string | null
          resolution_turn_idx: number | null
          resolved_by_harness_session_id: string | null
          resolved_by_session_id: string | null
          retire_reason: string | null
          retired_at: string | null
          scope: string
          session_title: string | null
          source: string
          source_record_ids: string[] | null
          supersede_kind: string | null
          superseded_by: string | null
          supersedes: string | null
          text: string
          text_fts: unknown
          thread: string | null
          turn_idx: number
          turn_role: string
          user_id: string
          valid_from: string | null
          valid_to: string | null
          verified: boolean
        }
        Insert: {
          agent_id?: string | null
          branch?: string | null
          chat_conversation_id?: string | null
          code_project_id: string
          code_session_id: string
          confidence?: number
          content_hash: string
          covered_by_handoff?: boolean | null
          created_at?: string
          durable?: boolean
          embedding?: string | null
          embedding_model?: string | null
          extraction_pass?: string | null
          head_sha?: string | null
          id?: string
          kind: string
          observed_durable?: boolean
          paths?: string[]
          priority?: boolean
          quote?: string | null
          quote_fts?: unknown
          recurrence_count?: number
          recurs_of?: string | null
          ref?: string | null
          ref_issue?: string | null
          ref_issue_basis?: string | null
          ref_kind?: string | null
          ref_title?: string | null
          resolution_quote?: string | null
          resolution_turn_idx?: number | null
          resolved_by_harness_session_id?: string | null
          resolved_by_session_id?: string | null
          retire_reason?: string | null
          retired_at?: string | null
          scope?: string
          session_title?: string | null
          source: string
          source_record_ids?: string[] | null
          supersede_kind?: string | null
          superseded_by?: string | null
          supersedes?: string | null
          text: string
          text_fts?: unknown
          thread?: string | null
          turn_idx: number
          turn_role: string
          user_id: string
          valid_from?: string | null
          valid_to?: string | null
          verified?: boolean
        }
        Update: {
          agent_id?: string | null
          branch?: string | null
          chat_conversation_id?: string | null
          code_project_id?: string
          code_session_id?: string
          confidence?: number
          content_hash?: string
          covered_by_handoff?: boolean | null
          created_at?: string
          durable?: boolean
          embedding?: string | null
          embedding_model?: string | null
          extraction_pass?: string | null
          head_sha?: string | null
          id?: string
          kind?: string
          observed_durable?: boolean
          paths?: string[]
          priority?: boolean
          quote?: string | null
          quote_fts?: unknown
          recurrence_count?: number
          recurs_of?: string | null
          ref?: string | null
          ref_issue?: string | null
          ref_issue_basis?: string | null
          ref_kind?: string | null
          ref_title?: string | null
          resolution_quote?: string | null
          resolution_turn_idx?: number | null
          resolved_by_harness_session_id?: string | null
          resolved_by_session_id?: string | null
          retire_reason?: string | null
          retired_at?: string | null
          scope?: string
          session_title?: string | null
          source?: string
          source_record_ids?: string[] | null
          supersede_kind?: string | null
          superseded_by?: string | null
          supersedes?: string | null
          text?: string
          text_fts?: unknown
          thread?: string | null
          turn_idx?: number
          turn_role?: string
          user_id?: string
          valid_from?: string | null
          valid_to?: string | null
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "session_memories_chat_conversation_id_fkey"
            columns: ["chat_conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_memories_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_memories_code_session_id_fkey"
            columns: ["code_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_memories_recurs_of_fkey"
            columns: ["recurs_of"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_memories_resolved_by_session_id_fkey"
            columns: ["resolved_by_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_memories_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_memories_supersedes_fkey"
            columns: ["supersedes"]
            isOneToOne: false
            referencedRelation: "session_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_memories_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_questionnaires: {
        Row: {
          answers: Json
          code_session_id: string | null
          created_at: string
          harness: string
          id: string
          question_order: string[]
          source: string
          source_session_id: string
          user_id: string
        }
        Insert: {
          answers: Json
          code_session_id?: string | null
          created_at?: string
          harness?: string
          id?: string
          question_order: string[]
          source: string
          source_session_id: string
          user_id: string
        }
        Update: {
          answers?: Json
          code_session_id?: string | null
          created_at?: string
          harness?: string
          id?: string
          question_order?: string[]
          source?: string
          source_session_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_questionnaires_code_session_id_fkey"
            columns: ["code_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_questionnaires_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_raw_unit_stage: {
        Row: {
          code_project_id: string
          code_session_id: string
          created_at: string
          embedding: string | null
          embedding_failed_at: string | null
          embedding_model: string | null
          full_text: string | null
          id: string
          ord: number
          parts: Json | null
          run_id: string
          text: string
          text_hash: string
          turn_from: number | null
          turn_idx: number | null
          turn_text: string | null
          turn_to: number | null
          unit: string
          user_id: string
          win: unknown
        }
        Insert: {
          code_project_id: string
          code_session_id: string
          created_at?: string
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          full_text?: string | null
          id?: string
          ord: number
          parts?: Json | null
          run_id: string
          text: string
          text_hash: string
          turn_from?: number | null
          turn_idx?: number | null
          turn_text?: string | null
          turn_to?: number | null
          unit: string
          user_id: string
          win?: unknown
        }
        Update: {
          code_project_id?: string
          code_session_id?: string
          created_at?: string
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          full_text?: string | null
          id?: string
          ord?: number
          parts?: Json | null
          run_id?: string
          text?: string
          text_hash?: string
          turn_from?: number | null
          turn_idx?: number | null
          turn_text?: string | null
          turn_to?: number | null
          unit?: string
          user_id?: string
          win?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "session_raw_unit_stage_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_raw_unit_stage_code_session_id_fkey"
            columns: ["code_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_raw_unit_stage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_raw_units: {
        Row: {
          code_project_id: string
          code_session_id: string
          created_at: string
          embedding: string | null
          embedding_failed_at: string | null
          embedding_model: string | null
          fts: unknown
          full_text: string | null
          id: string
          ord: number
          parts: Json | null
          source_hash: string
          text: string
          text_hash: string
          turn_from: number | null
          turn_idx: number | null
          turn_text: string | null
          turn_to: number | null
          unit: string
          units_version: number
          user_id: string
          win: unknown
        }
        Insert: {
          code_project_id: string
          code_session_id: string
          created_at?: string
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          fts?: unknown
          full_text?: string | null
          id?: string
          ord: number
          parts?: Json | null
          source_hash: string
          text: string
          text_hash: string
          turn_from?: number | null
          turn_idx?: number | null
          turn_text?: string | null
          turn_to?: number | null
          unit: string
          units_version: number
          user_id: string
          win?: unknown
        }
        Update: {
          code_project_id?: string
          code_session_id?: string
          created_at?: string
          embedding?: string | null
          embedding_failed_at?: string | null
          embedding_model?: string | null
          fts?: unknown
          full_text?: string | null
          id?: string
          ord?: number
          parts?: Json | null
          source_hash?: string
          text?: string
          text_hash?: string
          turn_from?: number | null
          turn_idx?: number | null
          turn_text?: string | null
          turn_to?: number | null
          unit?: string
          units_version?: number
          user_id?: string
          win?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "session_raw_units_code_project_id_fkey"
            columns: ["code_project_id"]
            isOneToOne: false
            referencedRelation: "code_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_raw_units_code_session_id_fkey"
            columns: ["code_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_raw_units_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_heartbeats: {
        Row: {
          last_item_at: string | null
          last_run_at: string
          meta: Json
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          last_item_at?: string | null
          last_run_at: string
          meta?: Json
          source: string
          updated_at?: string
          user_id: string
        }
        Update: {
          last_item_at?: string | null
          last_run_at?: string
          meta?: Json
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_heartbeats_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      thread_dismissals: {
        Row: {
          created_at: string
          id: string
          kind: string
          reason: string
          ref: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          reason: string
          ref: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          reason?: string
          ref?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_dismissals_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_stats: {
        Row: {
          busiest_repo: string | null
          commits: number
          computed_at: string
          cost_usd: number
          day: string
          edits: number
          first_session_at: string | null
          longest_session_id: string | null
          longest_session_seconds: number | null
          mcp_calls: number
          mcp_errors: number
          mcp_tool_counts: Json
          most_edited_file: string | null
          pushes: number
          reads: number
          ref_counts: Json
          refs: number
          sessions: number
          start_hour: number | null
          sub_agent_sessions: number
          tests: number
          tool_calls: number
          tool_counts: Json
          turns: number
          user_id: string
          user_turns: number
          verb_counts: Json
        }
        Insert: {
          busiest_repo?: string | null
          commits?: number
          computed_at?: string
          cost_usd?: number
          day: string
          edits?: number
          first_session_at?: string | null
          longest_session_id?: string | null
          longest_session_seconds?: number | null
          mcp_calls?: number
          mcp_errors?: number
          mcp_tool_counts?: Json
          most_edited_file?: string | null
          pushes?: number
          reads?: number
          ref_counts?: Json
          refs?: number
          sessions?: number
          start_hour?: number | null
          sub_agent_sessions?: number
          tests?: number
          tool_calls?: number
          tool_counts?: Json
          turns?: number
          user_id: string
          user_turns?: number
          verb_counts?: Json
        }
        Update: {
          busiest_repo?: string | null
          commits?: number
          computed_at?: string
          cost_usd?: number
          day?: string
          edits?: number
          first_session_at?: string | null
          longest_session_id?: string | null
          longest_session_seconds?: number | null
          mcp_calls?: number
          mcp_errors?: number
          mcp_tool_counts?: Json
          most_edited_file?: string | null
          pushes?: number
          reads?: number
          ref_counts?: Json
          refs?: number
          sessions?: number
          start_hour?: number | null
          sub_agent_sessions?: number
          tests?: number
          tool_calls?: number
          tool_counts?: Json
          turns?: number
          user_id?: string
          user_turns?: number
          verb_counts?: Json
        }
        Relationships: [
          {
            foreignKeyName: "user_stats_longest_session_id_fkey"
            columns: ["longest_session_id"]
            isOneToOne: false
            referencedRelation: "code_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_stats_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      mcp_usage_daily: {
        Row: {
          avg_result_chars: number | null
          calls: number | null
          day: string | null
          degraded: number | null
          errors: number | null
          p50_latency_ms: number | null
          p95_latency_ms: number | null
          paged: number | null
          tool: string | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      app_mode: { Args: never; Returns: string }
      apply_memory_reconciliation: {
        Args: {
          p_links: Json
          p_model: string
          p_projections: Json
          p_prompt_version: string
          p_run_id: string
          p_user_id: string
        }
        Returns: number
      }
      claims_browse_label_regex: { Args: { p_label: string }; Returns: string }
      code_context_for: {
        Args: {
          p_query: string
          p_scope_code_project_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      code_project_detail: {
        Args: {
          p_project_id: string
          p_scope_code_project_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      code_projects_list: {
        Args: { p_scope_code_project_id?: string; p_user_id: string }
        Returns: Json
      }
      code_session_detail: {
        Args: {
          p_scope_code_project_id?: string
          p_session_id: string
          p_user_id: string
        }
        Returns: Json
      }
      code_session_props_patch: {
        Args: {
          p_expect?: Json
          p_remove?: string[]
          p_session_id: string
          p_set: Json
          p_user_id: string
        }
        Returns: boolean
      }
      commit_session_raw_units: {
        Args: {
          p_code_session_id: string
          p_content_hash?: string
          p_expected_count: number
          p_run_id: string
          p_source_hash: string
          p_units_version: number
          p_user_id: string
        }
        Returns: number
      }
      conversation_messages_text: { Args: { messages: Json }; Returns: string }
      import_code_session_turns:
        | {
            Args: { p_session_id: string; p_turns: Json; p_user_id: string }
            Returns: number
          }
        | {
            Args: {
              p_forge_refs: Json
              p_forge_refs_version: number
              p_session_id: string
              p_turns: Json
              p_user_id: string
            }
            Returns: number
          }
      increment_memory_recurrence: {
        Args: { p_counts: number[]; p_ids: string[]; p_user_id: string }
        Returns: number
      }
      llm_spend_daily_totals: {
        Args: { p_days?: number }
        Returns: {
          calls: number
          day: string
          memory_usd: number
          total_usd: number
          users: number
        }[]
      }
      llm_spend_global_sum: { Args: { p_since: string }; Returns: number }
      llm_spend_sum: {
        Args: {
          p_exclude_passes?: string[]
          p_include_passes?: string[]
          p_run_id?: string
          p_since: string
          p_user_id: string
        }
        Returns: number
      }
      mcp_freshness: { Args: { p_user_id: string }; Returns: Json }
      mcp_recent_conversations: {
        Args: {
          p_include_chat?: boolean
          p_include_code?: boolean
          p_limit?: number
          p_scope_code_project_id?: string
          p_scope_id?: string
          p_since?: string
          p_source?: string
          p_user_id: string
        }
        Returns: Json
      }
      mcp_scoped_conversation: {
        Args: {
          p_conversation_id: string
          p_scope_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      mcp_search_unified: {
        Args: {
          p_include_code?: boolean
          p_limit?: number
          p_query: string
          p_query_embedding?: string
          p_scope_id?: string
          p_since?: string
          p_user_id: string
        }
        Returns: Json
      }
      memory_anchor_records: {
        Args: {
          p_code_project_id: string
          p_kinds?: string[]
          p_limit?: number
          p_tokens: string[]
          p_user_id: string
        }
        Returns: {
          agent_id: string
          branch: string
          chat_conversation_id: string
          code_project_id: string
          code_session_id: string
          confidence: number
          created_at: string
          durable: boolean
          head_sha: string
          id: string
          kind: string
          observed_durable: boolean
          paths: string[]
          quote: string
          recurrence_count: number
          ref: string
          ref_kind: string
          retired_at: string
          scope: string
          source: string
          supersedes: string
          text: string
          thread: string
          turn_idx: number
          turn_role: string
          verified: boolean
        }[]
      }
      memory_extraction_claim: {
        Args: {
          p_backfill_limit: number
          p_lease_seconds: number
          p_max_age_days?: number
          p_max_attempts: number
          p_user: string
        }
        Returns: {
          attempts: number
          lease_token: string
          session_id: string
        }[]
      }
      memory_extraction_enqueue: {
        Args: { p_ensure: string[]; p_requeue: string[]; p_user: string }
        Returns: number
      }
      memory_extraction_finish: {
        Args: {
          p_attempts: number
          p_reason: string
          p_session: string
          p_status: string
          p_token: string
        }
        Returns: string
      }
      memory_key: {
        Args: {
          p_claim_key: string
          p_kind: string
          p_payload: Json
          p_relation_class: string
          p_subject_key: string
          p_target_key: string
        }
        Returns: string
      }
      memory_norm: { Args: { p_text: string }; Returns: string }
      memory_raw_cover: {
        Args: {
          p_record_ids: string[]
          p_unit_ids: string[]
          p_user_id: string
        }
        Returns: {
          a_id: string
          b_id: string
          code_session_id: string
          cosine: number
          kind: string
          turn_idx: number
          turn_len: number
          turn_text: string
        }[]
      }
      memory_raw_pools: {
        Args: {
          p_code_project_id?: string
          p_embedding_model?: string
          p_min_similarity?: number
          p_query: string
          p_query_embedding?: string
          p_user_id: string
          p_want_r23?: boolean
        }
        Returns: {
          code_project_id: string
          code_session_id: string
          full_text: string
          id: string
          lex_hits: number
          lex_rank: number
          lex_score: number
          ord: number
          parts: Json
          pool: string
          query_lexemes: number
          rrf: number
          sem_rank: number
          session_time: string
          similarity: number
          text: string
          turn_from: number
          turn_idx: number
          turn_to: number
          unit: string
          win: unknown
        }[]
      }
      memory_raw_term_stats: {
        Args: { p_terms: string[]; p_user_id: string }
        Returns: {
          df: number
          term: string
          total: number
        }[]
      }
      memory_search_records: {
        Args: {
          p_code_project_id?: string
          p_include_retired?: boolean
          p_kinds?: string[]
          p_limit?: number
          p_path?: string
          p_query: string
          p_query_embedding?: string
          p_scope?: string
          p_user_id: string
        }
        Returns: {
          agent_id: string
          branch: string
          chat_conversation_id: string
          code_project_id: string
          code_session_id: string
          confidence: number
          created_at: string
          durable: boolean
          head_sha: string
          id: string
          kind: string
          leg_score: number
          observed_durable: boolean
          paths: string[]
          quote: string
          recurrence_count: number
          recurs_of: string
          ref: string
          ref_kind: string
          retired_at: string
          scope: string
          source: string
          supersedes: string
          text: string
          thread: string
          turn_idx: number
          turn_role: string
          verified: boolean
        }[]
      }
      memory_search_scored: {
        Args: {
          p_code_project_id?: string
          p_embedding_model?: string
          p_include_retired?: boolean
          p_kinds?: string[]
          p_limit?: number
          p_min_similarity?: number
          p_path?: string
          p_query: string
          p_query_embedding?: string
          p_scope?: string
          p_since?: string
          p_user_id: string
        }
        Returns: {
          agent_id: string
          branch: string
          chat_conversation_id: string
          code_project_id: string
          code_session_id: string
          confidence: number
          created_at: string
          durable: boolean
          head_sha: string
          id: string
          kind: string
          leg_score: number
          lex_hits: number
          lex_score: number
          observed_at: string
          observed_durable: boolean
          paths: string[]
          query_lexemes: number
          quote: string
          recurrence_count: number
          recurs_of: string
          ref: string
          ref_kind: string
          retired_at: string
          scope: string
          similarity: number
          source: string
          supersedes: string
          text: string
          thread: string
          turn_idx: number
          turn_role: string
          verified: boolean
        }[]
      }
      memory_semantic_duplicates: {
        Args: {
          p_kinds?: string[]
          p_min_sim?: number
          p_record_ids?: string[]
          p_user: string
        }
        Returns: {
          existing_created_at: string
          existing_id: string
          kind: string
          new_created_at: string
          new_id: string
          sim: number
        }[]
      }
      memory_title_anchor_records: {
        Args: {
          p_limit?: number
          p_project_id: string
          p_tokens: string[]
          p_user_id: string
        }
        Returns: {
          agent_id: string
          branch: string
          chat_conversation_id: string
          code_project_id: string
          code_session_id: string
          confidence: number
          created_at: string
          durable: boolean
          head_sha: string
          id: string
          kind: string
          observed_durable: boolean
          paths: string[]
          quote: string
          recurrence_count: number
          ref: string
          ref_kind: string
          retired_at: string
          scope: string
          source: string
          supersedes: string
          text: string
          thread: string
          turn_idx: number
          turn_role: string
          verified: boolean
        }[]
      }
      project_alias_normalize: { Args: { p_label: string }; Returns: string }
      project_alias_owner: { Args: { p_label: string }; Returns: string }
      project_alias_resolve: {
        Args: { p_label: string; p_user_id: string }
        Returns: string
      }
      project_alias_seed: { Args: { p_user: string }; Returns: Json }
      prune_memory_recall_events: { Args: never; Returns: number }
      rate_limit_check: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: Json
      }
      raw_units_retry_due: {
        Args: {
          p_code_session_id: string
          p_retry_seconds: number
          p_user_id: string
        }
        Returns: boolean
      }
      replace_code_session_forge_refs: {
        Args: {
          p_expected_content_hash: string
          p_expected_turn_ids_md5: string
          p_forge_refs: Json
          p_forge_refs_version: number
          p_session_id: string
          p_user_id: string
        }
        Returns: number
      }
      replace_session_handoff: {
        Args: {
          p_code_session_id: string
          p_content_hash: string
          p_extraction_pass: string
          p_retire_reason: string
          p_retired_at: string
          p_source_record_ids: string[]
          p_text: string
          p_turn_idx: number
          p_user_id: string
        }
        Returns: string
      }
      replace_session_raw_units: {
        Args: {
          p_code_session_id: string
          p_content_hash?: string
          p_rows: Json
          p_source_hash: string
          p_units_version: number
          p_user_id: string
        }
        Returns: number
      }
      require_auth_uid: { Args: never; Returns: string }
      require_session_or_service_role: {
        Args: { p_fn_name: string; p_user_id: string }
        Returns: boolean
      }
      retire_session_memory: {
        Args: { p_id: string; p_user_id?: string }
        Returns: number
      }
      search_conversations: {
        Args: {
          match_count?: number
          p_lane?: string
          query_embedding: string
          query_text: string
          search_user_id?: string
        }
        Returns: Json
      }
      search_prose_text: { Args: { p_text: string }; Returns: string }
      session_raw_unit_terms: { Args: { p_text: string }; Returns: string[] }
      session_raw_units_fts_src: {
        Args: { p_full_text: string; p_text: string }
        Returns: string
      }
      stage_session_raw_units: {
        Args: {
          p_code_session_id: string
          p_rows: Json
          p_run_id: string
          p_stale_seconds?: number
          p_user_id: string
        }
        Returns: number
      }
      user_first_session_at: {
        Args: { p_user_ids: string[] }
        Returns: {
          first_at: string
          user_id: string
        }[]
      }
      write_code_session_forge_refs: {
        Args: {
          p_forge_refs: Json
          p_session_id: string
          p_user_id: string
          p_version: number
        }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

