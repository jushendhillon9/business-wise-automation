import { normalizeCompanyName } from "../../normalize.ts";
import { toStringField } from "./types.ts";
import type { TxPermitObservation } from "./types.ts";

/**
 * Aggregate-only source-quality metrics. Never returns or logs an
 * individual observation's fields -- everything here is a count, a keyed
 * count map, or a rate, computed over a full observation set. Used by
 * src/tx-permits-profile.ts for the printed report and profile.json.
 */

const PO_BOX_PATTERN = /\bP\.?\s*O\.?\s*BOX\b/i;
/**
 * Heuristic only -- NOT a verified residential classification. Flags an
 * address whose text commonly indicates a residential unit (apartment/
 * trailer/mobile-home markers, or a bare trailing "#123" unit suffix).
 * False positives/negatives are expected; this exists purely to give the
 * profiler a rough signal, never to exclude or reclassify a record.
 */
const RESIDENTIAL_RISK_PATTERN = /\b(apt|apartment|unit|trlr|trailer|mobile\s*home)\b|#\s*\d+\s*$/i;

export function isPoBoxLikeAddress(address: string | undefined): boolean {
  return Boolean(address && PO_BOX_PATTERN.test(address));
}

export function isResidentialRiskHeuristic(address: string | undefined): boolean {
  return Boolean(address && RESIDENTIAL_RISK_PATTERN.test(address));
}

export type TxPermitProfile = {
  totalObservations: number;
  uniqueSourceRecordIds: number;
  duplicateSourceRecordIds: number;
  uniqueTaxpayers: number;
  taxpayersWithMultipleOutlets: number;
  countyCounts: Record<string, number>;
  organizationTypeCounts: Record<string, number>;
  naicsTwoDigitCounts: Record<string, number>;
  naicsThreeDigitCounts: Record<string, number>;
  missingOutletName: number;
  missingOutletAddress: number;
  missingOutletCity: number;
  missingOutletZip: number;
  missingOutletNaics: number;
  missingPermitIssueDate: number;
  missingFirstSalesDate: number;
  taxpayerNameDiffersFromOutletName: number;
  poBoxLikeAddressCount: number;
  /** Heuristic only -- see isResidentialRiskHeuristic(). */
  residentialRiskHeuristicCount: number;
  insideCityLimitsCount: number;
  outsideCityLimitsCount: number;
  cityLimitsUnknownCount: number;
  /**
   * Raw, unmapped `outlet_inside_outside_city_limits_indicator` values and
   * their counts -- kept distinct from the inside/outside/unknown counts
   * above so a future mapping can be added once the real code dictionary is
   * known, without guessing semantics now. A blank/absent value is bucketed
   * under "(missing)".
   */
  cityLimitRawCodeCounts: Record<string, number>;
};

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Never excludes a record from any count based on these heuristics -- see README's "what this stage does not do." */
export function profileTxPermitObservations(observations: TxPermitObservation[]): TxPermitProfile {
  const countyCounts: Record<string, number> = {};
  const organizationTypeCounts: Record<string, number> = {};
  const naicsTwoDigitCounts: Record<string, number> = {};
  const naicsThreeDigitCounts: Record<string, number> = {};
  const cityLimitRawCodeCounts: Record<string, number> = {};

  const taxpayerOutletCounts = new Map<string, number>();
  const seenSourceRecordIds = new Set<string>();

  let duplicateSourceRecordIds = 0;
  let missingOutletName = 0;
  let missingOutletAddress = 0;
  let missingOutletCity = 0;
  let missingOutletZip = 0;
  let missingOutletNaics = 0;
  let missingPermitIssueDate = 0;
  let missingFirstSalesDate = 0;
  let taxpayerNameDiffersFromOutletName = 0;
  let poBoxLikeAddressCount = 0;
  let residentialRiskHeuristicCount = 0;
  let insideCityLimitsCount = 0;
  let outsideCityLimitsCount = 0;
  let cityLimitsUnknownCount = 0;

  for (const observation of observations) {
    const raw = observation.raw;

    if (seenSourceRecordIds.has(observation.source_record_id)) {
      duplicateSourceRecordIds += 1;
    } else {
      seenSourceRecordIds.add(observation.source_record_id);
    }

    const taxpayerNumber = toStringField(raw.taxpayer_number);
    if (taxpayerNumber) {
      taxpayerOutletCounts.set(taxpayerNumber, (taxpayerOutletCounts.get(taxpayerNumber) ?? 0) + 1);
    }

    bump(countyCounts, toStringField(raw.outlet_county_code) ?? "(missing)");
    bump(organizationTypeCounts, toStringField(raw.taxpayer_organization_type) ?? "(missing)");

    const naics = toStringField(raw.outlet_naics_code);
    if (!naics) {
      missingOutletNaics += 1;
      bump(naicsTwoDigitCounts, "(missing)");
      bump(naicsThreeDigitCounts, "(missing)");
    } else {
      bump(naicsTwoDigitCounts, naics.length >= 2 ? naics.slice(0, 2) : "(short)");
      bump(naicsThreeDigitCounts, naics.length >= 3 ? naics.slice(0, 3) : "(short)");
    }

    if (!toStringField(raw.outlet_name)) missingOutletName += 1;
    const outletAddress = toStringField(raw.outlet_address);
    if (!outletAddress) missingOutletAddress += 1;
    if (!toStringField(raw.outlet_city)) missingOutletCity += 1;
    if (!toStringField(raw.outlet_zip_code)) missingOutletZip += 1;
    if (!toStringField(raw.outlet_permit_issue_date)) missingPermitIssueDate += 1;
    if (!toStringField(raw.outlet_first_sales_date)) missingFirstSalesDate += 1;

    const taxpayerName = toStringField(raw.taxpayer_name);
    const outletName = toStringField(raw.outlet_name);
    if (taxpayerName && outletName && normalizeCompanyName(taxpayerName) !== normalizeCompanyName(outletName)) {
      taxpayerNameDiffersFromOutletName += 1;
    }

    if (isPoBoxLikeAddress(outletAddress)) poBoxLikeAddressCount += 1;
    if (isResidentialRiskHeuristic(outletAddress)) residentialRiskHeuristicCount += 1;

    const cityLimitsRaw = toStringField(raw.outlet_inside_outside_city_limits_indicator);
    bump(cityLimitRawCodeCounts, cityLimitsRaw ?? "(missing)");

    const cityLimits = cityLimitsRaw?.toUpperCase();
    if (cityLimits?.startsWith("I")) insideCityLimitsCount += 1;
    else if (cityLimits?.startsWith("O")) outsideCityLimitsCount += 1;
    else cityLimitsUnknownCount += 1;
  }

  const taxpayersWithMultipleOutlets = [...taxpayerOutletCounts.values()].filter((count) => count > 1).length;

  return {
    totalObservations: observations.length,
    uniqueSourceRecordIds: seenSourceRecordIds.size,
    duplicateSourceRecordIds,
    uniqueTaxpayers: taxpayerOutletCounts.size,
    taxpayersWithMultipleOutlets,
    countyCounts,
    organizationTypeCounts,
    naicsTwoDigitCounts,
    naicsThreeDigitCounts,
    missingOutletName,
    missingOutletAddress,
    missingOutletCity,
    missingOutletZip,
    missingOutletNaics,
    missingPermitIssueDate,
    missingFirstSalesDate,
    taxpayerNameDiffersFromOutletName,
    poBoxLikeAddressCount,
    residentialRiskHeuristicCount,
    insideCityLimitsCount,
    outsideCityLimitsCount,
    cityLimitsUnknownCount,
    cityLimitRawCodeCounts
  };
}
