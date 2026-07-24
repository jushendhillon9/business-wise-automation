import { describe, expect, test } from "bun:test";
import { isPoBoxLikeAddress, isResidentialRiskHeuristic, profileTxPermitObservations } from "./profile.ts";
import type { TxPermitObservation, TxPermitRawRecord } from "./types.ts";

/** Fabricated fixtures only -- no real API rows. */
function observation(raw: TxPermitRawRecord, sourceRecordId?: string): TxPermitObservation {
  return {
    source_dataset_id: "jrea-zgmq",
    source_record_id: sourceRecordId ?? `${raw.taxpayer_number}:${raw.outlet_number}`,
    fetched_at: "2026-07-24T00:00:00.000Z",
    query_window_start: "2026-07-17",
    query_window_end: "2026-07-24",
    requested_counties: ["043", "057", "061", "220"],
    source_url: "https://data.texas.gov/api/v3/views/jrea-zgmq/query.json",
    raw
  };
}

function fakeRow(overrides: Partial<TxPermitRawRecord> = {}): TxPermitRawRecord {
  return {
    outlet_name: "Fictitious Outlet Co",
    taxpayer_name: "Fictitious Outlet Co",
    taxpayer_number: "1000000001",
    outlet_number: "001",
    outlet_address: "500 Fabricated Ave",
    outlet_city: "Testville",
    outlet_county_code: "057",
    outlet_zip_code: "75001",
    outlet_naics_code: "722511",
    outlet_permit_issue_date: "2026-07-20T00:00:00.000",
    outlet_first_sales_date: "2026-07-21T00:00:00.000",
    outlet_inside_outside_city_limits_indicator: "I",
    taxpayer_organization_type: "LIMITED LIABILITY CO",
    ...overrides
  };
}

describe("isPoBoxLikeAddress", () => {
  test("detects common PO box phrasing", () => {
    expect(isPoBoxLikeAddress("PO BOX 123")).toBe(true);
    expect(isPoBoxLikeAddress("P.O. Box 456")).toBe(true);
    expect(isPoBoxLikeAddress("500 Fabricated Ave")).toBe(false);
    expect(isPoBoxLikeAddress(undefined)).toBe(false);
  });
});

describe("isResidentialRiskHeuristic", () => {
  test("flags typical residential-unit markers, without claiming certainty", () => {
    expect(isResidentialRiskHeuristic("500 Fabricated Ave Apt 3")).toBe(true);
    expect(isResidentialRiskHeuristic("500 Fabricated Ave Unit 3")).toBe(true);
    expect(isResidentialRiskHeuristic("500 Fabricated Trlr 12")).toBe(true);
    expect(isResidentialRiskHeuristic("500 Fabricated Ave Suite 300")).toBe(false);
    expect(isResidentialRiskHeuristic(undefined)).toBe(false);
  });
});

describe("profileTxPermitObservations", () => {
  test("counts totals, unique/duplicate source_record_id, and unique taxpayers", () => {
    const observations = [
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1" })),
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1" })), // duplicate id
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1" }))
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.totalObservations).toBe(3);
    expect(profile.uniqueSourceRecordIds).toBe(2);
    expect(profile.duplicateSourceRecordIds).toBe(1);
    expect(profile.uniqueTaxpayers).toBe(2);
  });

  test("counts taxpayers with more than one outlet", () => {
    const observations = [
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1" })),
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "2" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1" }))
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.taxpayersWithMultipleOutlets).toBe(1);
  });

  test("counts by county and organization type", () => {
    const observations = [
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1", outlet_county_code: "043", taxpayer_organization_type: "SOLE OWNER" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1", outlet_county_code: "057", taxpayer_organization_type: "LIMITED LIABILITY CO" }))
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.countyCounts).toEqual({ "043": 1, "057": 1 });
    expect(profile.organizationTypeCounts).toEqual({ "SOLE OWNER": 1, "LIMITED LIABILITY CO": 1 });
  });

  test("computes two-digit and three-digit NAICS distributions", () => {
    const observations = [
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1", outlet_naics_code: "722511" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1", outlet_naics_code: "722513" })),
      observation(fakeRow({ taxpayer_number: "3", outlet_number: "1", outlet_naics_code: "445110" }))
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.naicsTwoDigitCounts).toEqual({ "72": 2, "44": 1 });
    expect(profile.naicsThreeDigitCounts).toEqual({ "722": 2, "445": 1 });
  });

  test("counts missing outlet name/address/city/zip/naics/permit-issue-date/first-sales-date", () => {
    const observations = [
      observation(
        fakeRow({
          taxpayer_number: "1",
          outlet_number: "1",
          outlet_name: undefined,
          outlet_address: undefined,
          outlet_city: undefined,
          outlet_zip_code: undefined,
          outlet_naics_code: undefined,
          outlet_permit_issue_date: undefined,
          outlet_first_sales_date: undefined
        })
      )
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.missingOutletName).toBe(1);
    expect(profile.missingOutletAddress).toBe(1);
    expect(profile.missingOutletCity).toBe(1);
    expect(profile.missingOutletZip).toBe(1);
    expect(profile.missingOutletNaics).toBe(1);
    expect(profile.missingPermitIssueDate).toBe(1);
    expect(profile.missingFirstSalesDate).toBe(1);
  });

  test("detects taxpayer name differing from outlet name using normalized comparison", () => {
    const observations = [
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1", taxpayer_name: "Acme Holdings Inc", outlet_name: "Acme Cafe" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1", taxpayer_name: "Beta Co", outlet_name: "Beta Co" }))
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.taxpayerNameDiffersFromOutletName).toBe(1);
  });

  test("counts PO-box-like and residential-risk-heuristic addresses without excluding them", () => {
    const observations = [
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1", outlet_address: "PO BOX 900" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1", outlet_address: "12 Fabricated Rd Apt 4" })),
      observation(fakeRow({ taxpayer_number: "3", outlet_number: "1", outlet_address: "12 Fabricated Rd Suite 200" }))
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.poBoxLikeAddressCount).toBe(1);
    expect(profile.residentialRiskHeuristicCount).toBe(1);
    expect(profile.totalObservations).toBe(3); // nothing excluded
  });

  test("counts inside/outside/unknown city-limits indicator", () => {
    const observations = [
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1", outlet_inside_outside_city_limits_indicator: "I" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1", outlet_inside_outside_city_limits_indicator: "O" })),
      observation(fakeRow({ taxpayer_number: "3", outlet_number: "1", outlet_inside_outside_city_limits_indicator: undefined }))
    ];
    const profile = profileTxPermitObservations(observations);
    expect(profile.insideCityLimitsCount).toBe(1);
    expect(profile.outsideCityLimitsCount).toBe(1);
    expect(profile.cityLimitsUnknownCount).toBe(1);
  });

  test("handles an empty observation list without throwing", () => {
    const profile = profileTxPermitObservations([]);
    expect(profile.totalObservations).toBe(0);
    expect(profile.uniqueTaxpayers).toBe(0);
    expect(profile.countyCounts).toEqual({});
  });
});
