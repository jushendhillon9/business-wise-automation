import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import * as dbModule from "./db.ts";
import {
  createSchema,
  insertCompanyIdentity,
  insertLocationCandidate,
  insertReviewDecision,
  loadLatestReviewDecisionForCandidate,
  loadReviewDecisionsForCandidate,
  loadReviewQueueRowByCandidateId,
  openDb,
  updateReviewQueueStatus,
  upsertReviewQueue
} from "./db.ts";
import type { PublicationReadinessAssessment } from "./publication-readiness.ts";
import {
  recordReviewDecision,
  ReviewLedgerInvariantError,
  statusForAction,
  validateSelectedBwiRecordId,
  type ReviewDecisionAction,
  type ReviewQueueStatus
} from "./review-decisions.ts";
import type { CompanyIdentity, EntityResolutionDecision, LocationCandidate, MatchResult } from "./types.ts";

const TEST_DB_PATH = "data/review-decisions.test.sqlite";

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    // no previous test db, that's fine
  }
  db = openDb(TEST_DB_PATH);
  createSchema(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    // ignore
  }
});

function seedCandidate(id: string): LocationCandidate {
  const company: CompanyIdentity = { id: `co-${id}`, legalName: `Test Co ${id}` };
  insertCompanyIdentity(db, company);

  const candidate: LocationCandidate = {
    id,
    company,
    source: { sourceId: "test-source", sourceName: "Test Source", fingerprint: `test-source:${id}`, ingestedAt: "2026-07-01T00:00:00.000Z" },
    capturedAt: "2026-07-01T00:00:00.000Z",
    contacts: [],
    evidence: []
  };
  insertLocationCandidate(db, candidate);
  return candidate;
}

function seedReviewQueueRow(candidate: LocationCandidate, matchedExistingCompanyId?: string): void {
  const match: MatchResult = {
    companySimilarity: { nameScore: 0, domainMatch: false, sicMatch: false },
    locationSimilarity: { addressScore: 0, phoneMatch: false, cityStateMatch: false },
    score: 0.1,
    classification: "likely_new",
    reasons: ["no_existing_locations_to_compare"]
  };
  const resolution: EntityResolutionDecision = {
    outcome: "likely_new_company",
    alternativeMatches: [],
    matchedExistingCompanyId,
    reasons: ["no_existing_locations_to_compare"],
    conflicts: [],
    requiresHumanReview: false
  };
  const completeness = { score: 0.4, presentFields: ["company.legalName"], missingFields: [] };
  const readiness: PublicationReadinessAssessment = {
    state: "blocked",
    blockers: [{ ruleId: "sic_code_present", scope: "company", field: "company.sicCode", explanation: "SIC missing", exceptionApplicable: false }],
    unresolvedRules: [],
    satisfiedRequirements: [],
    optionalMissingFields: []
  };
  upsertReviewQueue(db, candidate.id, match, resolution, completeness, readiness, 0.5);
}

describe("statusForAction", () => {
  test("maps every action to the expected, exhaustive status", () => {
    const expected: Record<ReviewDecisionAction, ReviewQueueStatus> = {
      approve_new_company: "approved",
      approve_new_branch: "approved",
      link_existing_location: "approved",
      mark_duplicate: "duplicate",
      needs_more_research: "needs_more_research",
      reject_source_observation: "rejected"
    };

    for (const [action, status] of Object.entries(expected)) {
      expect(statusForAction(action as ReviewDecisionAction)).toBe(status);
    }
  });
});

describe("validateSelectedBwiRecordId", () => {
  test("approve_new_company forbids a selected id", () => {
    expect(() => validateSelectedBwiRecordId("approve_new_company", "bw-1")).toThrow();
    expect(() => validateSelectedBwiRecordId("approve_new_company", undefined)).not.toThrow();
  });

  test("approve_new_branch, link_existing_location, and mark_duplicate all require a selected id", () => {
    for (const action of ["approve_new_branch", "link_existing_location", "mark_duplicate"] as const) {
      expect(() => validateSelectedBwiRecordId(action, undefined)).toThrow();
      expect(() => validateSelectedBwiRecordId(action, "bw-1")).not.toThrow();
    }
  });

  test("needs_more_research and reject_source_observation leave the selected id optional", () => {
    for (const action of ["needs_more_research", "reject_source_observation"] as const) {
      expect(() => validateSelectedBwiRecordId(action, undefined)).not.toThrow();
      expect(() => validateSelectedBwiRecordId(action, "bw-1")).not.toThrow();
    }
  });
});

describe("recordReviewDecision", () => {
  test("throws when no review_queue row exists yet for the candidate", () => {
    expect(() =>
      recordReviewDecision(db, { locationCandidateId: "does-not-exist", reviewer: "jane", action: "needs_more_research" })
    ).toThrow();
  });

  test("records the first decision against a pending candidate and updates only review_status/reviewer_note", () => {
    const candidate = seedCandidate("loc-1");
    seedReviewQueueRow(candidate);

    const decision = recordReviewDecision(db, {
      locationCandidateId: candidate.id,
      reviewer: "jane",
      action: "needs_more_research",
      notes: "waiting on SIC"
    });

    expect(decision.sequence).toBe(1);
    expect(decision.previousStatus).toBe("pending");
    expect(decision.newStatus).toBe("needs_more_research");
    expect(decision.notes).toBe("waiting on SIC");

    const queueRow = loadReviewQueueRowByCandidateId(db, candidate.id);
    expect(queueRow?.reviewStatus).toBe("needs_more_research");
    // Match/completeness/readiness/priority columns are untouched by a decision.
    expect(queueRow?.matchScore).toBe(0.1);
    expect(queueRow?.completenessScore).toBe(0.4);
  });

  test("multiple decisions remain queryable in sequence order, and previous/new status chain correctly", () => {
    const candidate = seedCandidate("loc-2");
    seedReviewQueueRow(candidate);

    const first = recordReviewDecision(db, { locationCandidateId: candidate.id, reviewer: "jane", action: "needs_more_research" });
    const second = recordReviewDecision(db, { locationCandidateId: candidate.id, reviewer: "sam", action: "approve_new_company" });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousStatus).toBe(first.newStatus);
    expect(second.newStatus).toBe("approved");

    const history = loadReviewDecisionsForCandidate(db, candidate.id);
    expect(history.map((d) => d.sequence)).toEqual([1, 2]);
    expect(history.map((d) => d.reviewer)).toEqual(["jane", "sam"]);

    const latest = loadLatestReviewDecisionForCandidate(db, candidate.id);
    expect(latest?.sequence).toBe(2);

    // The latest decision's status wins as the queue's convenience cache.
    expect(loadReviewQueueRowByCandidateId(db, candidate.id)?.reviewStatus).toBe("approved");
  });

  test("action-specific selected-BWI-ID validation runs before any write -- a rejected call leaves no trace", () => {
    const candidate = seedCandidate("loc-3");
    seedReviewQueueRow(candidate);

    expect(() =>
      recordReviewDecision(db, { locationCandidateId: candidate.id, reviewer: "jane", action: "approve_new_branch" })
    ).toThrow();

    expect(loadReviewDecisionsForCandidate(db, candidate.id)).toEqual([]);
    expect(loadReviewQueueRowByCandidateId(db, candidate.id)?.reviewStatus).toBe("pending");

    const decision = recordReviewDecision(db, {
      locationCandidateId: candidate.id,
      reviewer: "jane",
      action: "approve_new_branch",
      selectedBwiRecordId: "bw-9"
    });
    expect(decision.selectedBwiRecordId).toBe("bw-9");
  });

  test("approve_new_company rejects a selected id even when one is supplied", () => {
    const candidate = seedCandidate("loc-4");
    seedReviewQueueRow(candidate);

    expect(() =>
      recordReviewDecision(db, {
        locationCandidateId: candidate.id,
        reviewer: "jane",
        action: "approve_new_company",
        selectedBwiRecordId: "bw-1"
      })
    ).toThrow();
  });

  test("the machine-selected match and the reviewer's selected id are both preserved and distinguishable", () => {
    const candidate = seedCandidate("loc-5");
    seedReviewQueueRow(candidate, "bw-machine-pick");

    const decision = recordReviewDecision(db, {
      locationCandidateId: candidate.id,
      reviewer: "jane",
      action: "link_existing_location",
      selectedBwiRecordId: "bw-reviewer-pick"
    });

    expect(decision.machineRecommendation.machineSelectedExistingCompanyId).toBe("bw-machine-pick");
    expect(decision.selectedBwiRecordId).toBe("bw-reviewer-pick");
    expect(decision.selectedBwiRecordId).not.toBe(decision.machineRecommendation.machineSelectedExistingCompanyId);
  });

  test("the machine recommendation snapshot is frozen at decision time -- a later re-score never changes it", () => {
    const candidate = seedCandidate("loc-6");
    seedReviewQueueRow(candidate);

    const decision = recordReviewDecision(db, { locationCandidateId: candidate.id, reviewer: "jane", action: "needs_more_research" });
    expect(decision.machineRecommendation.completenessScore).toBe(0.4);
    expect(decision.machineRecommendation.matchScore).toBe(0.1);

    const rescoredMatch: MatchResult = {
      companySimilarity: { nameScore: 1, domainMatch: true, sicMatch: true },
      locationSimilarity: { addressScore: 1, phoneMatch: true, cityStateMatch: true },
      score: 0.99,
      classification: "likely_duplicate",
      reasons: []
    };
    const rescoredResolution: EntityResolutionDecision = {
      outcome: "same_existing_location",
      alternativeMatches: [],
      reasons: [],
      conflicts: [],
      requiresHumanReview: false
    };
    const rescoredReadiness: PublicationReadinessAssessment = {
      state: "confirmed_ready",
      blockers: [],
      unresolvedRules: [],
      satisfiedRequirements: [],
      optionalMissingFields: []
    };
    upsertReviewQueue(db, candidate.id, rescoredMatch, rescoredResolution, { score: 0.99, presentFields: [], missingFields: [] }, rescoredReadiness, 0.99);

    const stored = loadReviewDecisionsForCandidate(db, candidate.id)[0];
    expect(stored?.machineRecommendation.completenessScore).toBe(0.4);
    expect(stored?.machineRecommendation.matchScore).toBe(0.1);
  });

  test("field corrections are captured for audit only and round-trip unchanged", () => {
    const candidate = seedCandidate("loc-7");
    seedReviewQueueRow(candidate);

    const decision = recordReviewDecision(db, {
      locationCandidateId: candidate.id,
      reviewer: "jane",
      action: "needs_more_research",
      fieldCorrections: [
        { path: { scope: "company", field: "sicCode" }, previousValue: undefined, correctedValue: "4213", reason: "found on state filing" }
      ]
    });

    expect(decision.fieldCorrections.length).toBe(1);
    const stored = loadReviewDecisionsForCandidate(db, candidate.id)[0];
    expect(stored?.fieldCorrections).toEqual(decision.fieldCorrections);

    // Never applied to the underlying candidate in this commit.
    const [reloadedCandidate] = dbModule.loadLocationCandidates(db).filter((c) => c.id === candidate.id);
    expect(reloadedCandidate?.company.sicCode).toBeUndefined();
  });

  test("duplicate sequence prevention: the UNIQUE(location_candidate_id, sequence) constraint rejects a forged duplicate", () => {
    const candidate = seedCandidate("loc-8");
    seedReviewQueueRow(candidate);
    const first = recordReviewDecision(db, { locationCandidateId: candidate.id, reviewer: "jane", action: "needs_more_research" });

    expect(() =>
      insertReviewDecision(db, {
        id: crypto.randomUUID(),
        locationCandidateId: candidate.id,
        sequence: first.sequence,
        reviewer: "sam",
        action: "mark_duplicate",
        previousStatus: first.newStatus,
        newStatus: "duplicate",
        selectedBwiRecordId: "bw-1",
        notes: undefined,
        machineRecommendation: first.machineRecommendation,
        fieldCorrections: [],
        decidedAt: new Date().toISOString()
      })
    ).toThrow();

    // The forged row never landed -- history is unchanged.
    expect(loadReviewDecisionsForCandidate(db, candidate.id).length).toBe(1);
  });

  test("a ledger/queue invariant mismatch is detected and throws ReviewLedgerInvariantError", () => {
    const candidate = seedCandidate("loc-9");
    seedReviewQueueRow(candidate);
    recordReviewDecision(db, { locationCandidateId: candidate.id, reviewer: "jane", action: "needs_more_research" });

    // Simulate the queue's convenience column drifting from the ledger (e.g. manual tampering).
    updateReviewQueueStatus(db, candidate.id, "approved");

    expect(() =>
      recordReviewDecision(db, { locationCandidateId: candidate.id, reviewer: "sam", action: "approve_new_company" })
    ).toThrow(ReviewLedgerInvariantError);
  });

  test("there is no update/delete API for review_decisions rows", () => {
    expect((dbModule as Record<string, unknown>).updateReviewDecision).toBeUndefined();
    expect((dbModule as Record<string, unknown>).deleteReviewDecision).toBeUndefined();
  });
});
