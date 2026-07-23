import { evaluatePublicationReadiness, type PublicationReadinessAssessment } from "../publication-readiness.ts";
import { evidenceForField, type LocationCandidate } from "../types.ts";
import { planEnrichmentFields, type EnrichmentFieldPlan } from "./field-planner.ts";
import { mergeFieldProposal, recordProviderConflict, type MergeConflict } from "./merge-results.ts";
import {
  enrichmentFieldToPath,
  type EnrichmentContext,
  type EnrichmentExecutionPolicy,
  type EnrichmentField,
  type EnrichmentProvider,
  type EnrichmentProviderResult,
  type EnrichmentRequest
} from "./types.ts";

export type EnrichmentRunResult = {
  runId: string;
  candidateId: string;
  startedAt: string;
  finishedAt: string;
  plannedFields: EnrichmentFieldPlan[];
  providerResults: EnrichmentProviderResult[];
  conflicts: MergeConflict[];
  filledFieldCount: number;
  initialReadiness: PublicationReadinessAssessment;
  finalReadiness: PublicationReadinessAssessment;
  /** The enriched candidate, kept in memory only -- see README's "Enrichment seam" section for why persistence is deliberately deferred. */
  candidate: LocationCandidate;
};

function buildContext(candidate: LocationCandidate, readiness: PublicationReadinessAssessment, policy: EnrichmentExecutionPolicy): EnrichmentContext {
  return {
    candidate,
    company: candidate.company,
    sourceProvenance: candidate.source,
    readiness,
    permittedFields: policy.allowedFields ?? [],
    policy,
    targetContactId: candidate.contacts.find((c) => c.id)?.id
  };
}

function buildRequest(context: EnrichmentContext, fields: readonly EnrichmentField[], runId: string, startedAt: string): EnrichmentRequest {
  const existingEvidence: EnrichmentRequest["existingEvidence"] = {};
  for (const field of fields) {
    const path = enrichmentFieldToPath(field, context.targetContactId);
    if (!path) continue;
    const evidence = evidenceForField(context.candidate.fieldEvidence, path);
    if (evidence.length > 0) existingEvidence[field] = evidence;
  }

  return {
    candidate: context.candidate,
    fields,
    existingEvidence,
    blockers: context.readiness.blockers,
    run: { runId, startedAt },
    targetContactId: context.targetContactId
  };
}

/**
 * Runs every eligible provider against one candidate and returns a complete,
 * explainable result. Never persists anything -- see EnrichmentRunResult's
 * `candidate` field and the README's "Enrichment seam" section. Provider
 * failures (thrown exceptions or a `failed` result) never abort the run for
 * other providers; each provider is executed independently and its outcome
 * recorded regardless of what happened to the others.
 */
export async function runEnrichment(params: {
  candidate: LocationCandidate;
  providers: readonly EnrichmentProvider[];
  policy?: EnrichmentExecutionPolicy;
  runId?: string;
}): Promise<EnrichmentRunResult> {
  const { candidate, providers } = params;
  const policy = params.policy ?? {};
  const runId = params.runId ?? crypto.randomUUID();
  const startedAt = new Date().toISOString();

  const initialReadiness = evaluatePublicationReadiness(candidate);
  const context = buildContext(candidate, initialReadiness, policy);

  const plannedFields = planEnrichmentFields(context, providers);
  const plannedFieldSet = new Set(plannedFields.map((p) => p.field));
  const cappedProviders = policy.maxProvidersPerRun !== undefined ? providers.slice(0, policy.maxProvidersPerRun) : providers;

  const eligibleProviders = cappedProviders.filter(
    (provider) => provider.supportedFields.some((field) => plannedFieldSet.has(field)) && provider.canRun(context)
  );

  const providerResults: EnrichmentProviderResult[] = [];

  // Deliberately sequential (not Promise.all) so one rejecting provider
  // never loses the results already collected from the others -- each
  // provider's outcome (or thrown exception, converted below) is recorded
  // independently before moving to the next.
  for (const provider of eligibleProviders) {
    const requestedFields = provider.supportedFields.filter((field) => plannedFieldSet.has(field));
    const request = buildRequest(context, requestedFields, runId, startedAt);

    try {
      const result = await provider.enrich(request);
      providerResults.push(result);
    } catch (error) {
      providerResults.push({
        status: "failed",
        providerId: provider.id,
        errorCategory: "unexpected_error",
        message: error instanceof Error ? error.message : "Unknown enrichment provider error"
      });
    }
  }

  let mergedCandidate = candidate;
  const conflicts: MergeConflict[] = [];
  let filledFieldCount = 0;

  for (const result of providerResults) {
    if (result.status !== "completed") continue;

    for (const outcome of result.outcomes) {
      if (outcome.status === "success") {
        const merge = mergeFieldProposal(mergedCandidate, outcome.proposal);
        mergedCandidate = merge.candidate;
        conflicts.push(...merge.conflicts);
        filledFieldCount += merge.filledFieldCount;
      } else if (outcome.status === "conflict") {
        // The provider itself could not resolve between multiple proposed
        // values -- record each as evidence and as a conflict for human
        // review. Never applied to the actual field, even if it happens to
        // be empty right now: the provider explicitly signaled it doesn't
        // know which (if any) value is correct.
        for (const proposal of outcome.proposals) {
          const merge = recordProviderConflict(mergedCandidate, proposal);
          mergedCandidate = merge.candidate;
          conflicts.push(...merge.conflicts);
        }
      }
      // not_found / skipped: nothing to merge, already captured in providerResults.
    }
  }

  const finalReadiness = evaluatePublicationReadiness(mergedCandidate);

  return {
    runId,
    candidateId: candidate.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    plannedFields,
    providerResults,
    conflicts,
    filledFieldCount,
    initialReadiness,
    finalReadiness,
    candidate: mergedCandidate
  };
}
