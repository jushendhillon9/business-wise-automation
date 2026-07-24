import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadLocationCandidates, openDb } from "./db.ts";
import { runIngestion } from "./ingestion.ts";
import { createDfwCsvAdapter } from "./sources/dfw-csv-adapter.ts";
import { createDfwJsonAdapter } from "./sources/dfw-json-adapter.ts";
import type { SourceAdapter } from "./sources/types.ts";
import { closeAndRemoveTestDb, openFreshTestDb } from "./test-support/sqlite-test-db.ts";

const TEST_DB_PATH = "data/ingestion.test.sqlite";

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openFreshTestDb(TEST_DB_PATH);
});

afterEach(() => {
  closeAndRemoveTestDb(db, TEST_DB_PATH);
});

function mockAdapter(sourceId: string, sourceName: string, recordId: string, companyName: string): SourceAdapter {
  return {
    sourceId,
    sourceName,
    async fetch() {
      return [{ recordId, data: { companyName } }];
    },
    toCandidate(record) {
      const data = record.data as { companyName: string };
      return {
        ok: true,
        candidate: {
          capturedAt: new Date().toISOString(),
          company: { legalName: data.companyName },
          contacts: [],
          evidence: [`mock source ${sourceId}`]
        }
      };
    }
  };
}

describe("runIngestion", () => {
  test("summarizes counts for the DFW JSON fixture", async () => {
    const adapter = createDfwJsonAdapter();
    const summary = await runIngestion(db, adapter);

    expect(summary.status).toBe("success");
    expect(summary.rawCount).toBe(7);
    expect(summary.validCount).toBe(6);
    expect(summary.skippedCount).toBe(1);
    expect(summary.newCandidateCount).toBe(5);
    expect(summary.alreadyIngestedCount).toBe(1);
  });

  test("running the same source twice does not duplicate candidates", async () => {
    const adapter = createDfwCsvAdapter();

    const first = await runIngestion(db, adapter);
    const second = await runIngestion(db, adapter);

    expect(first.newCandidateCount).toBeGreaterThan(0);
    expect(second.newCandidateCount).toBe(0);
    expect(second.alreadyIngestedCount).toBe(first.newCandidateCount + first.alreadyIngestedCount);

    const candidates = loadLocationCandidates(db);
    expect(candidates.length).toBe(first.newCandidateCount);
  });

  test("each ingested location candidate references its own provisional company identity", async () => {
    const adapter = createDfwJsonAdapter();
    await runIngestion(db, adapter);

    const candidates = loadLocationCandidates(db);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.company.id).toBeDefined();
      expect(candidate.company.legalName).toBe(candidate.company.legalName);
    }
    // ingestion never merges identities: every location got its own distinct company id
    const companyIds = candidates.map((c) => c.company.id);
    expect(new Set(companyIds).size).toBe(candidates.length);
  });

  test("two different sources observing the same company both persist as separate observations", async () => {
    const sourceA = mockAdapter("chamber-mock", "Mock Chamber Source", "chamber-1", "Acme Logistics");
    const sourceB = mockAdapter("journal-mock", "Mock Business Journal Source", "journal-1", "Acme Logistics Inc.");

    await runIngestion(db, sourceA);
    await runIngestion(db, sourceB);

    const candidates = loadLocationCandidates(db);
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => c.company.legalName).sort()).toEqual(["Acme Logistics", "Acme Logistics Inc."]);
    // each is its own provisional company identity -- ingestion does not decide these are the same company
    expect(candidates[0]?.company.id).not.toBe(candidates[1]?.company.id);
  });
});
