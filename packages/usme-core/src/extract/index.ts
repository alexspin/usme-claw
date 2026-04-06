export { extractFacts, runFactExtraction, persistExtractedItems, DEDUP_SIMILARITY_THRESHOLD } from "./extractor.js";
export type { ExtractedItem, FactExtractionResult, ExtractionContext, ExtractorConfig } from "./extractor.js";

export { extractEntities, runEntityExtraction, persistEntities } from "./entity-extractor.js";
export type { ExtractedEntity, ExtractedRelationship, EntityExtractionResult, EntityExtractorConfig } from "./entity-extractor.js";

export { ExtractionQueue, getExtractionQueue, resetExtractionQueue } from "./queue.js";
export type { Job, QueueStats } from "./queue.js";

export { FACT_EXTRACTION_V1 } from "./prompts/fact-extraction-v1.js";
export { ENTITY_EXTRACTION_V1 } from "./prompts/entity-extraction-v1.js";
export type { PromptTemplate } from "./prompts/types.js";

export { stripMetadataEnvelope } from "./utils.js";
