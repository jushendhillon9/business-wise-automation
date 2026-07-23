import { describe, expect, test } from "bun:test";
import {
  addFieldEvidence,
  assertValidFieldEvidenceConfidence,
  companyFieldPath,
  contactFieldPath,
  createFieldEvidence,
  evidenceForField,
  fieldPathKey,
  hasFieldEvidence,
  isValidFieldEvidenceConfidence,
  locationFieldPath,
  type FieldEvidence,
  type FieldEvidenceSource,
  type LocationCandidate
} from "./types.ts";

const FIXED_CAPTURED_AT = "2026-07-01T12:00:00.000Z";

function testSource(overrides: Partial<FieldEvidenceSource> = {}): FieldEvidenceSource {
  return {
    sourceType: "chamber_of_commerce",
    sourceId: "test-source",
    sourceName: "Test Source",
    ...overrides
  };
}

function baseCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "loc-1",
    company: { id: "co-1", legalName: "Test Co" },
    source: { sourceId: "test-source", sourceName: "Test Source", fingerprint: "test-source:loc-1", ingestedAt: FIXED_CAPTURED_AT },
    capturedAt: FIXED_CAPTURED_AT,
    contacts: [],
    evidence: [],
    ...overrides
  };
}

describe("confidence validation", () => {
  test("0 is accepted", () => {
    expect(isValidFieldEvidenceConfidence(0)).toBe(true);
    expect(assertValidFieldEvidenceConfidence(0)).toBe(0);
  });

  test("1 is accepted", () => {
    expect(isValidFieldEvidenceConfidence(1)).toBe(true);
    expect(assertValidFieldEvidenceConfidence(1)).toBe(1);
  });

  test("a representative middle value is accepted", () => {
    expect(isValidFieldEvidenceConfidence(0.62)).toBe(true);
  });

  test("below 0 is rejected", () => {
    expect(isValidFieldEvidenceConfidence(-0.01)).toBe(false);
    expect(() => assertValidFieldEvidenceConfidence(-0.01)).toThrow(RangeError);
  });

  test("above 1 is rejected", () => {
    expect(isValidFieldEvidenceConfidence(1.01)).toBe(false);
    expect(() => assertValidFieldEvidenceConfidence(1.01)).toThrow(RangeError);
  });

  test("non-finite values are rejected", () => {
    expect(isValidFieldEvidenceConfidence(Number.NaN)).toBe(false);
    expect(isValidFieldEvidenceConfidence(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("createFieldEvidence throws for out-of-range confidence instead of silently accepting it", () => {
    expect(() =>
      createFieldEvidence({
        path: companyFieldPath("website"),
        value: "https://example.com",
        confidence: 1.5,
        source: testSource()
      })
    ).toThrow(RangeError);
  });

  test("addFieldEvidence throws for invalid confidence and does not mutate the collection", () => {
    const collection: FieldEvidence[] = [];
    expect(() =>
      addFieldEvidence(collection, {
        path: companyFieldPath("website"),
        value: "https://example.com",
        confidence: -1,
        source: testSource()
      })
    ).toThrow(RangeError);
    expect(collection.length).toBe(0);
  });
});

describe("field linkage", () => {
  test("company evidence maps to the correct company field", () => {
    const websiteEvidence = createFieldEvidence({
      path: companyFieldPath("website"),
      value: "https://acme.example",
      confidence: 0.6,
      source: testSource()
    });
    const sicEvidence = createFieldEvidence({
      path: companyFieldPath("sicCode"),
      value: "4213",
      confidence: 0.6,
      source: testSource()
    });

    const collection = [websiteEvidence, sicEvidence];
    expect(evidenceForField(collection, companyFieldPath("website"))).toEqual([websiteEvidence]);
    expect(evidenceForField(collection, companyFieldPath("sicCode"))).toEqual([sicEvidence]);
  });

  test("location evidence maps to the correct location field", () => {
    const phoneEvidence = createFieldEvidence({
      path: locationFieldPath("phone"),
      value: "214-555-0100",
      confidence: 0.6,
      source: testSource()
    });
    const addressEvidence = createFieldEvidence({
      path: locationFieldPath("physicalAddress"),
      value: { city: "Dallas", state: "TX" },
      confidence: 0.6,
      source: testSource()
    });

    const collection = [phoneEvidence, addressEvidence];
    expect(evidenceForField(collection, locationFieldPath("phone"))).toEqual([phoneEvidence]);
    expect(evidenceForField(collection, locationFieldPath("physicalAddress"))).toEqual([addressEvidence]);
  });

  test("contact evidence remains tied to the correct contact, not array position", () => {
    const contactAEmail = createFieldEvidence({
      path: contactFieldPath("contact-a", "email"),
      value: "a@example.com",
      confidence: 0.6,
      source: testSource()
    });
    const contactBEmail = createFieldEvidence({
      path: contactFieldPath("contact-b", "email"),
      value: "b@example.com",
      confidence: 0.6,
      source: testSource()
    });

    const collection = [contactAEmail, contactBEmail];
    expect(evidenceForField(collection, contactFieldPath("contact-a", "email"))).toEqual([contactAEmail]);
    expect(evidenceForField(collection, contactFieldPath("contact-b", "email"))).toEqual([contactBEmail]);
    // Same field name, different contact id -> distinct keys, never conflated.
    expect(fieldPathKey(contactAEmail.path)).not.toBe(fieldPathKey(contactBEmail.path));
  });

  test("hasFieldEvidence reflects whether any evidence exists for a field on a candidate", () => {
    const candidate = baseCandidate({
      fieldEvidence: [
        createFieldEvidence({ path: locationFieldPath("phone"), value: "214-555-0100", confidence: 0.6, source: testSource() })
      ]
    });

    expect(hasFieldEvidence(candidate, locationFieldPath("phone"))).toBe(true);
    expect(hasFieldEvidence(candidate, locationFieldPath("physicalAddress"))).toBe(false);
  });

  test("hasFieldEvidence is false (not an error) for a candidate with no fieldEvidence at all", () => {
    const candidate = baseCandidate();
    expect(candidate.fieldEvidence).toBeUndefined();
    expect(hasFieldEvidence(candidate, companyFieldPath("website"))).toBe(false);
  });
});

describe("multiple and conflicting evidence", () => {
  test("multiple supporting records for the same field are all preserved", () => {
    let collection: FieldEvidence[] = [];
    collection = addFieldEvidence(collection, {
      path: companyFieldPath("website"),
      value: "https://acme.example",
      confidence: 0.6,
      source: testSource({ sourceType: "chamber_of_commerce" })
    });
    collection = addFieldEvidence(collection, {
      path: companyFieldPath("website"),
      value: "https://acme.example",
      confidence: 0.85,
      source: testSource({ sourceType: "company_website" })
    });

    const websiteEvidence = evidenceForField(collection, companyFieldPath("website"));
    expect(websiteEvidence.length).toBe(2);
  });

  test("conflicting records for the same field are preserved, not resolved or overwritten", () => {
    let collection: FieldEvidence[] = [];
    collection = addFieldEvidence(collection, {
      path: locationFieldPath("phone"),
      value: "214-555-0100",
      confidence: 0.6,
      source: testSource()
    });
    collection = addFieldEvidence(collection, {
      path: locationFieldPath("phone"),
      value: "214-555-0199",
      confidence: 0.6,
      source: testSource({ sourceId: "another-source", sourceName: "Another Source" })
    });

    const phoneEvidence = evidenceForField(collection, locationFieldPath("phone"));
    expect(phoneEvidence.length).toBe(2);
    expect(phoneEvidence.map((e) => e.value).sort()).toEqual(["214-555-0100", "214-555-0199"]);
  });

  test("adding evidence for one field does not overwrite or remove evidence for an unrelated field", () => {
    let collection: FieldEvidence[] = [];
    collection = addFieldEvidence(collection, {
      path: companyFieldPath("website"),
      value: "https://acme.example",
      confidence: 0.6,
      source: testSource()
    });
    const beforeSicEvidence = evidenceForField(collection, companyFieldPath("sicCode"));
    expect(beforeSicEvidence).toEqual([]);

    collection = addFieldEvidence(collection, {
      path: companyFieldPath("sicCode"),
      value: "4213",
      confidence: 0.6,
      source: testSource()
    });

    expect(evidenceForField(collection, companyFieldPath("website")).length).toBe(1);
    expect(evidenceForField(collection, companyFieldPath("sicCode")).length).toBe(1);
  });
});

describe("provenance", () => {
  test("source URL is retained when present", () => {
    const evidence = createFieldEvidence({
      path: companyFieldPath("website"),
      value: "https://acme.example",
      confidence: 0.6,
      source: testSource({ sourceUrl: "https://dfwchamber.example/reports/1" })
    });
    expect(evidence.source.sourceUrl).toBe("https://dfwchamber.example/reports/1");
  });

  test("a non-URL source reference is retained for sources without a URL", () => {
    const evidence = createFieldEvidence({
      path: companyFieldPath("legalName"),
      value: "Acme Logistics",
      confidence: 0.95,
      source: {
        sourceType: "human_research_decision",
        sourceId: "manual-review",
        sourceName: "Manual research decision",
        sourceObservationId: "review-2026-07-01-jsmith"
      }
    });
    expect(evidence.source.sourceUrl).toBeUndefined();
    expect(evidence.source.sourceObservationId).toBe("review-2026-07-01-jsmith");
  });

  test("raw and normalized values remain both auditable when they differ", () => {
    const evidence = createFieldEvidence({
      path: locationFieldPath("siteType"),
      value: "headquarters",
      normalizedValue: "headquarters",
      rawValue: " h ",
      confidence: 0.6,
      source: testSource()
    });
    expect(evidence.rawValue).toBe(" h ");
    expect(evidence.normalizedValue).toBe("headquarters");
  });

  test("optional evidence text round-trips", () => {
    const evidence = createFieldEvidence({
      path: companyFieldPath("startYear"),
      value: 2015,
      confidence: 0.7,
      source: testSource(),
      evidenceText: "\"Founded in 2015\" -- company About page"
    });
    expect(evidence.evidenceText).toBe("\"Founded in 2015\" -- company About page");
  });

  test("inherited evidence preserves why it was proposed and whether it's independently confirmed", () => {
    const evidence = createFieldEvidence({
      path: companyFieldPath("sicCode"),
      value: "4213",
      confidence: 0.5,
      source: testSource({ sourceType: "existing_bwi_record" }),
      derivation: "inherited",
      inheritance: {
        fromExistingCompanyId: "bw-001",
        reason: "Same company identity matched an existing BWI record with this SIC code on file.",
        independentlyConfirmed: false
      }
    });
    expect(evidence.derivation).toBe("inherited");
    expect(evidence.inheritance?.independentlyConfirmed).toBe(false);
    expect(evidence.inheritance?.fromExistingCompanyId).toBe("bw-001");
  });
});

describe("determinism", () => {
  test("capturedAt is never set implicitly -- omitted evidence stays capturedAt: undefined", () => {
    const evidence = createFieldEvidence({
      path: companyFieldPath("website"),
      value: "https://acme.example",
      confidence: 0.6,
      source: testSource()
    });
    expect(evidence.capturedAt).toBeUndefined();
  });

  test("a fixed capturedAt round-trips unchanged", () => {
    const evidence = createFieldEvidence({
      path: companyFieldPath("website"),
      value: "https://acme.example",
      confidence: 0.6,
      source: testSource(),
      capturedAt: FIXED_CAPTURED_AT
    });
    expect(evidence.capturedAt).toBe(FIXED_CAPTURED_AT);
  });

  test("fieldPathKey is stable and order-independent for the same logical field", () => {
    const a = fieldPathKey(contactFieldPath("contact-1", "email"));
    const b = fieldPathKey(contactFieldPath("contact-1", "email"));
    expect(a).toBe(b);
  });
});
