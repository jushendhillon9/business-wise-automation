import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resolveCandidateAgainstExisting } from "./entity-resolution-policy.ts";
import { findBestMatch } from "./entity-resolution.ts";
import { evaluatePublicationReadiness } from "./publication-readiness.ts";
import { researchCompleteness, reviewPriority } from "./scoring.ts";
import {
  createSchema,
  insertCompanyIdentity,
  insertExistingCompany,
  insertLocationCandidate,
  insertReviewDecision,
  loadExistingCompanies,
  loadLocationCandidates,
  loadLocationCandidatesByCompanyId,
  loadReviewQueue,
  openDb,
  upsertReviewQueue
} from "./db.ts";
import { companyFieldPath, contactFieldPath, createFieldEvidence, locationFieldPath } from "./types.ts";
import type { CompanyIdentity, ExistingCompany, FieldEvidence, LocationCandidate } from "./types.ts";

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

describe("field-level evidence persistence (Task 6)", () => {
  test("multiple and conflicting field evidence survive a database round-trip", () => {
    const company: CompanyIdentity = { id: "co-evidence", legalName: "Acme Evidence Co" };
    insertCompanyIdentity(db, company);

    const fieldEvidence: FieldEvidence[] = [
      createFieldEvidence({
        path: companyFieldPath("website"),
        value: "https://acme.example",
        confidence: 0.6,
        source: { sourceType: "chamber_of_commerce", sourceId: "dfw-json", sourceName: "DFW Chamber Discovery Feed (JSON)" }
      }),
      createFieldEvidence({
        path: locationFieldPath("phone"),
        value: "214-555-0100",
        confidence: 0.6,
        source: { sourceType: "county_business_license", sourceId: "dfw-csv", sourceName: "DFW County Business License Export (CSV)" }
      }),
      createFieldEvidence({
        path: locationFieldPath("phone"),
        value: "214-555-0199",
        confidence: 0.6,
        source: { sourceType: "company_website", sourceId: "manual", sourceName: "Manual check", sourceUrl: "https://acme.example/contact" }
      }),
      createFieldEvidence({
        path: contactFieldPath("contact-1", "email"),
        value: "jamie@acme.example",
        confidence: 0.75,
        source: { sourceType: "hunter_email_verification", sourceId: "manual", sourceName: "Manual check" },
        evidenceText: "verified deliverable"
      })
    ];

    const candidate = makeLocation("loc-evidence", company, {
      phone: "214-555-0100",
      contacts: [{ id: "contact-1", name: "Jamie Rivera", email: "jamie@acme.example" }],
      fieldEvidence
    });
    insertLocationCandidate(db, candidate);

    const [loaded] = loadLocationCandidates(db);
    expect(loaded?.fieldEvidence?.length).toBe(4);

    const phoneEvidence = loaded?.fieldEvidence?.filter((e) => e.path.scope === "location" && e.path.field === "phone") ?? [];
    expect(phoneEvidence.length).toBe(2);
    expect(phoneEvidence.map((e) => e.value).sort()).toEqual(["214-555-0100", "214-555-0199"]);

    const contactEvidence = loaded?.fieldEvidence?.find((e) => e.path.scope === "contact" && e.path.contactId === "contact-1");
    expect(contactEvidence?.value).toBe("jamie@acme.example");
    expect(contactEvidence?.evidenceText).toBe("verified deliverable");
  });

  test("a legacy row inserted without fieldEvidence loads safely with fieldEvidence undefined", () => {
    const company: CompanyIdentity = { id: "co-legacy", legalName: "Legacy Co" };
    insertCompanyIdentity(db, company);
    insertLocationCandidate(db, makeLocation("loc-legacy", company));

    const [loaded] = loadLocationCandidates(db);
    expect(loaded?.fieldEvidence).toBeUndefined();
  });

  test("re-inserting the same candidate id does not accumulate duplicate rows or evidence", () => {
    const company: CompanyIdentity = { id: "co-rerun", legalName: "Rerun Co" };
    insertCompanyIdentity(db, company);
    const fieldEvidence: FieldEvidence[] = [
      createFieldEvidence({
        path: companyFieldPath("website"),
        value: "https://rerun.example",
        confidence: 0.6,
        source: { sourceType: "chamber_of_commerce", sourceId: "dfw-json", sourceName: "DFW Chamber Discovery Feed (JSON)" }
      })
    ];
    const candidate = makeLocation("loc-rerun", company, { fieldEvidence });

    insertLocationCandidate(db, candidate);
    insertLocationCandidate(db, candidate);

    const loaded = loadLocationCandidates(db);
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.fieldEvidence?.length).toBe(1);
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

describe("19. review_queue persists and reloads the richer business-resolution outcome", () => {
  test("resolution outcome, reasons, conflicts, and matched location survive a database round-trip", () => {
    const existing: ExistingCompany = {
      id: "bw-existing",
      companyName: "Acme Robotics Inc.",
      address: "100 Main St",
      city: "Dallas",
      state: "TX",
      postalCode: "75201",
      website: "https://acmerobotics.example",
      status: "DIRE",
      lifecycleStatus: "published"
    };
    insertExistingCompany(db, existing);

    const company: CompanyIdentity = { id: "co-existing-branch", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example" };
    insertCompanyIdentity(db, company);
    const candidate = makeLocation("loc-branch-candidate", company, {
      physicalAddress: { street: "999 Nowhere Rd", city: "Austin", state: "TX" },
      siteType: "branch"
    });
    insertLocationCandidate(db, candidate);

    const bestMatch = findBestMatch(candidate, [existing]);
    const resolution = resolveCandidateAgainstExisting(candidate, [existing]);
    const completeness = researchCompleteness(candidate);
    const publicationReadiness = evaluatePublicationReadiness(candidate);
    const priority = reviewPriority(candidate, bestMatch, completeness.score);

    // sanity check on the fixture before asserting the round-trip
    expect(resolution.outcome).toBe("new_branch_of_existing_company");

    upsertReviewQueue(db, candidate.id, bestMatch, resolution, completeness, publicationReadiness, priority);

    const [row] = loadReviewQueue(db);
    expect(row?.matchClassification).toBe(bestMatch.classification);
    expect(row?.resolutionOutcome).toBe("new_branch_of_existing_company");
    expect(row?.resolutionReasons).toEqual(resolution.reasons);
    expect(row?.resolutionConflicts).toEqual(resolution.conflicts);
    expect(row?.resolutionMatchedExistingCompanyId).toBe("bw-existing");
    expect(row?.resolutionRequiresHumanReview).toBe(false);
    expect(row?.resolutionAlternativeMatches).toEqual(resolution.alternativeMatches);
    // review priority still comes from the unchanged low-level formula
    expect(row?.reviewPriority).toBe(priority);
  });

  test("upsertReviewQueue keeps the low-level match_classification and the richer resolution_outcome in separate columns, not overloaded into one", () => {
    const existing: ExistingCompany = { id: "bw-unrelated", companyName: "Totally Unrelated Co" };
    insertExistingCompany(db, existing);

    const company: CompanyIdentity = { id: "co-new", legalName: "Brand New Startup" };
    insertCompanyIdentity(db, company);
    const candidate = makeLocation("loc-new", company);
    insertLocationCandidate(db, candidate);

    const bestMatch = findBestMatch(candidate, [existing]);
    const resolution = resolveCandidateAgainstExisting(candidate, [existing]);
    const completeness = researchCompleteness(candidate);
    const publicationReadiness = evaluatePublicationReadiness(candidate);
    const priority = reviewPriority(candidate, bestMatch, completeness.score);

    upsertReviewQueue(db, candidate.id, bestMatch, resolution, completeness, publicationReadiness, priority);

    const [row] = loadReviewQueue(db);
    expect(row?.matchClassification).toBe("likely_new");
    expect(row?.resolutionOutcome).toBe("likely_new_company");
  });
});

describe("foreign-key enforcement (Commit 2.1)", () => {
  test("openDb() enables foreign_keys on every connection, not just during createSchema()", () => {
    const pragma = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(pragma.foreign_keys).toBe(1);
  });

  test("inserting a review decision for a nonexistent location candidate is rejected", () => {
    expect(() =>
      insertReviewDecision(db, {
        id: "dec-orphan",
        locationCandidateId: "does-not-exist",
        sequence: 1,
        reviewer: "jane",
        action: "needs_more_research",
        previousStatus: "pending",
        newStatus: "needs_more_research",
        selectedBwiRecordId: undefined,
        notes: undefined,
        machineRecommendation: {
          matchClassification: "likely_new",
          matchScore: 0.1,
          resolutionOutcome: "likely_new_company",
          resolutionRequiresHumanReview: false,
          resolutionReasons: [],
          resolutionConflicts: [],
          completenessScore: 0,
          publicationState: "blocked",
          publicationBlockerRuleIds: [],
          reviewPriority: 0
        },
        fieldCorrections: [],
        decidedAt: new Date().toISOString()
      })
    ).toThrow();
  });
});
