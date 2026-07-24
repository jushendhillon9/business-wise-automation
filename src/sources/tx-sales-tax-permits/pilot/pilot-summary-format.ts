import type { PilotSummary } from "./aggregate.ts";

/**
 * Terminal-output formatting for the shadow pilot. Prints ONLY aggregate/
 * operational information -- counts, rates, keyed count maps, rule ids,
 * field names. Never accepts or prints an individual candidate's name,
 * address, taxpayer/outlet number, or a raw BWI record. See README's
 * "Texas Sales-Tax Permit Shadow Pilot" data-safety rules.
 */

function printCountMap(label: string, counts: Record<string, number>, topN = 12): void {
  console.log(`  ${label}:`);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const [key, count] of entries.slice(0, topN)) {
    console.log(`    ${key}: ${count}`);
  }
  if (entries.length > topN) {
    console.log(`    ... and ${entries.length - topN} more`);
  }
}

export function printPilotSummary(summary: PilotSummary): void {
  console.log("Source processing:");
  console.log(`  Source observations read: ${summary.sourceProcessing.sourceObservationsRead}`);
  console.log(`  Valid candidates created: ${summary.sourceProcessing.validCandidatesCreated}`);
  console.log(`  Invalid observations: ${summary.sourceProcessing.invalidObservations}`);
  console.log(`  Duplicate observations: ${summary.sourceProcessing.duplicateObservations}`);
  console.log(`  Candidates persisted: ${summary.sourceProcessing.candidatesPersisted}`);
  console.log(`  Already-ingested (idempotent skip): ${summary.sourceProcessing.alreadyIngestedSkipped}`);
  console.log("");

  console.log("BWI retrieval:");
  console.log(`  Candidates with zero retrieval results: ${summary.retrieval.zeroResultCount}`);
  console.log(`  Candidates with one or more retrieval results: ${summary.retrieval.oneOrMoreResultCount}`);
  console.log(`  Average retrieval-set size: ${summary.retrieval.averageSetSize}`);
  console.log(`  Median retrieval-set size: ${summary.retrieval.medianSetSize}`);
  console.log(`  Maximum retrieval-set size: ${summary.retrieval.maxSetSize}`);
  console.log(`  Total retrieval latency: ${summary.retrieval.totalRetrievalMs}ms`);
  console.log("");

  printCountMap("Entity-resolution outcomes", summary.outcomeCounts);
  console.log("");
  printCountMap("Matched-existing-record status (DIRE/KEEP/RSCH/RDEL/DELE)", summary.matchedStatusCounts);
  console.log(`  Candidates with a lifecycle warning (deleted/research-deleted match): ${summary.candidatesWithLifecycleWarnings}`);
  console.log("");
  printCountMap("Relationship context (top match has a known HQTR/AFFL edge)", summary.relationshipContextCounts);
  console.log("");

  console.log("Publication readiness:");
  console.log(`  confirmed_ready: ${summary.readinessCounts.confirmed_ready}`);
  console.log(`  provisionally_ready: ${summary.readinessCounts.provisionally_ready}`);
  console.log(`  blocked: ${summary.readinessCounts.blocked}`);
  console.log("");
  printCountMap("Most common readiness blockers", Object.fromEntries(summary.topBlockerRuleIds.map((b) => [b.ruleId, b.count])));
  console.log("");
  printCountMap(
    "Most common optional missing fields",
    Object.fromEntries(summary.topOptionalMissingFields.map((f) => [f.field, f.count]))
  );
}
