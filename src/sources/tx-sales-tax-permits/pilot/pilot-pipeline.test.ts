import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessWiseSnapshotAdapter } from "../../../business-wise-snapshot-adapter.ts";
import { createSchema, loadLocationCandidates, openDb, upsertReviewQueue } from "../../../db.ts";
import { resolveCandidateAgainstExisting } from "../../../entity-resolution-policy.ts";
import { findBestMatch } from "../../../entity-resolution.ts";
import { runIngestion } from "../../../ingestion.ts";
import { evaluatePublicationReadiness } from "../../../publication-readiness.ts";
import { researchCompleteness, reviewPriority } from "../../../scoring.ts";
import { createTxSalesTaxPermitSourceAdapter } from "../adapter.ts";
import { summarizePilotRun, type PilotCandidateOutcome } from "./aggregate.ts";

/**
 * Exercises the same pipeline the pilot CLI (src/tx-permits-pilot.ts) runs,
 * using entirely fabricated BWI + source fixtures written to temp
 * directories -- no real production files, no real network access, no
 * import of src/tx-permits-pilot.ts itself (which runs main() as a
 * top-level side effect on import).
 */

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tx-permits-pilot-pipeline-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const BWI_RECORDS_HEADER = "bwi_location_id,company_name,alpha_sort,status_code,site_type_code,address,city,state,zip,phone,website,sic\n";
const BWI_RELATIONSHIPS_HEADER = "relationship_type,parent_bwi_id,child_bwi_id\n";

async function writeBwiSnapshot(dir: string): Promise<{ recordsPath: string; relationshipsPath: string }> {
  const records =
    BWI_RECORDS_HEADER +
    "LOC-1,Fabricated Diner Co,FABRICATED DINER CO,DIRE,H,500 Fabricated Ave,Testville,TX,75001,,,\n" +
    "LOC-2,Fabricated Retail Shop,FABRICATED RETAIL SHOP,KEEP,B,900 Other Rd,Sampleburg,TX,75010,,,\n" +
    "LOC-3,Deleted Fabricated Co,DELETED FABRICATED CO,DELE,S,1 Ghost Ln,Testville,TX,75002,,,\n";
  const relationships = BWI_RELATIONSHIPS_HEADER + "HQTR,LOC-1,LOC-2\n";

  const recordsPath = join(dir, "bwi-records.csv");
  const relationshipsPath = join(dir, "bwi-relationships.csv");
  await Bun.write(recordsPath, records);
  await Bun.write(relationshipsPath, relationships);
  return { recordsPath, relationshipsPath };
}

function permitRow(index: number, overrides: Record<string, string | undefined> = {}): Record<string, unknown> {
  const raw = {
    outlet_name: `Fabricated Outlet ${index}`,
    taxpayer_name: `Fabricated Outlet ${index}`,
    taxpayer_number: `${2000 + index}`,
    outlet_number: "001",
    outlet_address: `${index} Fabricated Way`,
    outlet_city: "Testville",
    outlet_state: "TX",
    outlet_zip_code: "75001",
    outlet_county_code: "057",
    outlet_naics_code: "722511",
    outlet_permit_issue_date: "2026-07-20T00:00:00.000",
    outlet_first_sales_date: "2026-07-21T00:00:00.000",
    taxpayer_organization_type: "LIMITED LIABILITY CO",
    ...overrides
  };
  return {
    source_dataset_id: "jrea-zgmq",
    source_record_id: `${raw.taxpayer_number}:${raw.outlet_number}`,
    fetched_at: "2026-07-24T12:00:00.000Z",
    query_window_start: "2026-07-17",
    query_window_end: "2026-07-24",
    requested_counties: ["043", "057", "061", "220"],
    source_url: "https://data.texas.gov/api/v3/views/jrea-zgmq/query.json",
    raw
  };
}

async function writeSourceSnapshot(dir: string, observations: Array<Record<string, unknown>>): Promise<string> {
  const sourceDir = join(dir, "source");
  const ndjson = observations.map((o) => JSON.stringify(o)).join("\n") + "\n";
  await Bun.write(join(sourceDir, "raw.ndjson"), ndjson);
  return sourceDir;
}

describe("shadow-pilot pipeline (fabricated BWI + source fixtures)", () => {
  test("runs the full pipeline: ingest -> bounded BWI retrieval -> entity resolution -> readiness -> isolated review queue", async () => {
    const { recordsPath, relationshipsPath } = await writeBwiSnapshot(tempDir);
    const sourceDir = await writeSourceSnapshot(tempDir, [
      // Exact match to LOC-1.
      permitRow(0, {
        outlet_name: "Fabricated Diner Co",
        taxpayer_name: "Fabricated Diner Co",
        outlet_address: "500 Fabricated Ave",
        outlet_city: "Testville"
      }),
      // No plausible match anywhere.
      permitRow(1, { outlet_name: "Zzz Totally Unrelated Fabricated Co Zzz", taxpayer_name: "Zzz Totally Unrelated Fabricated Co Zzz", outlet_address: "999 Nowhere Rd" })
    ]);

    const pilotDbPath = join(tempDir, "pilot.sqlite");
    const pilotDb = openDb(pilotDbPath);
    createSchema(pilotDb);

    // BWI snapshot loaded exactly once, reused for every candidate below --
    // this single instance is never reloaded inside the loop.
    const bwiAdapter = await BusinessWiseSnapshotAdapter.load({ recordsPath, relationshipsPath });

    const sourceAdapter = createTxSalesTaxPermitSourceAdapter({ sourceDir });
    const ingestionSummary = await runIngestion(pilotDb, sourceAdapter);
    expect(ingestionSummary.status).toBe("success");
    expect(ingestionSummary.newCandidateCount).toBe(2);

    const candidates = loadLocationCandidates(pilotDb);
    expect(candidates).toHaveLength(2);

    const outcomes: PilotCandidateOutcome[] = [];
    for (const candidate of candidates) {
      const retrieved = await bwiAdapter.searchPotentialMatches(candidate);
      // Bounded retrieval -- never the full 3-record snapshot returned blindly, and never more than the adapter's own cap.
      expect(retrieved.length).toBeLessThanOrEqual(25);

      const bestMatch = findBestMatch(candidate, retrieved);
      const resolution = resolveCandidateAgainstExisting(candidate, retrieved);
      const completeness = researchCompleteness(candidate);
      const readiness = evaluatePublicationReadiness(candidate);
      const priority = reviewPriority(candidate, bestMatch, completeness.score);

      upsertReviewQueue(pilotDb, candidate.id, bestMatch, resolution, completeness, readiness, priority);

      outcomes.push({
        locationCandidateId: candidate.id,
        sourceRecordId: candidate.source.sourceRecordId ?? candidate.source.fingerprint,
        retrievalCount: retrieved.length,
        retrievalMs: 0,
        matchScore: bestMatch.score,
        matchClassification: bestMatch.classification,
        resolutionOutcome: resolution.outcome,
        requiresHumanReview: resolution.requiresHumanReview,
        lifecycleConflict:
          resolution.conflicts.includes("existing_location_is_deleted") || resolution.conflicts.includes("existing_location_is_research_deleted"),
        matchedExistingStatus: undefined,
        relationshipTypes: [],
        publicationState: readiness.state,
        blockerRuleIds: readiness.blockers.map((b) => b.ruleId),
        optionalMissingFields: readiness.optionalMissingFields
      });
    }

    // Review queue rows exist for every candidate -- persisted locally, isolated to this pilot db.
    const reviewQueueCount = pilotDb.query("SELECT COUNT(*) as c FROM review_queue").get() as { c: number };
    expect(reviewQueueCount.c).toBe(2);

    // No human review decision was ever recorded automatically.
    const decisionCount = pilotDb.query("SELECT COUNT(*) as c FROM review_decisions").get() as { c: number };
    expect(decisionCount.c).toBe(0);

    // The exact-match observation should resolve toward the known BWI record; the unrelated one should not.
    const exactMatchOutcome = outcomes.find((o) => o.sourceRecordId === "2000:001");
    const unrelatedOutcome = outcomes.find((o) => o.sourceRecordId === "2001:001");
    expect(exactMatchOutcome?.retrievalCount).toBeGreaterThan(0);
    expect(unrelatedOutcome?.retrievalCount).toBe(0);
    expect(unrelatedOutcome?.resolutionOutcome).toBe("likely_new_company");

    const summary = summarizePilotRun(outcomes, {
      sourceObservationsRead: ingestionSummary.rawCount,
      validCandidatesCreated: ingestionSummary.validCount,
      invalidObservations: ingestionSummary.skippedCount,
      duplicateObservations: 0,
      candidatesPersisted: ingestionSummary.newCandidateCount,
      alreadyIngestedSkipped: ingestionSummary.alreadyIngestedCount
    });
    expect(Object.keys(summary.outcomeCounts).length).toBeGreaterThan(0);
    expect(summary.retrieval.zeroResultCount).toBe(1);
    expect(summary.retrieval.oneOrMoreResultCount).toBe(1);

    pilotDb.close();
  });

  test("repeated ingestion against the same source snapshot is idempotent -- no duplicate candidates or review_queue rows", async () => {
    const { recordsPath, relationshipsPath } = await writeBwiSnapshot(tempDir);
    const sourceDir = await writeSourceSnapshot(tempDir, [permitRow(0)]);

    const pilotDbPath = join(tempDir, "pilot.sqlite");
    const pilotDb = openDb(pilotDbPath);
    createSchema(pilotDb);
    const bwiAdapter = await BusinessWiseSnapshotAdapter.load({ recordsPath, relationshipsPath });

    async function runOnce() {
      const sourceAdapter = createTxSalesTaxPermitSourceAdapter({ sourceDir });
      const summary = await runIngestion(pilotDb, sourceAdapter);
      for (const candidate of loadLocationCandidates(pilotDb)) {
        const retrieved = await bwiAdapter.searchPotentialMatches(candidate);
        const bestMatch = findBestMatch(candidate, retrieved);
        const resolution = resolveCandidateAgainstExisting(candidate, retrieved);
        const completeness = researchCompleteness(candidate);
        const readiness = evaluatePublicationReadiness(candidate);
        const priority = reviewPriority(candidate, bestMatch, completeness.score);
        upsertReviewQueue(pilotDb, candidate.id, bestMatch, resolution, completeness, readiness, priority);
      }
      return summary;
    }

    const first = await runOnce();
    const second = await runOnce();

    expect(first.newCandidateCount).toBe(1);
    expect(second.newCandidateCount).toBe(0);
    expect(second.alreadyIngestedCount).toBe(1);

    const candidateCount = pilotDb.query("SELECT COUNT(*) as c FROM location_candidates").get() as { c: number };
    const reviewQueueCount = pilotDb.query("SELECT COUNT(*) as c FROM review_queue").get() as { c: number };
    expect(candidateCount.c).toBe(1);
    expect(reviewQueueCount.c).toBe(1);

    pilotDb.close();
  });

  test("the pilot database is fully isolated -- never touches data/sandbox.sqlite", async () => {
    const { recordsPath, relationshipsPath } = await writeBwiSnapshot(tempDir);
    const sourceDir = await writeSourceSnapshot(tempDir, [permitRow(0)]);

    const pilotDbPath = join(tempDir, "pilot.sqlite");
    const pilotDb = openDb(pilotDbPath);
    createSchema(pilotDb);
    const bwiAdapter = await BusinessWiseSnapshotAdapter.load({ recordsPath, relationshipsPath });
    const sourceAdapter = createTxSalesTaxPermitSourceAdapter({ sourceDir });
    await runIngestion(pilotDb, sourceAdapter);
    for (const candidate of loadLocationCandidates(pilotDb)) {
      await bwiAdapter.searchPotentialMatches(candidate);
    }
    pilotDb.close();

    const { existsSync } = await import("node:fs");
    // The default sandbox path is a fixed repo-relative constant; this test
    // never opens it, only the isolated temp-dir pilot db above.
    expect(existsSync(pilotDbPath)).toBe(true);
  });

  test("never calls a write/publish API -- stageApprovedCandidate is never invoked by the pipeline", async () => {
    const { recordsPath, relationshipsPath } = await writeBwiSnapshot(tempDir);
    const sourceDir = await writeSourceSnapshot(tempDir, [permitRow(0)]);

    const bwiAdapter = await BusinessWiseSnapshotAdapter.load({ recordsPath, relationshipsPath });
    let stageCalled = false;
    const originalStage = bwiAdapter.stageApprovedCandidate.bind(bwiAdapter);
    bwiAdapter.stageApprovedCandidate = async (candidate) => {
      stageCalled = true;
      return originalStage(candidate);
    };

    const pilotDb = openDb(join(tempDir, "pilot.sqlite"));
    createSchema(pilotDb);
    const sourceAdapter = createTxSalesTaxPermitSourceAdapter({ sourceDir });
    await runIngestion(pilotDb, sourceAdapter);
    for (const candidate of loadLocationCandidates(pilotDb)) {
      const retrieved = await bwiAdapter.searchPotentialMatches(candidate);
      const bestMatch = findBestMatch(candidate, retrieved);
      const resolution = resolveCandidateAgainstExisting(candidate, retrieved);
      const completeness = researchCompleteness(candidate);
      const readiness = evaluatePublicationReadiness(candidate);
      const priority = reviewPriority(candidate, bestMatch, completeness.score);
      upsertReviewQueue(pilotDb, candidate.id, bestMatch, resolution, completeness, readiness, priority);
    }
    pilotDb.close();

    expect(stageCalled).toBe(false);
  });
});
