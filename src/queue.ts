import { createSchema, loadExistingCompanies, loadLocationCandidates, openDb } from "./db.ts";
import { formatFieldEvidenceBlock } from "./field-evidence-view.ts";

const db = openDb();
createSchema(db);

type ReviewQueueRow = {
  locationCandidateId: string;
  matchClassification: string;
  matchScore: number;
  resolutionOutcome: string;
  resolutionMatchedExistingCompanyId: string | null;
  resolutionRequiresHumanReview: number;
  completenessScore: number;
  publicationState: string;
  reviewPriority: number;
  reviewStatus: string;
};

const reviewRows = db.query(`
  SELECT
    location_candidate_id AS locationCandidateId,
    match_classification AS matchClassification,
    ROUND(match_score, 3) AS matchScore,
    resolution_outcome AS resolutionOutcome,
    resolution_matched_existing_company_id AS resolutionMatchedExistingCompanyId,
    resolution_requires_human_review AS resolutionRequiresHumanReview,
    ROUND(completeness_score, 3) AS completenessScore,
    publication_state AS publicationState,
    ROUND(review_priority, 3) AS reviewPriority,
    review_status AS reviewStatus
  FROM review_queue
  ORDER BY review_priority DESC, match_score DESC
`).all() as ReviewQueueRow[];

const candidatesById = new Map(loadLocationCandidates(db).map((c) => [c.id, c]));
const existingCompaniesById = new Map(loadExistingCompanies(db).map((c) => [c.id, c]));

// Five separate concepts, kept visibly separate: the richer business-
// resolution outcome, the low-level match classification underneath it,
// research completeness, publication readiness (rule-based, not a
// percentage), and review priority. None of them implies approval — a
// human still has to review and approve every record. One row per
// LocationCandidate; company-level fields (legalName) come from the
// embedded CompanyIdentity, location-level fields (city/state) from the
// candidate itself. Full reasons/conflicts/alternatives live in
// review_queue's *_json columns for anyone who needs the detail; the
// terminal table stays scannable.
const table = reviewRows.map((row) => {
  const candidate = candidatesById.get(row.locationCandidateId);
  const matchedExisting = row.resolutionMatchedExistingCompanyId
    ? existingCompaniesById.get(row.resolutionMatchedExistingCompanyId)
    : undefined;

  return {
    companyName: candidate?.company.legalName ?? "(unknown)",
    siteType: candidate?.siteType ?? "-",
    city: candidate?.physicalAddress?.city ?? null,
    state: candidate?.physicalAddress?.state ?? null,
    resolutionOutcome: row.resolutionOutcome,
    matchedExisting: matchedExisting?.companyName ?? "-",
    needsExtraReview: row.resolutionRequiresHumanReview ? "yes" : "no",
    classification: row.matchClassification,
    matchScore: row.matchScore,
    researchCompleteness: row.completenessScore,
    publicationState: row.publicationState,
    priority: row.reviewPriority,
    reviewStatus: row.reviewStatus
  };
});

console.table(table);

// Per-field evidence/confidence detail (Task 6) -- kept as a separate,
// readable text block below the scannable summary table above, rather than
// widening the table with raw evidence JSON. See src/field-evidence-view.ts.
const candidatesInQueueOrder = reviewRows
  .map((row) => candidatesById.get(row.locationCandidateId))
  .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
console.log("");
for (const line of formatFieldEvidenceBlock(candidatesInQueueOrder)) {
  console.log(line);
}

db.close();
