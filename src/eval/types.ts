import type {
  EntityResolutionConflictCode,
  EntityResolutionOutcome,
  EntityResolutionReasonCode,
  ExistingCompany,
  LocationCandidate
} from "../types.ts";

/**
 * The full, exhaustive `EntityResolutionOutcome` axis, in the same order the
 * type is declared in src/types.ts. Used as the fixed axis for the confusion
 * matrix and the `byExpectedOutcome` breakdown -- every outcome always
 * appears, even with a zero count, rather than only the ones a dataset
 * happens to exercise.
 */
export const ALL_ENTITY_RESOLUTION_OUTCOMES: readonly EntityResolutionOutcome[] = [
  "same_existing_location",
  "possible_changed_location",
  "new_branch_of_existing_company",
  "new_headquarters_of_existing_company",
  "possible_name_change",
  "likely_new_company",
  "ambiguous_manual_review"
];

/**
 * Outcomes that name/imply a specific existing BWI record -- the
 * "existingRelatedOutcomes" group used for false-existing-link/false-new
 * rates (see evaluate.ts). Deliberately named this way, not
 * "duplicateImplyingOutcomes" -- "duplicate" is not the only relationship
 * this group represents (branch/HQ/moved/renamed are not "duplicates").
 */
export const EXISTING_RELATED_OUTCOMES: readonly EntityResolutionOutcome[] = [
  "same_existing_location",
  "new_branch_of_existing_company",
  "new_headquarters_of_existing_company",
  "possible_changed_location",
  "possible_name_change"
];

export const NEW_COMPANY_OUTCOME: EntityResolutionOutcome = "likely_new_company";
export const ABSTENTION_OUTCOME: EntityResolutionOutcome = "ambiguous_manual_review";

/** Supported `EntityResolutionCaseDataset.schemaVersion` values this loader understands. A file declaring anything else is a validation error, not a silent best-effort parse. */
export const SUPPORTED_CASE_SCHEMA_VERSIONS: readonly string[] = ["1.0"];

/**
 * One labeled case: a candidate, its comparison set, and a human's expected
 * verdict. `candidate`/`existingCompanies` are exactly the production
 * `LocationCandidate`/`ExistingCompany[]` types -- never a second, harness-only
 * representation -- so a real case can be assembled from actual ingested/BWI
 * data without any schema translation.
 */
export type LabeledEntityResolutionCase = {
  caseId: string;
  description?: string;
  candidate: LocationCandidate;
  existingCompanies: ExistingCompany[];
  expected: {
    outcome: EntityResolutionOutcome;
    /** Required/forbidden/optional depending on `outcome` -- see EXISTING_RELATED_OUTCOMES-based validation in load-cases.ts. */
    matchedExistingCompanyId?: string;
  };
  provenance: {
    source: "synthetic" | "real_reviewer_case";
    reviewer?: string;
    notes?: string;
    recordedAt?: string;
  };
};

/** Versioned top-level file shape -- never a bare array, so a schema change is always explicit and checkable. */
export type EntityResolutionCaseDataset = {
  datasetId: string;
  schemaVersion: string;
  cases: LabeledEntityResolutionCase[];
};

/** One dataset after successful validation, annotated with where it came from. */
export type LoadedDataset = {
  datasetId: string;
  schemaVersion: string;
  sourcePath: string;
  cases: LabeledEntityResolutionCase[];
};

/** One attributable validation failure -- always identifies which file/dataset/case it came from, never a bare message. */
export type CaseValidationError = {
  sourcePath: string;
  datasetId?: string;
  caseId?: string;
  message: string;
};

export type LoadCasesResult = {
  datasets: LoadedDataset[];
  errors: CaseValidationError[];
};

/**
 * One case's evaluation result. Outcome correctness and matched-record
 * (target) correctness are deliberately separate fields -- a case can get
 * the right outcome but the wrong existing record (or vice versa isn't
 * possible under the current policy, but the fields stay independent on
 * principle). `matchedRecordCorrect`/`fullyCorrect` semantics:
 * - when `expectedMatchedExistingCompanyId` is undefined (the case's
 *   expected outcome doesn't name a record), `matchedRecordCorrect` is
 *   `undefined` (not applicable, not "false") and `fullyCorrect` depends
 *   only on `outcomeCorrect`.
 * - when it is defined, `fullyCorrect` requires both `outcomeCorrect` and
 *   `matchedRecordCorrect`.
 */
export type CaseResult = {
  datasetId: string;
  caseId: string;
  description?: string;
  expectedOutcome: EntityResolutionOutcome;
  actualOutcome: EntityResolutionOutcome;
  outcomeCorrect: boolean;
  expectedMatchedExistingCompanyId?: string;
  /** The machine's actual predicted existing-record id (`EntityResolutionDecision.matchedExistingCompanyId`), preserved regardless of correctness. */
  actualMatchedExistingCompanyId?: string;
  matchedRecordCorrect?: boolean;
  fullyCorrect: boolean;
  /** 1-based rank of the expected matched record in `rankCandidateMatches()`'s output, or null when this case has no expected matched record (not retrieval-applicable). */
  retrievalRank: number | null;
  decisionConfidence?: number;
  requiresHumanReview: boolean;
  reasonCodes: EntityResolutionReasonCode[];
  conflictCodes: EntityResolutionConflictCode[];
  reviewer?: string;
  notes?: string;
};

/** Outcome accuracy vs. matched-record (target) accuracy vs. combined full-case accuracy, always reported as a trio -- never conflated into one "accuracy" number. */
export type AccuracySummary = {
  count: number;
  outcomeAccuracy: number;
  /** null when no case in this group has an applicable expected matched record. */
  matchedRecordAccuracy: number | null;
  fullCaseAccuracy: number;
};

export type ConfusionMatrix = {
  outcomes: readonly EntityResolutionOutcome[];
  /** counts[expected][actual] */
  counts: Record<EntityResolutionOutcome, Record<EntityResolutionOutcome, number>>;
};

/** Retrieval-only metrics (rankCandidateMatches quality), computed solely over retrieval-applicable cases -- entirely independent of what the policy layer ultimately decided. */
export type RetrievalMetrics = {
  applicableCases: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  meanReciprocalRank: number;
  meanRank: number | null;
  medianRank: number | null;
};

/** False-existing-link / false-new rates, with ambiguous_manual_review deliberately excluded from both (see EXISTING_RELATED_OUTCOMES doc). null when the relevant denominator is empty, never 0-by-default. */
export type DirectionalErrorMetrics = {
  newExpectedCount: number;
  existingRelatedExpectedCount: number;
  falseExistingLinkRate: number | null;
  falseNewRate: number | null;
  abstentionRate: number | null;
};

export type ConfidenceBandMetrics = {
  band: string;
  caseCount: number;
  fullCaseAccuracy: number | null;
  outcomeAccuracy: number | null;
  meanConfidence: number | null;
};

export type OutcomeBreakdown = {
  accuracy: AccuracySummary;
  requiresHumanReviewRate: number;
  abstentionRate: number;
  actualOutcomeBreakdown: Record<EntityResolutionOutcome, number>;
};

export type EvaluationReport = {
  generatedAt: string;
  configuration: {
    casePaths: string[];
    retrievalKs: readonly number[];
    confidenceBandLabels: readonly string[];
  };
  datasets: Array<{ datasetId: string; schemaVersion: string; sourcePath: string; caseCount: number }>;
  totalCaseCount: number;
  overall: {
    accuracy: AccuracySummary;
    retrieval: RetrievalMetrics;
    directional: DirectionalErrorMetrics;
  };
  byExpectedOutcome: Record<EntityResolutionOutcome, OutcomeBreakdown>;
  confusionMatrix: ConfusionMatrix;
  confidenceCalibration: ConfidenceBandMetrics[];
  cases: CaseResult[];
};
