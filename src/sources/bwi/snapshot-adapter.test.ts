import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createBwiSnapshotSource } from "./snapshot-adapter.ts";

const TEST_FILE = "data/bwi-snapshot-adapter.test.csv";

function writeCsv(text: string) {
  Bun.write(TEST_FILE, text);
}

beforeEach(() => {
  try {
    unlinkSync(TEST_FILE);
  } catch {
    // no previous file, fine
  }
});

afterEach(() => {
  try {
    unlinkSync(TEST_FILE);
  } catch {
    // ignore
  }
});

const VALID_CSV = `bwi_location_id,company_name,city,state,phone,site_type_code,status_code
bwi-1,Acme Logistics LLC,Dallas,TX,214-555-0100,H,DIRE
bwi-2,Northstar Advisory,Fort Worth,TX,817-555-0144,S,DIRE
bwi-3,Blue Mesa Technologies,Plano,TX,972-555-0188,S,research
`;

describe("createBwiSnapshotSource — schema validation", () => {
  test("a well-formed file with valid rows is accepted", async () => {
    writeCsv(VALID_CSV);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    const results = await source.fetchExistingLocations({ limit: 10 });
    expect(results.length).toBe(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("a file missing the required bwi_location_id column throws a clear error", async () => {
    writeCsv(`company_name,city\nAcme Logistics LLC,Dallas\n`);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    await expect(source.fetchExistingLocations({ limit: 10 })).rejects.toThrow(/bwi_location_id/);
  });

  test("a file missing the required company_name column throws a clear error", async () => {
    writeCsv(`bwi_location_id,city\nbwi-1,Dallas\n`);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    await expect(source.fetchExistingLocations({ limit: 10 })).rejects.toThrow(/company_name/);
  });

  test("a row missing company_name is rejected but does not fail the whole import", async () => {
    writeCsv(`bwi_location_id,company_name,city\nbwi-1,,Dallas\nbwi-2,Valid Co,Plano\n`);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    const results = await source.fetchExistingLocations({ limit: 10 });
    expect(results.length).toBe(2);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok).toBe(true);
  });
});

describe("createBwiSnapshotSource — bounded fetch options", () => {
  test("limit bounds the number of rows returned", async () => {
    writeCsv(VALID_CSV);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    const results = await source.fetchExistingLocations({ limit: 2 });
    expect(results.length).toBe(2);
  });

  test("afterId excludes ids at or before the cursor", async () => {
    writeCsv(VALID_CSV);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    const results = await source.fetchExistingLocations({ limit: 10, afterId: "bwi-1" });
    const ids = results.map((r) => (r.ok ? r.existing.id : undefined));
    expect(ids).toEqual(["bwi-2", "bwi-3"]);
  });

  test("ids filters to exactly the requested stable ids", async () => {
    writeCsv(VALID_CSV);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    const results = await source.fetchExistingLocations({ limit: 10, ids: ["bwi-3", "bwi-1"] });
    const ids = results.map((r) => (r.ok ? r.existing.id : undefined)).sort();
    expect(ids).toEqual(["bwi-1", "bwi-3"]);
  });

  test("results are in deterministic id order regardless of options", async () => {
    writeCsv(VALID_CSV);
    const source = createBwiSnapshotSource({ filePath: TEST_FILE, ingestedAt: "2026-01-01T00:00:00.000Z" });
    const a = await source.fetchExistingLocations({ limit: 10 });
    const b = await source.fetchExistingLocations({ limit: 10 });
    expect(a.map((r) => (r.ok ? r.existing.id : undefined))).toEqual(b.map((r) => (r.ok ? r.existing.id : undefined)));
    expect(a.map((r) => (r.ok ? r.existing.id : undefined))).toEqual(["bwi-1", "bwi-2", "bwi-3"]);
  });
});
