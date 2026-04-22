import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { destr } from "destr";
import type pg from "pg";
import {
  getUnreconciledConcepts,
  findReconciliationCandidates,
  markConceptReconciled,
  updateConceptContent,
  updateConceptEmbedding,
  insertAuditEntry,
  insertConcept,
  deactivateConcept,
} from "../db/queries.js";
import { embedText, parseEmbeddingSafe } from "../embed/index.js";
import type { NightlyConfig } from "./nightly.js";
import type { Concept } from "../schema/types.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "reconcile" });

interface ReconcileDecision {
  operation: "noop" | "update" | "supersede" | "merge" | "delete_new";
  target_id: string | null;
  updated_content: string | null;
  reasoning: string;
  confidence: number;
  temporal_note?: string;
}

const ReconcileDecisionSchema = z.object({
  operation: z.enum(["noop", "update", "supersede", "merge", "delete_new"]),
  target_id: z.string().nullable(),
  updated_content: z.string().nullable(),
  reasoning: z.string(),
  confidence: z.number(),
  temporal_note: z.string().optional(),
});

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function buildPrompt(concept: Concept, candidates: Concept[]): string {
  const candidatesList = candidates
    .map((c, i) =>
      `[${i + 1}] (created: ${c.created_at.toISOString()}, type: ${c.concept_type}) ${c.content}`
    )
    .join("\n");

  return `You are a memory reconciliation system. A new memory concept has been extracted.
Compare it against existing concepts and decide what to do.

New concept (created: ${concept.created_at.toISOString()}):
Type: ${concept.concept_type}
Content: ${concept.content}
Tags: ${concept.tags.join(", ")}

Existing concepts to compare against:
${candidatesList}

Rules:
- Newer information takes precedence over older unless the older has clearly higher confidence
- Prefer updating or superseding over keeping duplicates
- If the new concept is genuinely different from all candidates, return noop
- If the new concept directly contradicts or refines an existing one, supersede or update it
- Only merge when both concepts contain complementary information worth preserving`;
}

export async function stepReconcile(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig,
  runId: string,
): Promise<number> {
  let concepts = await getUnreconciledConcepts(pool);

  if (concepts.length === 0) {
    log.info("No unreconciled concepts found");
    return 0;
  }

  const cap = (config as NightlyConfig & { maxConceptsPerRun?: number }).maxConceptsPerRun ?? 50;
  if (concepts.length > cap) {
    log.info(`Capping concepts from ${concepts.length} to ${cap}`);
    concepts = concepts.slice(0, cap);
  }

  log.info(`Reconciling ${concepts.length} concepts`);

  const model = (config as NightlyConfig & { reconciliationModel?: string }).reconciliationModel ?? "claude-sonnet-4-6";
  let nonNoopCount = 0;

  for (const concept of concepts) {
    const embedding = parseEmbeddingSafe(concept.embedding);
    const candidates = await findReconciliationCandidates(
      pool,
      concept.id,
      embedding,
      concept.tags,
    );

    if (candidates.length === 0) {
      await insertAuditEntry(pool, {
        run_id: runId,
        operation: "noop",
        concept_type: concept.concept_type,
        new_concept_id: concept.id,
        reasoning: "No candidates found",
        model_used: model,
      });
      await markConceptReconciled(pool, concept.id);
      continue;
    }

    // Call Sonnet for reconciliation decision via tool_use
    let decision: ReconcileDecision;
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        tools: [{
          name: "reconcile_decision",
          description: "Decide how to reconcile a new memory concept against existing ones.",
          input_schema: {
            type: "object" as const,
            properties: {
              operation: { type: "string", enum: ["noop", "update", "supersede", "merge", "delete_new"] },
              target_id: { type: ["string", "null"], description: "Existing concept UUID or null" },
              updated_content: { type: ["string", "null"], description: "New content for update or merge, null otherwise" },
              reasoning: { type: "string" },
              confidence: { type: "number" },
              temporal_note: { type: "string" },
            },
            required: ["operation", "target_id", "updated_content", "reasoning", "confidence"],
          },
        }],
        tool_choice: { type: "tool", name: "reconcile_decision" },
        messages: [{ role: "user", content: buildPrompt(concept, candidates) }],
      });

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        log.warn({ conceptId: concept.id }, "no tool_use block in reconcile response");
        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "parse_error",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          model_used: model,
        });
        await markConceptReconciled(pool, concept.id);
        continue;
      }

      const parsed = ReconcileDecisionSchema.safeParse(destr(toolBlock.input));
      if (!parsed.success) {
        log.error({ error: parsed.error, conceptId: concept.id }, "reconcile schema validation failed");
        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "parse_error",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          model_used: model,
        });
        await markConceptReconciled(pool, concept.id);
        continue;
      }
      decision = parsed.data;
    } catch (err) {
      log.error({ err }, `Parse error for concept ${concept.id}`);
      await insertAuditEntry(pool, {
        run_id: runId,
        operation: "parse_error",
        concept_type: concept.concept_type,
        new_concept_id: concept.id,
        model_used: model,
      });
      await markConceptReconciled(pool, concept.id);
      continue;
    }

    const isDestructive = ["supersede", "merge", "delete_new"].includes(decision.operation);

    // Low confidence guard on destructive operations
    if (isDestructive && decision.confidence < 0.5) {
      await insertAuditEntry(pool, {
        run_id: runId,
        operation: "low_confidence_skip",
        concept_type: concept.concept_type,
        new_concept_id: concept.id,
        target_id: decision.target_id ?? undefined,
        reasoning: decision.reasoning,
        confidence: decision.confidence,
        temporal_note: decision.temporal_note,
        model_used: model,
      });
      await markConceptReconciled(pool, concept.id);
      continue;
    }

    // Execute decision
    try {
      if (decision.operation === "noop") {
        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "noop",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          target_id: decision.target_id ?? undefined,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          temporal_note: decision.temporal_note,
          model_used: model,
        });

      } else if (decision.operation === "update" && decision.target_id && decision.updated_content) {
        const target = candidates.find(c => c.id === decision.target_id);
        await updateConceptContent(pool, decision.target_id, decision.updated_content);
        if (config.embeddingApiKey) {
          try {
            const newEmbedding = await embedText(decision.updated_content, config.embeddingApiKey);
            await updateConceptEmbedding(pool, decision.target_id, newEmbedding);
          } catch (err) {
            log.error({ err }, `Failed to re-embed updated concept ${decision.target_id}`);
          }
        }
        await markConceptReconciled(pool, decision.target_id);
        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "update",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          target_id: decision.target_id,
          before_content: target?.content,
          after_content: decision.updated_content,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          temporal_note: decision.temporal_note,
          model_used: model,
        });
        nonNoopCount++;

      } else if (decision.operation === "supersede" && decision.target_id) {
        if (!isUuid(decision.target_id)) {
          log.error(`Skipping supersede: target_id is not a valid UUID: "${decision.target_id}"`);
          await markConceptReconciled(pool, concept.id);
          continue;
        }
        const target = candidates.find(c => c.id === decision.target_id);
        await deactivateConcept(pool, decision.target_id, concept.id);
        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "supersede",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          target_id: decision.target_id,
          before_content: target?.content,
          after_content: concept.content,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          temporal_note: decision.temporal_note,
          model_used: model,
        });
        nonNoopCount++;

      } else if (decision.operation === "merge" && decision.target_id && decision.updated_content) {
        if (!isUuid(decision.target_id)) {
          log.error(`Skipping merge: target_id is not a valid UUID: "${decision.target_id}"`);
          await markConceptReconciled(pool, concept.id);
          continue;
        }
        const target = candidates.find(c => c.id === decision.target_id);
        const mergedId = await insertConcept(pool, {
          concept_type: concept.concept_type,
          content: decision.updated_content,
          embedding: null,
          utility_score: 0.5,
          provenance_kind: "model",
          provenance_ref: null,
          confidence: decision.confidence,
          supersedes_id: null,
          superseded_by: null,
          is_active: true,
          tags: [...new Set([...concept.tags, ...(target?.tags ?? [])])],
          metadata: {
            merged_from: [concept.id, decision.target_id],
            merged_at: new Date().toISOString(),
            reconciled_at: new Date().toISOString(),
          },
        });

        if (config.embeddingApiKey) {
          try {
            const vec = await embedText(decision.updated_content, config.embeddingApiKey);
            await pool.query(
              "UPDATE concepts SET embedding = $1::vector WHERE id = $2",
              [JSON.stringify(vec), mergedId],
            );
          } catch (err) {
            log.error({ err }, `embed merged concept ${mergedId} failed`);
          }
        }

        await deactivateConcept(pool, decision.target_id, mergedId);
        await deactivateConcept(pool, concept.id, mergedId);

        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "merge",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          target_id: decision.target_id,
          merged_id: mergedId,
          before_content: `NEW: ${concept.content} | EXISTING: ${target?.content ?? ""}`,
          after_content: decision.updated_content,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          temporal_note: decision.temporal_note,
          model_used: model,
        });
        nonNoopCount++;
        // concept was deactivated above — skip markConceptReconciled
        continue;

      } else if (decision.operation === "delete_new") {
        const supersededBy = decision.target_id && isUuid(decision.target_id)
          ? decision.target_id
          : concept.id;
        if (decision.target_id && !isUuid(decision.target_id)) {
          log.error(`delete_new: target_id is not a valid UUID: "${decision.target_id}", falling back to self-reference`);
        }
        await deactivateConcept(pool, concept.id, supersededBy);
        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "delete_new",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          target_id: decision.target_id ?? undefined,
          before_content: concept.content,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          temporal_note: decision.temporal_note,
          model_used: model,
        });
        nonNoopCount++;
        // concept was deactivated — no need to mark reconciled
        continue;

      } else {
        // Fallback: treat as noop if decision is malformed
        await insertAuditEntry(pool, {
          run_id: runId,
          operation: "noop",
          concept_type: concept.concept_type,
          new_concept_id: concept.id,
          reasoning: `Malformed decision: ${decision.operation}`,
          model_used: model,
        });
      }
    } catch (err) {
      log.error({ err }, `Failed to execute decision for concept ${concept.id}`);
    }

    await markConceptReconciled(pool, concept.id);
  }

  log.info(`Reconciled ${concepts.length} concepts, ${nonNoopCount} non-noop operations`);
  return nonNoopCount;
}
