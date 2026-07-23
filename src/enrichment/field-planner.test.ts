import { describe, expect, test } from "bun:test";
import { evaluatePublicationReadiness } from "../publication-readiness.ts";
import type { LocationCandidate } from "../types.ts";
import { planEnrichmentFields } from "./field-planner.ts";
import { createTestEnrichmentProvider } from "./test-provider.ts";
import type { EnrichmentContext } from "./types.ts";

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

function contextFor(candidate: LocationCandidate, allowedFields?: EnrichmentContext["policy"]["allowedFields"]): EnrichmentContext {
  const readiness = evaluatePublicationReadiness(candidate);
  return {
    candidate,
    company: candidate.company,
    sourceProvenance: candidate.source,
    readiness,
    permittedFields: allowedFields ?? [],
    policy: { allowedFields },
    targetContactId: candidate.contacts.find((c) => c.id)?.id
  };
}

describe("planEnrichmentFields", () => {
  test("plans a blocked field as mandatory when a provider supports it", () => {
    const candidate = baseCandidate();
    const context = contextFor(candidate);
    const provider = createTestEnrichmentProvider({ id: "p1", supportedFields: ["company.startYear"], behaviors: {} });

    const plan = planEnrichmentFields(context, [provider]);
    const startYearPlan = plan.find((p) => p.field === "company.startYear");

    expect(startYearPlan).toBeDefined();
    expect(startYearPlan?.mandatory).toBe(true);
    expect(startYearPlan?.reason).toBe("blocked_field");
  });

  test("does not plan a field that already has a value", () => {
    const candidate = baseCandidate({ company: { id: "co-1", legalName: "Acme Logistics", startYear: 2010 } });
    const context = contextFor(candidate);
    const provider = createTestEnrichmentProvider({ id: "p1", supportedFields: ["company.startYear"], behaviors: {} });

    const plan = planEnrichmentFields(context, [provider]);
    expect(plan.find((p) => p.field === "company.startYear")).toBeUndefined();
  });

  test("does not plan a field no available provider supports", () => {
    const candidate = baseCandidate();
    const context = contextFor(candidate);
    const provider = createTestEnrichmentProvider({ id: "p1", supportedFields: ["location.phone"], behaviors: {} });

    const plan = planEnrichmentFields(context, [provider]);
    expect(plan.find((p) => p.field === "company.sicCode")).toBeUndefined();
  });

  test("execution policy allowedFields restricts the plan even when a provider supports more", () => {
    const candidate = baseCandidate();
    const context = contextFor(candidate, ["company.startYear"]);
    const provider = createTestEnrichmentProvider({
      id: "p1",
      supportedFields: ["company.startYear", "company.sicCode"],
      behaviors: {}
    });

    const plan = planEnrichmentFields(context, [provider]);
    expect(plan.map((p) => p.field)).toEqual(["company.startYear"]);
  });

  test("optional (non-blocking) empty fields are planned but never marked mandatory", () => {
    const candidate = baseCandidate({ company: { id: "co-1", legalName: "Acme Logistics" } });
    const context = contextFor(candidate);
    const provider = createTestEnrichmentProvider({ id: "p1", supportedFields: ["company.website"], behaviors: {} });

    const plan = planEnrichmentFields(context, [provider]);
    const websitePlan = plan.find((p) => p.field === "company.website");
    expect(websitePlan).toBeDefined();
    expect(websitePlan?.mandatory).toBe(false);
    expect(websitePlan?.reason).toBe("optional_gap");
  });

  test("contact fields are never planned without an existing contact to attach evidence to", () => {
    const candidate = baseCandidate();
    const context = contextFor(candidate);
    const provider = createTestEnrichmentProvider({ id: "p1", supportedFields: ["contact.name", "contact.email"], behaviors: {} });

    const plan = planEnrichmentFields(context, [provider]);
    expect(plan.find((p) => p.field === "contact.name")).toBeUndefined();
    expect(plan.find((p) => p.field === "contact.email")).toBeUndefined();
  });
});
