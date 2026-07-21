import { createSchema, loadCandidates, loadExistingCompanies, openDb, upsertReviewQueue } from "./db.ts";
import { findBestMatch } from "./entity-resolution.ts";
import { evaluatePublicationReadiness } from "./publication-readiness.ts";
import { researchCompleteness, reviewPriority } from "./scoring.ts";

const db = openDb();
createSchema(db);
const existingCompanies = loadExistingCompanies(db);
const candidates = loadCandidates(db);

for (const candidate of candidates) {
  const bestMatch = findBestMatch(candidate, existingCompanies);
  const completeness = researchCompleteness(candidate);
  const publicationReadiness = evaluatePublicationReadiness(candidate);
  const priority = reviewPriority(candidate, bestMatch, completeness.score);
  upsertReviewQueue(db, candidate.id, bestMatch, completeness, publicationReadiness, priority);
}

db.close();
console.log(`Processed ${candidates.length} candidate companies into the review queue.`);
