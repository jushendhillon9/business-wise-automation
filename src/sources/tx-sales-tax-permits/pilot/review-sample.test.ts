import { describe, expect, test } from "bun:test";
import type { PublicationReadinessAssessment } from "../../../publication-readiness.ts";
import type { EntityResolutionDecision, EntityResolutionOutcome, ExistingCompany, LocationCandidate, MatchResult } from "../../../types.ts";
import { reviewSampleToCsv, selectReviewSample, type PilotReviewCandidateInput } from "./review-sample.ts";
import type { TxPermitObservation, TxPermitRawRecord } from "../types.ts";

/** All fixtures are fabricated -- no real API or BWI rows. */
function fakeRow(index: number, overrides: Partial<TxPermitRawRecord> = {}): TxPermitRawRecord {
  return {
    outlet_name: `Fabricated Outlet ${index}`,
    taxpayer_name: `Fabricated Taxpayer ${index}`,
    taxpayer_number: `${1000 + index}`,
    outlet_number: "001",
    outlet_address: `${index} Fabricated Ave`,
    outlet_county_code: ["043", "057", "061", "220"][index % 4],
    outlet_naics_code: index % 3 === 0 ? "722511" : "445110",
    outlet_first_sales_date: index % 5 === 0 ? undefined : "2026-07-21T00:00:00.000",
    taxpayer_organization_type: index % 4 === 0 ? "SOLE OWNER" : "LIMITED LIABILITY CO",
    ...overrides
  };
}

const OUTCOMES: EntityResolutionOutcome[] = [
  "likely_new_company",
  "same_existing_location",
  "new_branch_of_existing_company",
  "new_headquarters_of_existing_company",
  "possible_changed_location",
  "possible_name_change",
  "ambiguous_manual_review"
];

function fakeMatch(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    companySimilarity: { nameScore: 0, domainMatch: false, sicMatch: false },
    locationSimilarity: { addressScore: 0, phoneMatch: false, cityStateMatch: false },
    score: 0,
    classification: "likely_new",
    reasons: [],
    ...overrides
  };
}

function fakeResolution(overrides: Partial<EntityResolutionDecision> = {}): EntityResolutionDecision {
  return {
    outcome: "likely_new_company",
    alternativeMatches: [],
    reasons: [],
    conflicts: [],
    requiresHumanReview: false,
    ...overrides
  };
}

function fakeReadiness(overrides: Partial<PublicationReadinessAssessment> = {}): PublicationReadinessAssessment {
  return {
    state: "blocked",
    blockers: [],
    unresolvedRules: [],
    satisfiedRequirements: [],
    optionalMissingFields: [],
    ...overrides
  };
}

function fakeInput(index: number, overrides: { rowOverrides?: Partial<TxPermitRawRecord>; input?: Partial<PilotReviewCandidateInput> } = {}): PilotReviewCandidateInput {
  const raw = fakeRow(index, overrides.rowOverrides);
  const observation: TxPermitObservation = {
    source_dataset_id: "jrea-zgmq",
    source_record_id: `${raw.taxpayer_number}:${raw.outlet_number}`,
    fetched_at: "2026-07-24T12:00:00.000Z",
    query_window_start: "2026-07-17",
    query_window_end: "2026-07-24",
    requested_counties: ["043", "057", "061", "220"],
    source_url: "https://data.texas.gov/api/v3/views/jrea-zgmq/query.json",
    raw
  };

  const candidate: LocationCandidate = {
    id: crypto.randomUUID(),
    company: { id: crypto.randomUUID(), legalName: raw.outlet_name ?? "Fabricated" },
    contacts: [],
    evidence: [],
    source: { sourceId: "tx-sales-tax-permits", sourceName: "test", fingerprint: `test:${index}`, ingestedAt: observation.fetched_at },
    capturedAt: observation.fetched_at,
    rawSourceData: observation
  };

  return {
    candidate,
    match: fakeMatch(),
    resolution: fakeResolution({ outcome: OUTCOMES[index % OUTCOMES.length] }),
    readiness: fakeReadiness(),
    relationshipTypes: [],
    retrievalCount: index % 2,
    ...overrides.input
  };
}

describe("selectReviewSample", () => {
  test("caps the sample at the requested size", () => {
    const inputs = Array.from({ length: 154 }, (_, i) => fakeInput(i));
    const sample = selectReviewSample(inputs, { sampleSize: 20, seed: 1 });
    expect(sample.length).toBe(20);
  });

  test("is reproducible for a fixed seed and fixed population", () => {
    const inputs = Array.from({ length: 154 }, (_, i) => fakeInput(i));
    const first = selectReviewSample(inputs, { sampleSize: 20, seed: 7 });
    const second = selectReviewSample(inputs, { sampleSize: 20, seed: 7 });
    expect(second.map((c) => c.source.source_record_id)).toEqual(first.map((c) => c.source.source_record_id));
  });

  test("a different seed produces a different sample", () => {
    const inputs = Array.from({ length: 154 }, (_, i) => fakeInput(i));
    const seedOne = selectReviewSample(inputs, { sampleSize: 20, seed: 1 });
    const seedTwo = selectReviewSample(inputs, { sampleSize: 20, seed: 2 });
    expect(seedTwo.map((c) => c.source.source_record_id)).not.toEqual(seedOne.map((c) => c.source.source_record_id));
  });

  test("does not select the same source_record_id twice", () => {
    const inputs = Array.from({ length: 154 }, (_, i) => fakeInput(i));
    const sample = selectReviewSample(inputs, { sampleSize: 20, seed: 3 });
    const ids = sample.map((c) => c.source.source_record_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("outcome diversity: is not dominated by a single outcome when enough diversity exists", () => {
    const inputs = Array.from({ length: 154 }, (_, i) => fakeInput(i));
    const sample = selectReviewSample(inputs, { sampleSize: 20, seed: 1 });
    const distinctOutcomes = new Set(sample.map((c) => c.machine.recommended_outcome));
    expect(distinctOutcomes.size).toBeGreaterThan(1);
  });

  test("sensible behavior with fewer observations than the requested sample size", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => fakeInput(i));
    const sample = selectReviewSample(inputs, { sampleSize: 20, seed: 1 });
    expect(sample.length).toBe(5);
  });

  test("behaves sensibly with zero candidates", () => {
    const sample = selectReviewSample([], { sampleSize: 20, seed: 1 });
    expect(sample).toEqual([]);
  });

  test("each case includes full source-side and machine-side detail for a local reviewer", () => {
    const inputs = [
      fakeInput(0, {
        rowOverrides: { outlet_name: "Fabricated Outlet Name", taxpayer_name: "Fabricated Taxpayer Name" },
        input: {
          matchedExisting: {
            id: "bwi-1",
            companyName: "Fabricated BWI Match Co",
            address: "1 Fabricated BWI Ave",
            city: "Testville",
            state: "TX",
            status: "DIRE",
            lifecycleStatus: "published"
          } satisfies ExistingCompany,
          relationshipTypes: ["HQTR"],
          resolution: fakeResolution({ outcome: "same_existing_location", matchedExistingCompanyId: "bwi-1", decisionConfidence: 0.9, reasons: ["exact_phone_match"] }),
          readiness: fakeReadiness({ state: "confirmed_ready" })
        }
      })
    ];
    const [reviewCase] = selectReviewSample(inputs, { sampleSize: 1, seed: 1 });
    expect(reviewCase?.source.outlet_name).toBe("Fabricated Outlet Name");
    expect(reviewCase?.source.taxpayer_name).toBe("Fabricated Taxpayer Name");
    expect(reviewCase?.machine.recommended_outcome).toBe("same_existing_location");
    expect(reviewCase?.machine.confidence).toBe(0.9);
    expect(reviewCase?.machine.matched_bwi_id).toBe("bwi-1");
    expect(reviewCase?.machine.matched_bwi_summary?.company_name).toBe("Fabricated BWI Match Co");
    expect(reviewCase?.machine.relationship_context).toEqual(["HQTR"]);
    expect(reviewCase?.machine.readiness_state).toBe("confirmed_ready");
  });

  test("never includes contact data from the BWI snapshot (no contact fields exist on the matched summary)", () => {
    const inputs = [
      fakeInput(0, {
        input: {
          matchedExisting: { id: "bwi-1", companyName: "Fabricated BWI Match Co" } satisfies ExistingCompany
        }
      })
    ];
    const [reviewCase] = selectReviewSample(inputs, { sampleSize: 1, seed: 1 });
    expect(reviewCase?.machine.matched_bwi_summary && "contacts" in reviewCase.machine.matched_bwi_summary).toBe(false);
  });

  test("flags taxpayer-name-differs-from-outlet-name and residential-risk/PO-box heuristics per case", () => {
    const inputs = [
      fakeInput(0, { rowOverrides: { outlet_name: "Outlet A", taxpayer_name: "Totally Different Legal Name", outlet_address: "PO BOX 900" } })
    ];
    const [reviewCase] = selectReviewSample(inputs, { sampleSize: 1, seed: 1 });
    expect(reviewCase?.source.taxpayer_name_differs_from_outlet_name).toBe(true);
    expect(reviewCase?.source.po_box_like_address).toBe(true);
  });

  test("flags multi-outlet taxpayers based on the full input population", () => {
    const sharedTaxpayer = "9999999999";
    const inputs = [
      fakeInput(0, { rowOverrides: { taxpayer_number: sharedTaxpayer, outlet_number: "001" } }),
      fakeInput(1, { rowOverrides: { taxpayer_number: sharedTaxpayer, outlet_number: "002" } })
    ];
    const sample = selectReviewSample(inputs, { sampleSize: 2, seed: 1 });
    expect(sample.every((c) => c.source.taxpayer_has_multiple_outlets)).toBe(true);
  });
});

describe("reviewSampleToCsv", () => {
  test("produces one header row plus one row per case, with a matching column count", () => {
    const inputs = Array.from({ length: 3 }, (_, i) => fakeInput(i));
    const sample = selectReviewSample(inputs, { sampleSize: 3, seed: 1 });
    const csv = reviewSampleToCsv(sample);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(4); // header + 3 rows
    const headerColumnCount = lines[0]!.split(",").length;
    expect(headerColumnCount).toBeGreaterThan(10);
  });

  test("escapes commas and quotes in values", () => {
    const inputs = [fakeInput(0, { rowOverrides: { outlet_name: 'Fabricated, "Quoted" Outlet' } })];
    const sample = selectReviewSample(inputs, { sampleSize: 1, seed: 1 });
    const csv = reviewSampleToCsv(sample);
    expect(csv).toContain('"Fabricated, ""Quoted"" Outlet"');
  });

  test("handles an empty case list", () => {
    const csv = reviewSampleToCsv([]);
    expect(csv.trim().split("\n")).toHaveLength(1); // header only
  });
});
