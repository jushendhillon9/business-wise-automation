import { describe, expect, test } from "bun:test";
import { companyFieldPath, createFieldEvidence, locationFieldPath, type FieldEvidence, type FieldEvidenceSource, type LocationCandidate } from "../types.ts";
import { mergeFieldProposal } from "./merge-results.ts";

function testSource(overrides: Partial<FieldEvidenceSource> = {}): FieldEvidenceSource {
  return { sourceType: "other", sourceId: "test-provider", sourceName: "Test Provider", ...overrides };
}

function baseCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "loc-1",
    company: { id: "co-1", legalName: "Acme Logistics" },
    source: { sourceId: "test-source", sourceName: "Test Source", fingerprint: "test-source:loc-1", ingestedAt: "2026-07-01T00:00:00.000Z" },
    capturedAt: "2026-07-01T00:00:00.000Z",
    contacts: [],
    evidence: [],
    ...overrides
  };
}

function proposal(overrides: Partial<FieldEvidence> = {}): FieldEvidence {
  return createFieldEvidence({
    path: companyFieldPath("startYear"),
    value: 2015,
    confidence: 0.75,
    source: testSource(),
    derivation: "directly_observed",
    ...overrides
  });
}

describe("mergeFieldProposal", () => {
  test("fills an empty field and records evidence", () => {
    const candidate = baseCandidate();
    const result = mergeFieldProposal(candidate, proposal());

    expect(result.candidate.company.startYear).toBe(2015);
    expect(result.filledFieldCount).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.candidate.fieldEvidence?.length).toBe(1);
  });

  test("a different proposed value produces a conflict instead of overwriting a populated field", () => {
    const candidate = baseCandidate({ company: { id: "co-1", legalName: "Acme Logistics", startYear: 2010 } });
    const result = mergeFieldProposal(candidate, proposal({ value: 2015, normalizedValue: 2015 }));

    expect(result.candidate.company.startYear).toBe(2010);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]?.existingValue).toBe(2010);
    expect(result.filledFieldCount).toBe(0);
  });

  test("an identical value from a new source adds supporting evidence without duplicating a fill", () => {
    const candidate = baseCandidate({ company: { id: "co-1", legalName: "Acme Logistics", startYear: 2015 } });
    const result = mergeFieldProposal(candidate, proposal({ value: 2015, normalizedValue: 2015, source: testSource({ sourceId: "another-provider" }) }));

    expect(result.candidate.company.startYear).toBe(2015);
    expect(result.conflicts).toEqual([]);
    expect(result.filledFieldCount).toBe(0);
    expect(result.candidate.fieldEvidence?.length).toBe(1);
  });

  test("rerunning the same provider with the same value does not duplicate evidence", () => {
    const first = mergeFieldProposal(baseCandidate(), proposal());
    const second = mergeFieldProposal(first.candidate, proposal());

    expect(second.candidate.fieldEvidence?.length).toBe(1);
    expect(second.filledFieldCount).toBe(0);
    expect(second.conflicts).toEqual([]);
  });

  test("a human-confirmed value is never overwritten by a disagreeing proposal", () => {
    const humanEvidence = createFieldEvidence({
      path: locationFieldPath("phone"),
      value: "214-555-0100",
      confidence: 1,
      source: { sourceType: "human_research_decision", sourceId: "manual-review", sourceName: "Manual review" },
      derivation: "human_confirmed"
    });
    const candidate = baseCandidate({ phone: "214-555-0100", fieldEvidence: [humanEvidence] });

    const result = mergeFieldProposal(
      candidate,
      createFieldEvidence({ path: locationFieldPath("phone"), value: "214-555-9999", confidence: 0.6, source: testSource() })
    );

    expect(result.candidate.phone).toBe("214-555-0100");
    expect(result.conflicts.length).toBe(1);
    expect(result.filledFieldCount).toBe(0);
  });

  test("a human-confirmed value accepts corroborating evidence without treating it as a conflict", () => {
    const humanEvidence = createFieldEvidence({
      path: locationFieldPath("phone"),
      value: "214-555-0100",
      confidence: 1,
      source: { sourceType: "human_research_decision", sourceId: "manual-review", sourceName: "Manual review" },
      derivation: "human_confirmed"
    });
    const candidate = baseCandidate({ phone: "214-555-0100", fieldEvidence: [humanEvidence] });

    const result = mergeFieldProposal(
      candidate,
      createFieldEvidence({ path: locationFieldPath("phone"), value: "214-555-0100", confidence: 0.6, source: testSource() })
    );

    expect(result.candidate.phone).toBe("214-555-0100");
    expect(result.conflicts).toEqual([]);
  });
});
