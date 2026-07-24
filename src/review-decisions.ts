import type { Database } from "bun:sqlite";
import {
  insertReviewDecision,
  loadLatestReviewDecisionForCandidate,
  loadReviewQueueRowByCandidateId,
  updateReviewQueueStatus,
  type ReviewQueueRow
} from "./db.ts";
import type {
  EntityResolutionConflictCode,
  EntityResolutionOutcome,
  EntityResolutionReasonCode,
  FieldPath,
  MatchClassification
} from "./types.ts";
import type { PublicationReadinessRuleId, PublicationReadinessState } from "./publication-readiness.ts";

/**
 * Reviewer actions a human can record against one LocationCandidate, per
 * docs/BWI_DOMAIN_RULES.md §19's "Target reviewer actions" -- reused
 * verbatim rather than inventing a second taxonomy.
 */
export type ReviewDecisionAction =
  | "approve_new_company"
  | "approve_new_branch"
  | "link_existing_location"
  | "mark_duplicate"
  | "needs_more_research"
  | "reject_source_observation";

export const REVIEW_DECISION_ACTIONS: readonly ReviewDecisionAction[] = [
  "approve_new_company",
  "approve_new_branch",
  "link_existing_location",
  "mark_duplicate",
  "needs_more_research",
  "reject_source_observation"
];

export function isReviewDecisionAction(value: string): value is ReviewDecisionAction {
  return (REVIEW_DECISION_ACTIONS as readonly string[]).includes(value);
}

/**
 * Convenience status derived from the latest decision, mirrored onto
 * `review_queue.review_status`. `review_decisions` (append-only) is always
 * the source of truth; this is only ever a cache of its latest entry -- see
 * `recordReviewDecision()`'s invariant check below.
 */
export type ReviewQueueStatus = "pending" | "approved" | "duplicate" | "needs_more_research" | "rejected";

/** Deterministic, exhaustive action -> status mapping. */
export function statusForAction(action: ReviewDecisionAction): ReviewQueueStatus {
  switch (action) {
    case "approve_new_company":
    case "approve_new_branch":
    case "link_existing_location":
      return "approved";
    case "mark_duplicate":
      return "duplicate";
    case "needs_more_research":
      return "needs_more_research";
    case "reject_source_observation":
      return "rejected";
  }
}

type SelectedBwiIdRequirement = "forbidden" | "required" | "optional";

/**
 * Whether `selectedBwiRecordId` (the reviewer's actual chosen target, never
 * to be confused with the machine's recommended match -- see
 * `MachineRecommendationSnapshot.machineSelectedExistingCompanyId`) is
 * forbidden, required, or optional for a given action.
 */
function selectedBwiIdRequirementForAction(action: ReviewDecisionAction): SelectedBwiIdRequirement {
  switch (action) {
    case "approve_new_company":
      return "forbidden";
    case "approve_new_branch":
    case "link_existing_location":
    case "mark_duplicate":
      return "required";
    case "needs_more_research":
    case "reject_source_observation":
      return "optional";
  }
}

/** Throws a descriptive error when `selectedBwiRecordId` violates the action's requirement. Never silently drops or invents a value. */
export function validateSelectedBwiRecordId(action: ReviewDecisionAction, selectedBwiRecordId?: string): void {
  const requirement = selectedBwiIdRequirementForAction(action);
  const hasValue = Boolean(selectedBwiRecordId?.trim());

  if (requirement === "forbidden" && hasValue) {
    throw new Error(`Action "${action}" must not specify a selectedBwiRecordId (got "${selectedBwiRecordId}"); approving a brand-new company has no existing BWI record to select.`);
  }
  if (requirement === "required" && !hasValue) {
    throw new Error(`Action "${action}" requires a selectedBwiRecordId identifying the existing BWI record the reviewer chose.`);
  }
}

/** One structured correction a reviewer proposed for a field, captured for audit only -- never applied to the candidate/company/fieldEvidence in this commit. */
export type ReviewFieldCorrection = {
  path: FieldPath;
  previousValue: unknown;
  correctedValue: unknown;
  reason?: string;
};

/**
 * Frozen snapshot of what the automated pipeline recommended at the moment
 * a decision was recorded, built entirely from the existing `review_queue`
 * row -- no new scoring/matching logic. `machineSelectedExistingCompanyId`
 * is the pipeline's own pick (business-resolution's matched record, falling
 * back to the low-level best match when the richer layer didn't name one);
 * it is deliberately a separate concept from `ReviewDecision.selectedBwiRecordId`,
 * the reviewer's actual chosen target, which may agree or disagree with it.
 */
export type MachineRecommendationSnapshot = {
  matchClassification: MatchClassification;
  matchScore: number;
  machineSelectedExistingCompanyId?: string;
  resolutionOutcome: EntityResolutionOutcome;
  resolutionConfidence?: number;
  resolutionRequiresHumanReview: boolean;
  resolutionReasons: EntityResolutionReasonCode[];
  resolutionConflicts: EntityResolutionConflictCode[];
  completenessScore: number;
  publicationState: PublicationReadinessState;
  publicationBlockerRuleIds: PublicationReadinessRuleId[];
  reviewPriority: number;
};

/** Builds a MachineRecommendationSnapshot from an already-loaded review_queue row. Pure -- performs no scoring itself. */
export function buildMachineRecommendationSnapshot(row: ReviewQueueRow): MachineRecommendationSnapshot {
  return {
    matchClassification: row.matchClassification as MatchClassification,
    matchScore: row.matchScore,
    machineSelectedExistingCompanyId: row.resolutionMatchedExistingCompanyId ?? row.bestExistingCompanyId,
    resolutionOutcome: row.resolutionOutcome as EntityResolutionOutcome,
    resolutionConfidence: row.resolutionConfidence,
    resolutionRequiresHumanReview: row.resolutionRequiresHumanReview,
    resolutionReasons: row.resolutionReasons as EntityResolutionReasonCode[],
    resolutionConflicts: row.resolutionConflicts as EntityResolutionConflictCode[],
    completenessScore: row.completenessScore,
    publicationState: row.publicationState,
    publicationBlockerRuleIds: row.publicationBlockers.map((issue) => issue.ruleId),
    reviewPriority: row.reviewPriority
  };
}

/** One append-only decision record, exactly as persisted in `review_decisions`. */
export type ReviewDecision = {
  id: string;
  locationCandidateId: string;
  sequence: number;
  reviewer: string;
  action: ReviewDecisionAction;
  previousStatus: ReviewQueueStatus;
  newStatus: ReviewQueueStatus;
  /** The reviewer's actual selected target BWI record -- see MachineRecommendationSnapshot's doc comment for how this differs from the machine's pick. */
  selectedBwiRecordId?: string;
  notes?: string;
  machineRecommendation: MachineRecommendationSnapshot;
  fieldCorrections: ReviewFieldCorrection[];
  decidedAt: string;
};

/**
 * Everything an ordinary caller (the CLI, a test) supplies. Deliberately
 * excludes `id`/`sequence`/`previousStatus`/`newStatus`/`decidedAt` --
 * `recordReviewDecision()` always generates those internally so a caller
 * can never forge history.
 */
export type RecordReviewDecisionInput = {
  locationCandidateId: string;
  reviewer: string;
  action: ReviewDecisionAction;
  selectedBwiRecordId?: string;
  notes?: string;
  fieldCorrections?: ReviewFieldCorrection[];
};

/** Thrown when `review_queue.review_status` disagrees with what the `review_decisions` ledger says it should be -- the ledger is always the source of truth, so this signals a bug or manual tampering, not a normal validation failure. */
export class ReviewLedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewLedgerInvariantError";
  }
}

/**
 * Records one append-only reviewer decision against a LocationCandidate
 * already present in `review_queue`, then updates only that row's
 * `review_status`/`reviewer_note` convenience columns. Runs inside a
 * `BEGIN IMMEDIATE` transaction so sequence allocation and insertion are
 * atomic -- two concurrent calls for the same candidate cannot both compute
 * the same next `sequence` (the table's `UNIQUE(location_candidate_id,
 * sequence)` constraint is a second, defense-in-depth backstop).
 *
 * Treats `review_decisions` as the sole source of truth for status:
 * 1. loads the current `review_queue` row (throws if the candidate hasn't
 *    been scored yet -- there is nothing to attach a decision to);
 * 2. loads the latest prior decision, if any;
 * 3. derives `previousStatus` from that latest decision (or "pending" if
 *    none exists yet);
 * 4. verifies `review_queue.review_status` actually equals that derived
 *    value;
 * 5. throws `ReviewLedgerInvariantError` if it doesn't -- refusing to
 *    silently record a new decision on top of a ledger/queue disagreement;
 * 6. inserts the new decision;
 * 7. updates only `review_status`/`reviewer_note` on `review_queue`.
 */
export function recordReviewDecision(db: Database, input: RecordReviewDecisionInput): ReviewDecision {
  if (!isReviewDecisionAction(input.action)) {
    throw new Error(`Unknown review decision action: "${input.action}".`);
  }
  validateSelectedBwiRecordId(input.action, input.selectedBwiRecordId);

  const run = db.transaction((): ReviewDecision => {
    const queueRow = loadReviewQueueRowByCandidateId(db, input.locationCandidateId);
    if (!queueRow) {
      throw new Error(
        `Cannot record a review decision for candidate "${input.locationCandidateId}": no review_queue row exists yet (has \`bun run run\` been executed for this candidate?).`
      );
    }

    const latestDecision = loadLatestReviewDecisionForCandidate(db, input.locationCandidateId);
    const derivedPreviousStatus: ReviewQueueStatus = latestDecision ? latestDecision.newStatus : "pending";

    if (queueRow.reviewStatus !== derivedPreviousStatus) {
      throw new ReviewLedgerInvariantError(
        `review_queue.review_status ("${queueRow.reviewStatus}") for candidate "${input.locationCandidateId}" does not match the status derived from the review_decisions ledger ("${derivedPreviousStatus}"). The ledger is the source of truth -- refusing to record a new decision on top of a disagreement; investigate before proceeding.`
      );
    }

    const newStatus = statusForAction(input.action);

    const decision: ReviewDecision = {
      id: crypto.randomUUID(),
      locationCandidateId: input.locationCandidateId,
      sequence: (latestDecision?.sequence ?? 0) + 1,
      reviewer: input.reviewer,
      action: input.action,
      previousStatus: derivedPreviousStatus,
      newStatus,
      selectedBwiRecordId: input.selectedBwiRecordId,
      notes: input.notes,
      machineRecommendation: buildMachineRecommendationSnapshot(queueRow),
      fieldCorrections: input.fieldCorrections ?? [],
      decidedAt: new Date().toISOString()
    };

    insertReviewDecision(db, decision);
    updateReviewQueueStatus(db, input.locationCandidateId, newStatus, input.notes);

    return decision;
  });

  return run.immediate();
}
