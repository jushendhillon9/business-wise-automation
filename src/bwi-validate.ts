import { BwiSnapshotHeaderError, parseBwiRecordsCsv, parseBwiRelationshipsCsv } from "./bwi-snapshot/parse.ts";
import { readCliPathArg, resolveRecordsSnapshotPath, resolveRelationshipsSnapshotPath } from "./bwi-snapshot/paths.ts";
import {
  countByRelationshipType,
  countBySiteTypeCode,
  countByStatusCode,
  findMissingChildIds,
  findParentIdsAbsentFromRecords
} from "./bwi-snapshot/stats.ts";

/**
 * `bun run bwi:validate` -- structural validation and safe aggregate counts
 * for the two real BWI DFW snapshots. Never prints a full record, address,
 * company name, or contact -- only counts, headers, sizes, and timing. See
 * data/private/bwi/README.md.
 */

const EXPECTED_RECORD_COUNT = 241_194;
const EXPECTED_RELATIONSHIP_COUNT = 57_575;
const EXPECTED_DEVIATION_WARNING_RATIO = 0.2; // >20% off from the documented approximate count is worth flagging
const EXPECTED_STATUSES = ["DIRE", "KEEP", "RSCH", "RDEL", "DELE"];
const EXPECTED_RELATIONSHIP_TYPES = ["AFFL", "HQTR"];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function printCounts(label: string, counts: Record<string, number>): void {
  console.log(`  ${label}:`);
  for (const [key, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key}: ${count}`);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let structuralErrors = 0;

  const recordsPath = resolveRecordsSnapshotPath(readCliPathArg(process.argv, "records"));
  const relationshipsPath = resolveRelationshipsSnapshotPath(readCliPathArg(process.argv, "relationships"));

  console.log(`Records snapshot:       ${recordsPath}`);
  console.log(`Relationships snapshot: ${relationshipsPath}`);
  console.log("");

  const recordsFile = Bun.file(recordsPath);
  const relationshipsFile = Bun.file(relationshipsPath);

  const recordsExist = await recordsFile.exists();
  const relationshipsExist = await relationshipsFile.exists();

  if (!recordsExist) {
    console.error(`ERROR: records snapshot not found at "${recordsPath}". See data/private/bwi/README.md.`);
    structuralErrors += 1;
  }
  if (!relationshipsExist) {
    console.error(`ERROR: relationships snapshot not found at "${relationshipsPath}". See data/private/bwi/README.md.`);
    structuralErrors += 1;
  }

  if (structuralErrors > 0) {
    process.exit(1);
  }

  console.log(`Records file size:       ${formatBytes(recordsFile.size)}`);
  console.log(`Relationships file size: ${formatBytes(relationshipsFile.size)}`);
  console.log("");

  let parsedRecords: ReturnType<typeof parseBwiRecordsCsv> | undefined;
  let parsedRelationships: ReturnType<typeof parseBwiRelationshipsCsv> | undefined;

  try {
    const recordsText = await recordsFile.text();
    parsedRecords = parseBwiRecordsCsv(recordsText);
  } catch (error) {
    if (error instanceof BwiSnapshotHeaderError) {
      console.error(`ERROR: ${error.message}`);
      structuralErrors += 1;
    } else {
      throw error;
    }
  }

  try {
    const relationshipsText = await relationshipsFile.text();
    parsedRelationships = parseBwiRelationshipsCsv(relationshipsText);
  } catch (error) {
    if (error instanceof BwiSnapshotHeaderError) {
      console.error(`ERROR: ${error.message}`);
      structuralErrors += 1;
    } else {
      throw error;
    }
  }

  if (!parsedRecords || !parsedRelationships) {
    process.exit(1);
  }

  console.log(`Records: ${parsedRecords.records.length} valid data row(s) of ${parsedRecords.totalDataRows} total`);
  console.log(`  Malformed rows (missing required field): ${parsedRecords.malformedCount}`);
  console.log(`  Duplicate bwi_location_id values: ${parsedRecords.duplicateIds.length}`);
  if (Math.abs(parsedRecords.records.length - EXPECTED_RECORD_COUNT) / EXPECTED_RECORD_COUNT > EXPECTED_DEVIATION_WARNING_RATIO) {
    console.warn(
      `  WARNING: record count deviates by more than ${EXPECTED_DEVIATION_WARNING_RATIO * 100}% from the documented ~${EXPECTED_RECORD_COUNT}.`
    );
  }
  console.log("");

  const statusCounts = countByStatusCode(parsedRecords.records);
  printCounts("Status counts", statusCounts);
  const missingStatuses = EXPECTED_STATUSES.filter((status) => !(status in statusCounts));
  if (missingStatuses.length > 0) {
    console.warn(`  WARNING: expected lifecycle status(es) not observed: ${missingStatuses.join(", ")}`);
  }
  console.log("");

  const siteTypeCounts = countBySiteTypeCode(parsedRecords.records);
  printCounts("Site type counts", siteTypeCounts);
  console.log("");

  console.log(`Relationships: ${parsedRelationships.relationships.length} valid edge(s) of ${parsedRelationships.totalDataRows} total`);
  console.log(`  Malformed rows (missing required field): ${parsedRelationships.malformedCount}`);
  if (
    Math.abs(parsedRelationships.relationships.length - EXPECTED_RELATIONSHIP_COUNT) / EXPECTED_RELATIONSHIP_COUNT >
    EXPECTED_DEVIATION_WARNING_RATIO
  ) {
    console.warn(
      `  WARNING: relationship count deviates by more than ${EXPECTED_DEVIATION_WARNING_RATIO * 100}% from the documented ~${EXPECTED_RELATIONSHIP_COUNT}.`
    );
  }
  console.log("");

  const relationshipTypeCounts = countByRelationshipType(parsedRelationships.relationships);
  printCounts("Relationship type counts", relationshipTypeCounts);
  const missingRelationshipTypes = EXPECTED_RELATIONSHIP_TYPES.filter((type) => !(type in relationshipTypeCounts));
  if (missingRelationshipTypes.length > 0) {
    console.warn(`  WARNING: expected relationship type(s) not observed: ${missingRelationshipTypes.join(", ")}`);
  }
  console.log("");

  const missingChildIds = findMissingChildIds(parsedRecords.records, parsedRelationships.relationships);
  const parentIdsAbsent = findParentIdsAbsentFromRecords(parsedRecords.records, parsedRelationships.relationships);
  console.log(`Relationship edges with child_bwi_id absent from records: ${missingChildIds.length} (warning only)`);
  console.log(`Relationship edges with parent_bwi_id absent from records: ${parentIdsAbsent.length} (expected/allowed -- parents need no DFW row)`);
  console.log("");

  // Structural errors: missing headers (already handled above), and duplicate
  // bwi_location_id values -- the adapter refuses to load an ambiguous
  // snapshot for the same reason, so validate must agree and fail closed.
  if (parsedRecords.duplicateIds.length > 0) {
    console.error(`ERROR: ${parsedRecords.duplicateIds.length} duplicate bwi_location_id value(s) found. Snapshot is ambiguous.`);
    structuralErrors += 1;
  }

  console.log(`Validation completed in ${Date.now() - startedAt}ms`);

  if (structuralErrors > 0) {
    console.error(`\n${structuralErrors} structural error(s) found.`);
    process.exit(1);
  }

  console.log("\nNo structural errors found.");
}

await main();
