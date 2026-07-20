import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createSchema, loadCandidates, openDb } from "./db.ts";
import { runIngestion } from "./ingestion.ts";
import { createDfwCsvAdapter } from "./sources/dfw-csv-adapter.ts";
import { createDfwJsonAdapter } from "./sources/dfw-json-adapter.ts";
import type { SourceAdapter } from "./sources/types.ts";

const TEST_DB_PATH = "data/ingestion.test.sqlite";

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    // no previous test db, that's fine
  }
  db = openDb(TEST_DB_PATH);
  createSchema(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    // ignore
  }
});

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

    const candidates = loadCandidates(db);
    expect(candidates.length).toBe(first.newCandidateCount);
  });

  test("two different sources observing the same company both persist as candidates", async () => {
    const sourceA: SourceAdapter = {
      sourceId: "chamber-mock",
      sourceName: "Mock Chamber Source",
      async fetch() {
        return [{ recordId: "chamber-1", data: { companyName: "Acme Logistics" } }];
      },
      toCandidate(record) {
        const data = record.data as { companyName: string };
        return {
          ok: true,
          candidate: {
            sourceRecordId: record.recordId,
            capturedAt: new Date().toISOString(),
            companyName: data.companyName,
            evidence: ["mock chamber source"]
          }
        };
      }
    };

    const sourceB: SourceAdapter = {
      sourceId: "journal-mock",
      sourceName: "Mock Business Journal Source",
      async fetch() {
        return [{ recordId: "journal-1", data: { companyName: "Acme Logistics Inc." } }];
      },
      toCandidate(record) {
        const data = record.data as { companyName: string };
        return {
          ok: true,
          candidate: {
            sourceRecordId: record.recordId,
            capturedAt: new Date().toISOString(),
            companyName: data.companyName,
            evidence: ["mock business journal source"]
          }
        };
      }
    };

    await runIngestion(db, sourceA);
    await runIngestion(db, sourceB);

    const candidates = loadCandidates(db);
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => c.companyName).sort()).toEqual(["Acme Logistics", "Acme Logistics Inc."]);
  });
});
