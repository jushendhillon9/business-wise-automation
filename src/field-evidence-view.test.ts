import { describe, expect, test } from "bun:test";
import { formatCandidateEvidenceReport, formatFieldEvidenceBlock, summarizeCandidateFieldEvidence, summarizeContactFieldEvidence } from "./field-evidence-view.ts";
import { companyFieldPath, contactFieldPath, createFieldEvidence, locationFieldPath } from "./types.ts";
import type { LocationCandidate } from "./types.ts";

function baseCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "loc-1",
    company: { id: "co-1", legalName: "Acme Evidence Co" },
    source: { sourceId: "test-source", sourceName: "Test Source", fingerprint: "test-source:loc-1", ingestedAt: "2026-07-01T00:00:00.000Z" },
    capturedAt: "2026-07-01T00:00:00.000Z",
    contacts: [],
    evidence: [],
    ...overrides
  };
}

describe("summarizeCandidateFieldEvidence", () => {
  test("a field with a value but no evidence is flagged as missingEvidence, never as confirmed", () => {
    const candidate = baseCandidate({ company: { id: "co-1", legalName: "Acme Evidence Co", website: "https://acme.example" } });

    const summaries = summarizeCandidateFieldEvidence(candidate);
    const website = summaries.find((s) => s.fieldKey === "company.website");

    expect(website?.hasValue).toBe(true);
    expect(website?.evidenceCount).toBe(0);
    expect(website?.missingEvidence).toBe(true);
  });

  test("a field with no value and no evidence is not flagged as missing (nothing to be missing)", () => {
    const candidate = baseCandidate();
    const summaries = summarizeCandidateFieldEvidence(candidate);
    const sic = summaries.find((s) => s.fieldKey === "company.sicCode");

    expect(sic?.hasValue).toBe(false);
    expect(sic?.missingEvidence).toBe(false);
  });

  test("conflicting evidence for one field is detected", () => {
    const candidate = baseCandidate({
      phone: "214-555-0100",
      fieldEvidence: [
        createFieldEvidence({
          path: locationFieldPath("phone"),
          value: "214-555-0100",
          confidence: 0.6,
          source: { sourceType: "county_business_license", sourceId: "dfw-csv", sourceName: "DFW CSV" }
        }),
        createFieldEvidence({
          path: locationFieldPath("phone"),
          value: "214-555-0199",
          confidence: 0.6,
          source: { sourceType: "company_website", sourceId: "manual", sourceName: "Manual", sourceUrl: "https://acme.example/contact" }
        })
      ]
    });

    const summaries = summarizeCandidateFieldEvidence(candidate);
    const phone = summaries.find((s) => s.fieldKey === "location.phone");
    expect(phone?.evidenceCount).toBe(2);
    expect(phone?.conflicting).toBe(true);
  });

  test("agreeing evidence for one field is not flagged as conflicting", () => {
    const candidate = baseCandidate({
      phone: "214-555-0100",
      fieldEvidence: [
        createFieldEvidence({
          path: locationFieldPath("phone"),
          value: "214-555-0100",
          confidence: 0.6,
          source: { sourceType: "county_business_license", sourceId: "dfw-csv", sourceName: "DFW CSV" }
        }),
        createFieldEvidence({
          path: locationFieldPath("phone"),
          value: "214-555-0100",
          confidence: 0.9,
          source: { sourceType: "company_website", sourceId: "manual", sourceName: "Manual", sourceUrl: "https://acme.example/contact" }
        })
      ]
    });

    const phone = summarizeCandidateFieldEvidence(candidate).find((s) => s.fieldKey === "location.phone");
    expect(phone?.evidenceCount).toBe(2);
    expect(phone?.conflicting).toBe(false);
  });
});

describe("summarizeContactFieldEvidence", () => {
  test("contact evidence stays linked to the correct contact id, not array position", () => {
    const candidate = baseCandidate({
      contacts: [
        { id: "contact-a", name: "Alice", email: "alice@example.com" },
        { id: "contact-b", name: "Bob", email: "bob@example.com" }
      ],
      fieldEvidence: [
        createFieldEvidence({
          path: contactFieldPath("contact-b", "email"),
          value: "bob@example.com",
          confidence: 0.6,
          source: { sourceType: "chamber_of_commerce", sourceId: "dfw-json", sourceName: "DFW JSON" }
        })
      ]
    });

    const [aliceSummary, bobSummary] = summarizeContactFieldEvidence(candidate);
    const aliceEmail = aliceSummary?.fields.find((f) => f.fieldKey.endsWith(".email"));
    const bobEmail = bobSummary?.fields.find((f) => f.fieldKey.endsWith(".email"));

    expect(aliceEmail?.evidenceCount).toBe(0);
    expect(bobEmail?.evidenceCount).toBe(1);
  });

  test("a contact without a stable id is summarized without throwing", () => {
    const candidate = baseCandidate({ contacts: [{ name: "No Id Contact" }] });
    expect(() => summarizeContactFieldEvidence(candidate)).not.toThrow();
    expect(summarizeContactFieldEvidence(candidate)[0]?.contactId).toBeUndefined();
  });
});

describe("terminal formatting", () => {
  test("formatCandidateEvidenceReport never throws, even for a candidate with no fieldEvidence at all", () => {
    const candidate = baseCandidate({ company: { id: "co-1", legalName: "Legacy Co", website: "https://legacy.example" } });
    expect(() => formatCandidateEvidenceReport(candidate)).not.toThrow();
    const lines = formatCandidateEvidenceReport(candidate);
    expect(lines.some((line) => line.includes("NO EVIDENCE"))).toBe(true);
  });

  test("formatFieldEvidenceBlock produces readable text, not raw JSON, and never throws across multiple candidates", () => {
    const candidates = [
      baseCandidate({ id: "loc-a" }),
      baseCandidate({
        id: "loc-b",
        company: { id: "co-b", legalName: "Evidenced Co", website: "https://evidenced.example" },
        fieldEvidence: [
          createFieldEvidence({
            path: companyFieldPath("website"),
            value: "https://evidenced.example",
            confidence: 0.6,
            source: { sourceType: "chamber_of_commerce", sourceId: "dfw-json", sourceName: "DFW JSON" }
          })
        ]
      })
    ];

    expect(() => formatFieldEvidenceBlock(candidates)).not.toThrow();
    const lines = formatFieldEvidenceBlock(candidates);
    expect(lines.join("\n")).not.toMatch(/^\s*\{/m);
    expect(lines.some((line) => line.includes("Evidenced Co"))).toBe(true);
    expect(lines.some((line) => line.includes("confidence=0.60"))).toBe(true);
  });
});
