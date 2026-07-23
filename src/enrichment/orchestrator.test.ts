import { describe, expect, test } from "bun:test";
import { createFieldEvidence, locationFieldPath, type LocationCandidate } from "../types.ts";
import { runEnrichment } from "./orchestrator.ts";
import { createTestEnrichmentProvider } from "./test-provider.ts";

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

describe("runEnrichment", () => {
  test("a provider can fill a missing field with FieldEvidence, and readiness is recalculated afterward", async () => {
    const candidate = baseCandidate();
    const provider = createTestEnrichmentProvider({
      id: "start-year-provider",
      supportedFields: ["company.startYear"],
      behaviors: { "company.startYear": { kind: "success", value: 2012, confidence: 0.8 } }
    });

    const before = candidate;
    const result = await runEnrichment({ candidate: before, providers: [provider] });

    expect(result.candidate.company.startYear).toBe(2012);
    expect(result.candidate.fieldEvidence?.some((e) => e.path.scope === "company" && e.path.field === "startYear")).toBe(true);

    expect(result.initialReadiness.blockers.some((b) => b.ruleId === "start_year_present")).toBe(true);
    expect(result.finalReadiness.blockers.some((b) => b.ruleId === "start_year_present")).toBe(false);
  });

  test("a provider proposing sicCode fills the field and clears that specific blocker", async () => {
    const candidate = baseCandidate();
    const provider = createTestEnrichmentProvider({
      id: "sic-provider",
      supportedFields: ["company.sicCode"],
      behaviors: { "company.sicCode": { kind: "success", value: "4213" } }
    });

    const result = await runEnrichment({ candidate, providers: [provider] });

    expect(result.candidate.company.sicCode).toBe("4213");
    expect(result.finalReadiness.blockers.some((b) => b.ruleId === "sic_code_present")).toBe(false);
  });

  test("one failed provider does not abort other providers, and not_found is distinct from failed", async () => {
    const candidate = baseCandidate();
    const throwingProvider = createTestEnrichmentProvider({
      id: "broken-provider",
      supportedFields: ["company.startYear"],
      behaviors: { "company.startYear": { kind: "throw", message: "simulated network failure" } }
    });
    const notFoundProvider = createTestEnrichmentProvider({
      id: "sic-provider",
      supportedFields: ["company.sicCode"],
      behaviors: { "company.sicCode": { kind: "not_found", reason: "no SIC record found" } }
    });
    const workingProvider = createTestEnrichmentProvider({
      id: "website-provider",
      supportedFields: ["company.website"],
      behaviors: { "company.website": { kind: "success", value: "https://acme.example" } }
    });

    const result = await runEnrichment({ candidate, providers: [throwingProvider, notFoundProvider, workingProvider] });

    const failedResult = result.providerResults.find((r) => r.providerId === "broken-provider");
    expect(failedResult?.status).toBe("failed");
    if (failedResult?.status === "failed") {
      expect(failedResult.message).toContain("simulated network failure");
      expect(failedResult.errorCategory).toBeDefined();
    }

    const notFoundResult = result.providerResults.find((r) => r.providerId === "sic-provider");
    expect(notFoundResult?.status).toBe("completed");
    if (notFoundResult?.status === "completed") {
      expect(notFoundResult.outcomes[0]?.status).toBe("not_found");
    }

    // The working provider's result is still present and applied, proving the thrown error didn't abort the run.
    expect(result.candidate.company.website).toBe("https://acme.example");
  });

  test("conflicting values are preserved for review, never silently overwritten", async () => {
    // Phone itself is unset (so the planner still schedules it as a blocker),
    // but a prior observation already recorded a different value as
    // evidence -- the new proposal must not silently win.
    const priorEvidence = createFieldEvidence({
      path: locationFieldPath("phone"),
      value: "214-555-0100",
      confidence: 0.6,
      source: { sourceType: "chamber_of_commerce", sourceId: "dfw-json", sourceName: "DFW feed" },
      derivation: "directly_observed"
    });
    const candidate = baseCandidate({ fieldEvidence: [priorEvidence] });
    const provider = createTestEnrichmentProvider({
      id: "phone-provider",
      supportedFields: ["location.phone"],
      behaviors: { "location.phone": { kind: "success", value: "214-555-9999" } }
    });

    const result = await runEnrichment({ candidate, providers: [provider] });

    expect(result.candidate.phone).toBeUndefined();
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]?.path.field).toBe("phone");
  });

  test("a provider-reported internal conflict (disagreeing values) is preserved as a conflict, not applied", async () => {
    const candidate = baseCandidate();
    const provider = createTestEnrichmentProvider({
      id: "county-provider",
      supportedFields: ["location.county"],
      behaviors: { "location.county": { kind: "conflict", values: ["Dallas", "Tarrant"] } }
    });

    const result = await runEnrichment({ candidate, providers: [provider] });

    expect(result.candidate.county).toBeUndefined();
    expect(result.conflicts.length).toBe(2);
  });

  test("identical values from two providers add/preserve evidence safely without conflicting", async () => {
    const candidate = baseCandidate();
    const providerA = createTestEnrichmentProvider({
      id: "provider-a",
      supportedFields: ["company.startYear"],
      behaviors: { "company.startYear": { kind: "success", value: 2012 } }
    });
    const providerB = createTestEnrichmentProvider({
      id: "provider-b",
      supportedFields: ["company.startYear"],
      behaviors: { "company.startYear": { kind: "success", value: 2012 } }
    });

    const result = await runEnrichment({ candidate, providers: [providerA, providerB] });

    expect(result.candidate.company.startYear).toBe(2012);
    expect(result.conflicts).toEqual([]);
    expect(result.candidate.fieldEvidence?.length).toBe(2);
  });

  test("rerunning the same provider on an already-enriched candidate does not duplicate equivalent evidence", async () => {
    const candidate = baseCandidate();
    const provider = createTestEnrichmentProvider({
      id: "start-year-provider",
      supportedFields: ["company.startYear"],
      behaviors: { "company.startYear": { kind: "success", value: 2012 } }
    });

    const firstRun = await runEnrichment({ candidate, providers: [provider] });
    const secondRun = await runEnrichment({ candidate: firstRun.candidate, providers: [provider] });

    expect(secondRun.candidate.fieldEvidence?.length).toBe(1);
    expect(secondRun.conflicts).toEqual([]);
  });

  test("an already human-confirmed value is protected from an automatic overwrite", async () => {
    // The field itself is unset (a candidate carrying only a confirmed
    // evidence record, no populated value yet) so the planner still
    // schedules it as a blocker -- the human_confirmed evidence must still
    // win over a disagreeing provider proposal.
    const humanEvidence = createFieldEvidence({
      path: locationFieldPath("phone"),
      value: "214-555-0100",
      confidence: 1,
      source: { sourceType: "human_research_decision", sourceId: "manual-review", sourceName: "Manual review" },
      derivation: "human_confirmed"
    });
    const candidate = baseCandidate({ fieldEvidence: [humanEvidence] });
    const provider = createTestEnrichmentProvider({
      id: "phone-provider",
      supportedFields: ["location.phone"],
      behaviors: { "location.phone": { kind: "success", value: "999-999-9999" } }
    });

    const result = await runEnrichment({ candidate, providers: [provider] });

    expect(result.candidate.phone).toBeUndefined();
    expect(result.conflicts.length).toBe(1);
  });

  test("provider selection respects supportedFields -- a provider never runs for a field it doesn't declare", async () => {
    const candidate = baseCandidate();
    const phoneOnlyProvider = createTestEnrichmentProvider({
      id: "phone-only",
      supportedFields: ["location.phone"],
      behaviors: { "company.sicCode": { kind: "success", value: "4213" } }
    });

    const result = await runEnrichment({ candidate, providers: [phoneOnlyProvider] });

    // sicCode behavior was configured but the provider never declared the field as supported,
    // so the orchestrator never requests it and the candidate is untouched.
    expect(result.candidate.company.sicCode).toBeUndefined();
    const providerResult = result.providerResults.find((r) => r.providerId === "phone-only");
    expect(providerResult?.status).toBe("completed");
    if (providerResult?.status === "completed") {
      expect(providerResult.outcomes.some((o) => o.field === "company.sicCode")).toBe(false);
    }
  });

  test("canRun gates whether a provider executes at all", async () => {
    const candidate = baseCandidate();
    const gatedProvider = createTestEnrichmentProvider({
      id: "gated",
      supportedFields: ["company.startYear"],
      behaviors: { "company.startYear": { kind: "success", value: 2012 } },
      canRun: () => false
    });

    const result = await runEnrichment({ candidate, providers: [gatedProvider] });

    expect(result.providerResults).toEqual([]);
    expect(result.candidate.company.startYear).toBeUndefined();
  });
});
