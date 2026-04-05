/**
 * Types for the assemble() hot path pipeline.
 */

export type MemoryTier = 'episodes' | 'concepts' | 'skills' | 'entities';

export interface AssembleRequest {
  query: string;
  sessionId: string;
  conversationHistory: unknown[];
  mode: AssemblyMode;
  tokenBudget: number;
  turnIndex: number;
}

export interface InjectedMemory {
  id: string;
  tier: MemoryTier;
  content: string;
  score: number;
  tokenCount: number;
}

export interface AssembleResult {
  items: InjectedMemory[];
  metadata: AssembleMetadata;
}

export interface AssembleMetadata {
  itemsConsidered: number;
  itemsSelected: number;
  tiersQueried: MemoryTier[];
  durationMs: number;
  mode: AssemblyMode;
  tokenBudget: number;
  tokensUsed: number;
}

/** Candidate returned from ANN retrieval before scoring. */
export interface RetrievalCandidate {
  id: string;
  tier: MemoryTier;
  content: string;
  embedding: number[];
  tokenCount: number;
  createdAt: Date;
  provenanceKind: string;
  utilityPrior: 'high' | 'medium' | 'low' | 'discard';
  confidence: number;
  isActive: boolean;
  accessCount: number;
  lastAccessed: Date | null;
  /** Only present for skills tier. */
  teachability: number | null;
}

export interface ScoredCandidate extends RetrievalCandidate {
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  similarity: number;
  recency: number;
  provenance: number;
  accessFrequency: number;
  teachability?: number;
}

export type AssemblyMode = 'psycho-genius' | 'brilliant' | 'smart-efficient';

export interface AssemblyModeProfile {
  tokenBudgetFraction: number;
  sessionHistoryFraction: number;
  minInclusionScore: number;
  minConfidence: number;
  candidatesPerTier: number;
  annSearchK: number;
  tiersEnabled: MemoryTier[];
  slidingWindowTurns: number;
  slidingWindowTokens: number;
  includeSpeculative: boolean;
  speculativeMaxCount: number;
}
