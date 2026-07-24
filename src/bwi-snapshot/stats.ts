import type { BwiSnapshotRecord, BwiSnapshotRelationship } from "./types.ts";

/** Pure aggregate-counting helpers shared by `bun run bwi:validate` and the snapshot adapter's stats. Never return or log individual rows -- only counts. */

export function countByStatusCode(records: BwiSnapshotRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.statusCode] = (counts[record.statusCode] ?? 0) + 1;
  }
  return counts;
}

export function countBySiteTypeCode(records: BwiSnapshotRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const key = record.siteTypeCode ?? "(missing)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function countByRelationshipType(relationships: BwiSnapshotRelationship[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const relationship of relationships) {
    counts[relationship.relationshipType] = (counts[relationship.relationshipType] ?? 0) + 1;
  }
  return counts;
}

/**
 * Relationship edges whose child_bwi_id has no matching row in the records
 * snapshot. Parent absence is explicitly allowed (a parent/HQ/controlling
 * company may have no DFW directory row) and is never reported here -- only
 * the child side, since every child edge is expected to name a real DFW BWI
 * location.
 */
export function findMissingChildIds(
  records: BwiSnapshotRecord[],
  relationships: BwiSnapshotRelationship[]
): string[] {
  const recordIds = new Set(records.map((r) => r.bwiLocationId));
  const missing = new Set<string>();
  for (const relationship of relationships) {
    if (!recordIds.has(relationship.childBwiId)) {
      missing.add(relationship.childBwiId);
    }
  }
  return [...missing];
}

/** Distinct parent_bwi_id values with no matching row in the records snapshot -- informational only, never an error (see module doc above). */
export function findParentIdsAbsentFromRecords(
  records: BwiSnapshotRecord[],
  relationships: BwiSnapshotRelationship[]
): string[] {
  const recordIds = new Set(records.map((r) => r.bwiLocationId));
  const missing = new Set<string>();
  for (const relationship of relationships) {
    if (!recordIds.has(relationship.parentBwiId)) {
      missing.add(relationship.parentBwiId);
    }
  }
  return [...missing];
}
