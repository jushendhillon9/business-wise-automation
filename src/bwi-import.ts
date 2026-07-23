import type { Database } from "bun:sqlite";
import {
  finishBwiImportRun,
  getExistingCompanyById,
  insertExistingCompany,
  startBwiImportRun
} from "./db.ts";
import type { BusinessWiseReadOnlySource, FetchExistingLocationsOptions } from "./sources/bwi/types.ts";
import type { ExistingCompany } from "./types.ts";

export type BwiImportSummary = {
  runId: string;
  sourceType: "bwi_snapshot" | "bwi_live";
  sourceName: string;
  status: "success" | "failed";
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  unknownSiteTypeCodes: string[];
  unknownLifecycleCodes: string[];
  validationErrors: string[];
  errorMessage?: string;
};

/**
 * Deep-equality compare ignoring `source.sourceObservationId`/`ingestedAt`,
 * which legitimately differ on every run even for byte-identical source
 * data. Comparing on the full mapped ExistingCompany otherwise, so a
 * genuinely unchanged snapshot row reports as `unchanged`, not `updated`.
 */
function isUnchanged(previous: ExistingCompany, next: ExistingCompany): boolean {
  const strip = (company: ExistingCompany) => {
    const { source, fieldEvidence, ...rest } = company;
    return {
      ...rest,
      sourceId: source?.sourceId,
      sourceName: source?.sourceName,
      sourceUrl: source?.sourceUrl,
      sourceRecordId: source?.sourceRecordId,
      // Field evidence confidence/derivation/capturedAt are deterministic
      // per row given the same context, so comparing values (not
      // timestamps-of-ingestion) is enough to detect a real content change.
      fieldEvidenceValues: (fieldEvidence ?? []).map((e) => ({ path: e.path, value: e.value, rawValue: e.rawValue }))
    };
  };
  return JSON.stringify(strip(previous)) === JSON.stringify(strip(next));
}

/**
 * Upserts one mapped existing-BWI-location record, reusing
 * `insertExistingCompany()` (src/db.ts) unchanged, but first checking
 * whether a row with this id already exists and whether its content would
 * actually change — so the caller can report accurate inserted/updated/
 * unchanged counts instead of always claiming "replaced." Never deletes
 * anything; a snapshot/page that simply doesn't mention a previously
 * imported id is not evidence that record should be removed.
 */
export function upsertBwiExistingLocation(db: Database, existing: ExistingCompany): "inserted" | "updated" | "unchanged" {
  const previous = getExistingCompanyById(db, existing.id);
  if (!previous) {
    insertExistingCompany(db, existing);
    return "inserted";
  }
  if (isUnchanged(previous, existing)) {
    // Still safe/idempotent to re-write, but skip the write entirely so a
    // rerun with no real changes is a true no-op at the storage layer too.
    return "unchanged";
  }
  insertExistingCompany(db, existing);
  return "updated";
}

/**
 * Runs one bounded BWI import: fetches from the given read-only source
 * (snapshot or live — identical from here on), upserts every accepted row,
 * and records a `bwi_import_runs` summary row. `clock` is injected (default
 * `() => new Date().toISOString()`) so tests can supply a fixed timestamp
 * and stay deterministic.
 */
export async function runBwiImport(
  db: Database,
  source: BusinessWiseReadOnlySource,
  options: FetchExistingLocationsOptions,
  clock: () => string = () => new Date().toISOString()
): Promise<BwiImportSummary> {
  const runId = crypto.randomUUID();
  const startedAt = clock();
  startBwiImportRun(db, { id: runId, sourceType: source.sourceType, sourceName: source.sourceName, startedAt });

  let rowsRead = 0;
  let rowsAccepted = 0;
  let rowsRejected = 0;
  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsUnchanged = 0;
  const unknownSiteTypeCodes = new Set<string>();
  const unknownLifecycleCodes = new Set<string>();
  const validationErrors: string[] = [];

  try {
    const results = await source.fetchExistingLocations(options);
    rowsRead = results.length;

    for (const result of results) {
      if (!result.ok) {
        rowsRejected += 1;
        validationErrors.push(result.rawRecordId ? `${result.rawRecordId}: ${result.reason}` : result.reason);
        continue;
      }

      rowsAccepted += 1;
      if (result.unknownSiteTypeCode) unknownSiteTypeCodes.add(result.unknownSiteTypeCode);
      if (result.unknownLifecycleCode) unknownLifecycleCodes.add(result.unknownLifecycleCode);

      const outcome = upsertBwiExistingLocation(db, result.existing);
      if (outcome === "inserted") rowsInserted += 1;
      else if (outcome === "updated") rowsUpdated += 1;
      else rowsUnchanged += 1;
    }

    finishBwiImportRun(db, runId, {
      finishedAt: clock(),
      status: "success",
      rowsRead,
      rowsAccepted,
      rowsRejected,
      rowsInserted,
      rowsUpdated,
      rowsUnchanged,
      unknownSiteTypeCodes: [...unknownSiteTypeCodes],
      unknownLifecycleCodes: [...unknownLifecycleCodes],
      validationErrors
    });

    return {
      runId,
      sourceType: source.sourceType,
      sourceName: source.sourceName,
      status: "success",
      rowsRead,
      rowsAccepted,
      rowsRejected,
      rowsInserted,
      rowsUpdated,
      rowsUnchanged,
      unknownSiteTypeCodes: [...unknownSiteTypeCodes],
      unknownLifecycleCodes: [...unknownLifecycleCodes],
      validationErrors
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    finishBwiImportRun(db, runId, {
      finishedAt: clock(),
      status: "failed",
      rowsRead,
      rowsAccepted,
      rowsRejected,
      rowsInserted,
      rowsUpdated,
      rowsUnchanged,
      unknownSiteTypeCodes: [...unknownSiteTypeCodes],
      unknownLifecycleCodes: [...unknownLifecycleCodes],
      validationErrors,
      errorMessage
    });

    return {
      runId,
      sourceType: source.sourceType,
      sourceName: source.sourceName,
      status: "failed",
      rowsRead,
      rowsAccepted,
      rowsRejected,
      rowsInserted,
      rowsUpdated,
      rowsUnchanged,
      unknownSiteTypeCodes: [...unknownSiteTypeCodes],
      unknownLifecycleCodes: [...unknownLifecycleCodes],
      validationErrors,
      errorMessage
    };
  }
}
