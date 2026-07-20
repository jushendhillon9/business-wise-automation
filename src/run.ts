import { createSchema, loadCandidates, loadExistingCompanies, openDb, upsertReviewQueue } from "./db.ts";
import { findBestMatch } from "./entity-resolution.ts";
import { completenessScore, reviewPriority } from "./scoring.ts";

const db = openDb();
createSchema(db);
const existingCompanies = loadExistingCompanies(db);
const candidates = loadCandidates(db);

for (const candidate of candidates) {
  const bestMatch = findBestMatch(candidate, existingCompanies);
  const completeness = completenessScore(candidate);
  const priority = reviewPriority(candidate, bestMatch, completeness);
  upsertReviewQueue(db, candidate.id, bestMatch, completeness, priority);
}

db.close();
console.log(`Processed ${candidates.length} candidate companies into the review queue.`);
