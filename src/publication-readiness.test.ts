import { describe, expect, test } from "bun:test";
import { evaluatePublicationReadiness } from "./publication-readiness.ts";
import { researchCompleteness } from "./scoring.ts";
import type { LocationCandidate } from "./types.ts";

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

describe("evaluatePublicationReadiness", () => {
  test("a very complete record with zero contacts is NOT publication-ready", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Test Company", website: "example.com", sicCode: "7372" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" },
      phone: "214-555-0100",
      employeeSizeSite: { estimate: 40 },
      siteType: "headquarters",
      description: "Fully researched record with no known contact",
      contacts: []
    });

    // this candidate would score very high on research completeness...
    expect(researchCompleteness(candidate).score).toBeGreaterThan(0.8);

    // ...but is still not publication-ready, because the one explicit BW
    // publish rule we know about (at least one contact) is not satisfied
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).toContain("min_one_contact");
  });

  test("a record with one contact satisfies the explicit contact requirement", () => {
    const candidate = baseCandidate({ contacts: [{ name: "Taylor Nguyen", title: "CEO" }] });
    const readiness = evaluatePublicationReadiness(candidate);

    const contactRequirement = readiness.requirements.find((r) => r.id === "min_one_contact");
    expect(contactRequirement?.satisfied).toBe(true);
    expect(readiness.blockingReasons).not.toContain("min_one_contact");
  });

  test("a contact with only a phone number (no name or email) does not count", () => {
    const candidate = baseCandidate({ contacts: [{ phone: "214-555-0100" }] });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.blockingReasons).toContain("min_one_contact");
  });

  test("readiness always reports blocking reasons for unmet confirmed rules", () => {
    const candidate = baseCandidate({ company: { id: "co-test", legalName: "" }, contacts: [] });
    const readiness = evaluatePublicationReadiness(candidate);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).toEqual(
      expect.arrayContaining(["min_one_contact", "company_name_present"])
    );
  });

  test("unresolved rules (phone, address, SIC, website, site type) are reported but never block readiness", () => {
    const candidate = baseCandidate({ contacts: [{ name: "Jamie Rivera" }] });
    const readiness = evaluatePublicationReadiness(candidate);

    expect(readiness.ready).toBe(true);
    const unresolved = readiness.requirements.filter((r) => r.status === "unresolved");
    expect(unresolved.length).toBeGreaterThan(0);
    // none of the unresolved rules should ever appear in blockingReasons
    for (const rule of unresolved) {
      expect(readiness.blockingReasons).not.toContain(rule.id);
    }
  });

  test("the 000-000-0000 placeholder phone counts as an acceptable (non-blocking) value", () => {
    const candidate = baseCandidate({ contacts: [{ name: "Jamie Rivera" }], phone: "000-000-0000" });
    const readiness = evaluatePublicationReadiness(candidate);
    const phoneRequirement = readiness.requirements.find((r) => r.id === "local_phone_or_placeholder");
    expect(phoneRequirement?.satisfied).toBe(true);
  });

  test("reads company-level fields from candidate.company and location-level fields from the candidate itself", () => {
    const candidate = baseCandidate({
      company: { id: "co-test", legalName: "Test Company", website: "example.com", sicCode: "7372" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" },
      contacts: [{ name: "Jamie Rivera" }]
    });
    const readiness = evaluatePublicationReadiness(candidate);

    expect(readiness.requirements.find((r) => r.id === "sic_code")?.satisfied).toBe(true);
    expect(readiness.requirements.find((r) => r.id === "website")?.satisfied).toBe(true);
    expect(readiness.requirements.find((r) => r.id === "physical_address_or_exception")?.satisfied).toBe(true);
  });
});

describe("SiteType modeling", () => {
  test("round-trips between the internal SiteType and BW's S/H/B/R codes", async () => {
    const { SITE_TYPE_TO_BW_CODE, BW_CODE_TO_SITE_TYPE } = await import("./types.ts");
    expect(SITE_TYPE_TO_BW_CODE.headquarters).toBe("H");
    expect(SITE_TYPE_TO_BW_CODE.single_site).toBe("S");
    expect(BW_CODE_TO_SITE_TYPE.H).toBe("headquarters");
    expect(BW_CODE_TO_SITE_TYPE.R).toBe("regional_headquarters");
  });

  test("a candidate can carry a typed siteType instead of a raw BW code", () => {
    const candidate = baseCandidate({ siteType: "single_site" });
    expect(candidate.siteType).toBe("single_site");
  });
});
