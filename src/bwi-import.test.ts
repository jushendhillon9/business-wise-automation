import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { runBwiImport, upsertBwiExistingLocation } from "./bwi-import.ts";
import { createSchema, getExistingCompanyById, loadBwiImportRuns, loadExistingCompanies, openDb } from "./db.ts";
import { createBwiSnapshotSource } from "./sources/bwi/snapshot-adapter.ts";
import { mapRawBwiRecordToExistingLocation, type BwiMappingContext } from "./sources/bwi/mapping.ts";

const TEST_DB_PATH = "data/bwi-import.test.sqlite";
const TEST_CSV_PATH = "data/bwi-import.test.csv";

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-shm`, `${TEST_DB_PATH}-wal`, TEST_CSV_PATH]) {
    try {
      unlinkSync(path);
    } catch {
      // no previous file, fine
    }
  }
  db = openDb(TEST_DB_PATH);
  createSchema(db);
});

afterEach(() => {
  db.close();
  for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-shm`, `${TEST_DB_PATH}-wal`, TEST_CSV_PATH]) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
});

const FIXED_CLOCK = () => "2026-01-01T00:00:00.000Z";

const CONTEXT: BwiMappingContext = {
  sourceType: "bwi_snapshot",
  sourceId: "bwi-snapshot",
  sourceName: "BWI local read-only snapshot export",
  ingestedAt: "2026-01-01T00:00:00.000Z"
};

function mustMap(overrides: Record<string, string | undefined> = {}) {
  const result = mapRawBwiRecordToExistingLocation(
    {
      bwiLocationId: "bwi-1",
      companyName: "Acme Logistics LLC",
      address: "1200 Commerce St",
      city: "Dallas",
      state: "TX",
      phone: "214-555-0100",
      siteTypeCode: "H",
      statusCode: "DIRE",
      ...overrides
    },
    CONTEXT
  );
  if (!result.ok) throw new Error(`unexpected mapping failure: ${result.reason}`);
  return result.existing;
}

describe("upsertBwiExistingLocation", () => {
  test("first import inserts", () => {
    const outcome = upsertBwiExistingLocation(db, mustMap());
    expect(outcome).toBe("inserted");
    expect(getExistingCompanyById(db, "bwi-1")).toBeDefined();
  });

  test("identical rerun reports unchanged and does not alter the stored record", () => {
    upsertBwiExistingLocation(db, mustMap());
    const outcome = upsertBwiExistingLocation(db, mustMap());
    expect(outcome).toBe("unchanged");
  });

  test("a changed source row updates the stable record", () => {
    upsertBwiExistingLocation(db, mustMap());
    const outcome = upsertBwiExistingLocation(db, mustMap({ phone: "214-555-9999" }));
    expect(outcome).toBe("updated");
    expect(getExistingCompanyById(db, "bwi-1")?.phone).toBe("214-555-9999");
  });

  test("the stable BWI id remains the primary key across insert/update", () => {
    upsertBwiExistingLocation(db, mustMap());
    upsertBwiExistingLocation(db, mustMap({ phone: "214-555-9999" }));
    const all = loadExistingCompanies(db);
    expect(all.filter((c) => c.id === "bwi-1").length).toBe(1);
  });

  test("provenance and field evidence round-trip through persistence", () => {
    upsertBwiExistingLocation(db, mustMap());
    const loaded = getExistingCompanyById(db, "bwi-1");
    expect(loaded?.source?.sourceId).toBe("bwi-snapshot");
    expect(loaded?.fieldEvidence?.length).toBeGreaterThan(0);
    expect(loaded?.fieldEvidence?.every((e) => e.confidence >= 0 && e.confidence <= 1)).toBe(true);
  });
});

describe("runBwiImport — end-to-end with the snapshot adapter", () => {
  const CSV = `bwi_location_id,company_name,city,state,phone,site_type_code,status_code
bwi-1,Acme Logistics LLC,Dallas,TX,214-555-0100,H,DIRE
bwi-2,Northstar Advisory,Fort Worth,TX,817-555-0144,S,DIRE
`;

  function writeSnapshot(text: string) {
    writeFileSync(TEST_CSV_PATH, text);
  }

  test("a bounded snapshot import inserts every accepted row and records a run summary", async () => {
    writeSnapshot(CSV);
    const source = createBwiSnapshotSource({ filePath: TEST_CSV_PATH, ingestedAt: FIXED_CLOCK() });
    const summary = await runBwiImport(db, source, { limit: 10 }, FIXED_CLOCK);

    expect(summary.status).toBe("success");
    expect(summary.rowsRead).toBe(2);
    expect(summary.rowsInserted).toBe(2);
    expect(loadExistingCompanies(db).length).toBe(2);

    const runs = loadBwiImportRuns(db);
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe("success");
    expect(runs[0]?.rowsInserted).toBe(2);
  });

  test("identical rerun produces unchanged records, not duplicates", async () => {
    writeSnapshot(CSV);
    const source = createBwiSnapshotSource({ filePath: TEST_CSV_PATH, ingestedAt: FIXED_CLOCK() });

    await runBwiImport(db, source, { limit: 10 }, FIXED_CLOCK);
    const second = await runBwiImport(db, source, { limit: 10 }, FIXED_CLOCK);

    expect(second.rowsInserted).toBe(0);
    expect(second.rowsUpdated).toBe(0);
    expect(second.rowsUnchanged).toBe(2);
    expect(loadExistingCompanies(db).length).toBe(2);
  });

  test("a bounded snapshot that omits a previously-imported id does not delete it", async () => {
    writeSnapshot(CSV);
    const fullSource = createBwiSnapshotSource({ filePath: TEST_CSV_PATH, ingestedAt: FIXED_CLOCK() });
    await runBwiImport(db, fullSource, { limit: 10 }, FIXED_CLOCK);
    expect(loadExistingCompanies(db).length).toBe(2);

    writeSnapshot(`bwi_location_id,company_name,city,state\nbwi-1,Acme Logistics LLC,Dallas,TX\n`);
    const partialSource = createBwiSnapshotSource({ filePath: TEST_CSV_PATH, ingestedAt: FIXED_CLOCK() });
    await runBwiImport(db, partialSource, { limit: 10 }, FIXED_CLOCK);

    // bwi-2 was not in this later, narrower snapshot -- it must still be there.
    expect(loadExistingCompanies(db).length).toBe(2);
    expect(getExistingCompanyById(db, "bwi-2")).toBeDefined();
  });

  test("rejected rows are counted and reported without aborting the whole run", async () => {
    writeSnapshot(`bwi_location_id,company_name,city\nbwi-1,,Dallas\nbwi-2,Valid Co,Plano\n`);
    const source = createBwiSnapshotSource({ filePath: TEST_CSV_PATH, ingestedAt: FIXED_CLOCK() });
    const summary = await runBwiImport(db, source, { limit: 10 }, FIXED_CLOCK);

    expect(summary.status).toBe("success");
    expect(summary.rowsRejected).toBe(1);
    expect(summary.rowsAccepted).toBe(1);
    expect(summary.validationErrors.length).toBe(1);
  });

  test("an import run that hits a hard failure (missing required header) is recorded as failed", async () => {
    writeSnapshot(`company_name\nAcme Logistics LLC\n`);
    const source = createBwiSnapshotSource({ filePath: TEST_CSV_PATH, ingestedAt: FIXED_CLOCK() });
    const summary = await runBwiImport(db, source, { limit: 10 }, FIXED_CLOCK);

    expect(summary.status).toBe("failed");
    expect(summary.errorMessage).toMatch(/bwi_location_id/);
    const runs = loadBwiImportRuns(db);
    expect(runs[0]?.status).toBe("failed");
  });
});

describe("existing BWI records loaded safely alongside legacy fixtures", () => {
  test("a plain pre-Task-7 ExistingCompany (e.g. seed.ts style) still loads correctly", () => {
    upsertBwiExistingLocation(db, {
      id: "bw-seed-001",
      companyName: "Acme Logistics LLC",
      address: "1200 Commerce Street",
      city: "Dallas",
      state: "TX",
      postalCode: "75201",
      phone: "214-555-0100",
      website: "https://acmelogistics.example",
      status: "DIRE"
    });

    const loaded = getExistingCompanyById(db, "bw-seed-001");
    expect(loaded?.companyName).toBe("Acme Logistics LLC");
    expect(loaded?.lifecycleStatus).toBe("published");
    expect(loaded?.fieldEvidence).toBeUndefined();
    expect(loaded?.source).toBeUndefined();
  });
});
