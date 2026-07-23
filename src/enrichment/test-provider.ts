import { createFieldEvidence, type FieldEvidence, type FieldEvidenceSourceType } from "../types.ts";
import { enrichmentFieldToPath, type EnrichmentContext, type EnrichmentField, type EnrichmentFieldOutcome, type EnrichmentProvider, type EnrichmentProviderResult, type EnrichmentRequest } from "./types.ts";

/**
 * Deterministic, fully in-memory provider used only by tests -- proves the
 * `EnrichmentProvider` seam works end-to-end without calling anything
 * external. Never used outside test files; there is no live provider in
 * this commit.
 */
export type TestProviderFieldBehavior =
  | { kind: "success"; value: unknown; confidence?: number }
  | { kind: "not_found"; reason?: string }
  | { kind: "conflict"; values: unknown[]; reason?: string }
  | { kind: "skip"; reason?: string }
  | { kind: "throw"; message?: string };

export type TestProviderOptions = {
  id: string;
  supportedFields: readonly EnrichmentField[];
  behaviors: Partial<Record<EnrichmentField, TestProviderFieldBehavior>>;
  canRun?: (context: EnrichmentContext) => boolean;
  sourceType?: FieldEvidenceSourceType;
};

function buildEvidence(providerId: string, field: EnrichmentField, value: unknown, confidence: number | undefined, contactId: string | undefined, sourceType: FieldEvidenceSourceType): FieldEvidence | undefined {
  const path = enrichmentFieldToPath(field, contactId);
  if (!path) return undefined;

  return createFieldEvidence({
    path,
    value,
    normalizedValue: value,
    confidence: confidence ?? 0.75,
    source: {
      sourceType,
      sourceId: providerId,
      sourceName: `Test provider (${providerId})`,
      sourceObservationId: `${providerId}:${field}`
    },
    derivation: "directly_observed"
  });
}

/** Builds a deterministic fake provider whose per-field behavior is configured explicitly by the caller -- no hidden randomness or timing. */
export function createTestEnrichmentProvider(options: TestProviderOptions): EnrichmentProvider {
  const sourceType = options.sourceType ?? "other";

  return {
    id: options.id,
    supportedFields: options.supportedFields,

    canRun(context: EnrichmentContext): boolean {
      return options.canRun ? options.canRun(context) : true;
    },

    async enrich(request: EnrichmentRequest): Promise<EnrichmentProviderResult> {
      const outcomes: EnrichmentFieldOutcome[] = [];

      for (const field of request.fields) {
        const behavior = options.behaviors[field];
        if (!behavior) continue;

        if (behavior.kind === "throw") {
          throw new Error(behavior.message ?? `Test provider "${options.id}" was configured to throw for field "${field}"`);
        }

        if (behavior.kind === "not_found") {
          outcomes.push({ field, status: "not_found", reason: behavior.reason ?? "Test provider found no value for this field." });
          continue;
        }

        if (behavior.kind === "skip") {
          outcomes.push({ field, status: "skipped", reason: behavior.reason ?? "Test provider was configured to skip this field." });
          continue;
        }

        if (behavior.kind === "conflict") {
          const proposals = behavior.values
            .map((value) => buildEvidence(options.id, field, value, undefined, request.targetContactId, sourceType))
            .filter((e): e is FieldEvidence => e !== undefined);
          outcomes.push({ field, status: "conflict", proposals, reason: behavior.reason ?? "Test provider found disagreeing values." });
          continue;
        }

        const proposal = buildEvidence(options.id, field, behavior.value, behavior.confidence, request.targetContactId, sourceType);
        if (proposal) {
          outcomes.push({ field, status: "success", proposal });
        } else {
          outcomes.push({ field, status: "skipped", reason: "No addressable field path (e.g. a contact field with no target contact)." });
        }
      }

      return { status: "completed", providerId: options.id, outcomes };
    }
  };
}
