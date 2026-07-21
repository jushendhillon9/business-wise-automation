import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  createSchema,
  insertCompanyIdentity,
  insertLocationCandidate,
  loadLocationCandidates,
  loadLocationCandidatesByCompanyId,
  openDb
} from "./db.ts";
import type { CompanyIdentity, LocationCandidate } from "./types.ts";

const TEST_DB_PATH = "data/db.test.sqlite";

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

function makeLocation(id: string, company: CompanyIdentity, overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id,
    company,
    source: {
      sourceId: "test-source",
      sourceName: "Test Source",
      fingerprint: `test-source:${id}`,
      ingestedAt: new Date().toISOString()
    },
    capturedAt: new Date().toISOString(),
    contacts: [],
    evidence: [],
    ...overrides
  };
}

describe("company identity / location candidate schema", () => {
  test("one CompanyIdentity can be associated with multiple LocationCandidate records", () => {
    const company: CompanyIdentity = { id: "co-001", legalName: "Acme Logistics", website: "https://acmelogistics.example" };
    insertCompanyIdentity(db, company);

    const headquarters = makeLocation("loc-hq", company, { siteType: "headquarters", physicalAddress: { city: "Dallas", state: "TX" } });
    const branch = makeLocation("loc-branch", company, { siteType: "branch", physicalAddress: { city: "Fort Worth", state: "TX" } });

    insertLocationCandidate(db, headquarters);
    insertLocationCandidate(db, branch);

    const locationsForCompany = loadLocationCandidatesByCompanyId(db, company.id);
    expect(locationsForCompany.length).toBe(2);
    expect(locationsForCompany.map((l) => l.id).sort()).toEqual(["loc-branch", "loc-hq"]);
    // both locations share the same company-level identity
    expect(locationsForCompany.every((l) => l.company.id === company.id)).toBe(true);
    // but each keeps its own location-level facts
    expect(locationsForCompany.find((l) => l.id === "loc-hq")?.siteType).toBe("headquarters");
    expect(locationsForCompany.find((l) => l.id === "loc-branch")?.siteType).toBe("branch");
  });

  test("loadLocationCandidates round-trips the full embedded company identity", () => {
    const company: CompanyIdentity = { id: "co-002", legalName: "Northstar Advisory", sicCode: "8742" };
    insertCompanyIdentity(db, company);
    insertLocationCandidate(db, makeLocation("loc-only", company));

    const [loaded] = loadLocationCandidates(db);
    expect(loaded?.company.legalName).toBe("Northstar Advisory");
    expect(loaded?.company.sicCode).toBe("8742");
  });
});
