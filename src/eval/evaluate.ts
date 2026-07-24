import { resolveCandidateAgainstExisting } from "../entity-resolution-policy.ts";
import { rankCandidateMatches } from "../entity-resolution.ts";
import type { EntityResolutionOutcome } from "../types.ts";
import {
  ABSTENTION_OUTCOME,
  ALL_ENTITY_RESOLUTION_OUTCOMES,
  EXISTING_RELATED_OUTCOMES,
  NEW_COMPANY_OUTCOME,
  type AccuracySummary,
  type CaseResult,
  type ConfidenceBandMetrics,
  type ConfusionMatrix,
  type DirectionalErrorMetrics,
  type EvaluationReport,
  type LoadedDataset,
  type OutcomeBreakdown,
  type RetrievalMetrics
} from "./types.ts";

const RETRIEVAL_KS = [1, 3, 5] as const;

type ConfidenceBandDefinition = { label: string; min: number; max: number } | { label: "unscored" };

/** Five equal-width scored bands plus an explicit "unscored" bucket -- a case with no decisionConfidence is never silently folded into the lowest band. */
const CONFIDENCE_BANDS: readonly ConfidenceBandDefinition[] = [
  { label: "unscored" },
  { label: "0.0-0.2", min: 0.0, max: 0.2 },
  { label: "0.2-0.4", min: 0.2, max: 0.4 },
  { label: "0.4-0.6", min: 0.4, max: 0.6 },
  { label: "0.6-0.8", min: 0.6, max: 0.8 },
  { label: "0.8-1.0", min: 0.8, max: 1.0 }
];

/**
 * Exported for direct unit testing of band edges -- current production
 * `decisionConfidence` (src/entity-resolution-policy.ts) is always a number
 * in practice (even the "no existing companies" case resolves to 1, not
 * undefined), so `undefined`/"unscored" can't be exercised end-to-end today.
 * The type is still `decisionConfidence?: number`, so this stays correct
 * and future-proof rather than assuming a case that can't currently occur.
 */
export function bandForConfidence(confidence: number | undefined): string {
  if (confidence === undefined) return "unscored";
  for (const band of CONFIDENCE_BANDS) {
    if (!("min" in band)) continue;
    const isTopBand = band.label === "0.8-1.0";
    if (confidence >= band.min && (isTopBand ? confidence <= band.max : confidence < band.max)) {
      return band.label;
    }
  }
  return "unscored";
}

function evaluateCase(dataset: LoadedDataset, caseIndex: number): CaseResult {
  const labeledCase = dataset.cases[caseIndex]!;
  const { candidate, existingCompanies, expected } = labeledCase;

  const ranked = rankCandidateMatches(candidate, existingCompanies);
  const decision = resolveCandidateAgainstExisting(candidate, existingCompanies);

  const outcomeCorrect = decision.outcome === expected.outcome;
  const expectedMatchedExistingCompanyId = expected.matchedExistingCompanyId;
  const actualMatchedExistingCompanyId = decision.matchedExistingCompanyId;

  const matchedRecordCorrect =
    expectedMatchedExistingCompanyId === undefined ? undefined : actualMatchedExistingCompanyId === expectedMatchedExistingCompanyId;

  const fullyCorrect = expectedMatchedExistingCompanyId === undefined ? outcomeCorrect : outcomeCorrect && matchedRecordCorrect === true;

  const retrievalRank =
    expectedMatchedExistingCompanyId === undefined
      ? null
      : (() => {
          const index = ranked.findIndex((r) => r.existing.id === expectedMatchedExistingCompanyId);
          return index === -1 ? null : index + 1;
        })();

  return {
    datasetId: dataset.datasetId,
    caseId: labeledCase.caseId,
    description: labeledCase.description,
    expectedOutcome: expected.outcome,
    actualOutcome: decision.outcome,
    outcomeCorrect,
    expectedMatchedExistingCompanyId,
    actualMatchedExistingCompanyId,
    matchedRecordCorrect,
    fullyCorrect,
    retrievalRank,
    decisionConfidence: decision.decisionConfidence,
    requiresHumanReview: decision.requiresHumanReview,
    reasonCodes: decision.reasons,
    conflictCodes: decision.conflicts,
    reviewer: labeledCase.provenance.reviewer,
    notes: labeledCase.provenance.notes
  };
}

function summarizeAccuracy(cases: readonly CaseResult[]): AccuracySummary {
  const count = cases.length;
  const outcomeCorrectCount = cases.filter((c) => c.outcomeCorrect).length;
  const fullyCorrectCount = cases.filter((c) => c.fullyCorrect).length;
  const matchedApplicable = cases.filter((c) => c.matchedRecordCorrect !== undefined);
  const matchedCorrectCount = matchedApplicable.filter((c) => c.matchedRecordCorrect === true).length;

  return {
    count,
    outcomeAccuracy: count > 0 ? outcomeCorrectCount / count : 0,
    matchedRecordAccuracy: matchedApplicable.length > 0 ? matchedCorrectCount / matchedApplicable.length : null,
    fullCaseAccuracy: count > 0 ? fullyCorrectCount / count : 0
  };
}

function buildConfusionMatrix(cases: readonly CaseResult[]): ConfusionMatrix {
  const counts = Object.fromEntries(
    ALL_ENTITY_RESOLUTION_OUTCOMES.map((expected) => [
      expected,
      Object.fromEntries(ALL_ENTITY_RESOLUTION_OUTCOMES.map((actual) => [actual, 0]))
    ])
  ) as ConfusionMatrix["counts"];

  for (const c of cases) {
    counts[c.expectedOutcome][c.actualOutcome] += 1;
  }

  return { outcomes: ALL_ENTITY_RESOLUTION_OUTCOMES, counts };
}

function buildRetrievalMetrics(cases: readonly CaseResult[]): RetrievalMetrics {
  const ranks = cases.map((c) => c.retrievalRank).filter((rank): rank is number => rank !== null);
  const applicableCases = ranks.length;

  if (applicableCases === 0) {
    return { applicableCases: 0, recallAt1: 0, recallAt3: 0, recallAt5: 0, meanReciprocalRank: 0, meanRank: null, medianRank: null };
  }

  const recallAt = (k: number) => ranks.filter((rank) => rank <= k).length / applicableCases;
  const meanReciprocalRank = ranks.reduce((sum, rank) => sum + 1 / rank, 0) / applicableCases;
  const meanRank = ranks.reduce((sum, rank) => sum + rank, 0) / applicableCases;

  const sorted = [...ranks].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianRank = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

  return {
    applicableCases,
    recallAt1: recallAt(RETRIEVAL_KS[0]),
    recallAt3: recallAt(RETRIEVAL_KS[1]),
    recallAt5: recallAt(RETRIEVAL_KS[2]),
    meanReciprocalRank,
    meanRank,
    medianRank
  };
}

function buildDirectionalMetrics(cases: readonly CaseResult[]): DirectionalErrorMetrics {
  const newExpected = cases.filter((c) => c.expectedOutcome === NEW_COMPANY_OUTCOME);
  const existingRelatedExpected = cases.filter((c) => EXISTING_RELATED_OUTCOMES.includes(c.expectedOutcome));

  const falseExistingLinkCount = newExpected.filter((c) => EXISTING_RELATED_OUTCOMES.includes(c.actualOutcome)).length;
  const falseNewCount = existingRelatedExpected.filter((c) => c.actualOutcome === NEW_COMPANY_OUTCOME).length;
  const abstentionCount = cases.filter((c) => c.actualOutcome === ABSTENTION_OUTCOME).length;

  return {
    newExpectedCount: newExpected.length,
    existingRelatedExpectedCount: existingRelatedExpected.length,
    falseExistingLinkRate: newExpected.length > 0 ? falseExistingLinkCount / newExpected.length : null,
    falseNewRate: existingRelatedExpected.length > 0 ? falseNewCount / existingRelatedExpected.length : null,
    abstentionRate: cases.length > 0 ? abstentionCount / cases.length : null
  };
}

function buildOutcomeBreakdown(cases: readonly CaseResult[]): Record<EntityResolutionOutcome, OutcomeBreakdown> {
  const result = {} as Record<EntityResolutionOutcome, OutcomeBreakdown>;

  for (const expectedOutcome of ALL_ENTITY_RESOLUTION_OUTCOMES) {
    const group = cases.filter((c) => c.expectedOutcome === expectedOutcome);
    const actualOutcomeBreakdown = Object.fromEntries(ALL_ENTITY_RESOLUTION_OUTCOMES.map((o) => [o, 0])) as Record<
      EntityResolutionOutcome,
      number
    >;
    for (const c of group) actualOutcomeBreakdown[c.actualOutcome] += 1;

    result[expectedOutcome] = {
      accuracy: summarizeAccuracy(group),
      requiresHumanReviewRate: group.length > 0 ? group.filter((c) => c.requiresHumanReview).length / group.length : 0,
      abstentionRate: group.length > 0 ? group.filter((c) => c.actualOutcome === ABSTENTION_OUTCOME).length / group.length : 0,
      actualOutcomeBreakdown
    };
  }

  return result;
}

function buildConfidenceCalibration(cases: readonly CaseResult[]): ConfidenceBandMetrics[] {
  return CONFIDENCE_BANDS.map((band) => {
    const group = cases.filter((c) => bandForConfidence(c.decisionConfidence) === band.label);
    const scored = group.filter((c) => c.decisionConfidence !== undefined);

    return {
      band: band.label,
      caseCount: group.length,
      fullCaseAccuracy: group.length > 0 ? group.filter((c) => c.fullyCorrect).length / group.length : null,
      outcomeAccuracy: group.length > 0 ? group.filter((c) => c.outcomeCorrect).length / group.length : null,
      meanConfidence: scored.length > 0 ? scored.reduce((sum, c) => sum + (c.decisionConfidence ?? 0), 0) / scored.length : null
    };
  });
}

/**
 * Evaluates every case in every dataset by calling the exact production
 * resolution functions (`rankCandidateMatches`/`resolveCandidateAgainstExisting`)
 * -- no second matching implementation, no weight/threshold tuning. Assumes
 * `datasets` has already passed validation (see load-cases.ts) with zero
 * errors; the caller is responsible for failing closed before calling this.
 */
export function evaluateEntityResolution(datasets: readonly LoadedDataset[], casePaths: readonly string[]): EvaluationReport {
  const cases: CaseResult[] = [];
  for (const dataset of datasets) {
    for (let i = 0; i < dataset.cases.length; i++) {
      cases.push(evaluateCase(dataset, i));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    configuration: {
      casePaths: [...casePaths],
      retrievalKs: RETRIEVAL_KS,
      confidenceBandLabels: CONFIDENCE_BANDS.map((b) => b.label)
    },
    datasets: datasets.map((d) => ({ datasetId: d.datasetId, schemaVersion: d.schemaVersion, sourcePath: d.sourcePath, caseCount: d.cases.length })),
    totalCaseCount: cases.length,
    overall: {
      accuracy: summarizeAccuracy(cases),
      retrieval: buildRetrievalMetrics(cases),
      directional: buildDirectionalMetrics(cases)
    },
    byExpectedOutcome: buildOutcomeBreakdown(cases),
    confusionMatrix: buildConfusionMatrix(cases),
    confidenceCalibration: buildConfidenceCalibration(cases),
    cases
  };
}
