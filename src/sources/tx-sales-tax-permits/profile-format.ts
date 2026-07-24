import type { TxPermitProfile } from "./profile.ts";

/**
 * Terminal-output formatting for the profiler. Prints ONLY aggregate/
 * operational information -- counts, rates, keyed count maps. Never accepts
 * or prints an individual observation, a name, an address, an identifier,
 * or a raw row. See README's "Real Texas permit source" data-safety rules.
 */

function printCountMap(label: string, counts: Record<string, number>, topN = 12): void {
  console.log(`  ${label}:`);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [key, count] of entries.slice(0, topN)) {
    console.log(`    ${key}: ${count}`);
  }
  if (entries.length > topN) {
    console.log(`    ... and ${entries.length - topN} more`);
  }
}

export function printTxPermitProfile(profile: TxPermitProfile): void {
  console.log(`Total observations: ${profile.totalObservations}`);
  console.log(`Unique source_record_id: ${profile.uniqueSourceRecordIds}`);
  console.log(`Duplicate source_record_id: ${profile.duplicateSourceRecordIds}`);
  console.log(`Unique taxpayers: ${profile.uniqueTaxpayers}`);
  console.log(`Taxpayers with multiple outlets: ${profile.taxpayersWithMultipleOutlets}`);
  console.log("");

  printCountMap("County counts", profile.countyCounts);
  console.log("");
  printCountMap("Organization type counts", profile.organizationTypeCounts);
  console.log("");
  printCountMap("NAICS (2-digit) counts", profile.naicsTwoDigitCounts);
  console.log("");
  printCountMap("NAICS (3-digit) counts", profile.naicsThreeDigitCounts, 15);
  console.log("");

  console.log(`Missing outlet name: ${profile.missingOutletName}`);
  console.log(`Missing outlet address: ${profile.missingOutletAddress}`);
  console.log(`Missing outlet city: ${profile.missingOutletCity}`);
  console.log(`Missing outlet ZIP: ${profile.missingOutletZip}`);
  console.log(`Missing outlet NAICS: ${profile.missingOutletNaics}`);
  console.log(`Missing permit issue date: ${profile.missingPermitIssueDate}`);
  console.log(`Missing first-sales date: ${profile.missingFirstSalesDate}`);
  console.log(`Taxpayer name differs from outlet name: ${profile.taxpayerNameDiffersFromOutletName}`);
  console.log(`PO-box-like address count: ${profile.poBoxLikeAddressCount}`);
  console.log(
    `Residential-risk heuristic count (heuristic only -- NOT a verified residential classification): ${profile.residentialRiskHeuristicCount}`
  );
  console.log(`Inside city limits: ${profile.insideCityLimitsCount}`);
  console.log(`Outside city limits: ${profile.outsideCityLimitsCount}`);
  console.log(`City-limits indicator unknown/unrecognized: ${profile.cityLimitsUnknownCount}`);
  console.log("");
  printCountMap("City-limits raw code distribution (unmapped -- semantics not yet confirmed)", profile.cityLimitRawCodeCounts);
}
