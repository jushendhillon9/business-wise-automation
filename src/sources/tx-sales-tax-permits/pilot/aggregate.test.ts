import { describe, expect, test } from "bun:test";
import { summarizePilotRun, type PilotCandidateOutcome, type SourceProcessingCounts } from "./aggregate.ts";

/** All fixtures are fabricated -- no real BWI/source rows. */
function outcome(overrides: Partial<PilotCandidateOutcome> = {}): PilotCandidateOutcome {
  return {
    locationCandidateId: crypto.randomUUID(),
    sourceRecordId: `${Math.random()}:1`,
    retrievalCount: 0,
    retrievalMs: 1,
    matchScore: 0,
    matchClassification: "likely_new",
    resolutionOutcome: "likely_new_company",
    requiresHumanReview: false,
    lifecycleConflict: false,
    relationshipTypes: [],
    publicationState: "blocked",
    blockerRuleIds: [],
    optionalMissingFields: [],
    ...overrides
  };
}

const EMPTY_SOURCE_PROCESSING: SourceProcessingCounts = {
  sourceObservationsRead: 0,
  validCandidatesCreated: 0,
  invalidObservations: 0,
  duplicateObservations: 0,
  candidatesPersisted: 0,
  alreadyIngestedSkipped: 0
};

describe("summarizePilotRun", () => {
  test("passes through source-processing counts unchanged", () => {
    const counts: SourceProcessingCounts = {
      sourceObservationsRead: 10,
      validCandidatesCreated: 9,
      invalidObservations: 1,
      duplicateObservations: 0,
      candidatesPersisted: 9,
      alreadyIngestedSkipped: 0
    };
    const summary = summarizePilotRun([], counts);
    expect(summary.sourceProcessing).toEqual(counts);
  });

  test("computes retrieval stats: zero/one-or-more counts, average, median, max", () => {
    const outcomes = [outcome({ retrievalCount: 0 }), outcome({ retrievalCount: 2 }), outcome({ retrievalCount: 4 }), outcome({ retrievalCount: 10 })];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.retrieval.zeroResultCount).toBe(1);
    expect(summary.retrieval.oneOrMoreResultCount).toBe(3);
    expect(summary.retrieval.averageSetSize).toBe(4);
    expect(summary.retrieval.medianSetSize).toBe(3);
    expect(summary.retrieval.maxSetSize).toBe(10);
  });

  test("sums retrieval latency across all candidates", () => {
    const outcomes = [outcome({ retrievalMs: 3 }), outcome({ retrievalMs: 5 })];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.retrieval.totalRetrievalMs).toBe(8);
  });

  test("counts every entity-resolution outcome type", () => {
    const outcomes = [
      outcome({ resolutionOutcome: "likely_new_company" }),
      outcome({ resolutionOutcome: "same_existing_location" }),
      outcome({ resolutionOutcome: "same_existing_location" }),
      outcome({ resolutionOutcome: "ambiguous_manual_review" })
    ];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.outcomeCounts).toEqual({
      likely_new_company: 1,
      same_existing_location: 2,
      ambiguous_manual_review: 1
    });
  });

  test("counts matched-existing status only among candidates with a match", () => {
    const outcomes = [
      outcome({ matchedExistingStatus: "DIRE" }),
      outcome({ matchedExistingStatus: "KEEP" }),
      outcome({ matchedExistingStatus: "DIRE" }),
      outcome({ matchedExistingStatus: undefined })
    ];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.matchedStatusCounts).toEqual({ DIRE: 2, KEEP: 1 });
  });

  test("counts candidates with a lifecycle conflict", () => {
    const outcomes = [outcome({ lifecycleConflict: true }), outcome({ lifecycleConflict: false }), outcome({ lifecycleConflict: true })];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.candidatesWithLifecycleWarnings).toBe(2);
  });

  test("counts relationship context (HQTR/AFFL) among matched candidates", () => {
    const outcomes = [outcome({ relationshipTypes: ["HQTR"] }), outcome({ relationshipTypes: ["AFFL"] }), outcome({ relationshipTypes: [] })];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.relationshipContextCounts).toEqual({ HQTR: 1, AFFL: 1 });
  });

  test("counts readiness states exhaustively, including zero counts for states never observed", () => {
    const outcomes = [outcome({ publicationState: "blocked" }), outcome({ publicationState: "blocked" }), outcome({ publicationState: "confirmed_ready" })];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.readinessCounts).toEqual({ blocked: 2, provisionally_ready: 0, confirmed_ready: 1 });
  });

  test("ranks the most common blocker rule ids and optional missing fields", () => {
    const outcomes = [
      outcome({ blockerRuleIds: ["sic_code_present", "local_phone_present"], optionalMissingFields: ["squareFootage"] }),
      outcome({ blockerRuleIds: ["sic_code_present"], optionalMissingFields: ["squareFootage", "leaseExpiration"] }),
      outcome({ blockerRuleIds: [], optionalMissingFields: [] })
    ];
    const summary = summarizePilotRun(outcomes, EMPTY_SOURCE_PROCESSING);
    expect(summary.topBlockerRuleIds[0]).toEqual({ ruleId: "sic_code_present", count: 2 });
    expect(summary.topOptionalMissingFields[0]).toEqual({ field: "squareFootage", count: 2 });
  });

  test("handles an empty outcome list without throwing", () => {
    const summary = summarizePilotRun([], EMPTY_SOURCE_PROCESSING);
    expect(summary.retrieval.averageSetSize).toBe(0);
    expect(summary.retrieval.medianSetSize).toBe(0);
    expect(summary.retrieval.maxSetSize).toBe(0);
    expect(summary.outcomeCounts).toEqual({});
  });
});
