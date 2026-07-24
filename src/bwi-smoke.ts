import { BusinessWiseSnapshotAdapter } from "./business-wise-snapshot-adapter.ts";
import { readCliPathArg } from "./bwi-snapshot/paths.ts";
import type { LocationCandidate } from "./types.ts";

/**
 * `bun run bwi:smoke` -- loads the real local BWI snapshot adapter, builds
 * its indexes, and runs a handful of synthetic (fabricated, non-production)
 * lookup probes to demonstrate bounded, indexed retrieval. Never prints a
 * matched record's fields -- only counts. Never writes anywhere (this
 * adapter has no write path at all -- see stageApprovedCandidate). Does not
 * touch data/sandbox.sqlite.
 */

function syntheticCandidate(overrides: Partial<LocationCandidate>): LocationCandidate {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    company: {
      id: crypto.randomUUID(),
      legalName: "Synthetic Smoke Test Company",
      ...overrides.company
    },
    contacts: [],
    evidence: ["bwi:smoke synthetic probe -- not real production data"],
    source: {
      sourceId: "bwi-smoke",
      sourceName: "BWI Snapshot Smoke Test",
      fingerprint: `bwi-smoke:${crypto.randomUUID()}`,
      ingestedAt: now
    },
    capturedAt: now,
    ...overrides
  };
}

const SYNTHETIC_PROBES: Array<{ label: string; candidate: LocationCandidate }> = [
  {
    label: "no signal at all (should return empty)",
    candidate: syntheticCandidate({ company: { id: crypto.randomUUID(), legalName: "Zzz Totally Fictitious Nonexistent Co Zzz" } })
  },
  {
    label: "fabricated phone number",
    candidate: syntheticCandidate({ phone: "000-000-0000" })
  },
  {
    label: "fabricated website domain",
    candidate: syntheticCandidate({ company: { id: crypto.randomUUID(), legalName: "Fictitious Domain Co", website: "this-domain-does-not-exist.example" } })
  },
  {
    label: "fabricated ZIP + generic name",
    candidate: syntheticCandidate({
      company: { id: crypto.randomUUID(), legalName: "Generic Testing Company" },
      physicalAddress: { postalCode: "00000", city: "Nowhere", state: "ZZ" }
    })
  }
];

async function main(): Promise<void> {
  const recordsPath = readCliPathArg(process.argv, "records");
  const relationshipsPath = readCliPathArg(process.argv, "relationships");

  console.log("Loading BWI snapshot adapter...");
  const adapter = await BusinessWiseSnapshotAdapter.load({ recordsPath, relationshipsPath });
  const stats = adapter.getLoadStats();

  console.log(`Loaded ${stats.recordCount} record(s) and ${stats.relationshipCount} relationship edge(s) in ${stats.loadDurationMs}ms`);
  console.log(`  Malformed records skipped: ${stats.malformedRecordCount}`);
  console.log(`  Malformed relationships skipped: ${stats.malformedRelationshipCount}`);
  console.log(`  Duplicate record ids rejected: ${stats.duplicateRecordIdCount}`);
  console.log("");

  console.log("Synthetic candidate-retrieval probes (all inputs are fabricated, not real production data):");
  for (const probe of SYNTHETIC_PROBES) {
    const startedAt = Date.now();
    const matches = await adapter.searchPotentialMatches(probe.candidate);
    const elapsedMs = Date.now() - startedAt;
    console.log(`  - ${probe.label}: ${matches.length} candidate(s) (bounded, indexed lookup) in ${elapsedMs}ms`);
  }
  console.log("");

  console.log("This adapter never writes to Business Wise, connects to production SQL, or stages/publishes records.");
  console.log("Manual entry through Delphi remains the only production write path.");
  console.log("Smoke test complete -- no data/sandbox.sqlite writes occurred.");
}

await main();
