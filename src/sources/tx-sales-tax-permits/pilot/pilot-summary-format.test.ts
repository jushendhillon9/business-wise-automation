import { describe, expect, test } from "bun:test";
import { summarizePilotRun, type PilotCandidateOutcome } from "./aggregate.ts";
import { printPilotSummary } from "./pilot-summary-format.ts";

const SECRET_SOURCE_ID = "Zzz-Should-Never-Print-Fabricated-Candidate-Id-Zzz";

function outcome(overrides: Partial<PilotCandidateOutcome> = {}): PilotCandidateOutcome {
  return {
    locationCandidateId: SECRET_SOURCE_ID,
    sourceRecordId: SECRET_SOURCE_ID,
    retrievalCount: 1,
    retrievalMs: 2,
    matchScore: 0.9,
    matchClassification: "likely_duplicate",
    resolutionOutcome: "same_existing_location",
    requiresHumanReview: false,
    lifecycleConflict: false,
    matchedExistingStatus: "DIRE",
    relationshipTypes: ["HQTR"],
    publicationState: "blocked",
    blockerRuleIds: ["sic_code_present"],
    optionalMissingFields: ["squareFootage"],
    ...overrides
  };
}

describe("printPilotSummary", () => {
  test("prints only aggregate/operational information -- never a candidate/source id", () => {
    const summary = summarizePilotRun([outcome()], {
      sourceObservationsRead: 1,
      validCandidatesCreated: 1,
      invalidObservations: 0,
      duplicateObservations: 0,
      candidatesPersisted: 1,
      alreadyIngestedSkipped: 0
    });

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      printPilotSummary(summary);
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");
    expect(output).not.toContain(SECRET_SOURCE_ID);
    expect(output).toContain("Source observations read: 1");
    expect(output).toContain("same_existing_location");
    expect(output).toContain("DIRE");
  });
});
