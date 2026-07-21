import { describe, expect, test } from "bun:test";
import { evaluatePublicationReadiness } from "./publication-readiness.ts";
import { researchCompleteness, reviewPriority } from "./scoring.ts";
import type { CandidateCompany, MatchResult } from "./types.ts";

function baseCandidate(overrides: Partial<CandidateCompany> = {}): CandidateCompany {
  return {
    id: "cand-test",
    source: "Test Source",
    sourceId: "test-source",
    capturedAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    fingerprint: "test-source:cand-test",
    companyName: "Test Company",
    contacts: [],
    evidence: [],
    ...overrides
  };
}

describe("researchCompleteness", () => {
  test("is a description of known data, not an approval signal", () => {
    const sparse = baseCandidate();
    const result = researchCompleteness(sparse);
    expect(result.score).toBeLessThan(1);
    expect(result.presentFields).toContain("companyName");
    expect(result.missingFields).toContain("contacts");

    // a candidate can have a low research score while still being
    // "not publication ready" for entirely separate (rule-based) reasons
    const readiness = evaluatePublicationReadiness(sparse);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).not.toEqual([]);
  });

  test("missing optional research fields lower completeness but are not publication blockers", () => {
    const candidate = baseCandidate({
      phone: undefined,
      website: undefined,
      proposedSic: undefined,
      description: undefined,
      contacts: [{ name: "Jamie Rivera", email: "jamie@example.com" }]
    });

    const completeness = researchCompleteness(candidate);
    expect(completeness.missingFields).toEqual(expect.arrayContaining(["phone", "website", "proposedSic", "description"]));

    const readiness = evaluatePublicationReadiness(candidate);
    // the only confirmed_required rule (a contact) is satisfied, so missing
    // phone/website/SIC do not block readiness today
    expect(readiness.ready).toBe(true);
    expect(readiness.blockingReasons).toEqual([]);
    // but they should still show up as unresolved/known gaps for transparency
    expect(readiness.unresolvedRequirements.length).toBeGreaterThan(0);
  });
});

describe("reviewPriority", () => {
  const match: MatchResult = { score: 0.1, classification: "likely_new", reasons: [] };

  test("stays independent from publication readiness", () => {
    const withContact = baseCandidate({ employeeCountEstimate: 25, contacts: [{ name: "Jamie Rivera" }] });
    const withoutContact = baseCandidate({ employeeCountEstimate: 25, contacts: [] });

    const completenessWith = researchCompleteness(withContact);
    const completenessWithout = researchCompleteness(withoutContact);

    const priorityWith = reviewPriority(withContact, match, completenessWith.score);
    const priorityWithout = reviewPriority(withoutContact, match, completenessWithout.score);

    // publication readiness differs (one is ready, one is not) but that must
    // not be why the priorities differ -- any difference here comes only
    // from research completeness, which reviewPriority already accounts for
    expect(evaluatePublicationReadiness(withContact).ready).toBe(true);
    expect(evaluatePublicationReadiness(withoutContact).ready).toBe(false);
    expect(priorityWith).not.toBe(priorityWithout);

    // proof of independence: two candidates with identical research
    // completeness but different publication readiness get identical priority
    const sameCompletenessDifferentReadiness = reviewPriority(withoutContact, match, completenessWith.score);
    expect(sameCompletenessDifferentReadiness).toBe(priorityWith);
  });

  test("favors the 10-99 employee single-site/HQ core segment", () => {
    const coreSegment = baseCandidate({ employeeCountEstimate: 42, siteType: "headquarters" });
    const outsideSegment = baseCandidate({ employeeCountEstimate: 500, siteType: "headquarters" });

    const corePriority = reviewPriority(coreSegment, match, researchCompleteness(coreSegment).score);
    const outsidePriority = reviewPriority(outsideSegment, match, researchCompleteness(outsideSegment).score);

    expect(corePriority).toBeGreaterThan(outsidePriority);
  });
});
