import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { BusinessWiseSnapshotAdapter } from "./business-wise-snapshot-adapter.ts";
import { createSchema, loadLocationCandidates, openDb, upsertReviewQueue } from "./db.ts";
import { resolveCandidateAgainstExisting } from "./entity-resolution-policy.ts";
import { findBestMatch } from "./entity-resolution.ts";
import { runIngestion } from "./ingestion.ts";
import { evaluatePublicationReadiness } from "./publication-readiness.ts";
import { researchCompleteness, reviewPriority } from "./scoring.ts";
import { createTxSalesTaxPermitSourceAdapter } from "./sources/tx-sales-tax-permits/adapter.ts";
import { summarizePilotRun, type PilotCandidateOutcome, type SourceProcessingCounts } from "./sources/tx-sales-tax-permits/pilot/aggregate.ts";
import { generateRunId, resolvePilotDbPath, resolvePilotOutputDir, resolveSourceDir } from "./sources/tx-sales-tax-permits/pilot/pilot-paths.ts";
import { printPilotSummary } from "./sources/tx-sales-tax-permits/pilot/pilot-summary-format.ts";
import { reviewSampleToCsv, selectReviewSample, type PilotReviewCandidateInput } from "./sources/tx-sales-tax-permits/pilot/review-sample.ts";
import { TX_SALES_TAX_PERMITS_DATASET_ID } from "./sources/tx-sales-tax-permits/types.ts";

/**
 * `bun run source:tx-permits:pilot` -- local-only shadow-pilot connecting
 * the Texas sales-tax-permit source to the existing BWI matching and review
 * pipeline. Reuses entity resolution, publication readiness, and the review
 * queue completely unchanged; the only new code here is orchestration.
 * Never writes to Business Wise, Delphi, or production SQL, and never calls
 * a write/publish API -- see README's "Texas Sales-Tax Permit Shadow Pilot"
 * section.
 */

const DEFAULT_LIMIT = 1000;
const DEFAULT_REVIEW_SAMPLE_SIZE = 20;
const DEFAULT_SEED = 1;

function readCliArg(argv: string[], flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasCliFlag(argv: string[], flag: string): boolean {
  return argv.includes(`--${flag}`);
}

function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`ERROR: --${flag} must be a positive integer, got "${raw}".`);
    process.exit(1);
  }
  return value;
}

/** Removes only the explicitly resolved pilot database + its WAL/SHM sidecars. Never touches any other file. */
function removePilotDbFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      unlinkSync(path);
    } catch {
      // not present -- nothing to remove
    }
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const argv = process.argv;

  const sourceDir = resolveSourceDir(readCliArg(argv, "source-dir"));
  const limit = parsePositiveInt(readCliArg(argv, "limit"), "limit", DEFAULT_LIMIT);
  const reviewSampleSize = parsePositiveInt(readCliArg(argv, "review-sample-size"), "review-sample-size", DEFAULT_REVIEW_SAMPLE_SIZE);

  const seedArg = readCliArg(argv, "seed");
  const seed = seedArg !== undefined ? Number(seedArg) : DEFAULT_SEED;
  if (!Number.isInteger(seed)) {
    console.error(`ERROR: --seed must be an integer, got "${seedArg}".`);
    process.exit(1);
  }

  const runId = generateRunId();
  const outputDir = resolvePilotOutputDir(readCliArg(argv, "output"), runId);
  const dbPath = resolvePilotDbPath(readCliArg(argv, "db"), outputDir);
  const reset = hasCliFlag(argv, "reset");

  mkdirSync(outputDir, { recursive: true });
  if (reset) removePilotDbFiles(dbPath);

  console.log(`Source directory: ${sourceDir}`);
  console.log(`Pilot database:   ${dbPath}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Limit: ${limit}, review sample size: ${reviewSampleSize}, seed: ${seed}${reset ? " (reset applied)" : ""}`);
  console.log("");

  // Isolated pilot database -- never data/sandbox.sqlite.
  const pilotDb = openDb(dbPath);
  createSchema(pilotDb);

  console.log("Loading BWI snapshot (once)...");
  const bwiAdapter = await BusinessWiseSnapshotAdapter.load().catch((error: Error) => {
    console.error(`ERROR: failed to load BWI snapshot: ${error.message}`);
    pilotDb.close();
    process.exit(1);
  });
  const bwiStats = bwiAdapter.getLoadStats();
  console.log(`Loaded ${bwiStats.recordCount} BWI record(s) and ${bwiStats.relationshipCount} relationship edge(s) in ${bwiStats.loadDurationMs}ms`);
  console.log("");

  const sourceAdapter = createTxSalesTaxPermitSourceAdapter({ sourceDir, limit });
  const ingestionSummary = await runIngestion(pilotDb, sourceAdapter).catch((error: Error) => {
    console.error(`ERROR: ${error.message}`);
    pilotDb.close();
    process.exit(1);
  });

  if (ingestionSummary.status === "failed") {
    console.error(`ERROR: ingestion failed: ${ingestionSummary.errorMessage}`);
    pilotDb.close();
    process.exit(1);
  }

  console.log(`Source observations read: ${ingestionSummary.rawCount}`);
  console.log(`Valid candidates created: ${ingestionSummary.validCount}`);
  console.log(`Invalid observations: ${ingestionSummary.skippedCount}`);
  console.log(`Already-ingested (idempotent skip): ${ingestionSummary.alreadyIngestedCount}`);
  console.log(`New candidates persisted: ${ingestionSummary.newCandidateCount}`);
  console.log("");

  // Every candidate currently in the pilot db (old + newly ingested) is
  // (re)scored -- upsertReviewQueue() is an upsert, so a repeated run stays
  // idempotent rather than accumulating duplicate review_queue rows.
  const candidates = loadLocationCandidates(pilotDb);
  console.log(`Scoring ${candidates.length} candidate(s) against the BWI snapshot (bounded indexed retrieval, loaded once)...`);

  const outcomes: PilotCandidateOutcome[] = [];
  const reviewInputs: PilotReviewCandidateInput[] = [];

  for (const candidate of candidates) {
    const retrievalStartedAt = Date.now();
    // Bounded, indexed retrieval -- never a full scan of all ~241k BWI records.
    const retrieved = await bwiAdapter.searchPotentialMatches(candidate);
    const retrievalMs = Date.now() - retrievalStartedAt;

    // Existing entity-resolution layers, completely unchanged -- no
    // duplicated scoring/threshold logic here.
    const bestMatch = findBestMatch(candidate, retrieved);
    const resolution = resolveCandidateAgainstExisting(candidate, retrieved);
    const completeness = researchCompleteness(candidate);
    const publicationReadiness = evaluatePublicationReadiness(candidate);
    const priority = reviewPriority(candidate, bestMatch, completeness.score);

    // Local review queue only -- never stageApprovedCandidate(), never a
    // human decision recorded automatically.
    upsertReviewQueue(pilotDb, candidate.id, bestMatch, resolution, completeness, publicationReadiness, priority);

    const matchedId = resolution.matchedExistingCompanyId ?? bestMatch.existingCompanyId;
    const matchedExisting = matchedId ? retrieved.find((existing) => existing.id === matchedId) : undefined;
    const relationshipTypes = matchedId ? bwiAdapter.getRelationshipTypesForRecord(matchedId) : [];
    const lifecycleConflict =
      resolution.conflicts.includes("existing_location_is_deleted") || resolution.conflicts.includes("existing_location_is_research_deleted");

    outcomes.push({
      locationCandidateId: candidate.id,
      sourceRecordId: candidate.source.sourceRecordId ?? candidate.source.fingerprint,
      retrievalCount: retrieved.length,
      retrievalMs,
      matchScore: bestMatch.score,
      matchClassification: bestMatch.classification,
      resolutionOutcome: resolution.outcome,
      requiresHumanReview: resolution.requiresHumanReview,
      lifecycleConflict,
      matchedExistingStatus: matchedExisting?.status,
      relationshipTypes,
      publicationState: publicationReadiness.state,
      blockerRuleIds: publicationReadiness.blockers.map((blocker) => blocker.ruleId),
      optionalMissingFields: publicationReadiness.optionalMissingFields
    });

    reviewInputs.push({
      candidate,
      match: bestMatch,
      resolution,
      readiness: publicationReadiness,
      matchedExisting,
      relationshipTypes,
      retrievalCount: retrieved.length
    });
  }

  console.log("Scoring complete.");
  console.log("");

  const sourceProcessing: SourceProcessingCounts = {
    sourceObservationsRead: ingestionSummary.rawCount,
    validCandidatesCreated: ingestionSummary.validCount,
    invalidObservations: ingestionSummary.skippedCount,
    // The adapter fails the whole run closed on a structurally duplicate
    // source_record_id (see adapter.ts) rather than skipping rows one at a
    // time, so a completed run always has zero here by construction.
    duplicateObservations: 0,
    candidatesPersisted: ingestionSummary.newCandidateCount,
    alreadyIngestedSkipped: ingestionSummary.alreadyIngestedCount
  };
  const summary = summarizePilotRun(outcomes, sourceProcessing);
  printPilotSummary(summary);

  const reviewSample = selectReviewSample(reviewInputs, { sampleSize: reviewSampleSize, seed });
  console.log("");
  console.log(`Private review sample: ${reviewSample.length} case(s) (seed=${seed}) -- see review-sample.json/.csv (never printed here)`);

  const summaryPath = `${outputDir}/summary.json`;
  const reviewSamplePath = `${outputDir}/review-sample.json`;
  const reviewSampleCsvPath = `${outputDir}/review-sample.csv`;
  const manifestPath = `${outputDir}/run-manifest.json`;

  const summaryJson = JSON.stringify(summary, null, 2);
  const reviewSampleJson = JSON.stringify({ seed, sampleSize: reviewSample.length, cases: reviewSample }, null, 2);
  const reviewSampleCsv = reviewSampleToCsv(reviewSample);

  writeFileSync(summaryPath, summaryJson);
  writeFileSync(reviewSamplePath, reviewSampleJson);
  writeFileSync(reviewSampleCsvPath, reviewSampleCsv);

  const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

  const manifest = {
    run_id: runId,
    source_dir: sourceDir,
    dataset_id: TX_SALES_TAX_PERMITS_DATASET_ID,
    pilot_db_path: dbPath,
    output_dir: outputDir,
    limit,
    review_sample_size: reviewSampleSize,
    seed,
    reset_applied: reset,
    bwi_record_count: bwiStats.recordCount,
    bwi_relationship_count: bwiStats.relationshipCount,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    source_processing: sourceProcessing,
    files: {
      "pilot.sqlite": {},
      "summary.json": { sha256: sha256(summaryJson) },
      "review-sample.json": { sha256: sha256(reviewSampleJson) },
      "review-sample.csv": { sha256: sha256(reviewSampleCsv) }
    }
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  pilotDb.close();

  console.log("");
  console.log(`Elapsed: ${Date.now() - startedAt}ms`);
  console.log("Output directory:");
  console.log(`  ${dbPath}`);
  console.log(`  ${summaryPath}`);
  console.log(`  ${reviewSamplePath}`);
  console.log(`  ${reviewSampleCsvPath}`);
  console.log(`  ${manifestPath}`);
  console.log("");
  console.log("No writes occurred to Business Wise, Delphi, or production SQL. No candidate was staged for publication.");
  console.log("The private review packet was not printed -- open review-sample.json/.csv locally to inspect it.");
}

await main();
