import { parseCsv, parseCsvRecords } from "../csv.ts";
import { mapRawBwiRecordToExistingLocation, type BwiMappingContext } from "./mapping.ts";
import type { BusinessWiseReadOnlySource, BwiImportRowResult, FetchExistingLocationsOptions, RawBwiDirectoryRecord } from "./types.ts";

/**
 * Local snapshot schema (CSV). Column names are deterministic, snake_case,
 * and documented in docs/BWI_READ_ONLY_IMPORT.md. Only `bwi_location_id` and
 * `company_name` are required; every other column is optional and tolerated
 * absent. See that doc for the full schema and a synthetic example fixture
 * at data/sources/bwi-snapshot-sample.csv.
 */
const REQUIRED_HEADERS = ["bwi_location_id", "company_name"];

export type BwiSnapshotAdapterOptions = {
  filePath: string;
  sourceId?: string;
  sourceName?: string;
  /** SourceProvenance.ingestedAt for every row this fetch produces — an injected clock value, never Date.now() computed inside the adapter. */
  ingestedAt: string;
  /** When the snapshot file was exported, if known. Never fabricated when absent. */
  exportedAt?: string;
};

function toRawRecord(row: Record<string, string>): RawBwiDirectoryRecord {
  return {
    bwiLocationId: row.bwi_location_id,
    companyName: row.company_name,
    alphasort: row.alphasort,
    address: row.address,
    mailingAddress: row.mailing_address,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    phone: row.phone,
    website: row.website,
    sicCode: row.sic_code,
    siteTypeCode: row.site_type_code,
    statusCode: row.status_code,
    market: row.market,
    county: row.county,
    parentCompany: row.parent_company,
    affiliate: row.affiliate,
    employeeSizeSite: row.employee_size_site,
    employeeSizeSiteRawCode: row.employee_size_site_raw_code,
    employeeSizeCompanyWide: row.employee_size_company_wide,
    employeeSizeCompanyWideRawCode: row.employee_size_company_wide_raw_code,
    lastUpdatedAt: row.last_updated_at
  };
}

/**
 * Reads a local BWI snapshot export (CSV) and maps every row through the
 * shared mapping.ts path. Deterministic, offline, and safe to rerun — the
 * intended default path for tests, local development, and CI, and a
 * fallback whenever VPN/allowlisting/credentials for the live adapter
 * aren't available. Never fetches anything external; `filePath` must point
 * at a local file (see docs/BWI_READ_ONLY_IMPORT.md for where real exports
 * belong — never committed to the repo).
 */
export function createBwiSnapshotSource(options: BwiSnapshotAdapterOptions): BusinessWiseReadOnlySource {
  const sourceId = options.sourceId ?? "bwi-snapshot";
  const sourceName = options.sourceName ?? "BWI local read-only snapshot export";

  return {
    sourceType: "bwi_snapshot",
    sourceName,

    async fetchExistingLocations(fetchOptions: FetchExistingLocationsOptions): Promise<BwiImportRowResult[]> {
      const text = await Bun.file(options.filePath).text();
      const rawRows = parseCsv(text);
      if (rawRows.length === 0) {
        throw new Error(`BWI snapshot file has no header row: ${options.filePath}`);
      }

      const header = rawRows[0]!.map((h) => h.trim());
      const missingHeaders = REQUIRED_HEADERS.filter((required) => !header.includes(required));
      if (missingHeaders.length > 0) {
        throw new Error(
          `BWI snapshot file "${options.filePath}" is missing required column(s): ${missingHeaders.join(", ")}. ` +
            `See docs/BWI_READ_ONLY_IMPORT.md for the required snapshot schema.`
        );
      }

      let rows = parseCsvRecords(text);

      if (fetchOptions.ids && fetchOptions.ids.length > 0) {
        const idSet = new Set(fetchOptions.ids);
        rows = rows.filter((row) => idSet.has(row.bwi_location_id ?? ""));
      }
      if (fetchOptions.afterId !== undefined) {
        rows = rows.filter((row) => (row.bwi_location_id ?? "") > fetchOptions.afterId!);
      }
      if (fetchOptions.updatedSince !== undefined) {
        rows = rows.filter((row) => !row.last_updated_at || row.last_updated_at >= fetchOptions.updatedSince!);
      }

      // Deterministic order, matching the live adapter's ORDER BY bwi_location_id ASC.
      rows = [...rows].sort((a, b) => (a.bwi_location_id ?? "").localeCompare(b.bwi_location_id ?? ""));
      rows = rows.slice(0, fetchOptions.limit);

      const context: BwiMappingContext = {
        sourceType: "bwi_snapshot",
        sourceId,
        sourceName,
        ingestedAt: options.ingestedAt,
        capturedAt: options.exportedAt
      };

      return rows.map((row) => mapRawBwiRecordToExistingLocation(toRawRecord(row), context));
    }
  };
}
