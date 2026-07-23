import sql from "mssql";
import { mapRawBwiRecordToExistingLocation, type BwiMappingContext } from "./mapping.ts";
import type { BusinessWiseReadOnlySource, BwiImportRowResult, FetchExistingLocationsOptions, RawBwiDirectoryRecord } from "./types.ts";
import type { BwiLiveDbConfig } from "./live-config.ts";

/**
 * Direct, structurally read-only SQL Server adapter over the canonical BWI
 * directory layer (docs/BWI_PRODUCTION_DB_DISCOVERY.md §3.1). This module
 * exposes exactly one capability — `createBwiLiveSource(...).
 * fetchExistingLocations(options)` — built from a small, fixed set of
 * code-owned SELECT statements (see the *_SQL constants and
 * `buildFetchByIdsSql` below). There is:
 *
 * - no generic `execute(sql)`/`query(sql)` method exposed to callers
 * - no caller-supplied SQL text anywhere
 * - no INSERT / UPDATE / DELETE / MERGE / EXEC / CREATE / ALTER / DROP /
 *   TRUNCATE statement anywhere in this file
 * - no stored-procedure invocation
 * - no temporary tables, no schema changes, no write transactions
 *
 * `src/sources/bwi/live-adapter.test.ts` enforces this: it scans the
 * exported SQL constants (and, as a broader safety net, this file's own
 * source text with comments stripped) for forbidden SQL verbs, and asserts
 * this module exports no generic query/execute method.
 *
 * IMPORTANT — column/table names below are NOT confirmed by
 * docs/BWI_PRODUCTION_DB_DISCOVERY.md. That discovery confirmed the
 * table-level roles of DirCompany/DirCompanyDirectory (§3.1) but explicitly
 * did not capture column-level detail ("not every column's exact business
 * meaning is confirmed" — §3.1). The names in `SCHEMA` below are a
 * best-effort placeholder, informed only by one confirmed clue (§5's
 * observed `ResearchData` `Edit...` field-name pattern — `EditName`,
 * `EditAddress`, `EditWebsite`, `EditSIC`, `EditPhone...`, `EditSize...` —
 * which suggests, but does not prove, similarly-named canonical columns).
 * **Needs confirmation from Jushen** before this adapter is ever pointed at
 * a real server: every table/column name in `SCHEMA` must be verified
 * against the actual schema. Centralized here specifically so correcting it
 * is a one-place edit, not a search-and-replace across SQL text.
 */
const SCHEMA = {
  companyTable: "DirCompany",
  directoryTable: "DirCompanyDirectory",
  companyIdColumn: "Id",
  /** FK on DirCompanyDirectory referencing DirCompany's id column. Unconfirmed name. */
  directoryCompanyIdColumn: "CompanyId",
  nameColumn: "Name",
  alphasortColumn: "Alphasort",
  addressColumn: "Address",
  mailingAddressColumn: "MailingAddress",
  cityColumn: "City",
  stateColumn: "State",
  postalCodeColumn: "PostalCode",
  phoneColumn: "Phone",
  websiteColumn: "Website",
  sicColumn: "SIC",
  siteTypeColumn: "SiteType",
  statusColumn: "Status",
  marketColumn: "Market",
  countyColumn: "County",
  parentCompanyColumn: "ParentCompany",
  affiliateColumn: "Affiliate",
  employeeSizeSiteColumn: "EmployeeSizeSite",
  employeeSizeCompanyWideColumn: "EmployeeSizeCompanyWide",
  lastUpdatedColumn: "LastUpdated"
} as const;

/** Hard operational caps enforced regardless of what a caller requests. */
const MAX_LIVE_LIMIT = 500;
const MAX_IDS_PER_FETCH = 100;

function selectColumns(): string {
  const c = SCHEMA;
  return [
    `dc.${c.companyIdColumn} AS BwiLocationId`,
    `dc.${c.nameColumn} AS CompanyName`,
    `dc.${c.alphasortColumn} AS Alphasort`,
    `dcd.${c.addressColumn} AS Address`,
    `dcd.${c.mailingAddressColumn} AS MailingAddress`,
    `dcd.${c.cityColumn} AS City`,
    `dcd.${c.stateColumn} AS State`,
    `dcd.${c.postalCodeColumn} AS PostalCode`,
    `dcd.${c.phoneColumn} AS Phone`,
    `dc.${c.websiteColumn} AS Website`,
    `dc.${c.sicColumn} AS SicCode`,
    `dcd.${c.siteTypeColumn} AS SiteTypeCode`,
    `dcd.${c.statusColumn} AS StatusCode`,
    `dcd.${c.marketColumn} AS Market`,
    `dcd.${c.countyColumn} AS County`,
    `dc.${c.parentCompanyColumn} AS ParentCompany`,
    `dc.${c.affiliateColumn} AS Affiliate`,
    `dcd.${c.employeeSizeSiteColumn} AS EmployeeSizeSite`,
    `dc.${c.employeeSizeCompanyWideColumn} AS EmployeeSizeCompanyWide`,
    `dcd.${c.lastUpdatedColumn} AS LastUpdatedAt`
  ].join(",\n    ");
}

function fromClause(): string {
  return `FROM ${SCHEMA.companyTable} dc\n  INNER JOIN ${SCHEMA.directoryTable} dcd ON dcd.${SCHEMA.directoryCompanyIdColumn} = dc.${SCHEMA.companyIdColumn}`;
}

/** Bounded, deterministic keyset page: stable id > cursor, ordered ascending. Never OFFSET (unstable against an unverified index). */
export const FETCH_PAGE_SQL = `SELECT TOP (@limit)
    ${selectColumns()}
  ${fromClause()}
  WHERE (@afterId IS NULL OR dc.${SCHEMA.companyIdColumn} > @afterId)
  ORDER BY dc.${SCHEMA.companyIdColumn} ASC`;

/** Bounded updated-since fetch, still capped by TOP and still deterministically ordered. */
export const FETCH_UPDATED_SINCE_SQL = `SELECT TOP (@limit)
    ${selectColumns()}
  ${fromClause()}
  WHERE dcd.${SCHEMA.lastUpdatedColumn} >= @updatedSince
  ORDER BY dc.${SCHEMA.companyIdColumn} ASC`;

const SAFE_PARAM_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Bounded fetch by a fixed list of stable ids, each bound as its own
 * parameter — never string-concatenated. `paramNames` must be the
 * placeholder names only (e.g. "id0", "id1", ...), never the id values
 * themselves; every name is validated against a strict allowlist pattern
 * before being interpolated into the SQL text, so even a caller that
 * misuses this function (passes something that isn't a plain identifier)
 * gets a thrown error instead of malformed/unsafe SQL text.
 */
export function buildFetchByIdsSql(paramNames: readonly string[]): string {
  for (const name of paramNames) {
    if (!SAFE_PARAM_NAME.test(name)) {
      throw new Error(`Invalid SQL parameter name "${name}" — must match ${SAFE_PARAM_NAME}.`);
    }
  }

  return `SELECT
    ${selectColumns()}
  ${fromClause()}
  WHERE dc.${SCHEMA.companyIdColumn} IN (${paramNames.map((name) => `@${name}`).join(", ")})
  ORDER BY dc.${SCHEMA.companyIdColumn} ASC`;
}

function toOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function rowsToRaw(recordset: Array<Record<string, unknown>>): RawBwiDirectoryRecord[] {
  return recordset.map((row) => ({
    bwiLocationId: toOptionalString(row.BwiLocationId),
    companyName: toOptionalString(row.CompanyName),
    alphasort: toOptionalString(row.Alphasort),
    address: toOptionalString(row.Address),
    mailingAddress: toOptionalString(row.MailingAddress),
    city: toOptionalString(row.City),
    state: toOptionalString(row.State),
    postalCode: toOptionalString(row.PostalCode),
    phone: toOptionalString(row.Phone),
    website: toOptionalString(row.Website),
    sicCode: toOptionalString(row.SicCode),
    siteTypeCode: toOptionalString(row.SiteTypeCode),
    statusCode: toOptionalString(row.StatusCode),
    market: toOptionalString(row.Market),
    county: toOptionalString(row.County),
    parentCompany: toOptionalString(row.ParentCompany),
    affiliate: toOptionalString(row.Affiliate),
    employeeSizeSite: toOptionalString(row.EmployeeSizeSite),
    employeeSizeCompanyWide: toOptionalString(row.EmployeeSizeCompanyWide),
    lastUpdatedAt: row.LastUpdatedAt ? new Date(row.LastUpdatedAt as string).toISOString() : undefined
  }));
}

/**
 * Creates the live read-only BWI source. Connecting happens lazily, inside
 * `fetchExistingLocations()`, and the pool is always closed in a `finally`
 * — no connection is held open beyond one bounded fetch. Never called by
 * `bun test` or `bun run reset`; only by the explicit, manual
 * `bun run bwi:smoke -- --live` command (see src/bwi-smoke-cli.ts).
 */
export function createBwiLiveSource(config: BwiLiveDbConfig, options: { sourceName?: string } = {}): BusinessWiseReadOnlySource {
  const sourceId = "bwi-live";
  const sourceName = options.sourceName ?? "BWI canonical directory (live read-only)";

  async function withPool<T>(fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
    const pool = new sql.ConnectionPool({
      server: config.server,
      database: config.database,
      user: config.user,
      password: config.password,
      port: config.port,
      options: {
        encrypt: config.encrypt,
        trustServerCertificate: config.trustServerCertificate,
        // Requests routing to an Always On readable secondary when the
        // target supports it. Does not by itself block writes against a
        // primary -- the fixed-SELECT-only surface above is the actual
        // enforced guardrail. Set BWI_DB_READ_ONLY_INTENT=false if the
        // target server rejects this option.
        readOnlyIntent: config.readOnlyIntent
      }
    });

    try {
      await pool.connect();
      return await fn(pool);
    } finally {
      await pool.close();
    }
  }

  return {
    sourceType: "bwi_live",
    sourceName,

    async fetchExistingLocations(fetchOptions: FetchExistingLocationsOptions): Promise<BwiImportRowResult[]> {
      const limit = Math.max(1, Math.min(fetchOptions.limit, MAX_LIVE_LIMIT));
      // The only place this module computes "now" -- an IO-boundary side
      // effect confined here, never inside the pure mapping.ts function.
      const ingestedAt = new Date().toISOString();
      const context: BwiMappingContext = { sourceType: "bwi_live", sourceId, sourceName, ingestedAt };

      const rawRows = await withPool(async (pool) => {
        if (fetchOptions.ids && fetchOptions.ids.length > 0) {
          const boundedIds = fetchOptions.ids.slice(0, MAX_IDS_PER_FETCH);
          const paramNames = boundedIds.map((_, index) => `id${index}`);
          const request = pool.request();
          boundedIds.forEach((id, index) => request.input(paramNames[index]!, sql.NVarChar, id));
          const result = await request.query(buildFetchByIdsSql(paramNames));
          return rowsToRaw(result.recordset as Array<Record<string, unknown>>);
        }

        if (fetchOptions.updatedSince !== undefined) {
          const request = pool.request();
          request.input("limit", sql.Int, limit);
          request.input("updatedSince", sql.DateTime2, new Date(fetchOptions.updatedSince));
          const result = await request.query(FETCH_UPDATED_SINCE_SQL);
          return rowsToRaw(result.recordset as Array<Record<string, unknown>>);
        }

        const request = pool.request();
        request.input("limit", sql.Int, limit);
        request.input("afterId", sql.NVarChar, fetchOptions.afterId ?? null);
        const result = await request.query(FETCH_PAGE_SQL);
        return rowsToRaw(result.recordset as Array<Record<string, unknown>>);
      });

      return rawRows.map((raw) => mapRawBwiRecordToExistingLocation(raw, context));
    }
  };
}
