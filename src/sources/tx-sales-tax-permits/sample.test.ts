import { describe, expect, test } from "bun:test";
import { generatePilotSample } from "./sample.ts";
import type { TxPermitObservation, TxPermitRawRecord } from "./types.ts";

/** Fabricated fixtures only -- no real API rows. */
function observation(raw: TxPermitRawRecord): TxPermitObservation {
  return {
    source_dataset_id: "jrea-zgmq",
    source_record_id: `${raw.taxpayer_number}:${raw.outlet_number}`,
    fetched_at: "2026-07-24T00:00:00.000Z",
    query_window_start: "2026-07-17",
    query_window_end: "2026-07-24",
    requested_counties: ["043", "057", "061", "220"],
    source_url: "https://data.texas.gov/api/v3/views/jrea-zgmq/query.json",
    raw
  };
}

function fakeRow(index: number, overrides: Partial<TxPermitRawRecord> = {}): TxPermitRawRecord {
  return {
    outlet_name: `Fictitious Outlet ${index}`,
    taxpayer_name: `Fictitious Outlet ${index}`,
    taxpayer_number: `${1000 + index}`,
    outlet_number: "001",
    outlet_address: `${index} Fabricated Ave`,
    outlet_county_code: index % 2 === 0 ? "043" : "057",
    outlet_naics_code: index % 3 === 0 ? "722511" : "445110",
    outlet_first_sales_date: index % 4 === 0 ? undefined : "2026-07-21T00:00:00.000",
    taxpayer_organization_type: index % 5 === 0 ? "SOLE OWNER" : "LIMITED LIABILITY CO",
    ...overrides
  };
}

function makeObservations(count: number): TxPermitObservation[] {
  return Array.from({ length: count }, (_, i) => observation(fakeRow(i)));
}

describe("generatePilotSample", () => {
  test("caps the sample at 100 with a large population, split ~70/30", () => {
    const observations = makeObservations(500);
    const sample = generatePilotSample(observations, { seed: 42 });
    expect(sample.sampleSize).toBe(100);
    expect(sample.priorityCount).toBe(70);
    expect(sample.controlCount).toBe(30);
  });

  test("is reproducible for a fixed seed and fixed observation set", () => {
    const observations = makeObservations(500);
    const first = generatePilotSample(observations, { seed: 7 });
    const second = generatePilotSample(observations, { seed: 7 });
    expect(second.items).toEqual(first.items);
  });

  test("is reproducible even when the input observation order differs (sorted internally)", () => {
    const observations = makeObservations(200);
    const shuffled = [...observations].reverse();
    const fromOriginal = generatePilotSample(observations, { seed: 99 });
    const fromShuffled = generatePilotSample(shuffled, { seed: 99 });
    expect(fromShuffled.items).toEqual(fromOriginal.items);
  });

  test("a different seed produces a different sample (with enough population to matter)", () => {
    const observations = makeObservations(500);
    const seedOne = generatePilotSample(observations, { seed: 1 });
    const seedTwo = generatePilotSample(observations, { seed: 2 });
    expect(seedTwo.items).not.toEqual(seedOne.items);
  });

  test("never selects the same source_record_id twice", () => {
    const observations = makeObservations(300);
    const sample = generatePilotSample(observations, { seed: 3 });
    const ids = sample.items.map((item) => item.source_record_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("only references source_record_id + sampling metadata, never full raw rows", () => {
    const observations = makeObservations(150);
    const sample = generatePilotSample(observations, { seed: 5 });
    for (const item of sample.items) {
      expect(Object.keys(item).sort()).toEqual(["selection", "source_record_id", "stratum"]);
    }
  });

  test("sensible behavior with fewer than 100 observations: sample size never exceeds the population", () => {
    const observations = makeObservations(12);
    const sample = generatePilotSample(observations, { seed: 1 });
    expect(sample.sampleSize).toBe(12);
    expect(sample.totalEligible).toBe(12);
    expect(sample.priorityCount + sample.controlCount).toBe(12);
  });

  test("behaves sensibly with a single observation", () => {
    const observations = makeObservations(1);
    const sample = generatePilotSample(observations, { seed: 1 });
    expect(sample.sampleSize).toBe(1);
    expect(sample.items).toHaveLength(1);
  });

  test("behaves sensibly with zero observations", () => {
    const sample = generatePilotSample([], { seed: 1 });
    expect(sample.sampleSize).toBe(0);
    expect(sample.items).toEqual([]);
  });

  test("does not silently discard any organization type, NAICS bucket, or county from priority selection eligibility", () => {
    // Small population where every stratum has exactly one member -- priority
    // selection must be able to draw from every distinct stratum, not just
    // the first one encountered.
    const observations = [
      observation(fakeRow(0, { taxpayer_organization_type: "SOLE OWNER", outlet_county_code: "220" })),
      observation(fakeRow(1, { taxpayer_organization_type: "LIMITED LIABILITY CO", outlet_county_code: "061" })),
      observation(fakeRow(2, { taxpayer_organization_type: "GENERAL PARTNERSHIP", outlet_county_code: "043" }))
    ];
    const sample = generatePilotSample(observations, { seed: 1, maxSampleSize: 3 });
    expect(sample.items.map((item) => item.source_record_id).sort()).toEqual(
      observations.map((o) => o.source_record_id).sort()
    );
  });

  test("random-control draws from the overall eligible population, not a pre-filtered subgroup", () => {
    // All observations share one stratum (identical dimensions) so every
    // priority pick necessarily also comes from that one group; the
    // random-control slice should still be able to pull from the same full
    // pool once priority picks are removed.
    const uniform = Array.from({ length: 50 }, (_, i) =>
      observation(
        fakeRow(0, {
          taxpayer_number: `${2000 + i}`,
          outlet_number: "001",
          outlet_county_code: "057",
          outlet_naics_code: "445110",
          taxpayer_organization_type: "LIMITED LIABILITY CO",
          outlet_first_sales_date: "2026-07-21T00:00:00.000"
        })
      )
    );
    const sample = generatePilotSample(uniform, { seed: 1, maxSampleSize: 20 });
    expect(sample.controlCount).toBeGreaterThan(0);
    expect(sample.sampleSize).toBe(20);
  });
});
