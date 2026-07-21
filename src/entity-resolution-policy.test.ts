import { describe, expect, test } from "bun:test";
import { resolveCandidateAgainstExisting } from "./entity-resolution-policy.ts";
import type { ExistingCompany, LocationCandidate } from "./types.ts";

function baseCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "loc-test",
    company: { id: "co-test", legalName: "Acme Robotics" },
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

const acmeRobotics: ExistingCompany = {
  id: "bw-100",
  companyName: "Acme Robotics Inc.",
  address: "100 Main St",
  city: "Dallas",
  state: "TX",
  postalCode: "75201",
  phone: "214-555-0100",
  website: "https://acmerobotics.example",
  sicCode: "3559",
  status: "DIRE",
  lifecycleStatus: "published"
};

describe("resolveCandidateAgainstExisting", () => {
  test("1. strong company + strong address produces same_existing_location", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).toBe("same_existing_location");
    expect(decision.matchedExistingCompanyId).toBe("bw-100");
    expect(decision.requiresHumanReview).toBe(false);
    expect(decision.conflicts).toEqual([]);
  });

  test("2. exact phone + compatible geography supports same_existing_location even with a weak street match", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example" },
      phone: "214-555-0100",
      physicalAddress: { city: "Dallas", state: "TX" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).toBe("same_existing_location");
    expect(decision.matchedExistingCompanyId).toBe("bw-100");
  });

  test("3. strong company identity + materially different location + siteType branch produces new_branch_of_existing_company", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example" },
      physicalAddress: { street: "999 Nowhere Rd", city: "Austin", state: "TX", postalCode: "78701" },
      siteType: "branch"
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).toBe("new_branch_of_existing_company");
    expect(decision.matchedExistingCompanyId).toBe("bw-100");
    expect(decision.reasons).toContain("candidate_site_type_branch");
    expect(decision.requiresHumanReview).toBe(false);
  });

  test("4. strong company identity + materially different location + siteType headquarters produces new_headquarters_of_existing_company", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example" },
      physicalAddress: { street: "999 Nowhere Rd", city: "Austin", state: "TX", postalCode: "78701" },
      siteType: "headquarters"
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).toBe("new_headquarters_of_existing_company");
    expect(decision.reasons).toContain("candidate_site_type_headquarters");
    // never automatically claim the former HQ closed/moved -- always flag for review
    expect(decision.requiresHumanReview).toBe(true);
  });

  test("5. strong company identity + different location + missing/unknown site type produces possible_changed_location", () => {
    const missingSiteType = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example" },
      physicalAddress: { street: "999 Nowhere Rd", city: "Austin", state: "TX", postalCode: "78701" }
    });
    const decisionMissing = resolveCandidateAgainstExisting(missingSiteType, [acmeRobotics]);
    expect(decisionMissing.outcome).toBe("possible_changed_location");
    expect(decisionMissing.reasons).toContain("candidate_site_type_missing");
    expect(decisionMissing.requiresHumanReview).toBe(true);

    const unknownSiteType = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example" },
      physicalAddress: { street: "999 Nowhere Rd", city: "Austin", state: "TX", postalCode: "78701" },
      siteType: "unknown"
    });
    const decisionUnknown = resolveCandidateAgainstExisting(unknownSiteType, [acmeRobotics]);
    expect(decisionUnknown.outcome).toBe("possible_changed_location");
    expect(decisionUnknown.reasons).toContain("candidate_site_type_unknown");
  });

  test("6. strong location + materially different name + domain support produces possible_name_change", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Titan Fabrication Group", website: "https://acmerobotics.example" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).toBe("possible_name_change");
    expect(decision.conflicts).toContain("company_name_materially_different");
    expect(decision.requiresHumanReview).toBe(true);
  });

  test("7. no credible matches produces likely_new_company", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Zephyr Consulting Group" },
      physicalAddress: { street: "1 Random Way", city: "Miami", state: "FL" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).toBe("likely_new_company");
    expect(decision.requiresHumanReview).toBe(false);
  });

  test("8. no existing records produces likely_new_company", () => {
    const decision = resolveCandidateAgainstExisting(baseCandidate(), []);
    expect(decision.outcome).toBe("likely_new_company");
    expect(decision.reasons).toContain("no_existing_locations_to_compare");
    expect(decision.bestMatch).toBeUndefined();
    expect(decision.alternativeMatches).toEqual([]);
  });

  test("9. conflicting signals across multiple plausible existing locations for the same identity produce ambiguous_manual_review", () => {
    const existingA: ExistingCompany = { id: "bw-A", companyName: "Acme Robotics Inc.", address: "1 Foo St", city: "Houston", state: "TX", website: "https://acmerobotics.example" };
    const existingB: ExistingCompany = { id: "bw-B", companyName: "Acme Robotics LLC", address: "2 Bar Ave", city: "Austin", state: "TX" };
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics", website: "https://acmerobotics.example" },
      physicalAddress: { street: "500 Somewhere Blvd", city: "Dallas", state: "TX" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [existingA, existingB]);
    expect(decision.outcome).toBe("ambiguous_manual_review");
    expect(decision.conflicts).toContain("multiple_close_existing_location_matches");
    expect(decision.requiresHumanReview).toBe(true);
  });

  test("10. two close, plausible top matches produce ambiguous_manual_review", () => {
    const existingC: ExistingCompany = { id: "bw-C", companyName: "Falcon Systems Inc", address: "77 Falcon Way", city: "Dallas", state: "TX", postalCode: "75001" };
    const existingD: ExistingCompany = { id: "bw-D", companyName: "Falcon Systems LLC", address: "77 Falcon Way", city: "Dallas", state: "TX", postalCode: "75001" };
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Falcon Systems" },
      physicalAddress: { street: "77 Falcon Way", city: "Dallas", state: "TX", postalCode: "75001" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [existingC, existingD]);
    expect(decision.outcome).toBe("ambiguous_manual_review");
    expect(decision.conflicts).toContain("multiple_close_existing_location_matches");
  });

  test("12. a match against a deleted existing row is still considered and surfaces a lifecycle warning", () => {
    const deletedRecord: ExistingCompany = { ...acmeRobotics, id: "bw-deleted", status: "DEL", lifecycleStatus: "deleted" };
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [deletedRecord]);
    // still matched -- deleted rows are never excluded from matching
    expect(decision.outcome).toBe("same_existing_location");
    expect(decision.matchedExistingCompanyId).toBe("bw-deleted");
    expect(decision.conflicts).toContain("existing_location_is_deleted");
    expect(decision.requiresHumanReview).toBe(true);
  });

  test("13. a match against a research-deleted existing row is still considered and surfaces a lifecycle warning", () => {
    const researchDeletedRecord: ExistingCompany = { ...acmeRobotics, id: "bw-research-deleted", status: "RDL", lifecycleStatus: "research_deleted" };
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [researchDeletedRecord]);
    expect(decision.outcome).toBe("same_existing_location");
    expect(decision.conflicts).toContain("existing_location_is_research_deleted");
    expect(decision.requiresHumanReview).toBe(true);
  });

  test("14. RDL and RDEL raw spellings produce identical decision semantics", () => {
    const rdl: ExistingCompany = { ...acmeRobotics, id: "bw-rdl", status: "RDL", lifecycleStatus: "research_deleted" };
    const rdel: ExistingCompany = { ...acmeRobotics, id: "bw-rdel", status: "RDEL", lifecycleStatus: "research_deleted" };
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const decisionRdl = resolveCandidateAgainstExisting(candidate, [rdl]);
    const decisionRdel = resolveCandidateAgainstExisting(candidate, [rdel]);

    expect(decisionRdl.outcome).toBe(decisionRdel.outcome);
    expect(decisionRdl.conflicts).toEqual(decisionRdel.conflicts);
    expect(decisionRdl.requiresHumanReview).toBe(decisionRdel.requiresHumanReview);
  });

  test("15. a company-name match without location or domain support cannot become same_existing_location", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc." },
      physicalAddress: { street: "1 Random Way", city: "Miami", state: "FL" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).not.toBe("same_existing_location");
  });

  test("16. an exact address alone with conflicting identity evidence does not automatically become possible_name_change", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Titan Fabrication Group" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.outcome).not.toBe("possible_name_change");
    expect(decision.outcome).toBe("ambiguous_manual_review");
  });

  test("decisionConfidence is a deterministic heuristic derived from the existing score, not a new statistical model", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const decision = resolveCandidateAgainstExisting(candidate, [acmeRobotics]);
    expect(decision.decisionConfidence).toBe(decision.bestMatch?.score);
  });
});
