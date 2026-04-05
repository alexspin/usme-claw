export interface SensoryTrace {
  id: string;
  session_id: string;
  turn_index: number;
  item_type: "verbatim" | "extracted";
  memory_type: "fact" | "preference" | "decision" | "plan" | "anomaly" | "ephemeral" | null;
  content: string;
  embedding: number[] | null;
  provenance_kind: "user" | "tool" | "model" | "web" | "file";
  provenance_ref: string | null;
  utility_prior: "high" | "medium" | "low" | "discard";
  tags: string[];
  extractor_ver: string | null;
  metadata: Record<string, unknown>;
  episodified_at: Date | null;
  created_at: Date;
  expires_at: Date | null;
}

export interface Episode {
  id: string;
  session_ids: string[];
  time_bucket: Date;
  summary: string;
  embedding: number[] | null;
  source_trace_ids: string[];
  token_count: number | null;
  utility_score: number;
  access_count: number;
  last_accessed: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface Concept {
  id: string;
  concept_type: "fact" | "preference" | "decision" | "relationship_summary";
  content: string;
  embedding: number[] | null;
  utility_score: number;
  provenance_kind: string;
  provenance_ref: string | null;
  confidence: number;
  access_count: number;
  last_accessed: Date | null;
  supersedes_id: string | null;
  superseded_by: string | null;
  is_active: boolean;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  embedding: number[] | null;
  status: "candidate" | "active" | "retired";
  skill_path: string;
  source_episode_ids: string[];
  teachability: number | null;
  use_count: number;
  last_used: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface Entity {
  id: string;
  name: string;
  entity_type: "person" | "org" | "project" | "tool" | "location" | "concept";
  canonical: string | null;
  embedding: number[] | null;
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface EntityRelationship {
  id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  confidence: number;
  source_item_id: string | null;
  valid_from: Date;
  valid_until: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ShadowComparison {
  id: string;
  session_id: string;
  turn_index: number;
  query_preview: string | null;
  lcm_token_count: number | null;
  lcm_latency_ms: number | null;
  usme_token_count: number | null;
  usme_latency_ms: number | null;
  usme_mode: string | null;
  usme_tiers_contributed: string[] | null;
  usme_items_selected: number | null;
  usme_items_considered: number | null;
  usme_system_addition_tokens: number | null;
  token_delta: number | null;
  overlap_score: number | null;
  usme_only_preview: string | null;
  lcm_only_preview: string | null;
  usme_relevance_score: number | null;
  usme_memory_cited: boolean | null;
  relevance_analysis_done: boolean;
  created_at: Date;
}
