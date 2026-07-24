import { parseCsv } from "../sources/csv.ts";
import type { BwiSnapshotRecord, BwiSnapshotRelationship } from "./types.ts";

/**
 * Header-name-based parsing for the two real BWI DFW production snapshot
 * CSVs (SSMS exports). Deliberately does not assume column order -- every
 * field is looked up by its trimmed, lowercased header name. Fails clearly
 * (throws BwiSnapshotHeaderError) when a required header is missing;
 * optional fields simply come back undefined when their column is absent.
 *
 * Reuses the existing RFC4180-ish parser (src/sources/csv.ts) rather than
 * adding a dependency -- it already handles quoted fields, embedded commas,
 * embedded newlines, doubled-quote escaping, and CRLF line endings, which
 * covers what an SSMS export needs (see src/bwi-snapshot/parse.test.ts for
 * the coverage of each case against this module specifically).
 */

export class BwiSnapshotHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BwiSnapshotHeaderError";
  }
}

export const RECORDS_REQUIRED_HEADERS = ["bwi_location_id", "company_name", "status_code", "site_type_code"] as const;
export const RELATIONSHIPS_REQUIRED_HEADERS = ["relationship_type", "parent_bwi_id", "child_bwi_id"] as const;

export type ParsedBwiRecords = {
  records: BwiSnapshotRecord[];
  totalDataRows: number;
  /** Rows skipped because a required field (id/company name/status) was blank. */
  malformedCount: number;
  /** Distinct bwi_location_id values that appeared more than once. */
  duplicateIds: string[];
  /** Total extra rows beyond each id's first occurrence (i.e. rows dropped for being a duplicate). */
  duplicateRowCount: number;
};

export type ParsedBwiRelationships = {
  relationships: BwiSnapshotRelationship[];
  totalDataRows: number;
  /** Rows skipped because a required field (type/parent id/child id) was blank. */
  malformedCount: number;
};

function normalizeHeaderName(header: string): string {
  return header.trim().toLowerCase();
}

function buildHeaderIndex(headerRow: string[]): Map<string, number> {
  const index = new Map<string, number>();
  headerRow.forEach((header, position) => {
    index.set(normalizeHeaderName(header), position);
  });
  return index;
}

function assertRequiredHeaders(headerIndex: Map<string, number>, required: readonly string[], fileLabel: string): void {
  const missing = required.filter((name) => !headerIndex.has(name));
  if (missing.length > 0) {
    throw new BwiSnapshotHeaderError(`${fileLabel}: missing required header(s): ${missing.join(", ")}`);
  }
}

/** Trims and normalizes a raw CSV cell: blank, literal "NULL", and literal "None" (any case) all become undefined. */
export function normalizeNullish(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (/^(null|none)$/i.test(trimmed)) return undefined;
  return trimmed;
}

function field(row: string[], headerIndex: Map<string, number>, name: string): string | undefined {
  const position = headerIndex.get(name);
  if (position === undefined) return undefined;
  return normalizeNullish(row[position]);
}

export function parseBwiRecordsCsv(text: string): ParsedBwiRecords {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new BwiSnapshotHeaderError("BWI records CSV: file is empty (no header row found)");
  }

  const headerIndex = buildHeaderIndex(rows[0]!);
  assertRequiredHeaders(headerIndex, RECORDS_REQUIRED_HEADERS, "BWI records CSV");

  const dataRows = rows.slice(1);
  const records: BwiSnapshotRecord[] = [];
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  let malformedCount = 0;
  let duplicateRowCount = 0;

  for (const row of dataRows) {
    const bwiLocationId = field(row, headerIndex, "bwi_location_id");
    const companyName = field(row, headerIndex, "company_name");
    const statusCode = field(row, headerIndex, "status_code");

    if (!bwiLocationId || !companyName || !statusCode) {
      malformedCount += 1;
      continue;
    }

    if (seenIds.has(bwiLocationId)) {
      duplicateIds.add(bwiLocationId);
      duplicateRowCount += 1;
      continue;
    }
    seenIds.add(bwiLocationId);

    records.push({
      bwiLocationId,
      companyName,
      alphaSort: field(row, headerIndex, "alpha_sort"),
      statusCode,
      statusDescription: field(row, headerIndex, "status_description"),
      marketId: field(row, headerIndex, "market_id"),
      marketName: field(row, headerIndex, "market_name"),
      marketAbbreviation: field(row, headerIndex, "market_abbreviation"),
      siteTypeCode: field(row, headerIndex, "site_type_code"),
      siteTypeDescription: field(row, headerIndex, "site_type_description"),
      address: field(row, headerIndex, "address"),
      buildingNumber: field(row, headerIndex, "building_number"),
      street: field(row, headerIndex, "street"),
      suiteNumber: field(row, headerIndex, "suite_number"),
      city: field(row, headerIndex, "city"),
      state: field(row, headerIndex, "state"),
      zip: field(row, headerIndex, "zip"),
      zipPlus: field(row, headerIndex, "zip_plus"),
      county: field(row, headerIndex, "county"),
      phone: field(row, headerIndex, "phone"),
      website: field(row, headerIndex, "website"),
      sic: field(row, headerIndex, "sic"),
      naics: field(row, headerIndex, "naics"),
      startYear: field(row, headerIndex, "start_year"),
      siteSizeCode: field(row, headerIndex, "site_size_code"),
      siteEmployeeCount: field(row, headerIndex, "site_employee_count"),
      companySizeCode: field(row, headerIndex, "company_size_code"),
      numberOfSites: field(row, headerIndex, "number_of_sites"),
      buildingTypeCode: field(row, headerIndex, "building_type_code"),
      addressTypeCode: field(row, headerIndex, "address_type_code"),
      addressValidationCode: field(row, headerIndex, "address_validation_code"),
      latitude: field(row, headerIndex, "latitude"),
      longitude: field(row, headerIndex, "longitude"),
      enteredDate: field(row, headerIndex, "entered_date"),
      baseDate: field(row, headerIndex, "base_date"),
      researchedDate: field(row, headerIndex, "researched_date")
    });
  }

  return {
    records,
    totalDataRows: dataRows.length,
    malformedCount,
    duplicateIds: [...duplicateIds],
    duplicateRowCount
  };
}

export function parseBwiRelationshipsCsv(text: string): ParsedBwiRelationships {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new BwiSnapshotHeaderError("BWI relationships CSV: file is empty (no header row found)");
  }

  const headerIndex = buildHeaderIndex(rows[0]!);
  assertRequiredHeaders(headerIndex, RELATIONSHIPS_REQUIRED_HEADERS, "BWI relationships CSV");

  const dataRows = rows.slice(1);
  const relationships: BwiSnapshotRelationship[] = [];
  let malformedCount = 0;

  for (const row of dataRows) {
    const relationshipType = field(row, headerIndex, "relationship_type");
    const parentBwiId = field(row, headerIndex, "parent_bwi_id");
    const childBwiId = field(row, headerIndex, "child_bwi_id");

    if (!relationshipType || !parentBwiId || !childBwiId) {
      malformedCount += 1;
      continue;
    }

    relationships.push({
      relationshipType,
      relationshipDescription: field(row, headerIndex, "relationship_description"),
      parentBwiId,
      parentCompanyName: field(row, headerIndex, "parent_company_name"),
      parentAlphaSort: field(row, headerIndex, "parent_alpha_sort"),
      parentIsFortune1000: field(row, headerIndex, "parent_is_fortune_1000"),
      parentCity: field(row, headerIndex, "parent_city"),
      parentState: field(row, headerIndex, "parent_state"),
      parentCountry: field(row, headerIndex, "parent_country"),
      parentStockTicker: field(row, headerIndex, "parent_stock_ticker"),
      childBwiId,
      childCompanyName: field(row, headerIndex, "child_company_name"),
      childStatus: field(row, headerIndex, "child_status"),
      childSiteType: field(row, headerIndex, "child_site_type"),
      childMarketId: field(row, headerIndex, "child_market_id"),
      childCity: field(row, headerIndex, "child_city"),
      childState: field(row, headerIndex, "child_state")
    });
  }

  return { relationships, totalDataRows: dataRows.length, malformedCount };
}
