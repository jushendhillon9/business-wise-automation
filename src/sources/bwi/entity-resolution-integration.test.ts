import { describe, expect, test } from "bun:test";
import { findBestMatch } from "../../entity-resolution.ts";
import { resolveCandidateAgainstExisting } from "../../entity-resolution-policy.ts";
import { mapRawBwiRecordToExistingLocation, type BwiMappingContext } from "./mapping.ts";
import type { LocationCandidate } from "../../types.ts";

/**
 * Verifies that BWI-imported ExistingCompany records — not just seed.ts's
 * synthetic ones — flow through the unmodified Task 4 entity-resolution
 * pipeline correctly. This never recalibrates matching; it only proves the
 * new import path connects to the existing pipeline.
 */

const CONTEXT: BwiMappingContext = {
  sourceType: "bwi_snapshot",
  sourceId: "bwi-snapshot",
  sourceName: "BWI local read-only snapshot export",
  ingestedAt: "2026-01-01T00:00:00.000Z"
};

function mustImport(overrides: Record<string, string | undefined>) {
  const result = mapRawBwiRecordToExistingLocation(
    {
      bwiLocationId: "bwi-100",
      companyName: "Acme Logistics LLC",
      address: "1200 Commerce Street",
      city: "Dallas",
      state: "TX",
      phone: "214-555-0100",
      website: "https://acmelogistics.example",
      siteTypeCode: "H",
      statusCode: "DIRE",
      ...overrides
    },
    CONTEXT
  );
  if (!result.ok) throw new Error(`unexpected mapping failure: ${result.reason}`);
  return result.existing;
}

function candidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "cand-1",
    company: { id: "co-1", legalName: "Acme Logistics LLC", website: "https://acmelogistics.example" },
    physicalAddress: { street: "1200 Commerce Street", city: "Dallas", state: "TX" },
    phone: "214-555-0100",
    contacts: [],
    evidence: [],
    source: { sourceId: "test", sourceName: "Test", fingerprint: "test:cand-1", ingestedAt: "2026-01-01T00:00:00.000Z" },
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("imported BWI records reach the unmodified Task 4 entity-resolution pipeline", () => {
  test("a candidate matching an imported existing location produces same_existing_location and carries the stable BWI id", () => {
    const existing = mustImport({});
    const decision = resolveCandidateAgainstExisting(candidate(), [existing]);

    expect(decision.outcome).toBe("same_existing_location");
    expect(decision.matchedExistingCompanyId).toBe("bwi-100");
    expect(decision.bestMatch?.existingCompanyId).toBe("bwi-100");
  });

  test("a candidate at a materially different address for an imported company can produce new_branch_of_existing_company", () => {
    const existing = mustImport({});
    const branchCandidate = candidate({
      physicalAddress: { street: "9999 Faraway Rd", city: "Austin", state: "TX" },
      phone: "512-555-0000",
      siteType: "branch"
    });

    const decision = resolveCandidateAgainstExisting(branchCandidate, [existing]);
    expect(decision.outcome).toBe("new_branch_of_existing_company");
    expect(decision.matchedExistingCompanyId).toBe("bwi-100");
  });

  test("an imported record with a deleted/research-deleted lifecycle is still visible to matching, flagged for human review", () => {
    const deleted = mustImport({ bwiLocationId: "bwi-101", statusCode: "RDL" });
    const decision = resolveCandidateAgainstExisting(candidate(), [deleted]);

    expect(decision.outcome).toBe("same_existing_location");
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.conflicts).toContain("existing_location_is_research_deleted");
  });

  test("a genuinely unrelated candidate against imported records remains likely_new / manual review, never a forced match", () => {
    const unrelated = mustImport({ bwiLocationId: "bwi-102", companyName: "Totally Different Co", address: "1 Nowhere Ln" });
    const newCompanyCandidate = candidate({
      company: { id: "co-2", legalName: "Brand New Startup Inc" },
      physicalAddress: { street: "42 New Ave", city: "Waco", state: "TX" },
      phone: "254-555-0000"
    });

    const bestMatch = findBestMatch(newCompanyCandidate, [unrelated]);
    expect(bestMatch.classification).toBe("likely_new");

    const decision = resolveCandidateAgainstExisting(newCompanyCandidate, [unrelated]);
    expect(decision.outcome).toBe("likely_new_company");
  });

  test("ambiguous cases across imported records still fall back to manual review, never guessed", () => {
    const a = mustImport({ bwiLocationId: "bwi-200", companyName: "Ambiguous Co A", address: "500 Shared Plaza", phone: "111-111-1111" });
    const b = mustImport({ bwiLocationId: "bwi-201", companyName: "Ambiguous Co B", address: "500 Shared Plaza", phone: "222-222-2222" });
    const ambiguousCandidate = candidate({
      company: { id: "co-3", legalName: "Ambiguous Co" },
      physicalAddress: { street: "500 Shared Plaza", city: "Dallas", state: "TX" }
    });

    const decision = resolveCandidateAgainstExisting(ambiguousCandidate, [a, b]);
    expect(decision.requiresHumanReview).toBe(true);
  });
});
