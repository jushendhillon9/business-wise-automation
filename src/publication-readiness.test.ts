import { describe, expect, test } from "bun:test";
import { resolveCandidateAgainstExisting } from "./entity-resolution-policy.ts";
import { isPublicationReadyCompat, evaluatePublicationReadiness } from "./publication-readiness.ts";
import type { CompanyIdentity, LocationCandidate } from "./types.ts";

function baseCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "loc-test",
    company: { id: "co-test", legalName: "Test Company" },
    source: {
      sourceId: "test-source",
      sourceName: "Test Source",
      fingerprint: "test-source:loc-test",
      ingestedAt: new Date().toISOString()
    },
    capturedAt: new Date().toISOString(),
    contacts: [],
    evidence: [],
    ...overrides
  };
}

function completeCompany(overrides: Partial<CompanyIdentity> = {}): CompanyIdentity {
  return {
    id: "co-test",
    legalName: "Acme Test Company",
    alphasort: "ACME TEST COMPANY",
    sicCode: "7372",
    startYear: 2010,
    ...overrides
  };
}

/** A candidate satisfying every confirmed base requirement (docs/BWI_DOMAIN_RULES.md §8.2), for a Branch by default. */
function completeCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return baseCandidate({
    company: completeCompany(),
    physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" },
    phone: "214-555-0100",
    buildingType: "office",
    siteType: "branch",
    employeeSizeSite: { estimate: 25 },
    contacts: [{ name: "Jamie Rivera", email: "jamie@example.com" }],
    ...overrides
  });
}

const CONDITIONAL_FIELDS = {
  employeeSizeCompanyWide: { estimate: 120 },
  estimatedAnnualRevenue: { bandLabel: "$10M-$25M" },
  totalSites: 4
};

describe("evaluatePublicationReadiness — confirmed_ready", () => {
  test("fully complete Single Site is confirmed_ready", () => {
    const candidate = completeCandidate({ siteType: "single_site", ...CONDITIONAL_FIELDS });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
    expect(readiness.blockers).toEqual([]);
    expect(readiness.unresolvedRules).toEqual([]);
  });

  test("fully complete Headquarters is confirmed_ready", () => {
    const candidate = completeCandidate({ siteType: "headquarters", ...CONDITIONAL_FIELDS });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
  });

  test("complete Branch without company-wide fields is confirmed_ready", () => {
    const candidate = completeCandidate({ siteType: "branch" });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
    expect(readiness.blockers).toEqual([]);
  });

  test("complete Regional Headquarters without Single Site/HQ-only fields is confirmed_ready", () => {
    const candidate = completeCandidate({ siteType: "regional_headquarters" });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
  });

  test("no blockers and no unresolved rules implies confirmed_ready (and vice versa)", () => {
    const candidate = completeCandidate();
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.blockers.length === 0 && readiness.unresolvedRules.length === 0).toBe(true);
    expect(readiness.state).toBe("confirmed_ready");
  });
});

describe("evaluatePublicationReadiness — blocked (confirmed base requirements)", () => {
  test("missing company name is blocked", () => {
    const candidate = completeCandidate({ company: completeCompany({ legalName: "" }) });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("company_name_present");
  });

  test("missing alphasort is blocked", () => {
    const candidate = completeCandidate({ company: completeCompany({ alphasort: undefined }) });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("alphasort_present");
  });

  test("invalid/unusable address treatment (no physical address, no ZIP+mailing exception) is blocked", () => {
    const candidate = completeCandidate({ physicalAddress: undefined, mailingAddress: undefined });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("physical_address_or_exception");
  });

  test("missing local phone with no exception basis is blocked", () => {
    const candidate = completeCandidate({ phone: undefined, physicalAddress: undefined, mailingAddress: undefined });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("local_phone_or_exception");
  });

  test("missing building type is blocked", () => {
    const candidate = completeCandidate({ buildingType: undefined });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("building_type_present");
  });

  test("missing site type is blocked, and also flags conditional-requirement applicability as unresolved", () => {
    const candidate = completeCandidate({ siteType: undefined });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("site_type_present");
    // conditional rules are not silently skipped -- the ambiguity is surfaced explicitly
    expect(readiness.unresolvedRules.length).toBeGreaterThan(0);
  });

  test("missing site employee band is blocked", () => {
    const candidate = completeCandidate({ employeeSizeSite: undefined });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("site_employee_band_present");
  });

  test("missing start year is blocked", () => {
    const candidate = completeCandidate({ company: completeCompany({ startYear: undefined }) });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("start_year_present");
  });

  test("missing SIC is blocked", () => {
    const candidate = completeCandidate({ company: completeCompany({ sicCode: undefined }) });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("sic_code_present");
  });

  test("no meaningful contact is blocked", () => {
    const candidate = completeCandidate({ contacts: [] });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("min_one_contact");
  });

  test("an empty contact object does not satisfy the contact requirement", () => {
    const candidate = completeCandidate({ contacts: [{}] });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("min_one_contact");
  });

  test("a contact with only a phone number (no name or email) does not count", () => {
    const candidate = completeCandidate({ contacts: [{ phone: "214-555-0199" }] });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("min_one_contact");
  });
});

describe("evaluatePublicationReadiness — local-phone exception states", () => {
  test("approved local-phone exception (000-000-0000, physical location confirmed) satisfies the requirement", () => {
    const candidate = completeCandidate({ phone: "000-000-0000" });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
    expect(readiness.satisfiedRequirements.map((r) => r.ruleId)).toContain("local_phone_or_exception");
  });

  test("phone missing but physical location confirmed: exception potentially applicable, unresolved -> provisionally_ready", () => {
    const candidate = completeCandidate({ phone: undefined });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.unresolvedRules.map((r) => r.ruleId)).toContain("local_phone_or_exception");
    expect(readiness.state).toBe("provisionally_ready");
  });
});

describe("evaluatePublicationReadiness — conditional corporate-office requirements", () => {
  test("Single Site missing revenue band is blocked", () => {
    const candidate = completeCandidate({
      siteType: "single_site",
      employeeSizeCompanyWide: CONDITIONAL_FIELDS.employeeSizeCompanyWide,
      totalSites: CONDITIONAL_FIELDS.totalSites
    });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("estimated_revenue_present");
  });

  test("Headquarters missing total sites is blocked", () => {
    const candidate = completeCandidate({
      siteType: "headquarters",
      employeeSizeCompanyWide: CONDITIONAL_FIELDS.employeeSizeCompanyWide,
      estimatedAnnualRevenue: CONDITIONAL_FIELDS.estimatedAnnualRevenue
    });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers.map((b) => b.ruleId)).toContain("total_sites_present");
  });

  test("Branch missing revenue band is NOT blocked for that reason -- the rule doesn't apply", () => {
    const candidate = completeCandidate({ siteType: "branch" });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.blockers.map((b) => b.ruleId)).not.toContain("estimated_revenue_present");
    expect(readiness.state).toBe("confirmed_ready");
  });
});

describe("evaluatePublicationReadiness — optional fields never block", () => {
  test("missing square footage and lease expiration do not block (not yet modeled on LocationCandidate)", () => {
    const candidate = completeCandidate();
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
  });

  test("missing email format does not block, and is reported as an optional missing field", () => {
    const candidate = completeCandidate({ company: completeCompany({ emailFormat: undefined }) });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
    expect(readiness.optionalMissingFields).toContain("company.emailFormat");
  });

  test("missing parent-company information does not block, and is reported as an optional missing field", () => {
    const candidate = completeCandidate({ company: completeCompany({ relationship: undefined }) });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.state).toBe("confirmed_ready");
    expect(readiness.optionalMissingFields).toContain("company.relationship");
  });

  test("optional missing fields are reported even though they never affect state", () => {
    const candidate = completeCandidate({ company: completeCompany({ emailFormat: undefined, relationship: undefined }) });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.optionalMissingFields.length).toBeGreaterThan(0);
    expect(readiness.state).toBe("confirmed_ready");
  });
});

describe("evaluatePublicationReadiness — compatibility boolean", () => {
  test("isPublicationReadyCompat is true only for confirmed_ready, never provisionally_ready", () => {
    const confirmed = evaluatePublicationReadiness(completeCandidate());
    const provisional = evaluatePublicationReadiness(completeCandidate({ phone: undefined }));
    const blocked = evaluatePublicationReadiness(completeCandidate({ contacts: [] }));

    expect(confirmed.state).toBe("confirmed_ready");
    expect(provisional.state).toBe("provisionally_ready");
    expect(blocked.state).toBe("blocked");

    expect(isPublicationReadyCompat(confirmed)).toBe(true);
    expect(isPublicationReadyCompat(provisional)).toBe(false);
    expect(isPublicationReadyCompat(blocked)).toBe(false);
  });
});

describe("evaluatePublicationReadiness — determinism", () => {
  test("repeated evaluation of the same candidate produces the same result", () => {
    const candidate = completeCandidate({ phone: undefined });
    const first = evaluatePublicationReadiness(candidate);
    const second = evaluatePublicationReadiness(candidate);
    expect(second).toEqual(first);
  });
});

describe("Task 4 entity-resolution behavior is unaffected by the readiness rewrite", () => {
  test("resolveCandidateAgainstExisting still returns likely_new_company for a candidate with no plausible match", () => {
    const candidate = completeCandidate();
    const decision = resolveCandidateAgainstExisting(candidate, []);
    expect(decision.outcome).toBe("likely_new_company");
    expect(decision.requiresHumanReview).toBe(false);
  });
});
