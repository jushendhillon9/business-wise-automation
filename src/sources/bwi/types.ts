import type { ExistingCompany } from "../../types.ts";

/**
 * Canonical intermediate shape both BWI read-only implementations produce
 * before handing off to the one shared mapping function (mapping.ts). The
 * snapshot adapter (CSV) and the live adapter (SQL Server) parse two
 * completely different wire formats, but both convert into this same loose,
 * string-keyed shape first — that's what keeps a single normalization path
 * (mapping.ts) instead of two adapters silently drifting into two different
 * domain models. Every field is an optional string (even numeric-looking
 * ones like employeeSizeSite) so both sources can produce it the same way:
 * "whatever text/value the source gave us for this column, or undefined."
 */
export type RawBwiDirectoryRecord = {
  bwiLocationId?: string;
  companyName?: string;
  alphasort?: string;
  address?: string;
  mailingAddress?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  website?: string;
  sicCode?: string;
  /** Raw BWI site-type code (S/H/B/R/U or already-normalized text), unnormalized. */
  siteTypeCode?: string;
  /** Raw BWI lifecycle/status code (DIRE/DEL/RDL/RDEL/research), unnormalized. */
  statusCode?: string;
  market?: string;
  county?: string;
  parentCompany?: string;
  affiliate?: string;
  employeeSizeSite?: string;
  employeeSizeSiteRawCode?: string;
  employeeSizeCompanyWide?: string;
  employeeSizeCompanyWideRawCode?: string;
  /** Raw audit/last-updated timestamp text, unparsed. */
  lastUpdatedAt?: string;
};

/** One row's mapping outcome — mirrors the existing SourceAdapter MappingResult convention (src/sources/types.ts), extended with the unknown-raw-code flags an import summary needs to report. */
export type BwiImportRowResult =
  | { ok: true; existing: ExistingCompany; unknownSiteTypeCode?: string; unknownLifecycleCode?: string }
  | { ok: false; reason: string; rawRecordId?: string };

/**
 * Bounded fetch options every BusinessWiseReadOnlySource implementation must
 * honor. `limit` is required and every implementation must enforce its own
 * hard cap regardless of what's requested — never trust the caller alone.
 * `afterId` is keyset pagination (stable id > cursor, ORDER BY id) rather
 * than OFFSET, since OFFSET stability against the live schema's actual
 * indexes is unverified (see docs/BWI_READ_ONLY_IMPORT.md).
 */
export type FetchExistingLocationsOptions = {
  limit: number;
  afterId?: string;
  /** Only rows with a last-updated audit timestamp at or after this ISO date. */
  updatedSince?: string;
  /** Fetch specific stable BWI ids. Implementations should bound the accepted count. */
  ids?: string[];
};

/**
 * Domain-neutral read interface for "give me existing BWI company-location
 * records to match candidates against." Two implementations exist —
 * `createBwiSnapshotSource()` (snapshot-adapter.ts, CSV) and
 * `createBwiLiveSource()` (live-adapter.ts, direct read-only SQL Server) —
 * and both emit the exact same `BwiImportRowResult[]` shape via the shared
 * mapping.ts. Deliberately narrow: no generic query/execute method, no
 * caller-supplied filter beyond the bounded options above. Only the
 * operations the current entity-resolution pipeline (which reads whatever
 * ends up in the local `existing_companies` table — see src/db.ts) actually
 * needs.
 */
export interface BusinessWiseReadOnlySource {
  sourceType: "bwi_snapshot" | "bwi_live";
  sourceName: string;
  fetchExistingLocations(options: FetchExistingLocationsOptions): Promise<BwiImportRowResult[]>;
}
