export const REFLECT_CONFIG = {
  episodeLimit: 60,
  traceWindowHours: 48,
  traceLimit: 500,
  corpusTokenThreshold: 350_000,
  llmMaxTokens: 16_000,
  entityRelCap: 20,
  skillConfidenceMin: 0.5,
  skillCandidateTierThreshold: 0.7,
  trgmSimilarityThreshold: 0.5,
  constraintMinEvidenceCount: 2,
  allowedRelVerbs: ['uses','manages','owns','part_of','calls','routes_via','works_at','is_a'],
} as const;

export const GRAPH_BUILDER_CONFIG = {
  batchSize: 50,
  orphanFirst: true,
  minEvidenceCount: 2,
  allowedRelVerbs: ['uses','manages','owns','part_of','calls','routes_via','works_at','is_a'],
} as const;
