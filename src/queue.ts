import { createSchema, loadLocationCandidates, openDb } from "./db.ts";

const db = openDb();
createSchema(db);

type ReviewQueueRow = {
  locationCandidateId: string;
  matchClassification: string;
  matchScore: number;
  completenessScore: number;
  publicationReady: number;
  publicationBlockingReasonsJson: string;
  reviewPriority: number;
  reviewStatus: string;
};

const reviewRows = db.query(`
  SELECT
    location_candidate_id AS locationCandidateId,
    match_classification AS matchClassification,
    ROUND(match_score, 3) AS matchScore,
    ROUND(completeness_score, 3) AS completenessScore,
    publication_ready AS publicationReady,
    publication_blocking_reasons_json AS publicationBlockingReasonsJson,
    ROUND(review_priority, 3) AS reviewPriority,
    review_status AS reviewStatus
  FROM review_queue
  ORDER BY review_priority DESC, match_score DESC
`).all() as ReviewQueueRow[];

const candidatesById = new Map(loadLocationCandidates(db).map((c) => [c.id, c]));

// Four separate concepts, kept visibly separate: entity resolution
// (classification/matchScore), research completeness, publication readiness
// (rule-based, not a percentage), and review priority. None of them implies
// approval — a human still has to review and approve every record. One row
// per LocationCandidate; company-level fields (legalName) come from the
// embedded CompanyIdentity, location-level fields (city/state/employees)
// from the candidate itself.
const table = reviewRows.map((row) => {
  const candidate = candidatesById.get(row.locationCandidateId);
  const blockingReasons = JSON.parse(row.publicationBlockingReasonsJson) as string[];

  return {
    locationCandidateId: row.locationCandidateId,
    companyName: candidate?.company.legalName ?? "(unknown)",
    siteType: candidate?.siteType ?? "-",
    city: candidate?.physicalAddress?.city ?? null,
    state: candidate?.physicalAddress?.state ?? null,
    employees: candidate?.employeeSizeSite?.estimate ?? null,
    classification: row.matchClassification,
    matchScore: row.matchScore,
    researchCompleteness: row.completenessScore,
    publicationReady: row.publicationReady ? "yes" : "no",
    blockingReasons: blockingReasons.length > 0 ? blockingReasons.join(", ") : "-",
    priority: row.reviewPriority,
    reviewStatus: row.reviewStatus
  };
});

console.table(table);
db.close();
