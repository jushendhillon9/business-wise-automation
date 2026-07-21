import { describe, expect, test } from "bun:test";
import { findBestMatch, scoreCandidateAgainstExisting } from "./entity-resolution.ts";
import type { ExistingCompany, LocationCandidate } from "./types.ts";

function baseCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "loc-test",
    company: { id: "co-test", legalName: "Acme Logistics" },
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

const existing: ExistingCompany = {
  id: "bw-001",
  companyName: "Acme Logistics LLC",
  address: "1200 Commerce Street",
  city: "Dallas",
  state: "TX",
  postalCode: "75201",
  phone: "214-555-0100",
  website: "https://acmelogistics.example",
  sicCode: "4213",
  status: "DIRE"
};

describe("scoreCandidateAgainstExisting", () => {
  test("compares company-level and location-level evidence separately", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Logistics, Inc.", website: "https://acmelogistics.example", sicCode: "4213" },
      physicalAddress: { street: "1200 Commerce Street", city: "Dallas", state: "TX", postalCode: "75201" },
      phone: "214-555-0100"
    });

    const result = scoreCandidateAgainstExisting(candidate, existing);

    // company-level evidence
    expect(result.companySimilarity.nameScore).toBeGreaterThan(0.7);
    expect(result.companySimilarity.domainMatch).toBe(true);
    expect(result.companySimilarity.sicMatch).toBe(true);

    // location-level evidence, computed independently of company-level evidence
    expect(result.locationSimilarity.addressScore).toBeGreaterThan(0.7);
    expect(result.locationSimilarity.phoneMatch).toBe(true);
    expect(result.locationSimilarity.cityStateMatch).toBe(true);

    expect(result.classification).toBe("likely_duplicate");
  });

  test("a strong company-name match with a completely different location still lowers overall similarity", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Logistics" },
      physicalAddress: { street: "9999 Nowhere Rd", city: "Austin", state: "TX", postalCode: "78701" },
      phone: "512-555-9999"
    });

    const result = scoreCandidateAgainstExisting(candidate, existing);

    expect(result.companySimilarity.nameScore).toBeGreaterThan(0.7);
    expect(result.locationSimilarity.phoneMatch).toBe(false);
    expect(result.locationSimilarity.cityStateMatch).toBe(false);
    // no location evidence corroborates the company-name match, so this
    // should not be treated as a confident duplicate
    expect(result.classification).not.toBe("likely_duplicate");
  });

  test("SIC and city/state matches are surfaced as reasons", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Acme Logistics", sicCode: "4213" },
      physicalAddress: { city: "Dallas", state: "TX" }
    });

    const result = scoreCandidateAgainstExisting(candidate, existing);
    expect(result.reasons).toContain("matching SIC code");
    expect(result.reasons).toContain("matching city/state");
  });
});

describe("findBestMatch", () => {
  test("still produces the three current classifications", () => {
    const noMatch = findBestMatch(baseCandidate({ company: { id: "co-test", legalName: "Totally Unrelated Co" } }), [existing]);
    expect(noMatch.classification).toBe("likely_new");

    const strongMatch = findBestMatch(
      baseCandidate({
        company: { id: "co-test", legalName: "Acme Logistics, Inc.", website: "https://acmelogistics.example" },
        phone: "214-555-0100"
      }),
      [existing]
    );
    expect(strongMatch.classification).toBe("likely_duplicate");
  });

  test("returns empty-but-structured evidence when there are no existing companies to compare against", () => {
    const result = findBestMatch(baseCandidate(), []);
    expect(result.classification).toBe("likely_new");
    expect(result.companySimilarity).toEqual({ nameScore: 0, domainMatch: false, sicMatch: false });
    expect(result.locationSimilarity).toEqual({ addressScore: 0, phoneMatch: false, cityStateMatch: false });
  });
});
