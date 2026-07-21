import { createSchema, loadExistingCompanies, loadLocationCandidates, openDb, upsertReviewQueue } from "./db.ts";
import { findBestMatch } from "./entity-resolution.ts";
import { resolveCandidateAgainstExisting } from "./entity-resolution-policy.ts";
import { evaluatePublicationReadiness } from "./publication-readiness.ts";
import { researchCompleteness, reviewPriority } from "./scoring.ts";

const db = openDb();
createSchema(db);
const existingCompanies = loadExistingCompanies(db);
const locationCandidates = loadLocationCandidates(db);

for (const candidate of locationCandidates) {
  // Low-level similarity match: unchanged formula/classification/thresholds.
  const bestMatch = findBestMatch(candidate, existingCompanies);
  // Richer business-outcome interpretation, built on top of the same evidence.
  const resolution = resolveCandidateAgainstExisting(candidate, existingCompanies);

  const completeness = researchCompleteness(candidate);
  const publicationReadiness = evaluatePublicationReadiness(candidate);
  // reviewPriority intentionally still consumes the low-level bestMatch, not
  // the business-resolution outcome -- Task 4 is entity-resolution
  // interpretation, not queue-priority recalibration.
  const priority = reviewPriority(candidate, bestMatch, completeness.score);

  upsertReviewQueue(db, candidate.id, bestMatch, resolution, completeness, publicationReadiness, priority);
}

db.close();
console.log(`Processed ${locationCandidates.length} location candidates into the review queue.`);
