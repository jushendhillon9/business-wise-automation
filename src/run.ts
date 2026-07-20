import { createSchema, insertCandidate, loadExistingCompanies, openDb, upsertReviewQueue } from "./db.ts";
import { findBestMatch } from "./entity-resolution.ts";
import { completenessScore, reviewPriority } from "./scoring.ts";
import type { CandidateCompany } from "./types.ts";

const sourcePath = process.argv[2] ?? "data/candidates.sample.json";
const raw = await Bun.file(sourcePath).text();
const candidates = JSON.parse(raw) as CandidateCompany[];

const db = openDb();
createSchema(db);
const existingCompanies = loadExistingCompanies(db);

for (const candidate of candidates) {
  insertCandidate(db, candidate);
  const bestMatch = findBestMatch(candidate, existingCompanies);
  const completeness = completenessScore(candidate);
  const priority = reviewPriority(candidate, bestMatch, completeness);
  upsertReviewQueue(db, candidate.id, bestMatch, completeness, priority);
}

db.close();
console.log(`Processed ${candidates.length} candidate companies into the review queue.`);
