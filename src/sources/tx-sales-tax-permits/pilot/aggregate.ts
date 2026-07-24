import type { PublicationReadinessState } from "../../../publication-readiness.ts";

/**
 * Aggregate-only summary of one shadow-pilot run. Never holds or exposes an
 * individual candidate's name/address/identifier -- only counts and rates,
 * built from a per-candidate outcome list the pilot CLI assembles during its
 * processing loop. See src/tx-permits-pilot.ts.
 */

export type PilotCandidateOutcome = {
  locationCandidateId: string;
  sourceRecordId: string;
  retrievalCount: number;
  retrievalMs: number;
  matchScore: number;
  matchClassification: string;
  resolutionOutcome: string;
  requiresHumanReview: boolean;
  /** True when resolution.conflicts includes a deleted/research-deleted lifecycle conflict for the matched BWI record. */
  lifecycleConflict: boolean;
  /** Raw BWI status code (e.g. "DIRE"/"KEEP"/"RSCH"/"RDEL"/"DELE") of the matched existing record, when one was matched. */
  matchedExistingStatus?: string;
  /** Relationship types (e.g. "HQTR"/"AFFL") the matched BWI record participates in, if any. */
  relationshipTypes: string[];
  publicationState: PublicationReadinessState;
  blockerRuleIds: string[];
  optionalMissingFields: string[];
};

export type SourceProcessingCounts = {
  sourceObservationsRead: number;
  validCandidatesCreated: number;
  invalidObservations: number;
  duplicateObservations: number;
  candidatesPersisted: number;
  alreadyIngestedSkipped: number;
};

export type RetrievalStats = {
  zeroResultCount: number;
  oneOrMoreResultCount: number;
  averageSetSize: number;
  medianSetSize: number;
  maxSetSize: number;
  totalRetrievalMs: number;
};

export type PilotSummary = {
  sourceProcessing: SourceProcessingCounts;
  retrieval: RetrievalStats;
  outcomeCounts: Record<string, number>;
  /** Counts of matched-existing-record raw status, among candidates with a match (e.g. DIRE/KEEP/RSCH/RDEL/DELE). */
  matchedStatusCounts: Record<string, number>;
  candidatesWithLifecycleWarnings: number;
  relationshipContextCounts: Record<string, number>;
  readinessCounts: Record<PublicationReadinessState, number>;
  topBlockerRuleIds: Array<{ ruleId: string; count: number }>;
  topOptionalMissingFields: Array<{ field: string; count: number }>;
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function rankCounts(counts: Record<string, number>, limit: number): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

export function summarizePilotRun(outcomes: PilotCandidateOutcome[], sourceProcessing: SourceProcessingCounts): PilotSummary {
  const retrievalCounts = outcomes.map((outcome) => outcome.retrievalCount);
  const totalRetrievalMs = outcomes.reduce((sum, outcome) => sum + outcome.retrievalMs, 0);

  const outcomeCounts: Record<string, number> = {};
  const matchedStatusCounts: Record<string, number> = {};
  const relationshipContextCounts: Record<string, number> = {};
  const blockerCounts: Record<string, number> = {};
  const optionalMissingCounts: Record<string, number> = {};
  const readinessCounts: Record<PublicationReadinessState, number> = { blocked: 0, provisionally_ready: 0, confirmed_ready: 0 };

  let candidatesWithLifecycleWarnings = 0;

  for (const outcome of outcomes) {
    outcomeCounts[outcome.resolutionOutcome] = (outcomeCounts[outcome.resolutionOutcome] ?? 0) + 1;

    if (outcome.matchedExistingStatus) {
      matchedStatusCounts[outcome.matchedExistingStatus] = (matchedStatusCounts[outcome.matchedExistingStatus] ?? 0) + 1;
    }

    if (outcome.lifecycleConflict) candidatesWithLifecycleWarnings += 1;

    for (const type of outcome.relationshipTypes) {
      relationshipContextCounts[type] = (relationshipContextCounts[type] ?? 0) + 1;
    }

    readinessCounts[outcome.publicationState] += 1;

    for (const ruleId of outcome.blockerRuleIds) {
      blockerCounts[ruleId] = (blockerCounts[ruleId] ?? 0) + 1;
    }
    for (const field of outcome.optionalMissingFields) {
      optionalMissingCounts[field] = (optionalMissingCounts[field] ?? 0) + 1;
    }
  }

  return {
    sourceProcessing,
    retrieval: {
      zeroResultCount: outcomes.filter((outcome) => outcome.retrievalCount === 0).length,
      oneOrMoreResultCount: outcomes.filter((outcome) => outcome.retrievalCount > 0).length,
      averageSetSize: Number(average(retrievalCounts).toFixed(2)),
      medianSetSize: median(retrievalCounts),
      maxSetSize: retrievalCounts.length > 0 ? Math.max(...retrievalCounts) : 0,
      totalRetrievalMs
    },
    outcomeCounts,
    matchedStatusCounts,
    candidatesWithLifecycleWarnings,
    relationshipContextCounts,
    readinessCounts,
    topBlockerRuleIds: rankCounts(blockerCounts, 10).map(({ key, count }) => ({ ruleId: key, count })),
    topOptionalMissingFields: rankCounts(optionalMissingCounts, 10).map(({ key, count }) => ({ field: key, count }))
  };
}
