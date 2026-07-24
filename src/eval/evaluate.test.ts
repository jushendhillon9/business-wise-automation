import { describe, expect, test } from "bun:test";
import { resolveCandidateAgainstExisting } from "../entity-resolution-policy.ts";
import { rankCandidateMatches } from "../entity-resolution.ts";
import type { ExistingCompany, LocationCandidate } from "../types.ts";
import { bandForConfidence, evaluateEntityResolution } from "./evaluate.ts";
import { loadEntityResolutionCases } from "./load-cases.ts";
import type { LabeledEntityResolutionCase, LoadedDataset } from "./types.ts";

function candidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    id: "loc-x",
    company: { id: "co-x", legalName: "Acme Robotics" },
    contacts: [],
    evidence: [],
    source: { sourceId: "s", sourceName: "s", fingerprint: "f", ingestedAt: "2026-01-01T00:00:00.000Z" },
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function labeledCase(overrides: Partial<LabeledEntityResolutionCase> = {}): LabeledEntityResolutionCase {
  return {
    caseId: "case-x",
    candidate: candidate(),
    existingCompanies: [],
    expected: { outcome: "likely_new_company" },
    provenance: { source: "synthetic" },
    ...overrides
  };
}

function dataset(cases: LabeledEntityResolutionCase[], overrides: Partial<LoadedDataset> = {}): LoadedDataset {
  return { datasetId: "test-dataset", schemaVersion: "1.0", sourcePath: "in-memory", cases, ...overrides };
}

const acmeRobotics: ExistingCompany = {
  id: "bw-100",
  companyName: "Acme Robotics Inc.",
  address: "100 Main St",
  city: "Dallas",
  state: "TX",
  postalCode: "75201",
  phone: "214-555-0100",
  website: "https://acmerobotics.example",
  sicCode: "3559",
  status: "DIRE",
  lifecycleStatus: "published"
};

describe("evaluateEntityResolution", () => {
  test("does not reimplement matching -- its computed outcome/matched id matches calling resolveCandidateAgainstExisting directly", () => {
    const sameLocationCandidate = candidate({
      company: { id: "co-x", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });
    const directDecision = resolveCandidateAgainstExisting(sameLocationCandidate, [acmeRobotics]);

    const report = evaluateEntityResolution(
      [dataset([labeledCase({ candidate: sameLocationCandidate, existingCompanies: [acmeRobotics], expected: { outcome: "same_existing_location", matchedExistingCompanyId: "bw-100" } })])],
      ["in-memory"]
    );

    expect(report.cases[0]?.actualOutcome).toBe(directDecision.outcome);
    expect(report.cases[0]?.actualMatchedExistingCompanyId).toBe(directDecision.matchedExistingCompanyId);
    expect(report.cases[0]?.decisionConfidence).toBe(directDecision.decisionConfidence);
  });

  test("confusion matrix, outcome accuracy, and full-case accuracy on a simple correct case", () => {
    const sameLocationCandidate = candidate({
      company: { id: "co-x", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const report = evaluateEntityResolution(
      [dataset([labeledCase({ candidate: sameLocationCandidate, existingCompanies: [acmeRobotics], expected: { outcome: "same_existing_location", matchedExistingCompanyId: "bw-100" } })])],
      ["in-memory"]
    );

    expect(report.confusionMatrix.counts.same_existing_location.same_existing_location).toBe(1);
    expect(report.overall.accuracy.outcomeAccuracy).toBe(1);
    expect(report.overall.accuracy.matchedRecordAccuracy).toBe(1);
    expect(report.overall.accuracy.fullCaseAccuracy).toBe(1);
  });

  test("outcome correct but wrong matched-record id makes fullyCorrect false while outcomeCorrect stays true", () => {
    const sameLocationCandidate = candidate({
      company: { id: "co-x", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    // Correct outcome will be produced (same_existing_location against bw-100), but the case expects a different id.
    const report = evaluateEntityResolution(
      [dataset([labeledCase({ candidate: sameLocationCandidate, existingCompanies: [acmeRobotics], expected: { outcome: "same_existing_location", matchedExistingCompanyId: "bw-wrong-id" } })])],
      ["in-memory"]
    );

    const result = report.cases[0]!;
    expect(result.outcomeCorrect).toBe(true);
    expect(result.matchedRecordCorrect).toBe(false);
    expect(result.fullyCorrect).toBe(false);
    expect(result.actualMatchedExistingCompanyId).toBe("bw-100");
  });

  test("false-existing-link: expected likely_new_company but actual is existing-related", () => {
    const brandedLikeExisting = candidate({
      company: { id: "co-x", legalName: "Acme Robotics, Inc.", website: "https://acmerobotics.example", sicCode: "3559" },
      physicalAddress: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201" }
    });

    const report = evaluateEntityResolution(
      [dataset([labeledCase({ candidate: brandedLikeExisting, existingCompanies: [acmeRobotics], expected: { outcome: "likely_new_company" } })])],
      ["in-memory"]
    );

    expect(report.cases[0]?.actualOutcome).toBe("same_existing_location");
    expect(report.overall.directional.falseExistingLinkRate).toBe(1);
    expect(report.overall.directional.falseNewRate).toBeNull();
  });

  test("false-new: expected existing-related but actual is likely_new_company", () => {
    const unrelatedCandidate = candidate({
      company: { id: "co-x", legalName: "Zephyr Consulting Group" },
      physicalAddress: { street: "1 Random Way", city: "Miami", state: "FL" }
    });

    const report = evaluateEntityResolution(
      [dataset([labeledCase({ candidate: unrelatedCandidate, existingCompanies: [acmeRobotics], expected: { outcome: "same_existing_location", matchedExistingCompanyId: "bw-100" } })])],
      ["in-memory"]
    );

    expect(report.cases[0]?.actualOutcome).toBe("likely_new_company");
    expect(report.overall.directional.falseNewRate).toBe(1);
    expect(report.overall.directional.falseExistingLinkRate).toBeNull();
  });

  test("ambiguous_manual_review is counted as abstention, never as a false-existing-link or false-new", () => {
    const existingA: ExistingCompany = { id: "bw-A", companyName: "Acme Robotics Inc.", address: "1 Foo St", city: "Houston", state: "TX", website: "https://acmerobotics.example" };
    const existingB: ExistingCompany = { id: "bw-B", companyName: "Acme Robotics LLC", address: "2 Bar Ave", city: "Austin", state: "TX" };
    const ambiguousCandidate = candidate({
      company: { id: "co-x", legalName: "Acme Robotics", website: "https://acmerobotics.example" },
      physicalAddress: { street: "500 Somewhere Blvd", city: "Dallas", state: "TX" }
    });

    const report = evaluateEntityResolution(
      [dataset([labeledCase({ candidate: ambiguousCandidate, existingCompanies: [existingA, existingB], expected: { outcome: "ambiguous_manual_review" } })])],
      ["in-memory"]
    );

    expect(report.cases[0]?.actualOutcome).toBe("ambiguous_manual_review");
    expect(report.overall.directional.abstentionRate).toBe(1);
    expect(report.overall.directional.falseExistingLinkRate).toBeNull();
    expect(report.overall.directional.falseNewRate).toBeNull();
  });

  test("retrieval rank reflects rankCandidateMatches's actual order, even when the expected record isn't ranked first", () => {
    const decoy: ExistingCompany = { id: "bw-decoy", companyName: "Falcon Systems Group", address: "1 Decoy Ave", city: "Dallas", state: "TX", postalCode: "75001" };
    const target: ExistingCompany = { id: "bw-target", companyName: "Falcon Systems Inc" };
    const falconCandidate = candidate({
      company: { id: "co-x", legalName: "Falcon Systems" },
      physicalAddress: { street: "1 Decoy Ave", city: "Dallas", state: "TX", postalCode: "75001" }
    });

    const ranked = rankCandidateMatches(falconCandidate, [target, decoy]);
    const expectedRank = ranked.findIndex((r) => r.existing.id === "bw-target") + 1;
    expect(expectedRank).toBe(2); // sanity: this fixture is deliberately not rank-1

    const report = evaluateEntityResolution(
      [dataset([labeledCase({ candidate: falconCandidate, existingCompanies: [target, decoy], expected: { outcome: "same_existing_location", matchedExistingCompanyId: "bw-target" } })])],
      ["in-memory"]
    );

    expect(report.cases[0]?.retrievalRank).toBe(2);
    expect(report.overall.retrieval.recallAt1).toBe(0);
    expect(report.overall.retrieval.recallAt3).toBe(1);
    expect(report.overall.retrieval.meanReciprocalRank).toBe(0.5);
    expect(report.overall.retrieval.meanRank).toBe(2);
    expect(report.overall.retrieval.medianRank).toBe(2);
  });

  test("retrieval metrics are null/zero appropriately when no case has an expected matched record", () => {
    const report = evaluateEntityResolution([dataset([labeledCase({ expected: { outcome: "likely_new_company" } })])], ["in-memory"]);

    expect(report.overall.retrieval.applicableCases).toBe(0);
    expect(report.overall.retrieval.meanRank).toBeNull();
    expect(report.overall.retrieval.medianRank).toBeNull();
  });

  test("confidence bands: undefined confidence buckets to unscored (never zero), and edges are inclusive/exclusive as documented", () => {
    expect(bandForConfidence(undefined)).toBe("unscored");
    expect(bandForConfidence(0)).toBe("0.0-0.2");
    expect(bandForConfidence(0.19)).toBe("0.0-0.2");
    expect(bandForConfidence(0.2)).toBe("0.2-0.4"); // lower edge of a band is inclusive to that band, not the one below
    expect(bandForConfidence(0.4)).toBe("0.4-0.6");
    expect(bandForConfidence(0.6)).toBe("0.6-0.8");
    expect(bandForConfidence(0.8)).toBe("0.8-1.0");
    expect(bandForConfidence(1.0)).toBe("0.8-1.0"); // top band's upper edge is inclusive (1.0 is a valid confidence)
  });

  test("the report always includes an unscored row (even at zero count) since production decisionConfidence is currently always a number", () => {
    const report = evaluateEntityResolution([dataset([labeledCase({ expected: { outcome: "likely_new_company" } })])], ["in-memory"]);

    const unscoredBand = report.confidenceCalibration.find((b) => b.band === "unscored")!;
    expect(unscoredBand.caseCount).toBe(0);
    expect(unscoredBand.meanConfidence).toBeNull();
  });

  test("byExpectedOutcome includes every EntityResolutionOutcome, even ones absent from the dataset", () => {
    const report = evaluateEntityResolution([dataset([labeledCase({ expected: { outcome: "likely_new_company" } })])], ["in-memory"]);

    expect(Object.keys(report.byExpectedOutcome).sort()).toEqual(
      [
        "same_existing_location",
        "possible_changed_location",
        "new_branch_of_existing_company",
        "new_headquarters_of_existing_company",
        "possible_name_change",
        "likely_new_company",
        "ambiguous_manual_review"
      ].sort()
    );
    expect(report.byExpectedOutcome.same_existing_location.accuracy.count).toBe(0);
  });

  test("the shipped synthetic sample dataset evaluates end-to-end with 100% accuracy and covers every outcome", async () => {
    const { datasets, errors } = await loadEntityResolutionCases(["data/eval/entity-resolution-cases.sample.json"]);
    expect(errors).toEqual([]);

    const report = evaluateEntityResolution(datasets, ["data/eval/entity-resolution-cases.sample.json"]);

    expect(report.overall.accuracy.outcomeAccuracy).toBe(1);
    expect(report.overall.accuracy.fullCaseAccuracy).toBe(1);

    for (const outcome of Object.keys(report.byExpectedOutcome) as Array<keyof typeof report.byExpectedOutcome>) {
      expect(report.byExpectedOutcome[outcome].accuracy.count).toBeGreaterThan(0);
    }
  });
});
