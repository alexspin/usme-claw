import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import {
  getUnreconciledConcepts,
  findReconciliationCandidates,
  markConceptReconciled,
  updateConceptContent,
  insertAuditEntry,
  insertConcept,
  deactivateConcept,
} from "../db/queries.js";
import { embedText } from "../embed/index.js";
import type { NightlyConfig } from "./nightly.js";
import type { Concept } from "../schema/types.js";

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`[usme:reconcile] ${msg}`, data ?? ""),
  error: (msg: string, err?: unknown) =>
    console.error(`[usme:reconcile] ERROR ${msg}`, err ?? ""),
};

interface ReconcileDecision {
  operation: "noop" | "update" | "supersede" | "merge" | "delete_new";
  target_id: string | null;
  updated_content: string | null;
  reasoning: string;
  confidence: number;
  temporal_note?: string;
}

function stripJsonFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
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
- Only merge when both concepts contain complementary information worth preserving

Return valid JSON only:
{
  "operation": "noop" | "update" | "supersede" | "merge" | "delete_new",
  "target_id": "<existing concept UUID or null>",
  "updated_content": "<new content string for update or merge, null otherwise>",
  "reasoning": "<one sentence explanation>",
  "confidence": <0.0-1.0>,
  "temporal_note": "<optional: e.g. User switched from X to Y in April 2026>"
}`;
}

export async function stepReconcile(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig,
  runId: string,
): Promise<number> {
  const concepts = await getUnreconciledConcepts(pool);

  if (concepts.length === 0) {
    log.info("No unreconciled concepts found");
    return 0;
  }

  log.info(`Reconciling ${concepts.length} concepts`);

  const model = (config as NightlyConfig & { reconciliationModel?: string }).reconciliationModel ?? "claude-sonnet-4-6";
  let nonNoopCount = 0;

  for (const concept of concepts) {
    const candidates = await findReconciliationCandidates(
      pool,
      concept.id,
      concept.embedding,
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

    // Call Sonnet for reconciliation decision
    let decision: ReconcileDecision;
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: buildPrompt(concept, candidates) }],
      });

      const text = stripJsonFences(
        response.content[0].type === "text" ? response.content[0].text : "{}",
      );
      decision = JSON.parse(text) as ReconcileDecision;
    } catch (err) {
      log.error(`Parse error for concept ${concept.id}`, err);
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
            log.error(`embed merged concept ${mergedId} failed`, err);
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
        await deactivateConcept(pool, concept.id, decision.target_id ?? concept.id);
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
      log.error(`Failed to execute decision for concept ${concept.id}`, err);
    }

    await markConceptReconciled(pool, concept.id);
  }

  log.info(`Reconciled ${concepts.length} concepts, ${nonNoopCount} non-noop operations`);
  return nonNoopCount;
}
