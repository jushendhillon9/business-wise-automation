import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  createSchema,
  insertCompanyIdentity,
  insertExistingCompany,
  insertLocationCandidate,
  loadExistingCompanies,
  loadLocationCandidates,
  loadLocationCandidatesByCompanyId,
  openDb
} from "./db.ts";
import type { CompanyIdentity, ExistingCompany, LocationCandidate } from "./types.ts";

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

describe("BWI code round-tripping through the sandbox schema", () => {
  test("employee-size rawCode survives a database round-trip", () => {
    const company: CompanyIdentity = { id: "co-003", legalName: "Acme Logistics" };
    insertCompanyIdentity(db, company);
    insertLocationCandidate(
      db,
      makeLocation("loc-employee-code", company, {
        employeeSizeSite: { estimate: 42, minimum: 25, maximum: 49, bandLabel: "25-49 employees", rawCode: "E" }
      })
    );

    const [loaded] = loadLocationCandidates(db);
    expect(loaded?.employeeSizeSite).toEqual({
      estimate: 42,
      minimum: 25,
      maximum: 49,
      bandLabel: "25-49 employees",
      rawCode: "E"
    });
  });

  test("revenue rawCode survives a database round-trip", () => {
    const company: CompanyIdentity = { id: "co-004", legalName: "Acme Logistics" };
    insertCompanyIdentity(db, company);
    insertLocationCandidate(
      db,
      makeLocation("loc-revenue-code", company, {
        estimatedAnnualRevenue: { minimum: 1_000_000, maximum: 5_000_000, bandLabel: "$1M-$5M", rawCode: "D" }
      })
    );

    const [loaded] = loadLocationCandidates(db);
    expect(loaded?.estimatedAnnualRevenue?.rawCode).toBe("D");
    expect(loaded?.estimatedAnnualRevenue?.bandLabel).toBe("$1M-$5M");
  });

  test("a location candidate's raw site-type code survives a database round-trip alongside the normalized value", () => {
    const company: CompanyIdentity = { id: "co-005", legalName: "Acme Logistics" };
    insertCompanyIdentity(db, company);
    insertLocationCandidate(
      db,
      makeLocation("loc-site-type-code", company, { siteType: "headquarters", rawSiteTypeCode: " h " })
    );

    const [loaded] = loadLocationCandidates(db);
    expect(loaded?.siteType).toBe("headquarters");
    expect(loaded?.rawSiteTypeCode).toBe(" h ");
  });

  test("an existing BWI record's raw lifecycle code survives a database round-trip alongside the normalized status", () => {
    const rdl: ExistingCompany = { id: "bw-rdl", companyName: "Ghost Co", status: "RDL" };
    const rdel: ExistingCompany = { id: "bw-rdel", companyName: "Phantom Co", status: "RDEL" };
    insertExistingCompany(db, rdl);
    insertExistingCompany(db, rdel);

    const loaded = loadExistingCompanies(db);
    const loadedRdl = loaded.find((c) => c.id === "bw-rdl");
    const loadedRdel = loaded.find((c) => c.id === "bw-rdel");

    // raw values are preserved distinctly...
    expect(loadedRdl?.status).toBe("RDL");
    expect(loadedRdel?.status).toBe("RDEL");
    // ...while both normalize to the same semantic lifecycle value
    expect(loadedRdl?.lifecycleStatus).toBe("research_deleted");
    expect(loadedRdel?.lifecycleStatus).toBe("research_deleted");
  });

  test("existing_companies lifecycle_status is always derived from status, never passed through independently", () => {
    const company: ExistingCompany = { id: "bw-dire", companyName: "Acme Logistics", status: "DIRE" };
    insertExistingCompany(db, company);

    const [loaded] = loadExistingCompanies(db);
    expect(loaded?.status).toBe("DIRE");
    expect(loaded?.lifecycleStatus).toBe("published");
  });
});
