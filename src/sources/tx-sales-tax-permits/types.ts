/**
 * Texas Comptroller "Texas Sales Tax Permit Holders" Socrata dataset
 * (data.texas.gov, dataset ID jrea-zgmq). This module is a source PROFILER
 * only -- see src/tx-permits-profile.ts. It does not implement a permanent
 * SourceAdapter, does not touch entity resolution or the BWI snapshot
 * adapter, and never writes to Business Wise/Delphi.
 */

export const TX_SALES_TAX_PERMITS_DATASET_ID = "jrea-zgmq";
export const TX_SALES_TAX_PERMITS_DOMAIN = "data.texas.gov";
export const TX_SALES_TAX_PERMITS_ENDPOINT = `https://${TX_SALES_TAX_PERMITS_DOMAIN}/api/v3/views/${TX_SALES_TAX_PERMITS_DATASET_ID}/query.json`;

/**
 * Raw fields as confirmed live from the dataset. Every field is typed as an
 * optional string -- Socrata "Text" columns are returned as JSON strings,
 * and treating every identifier/code this way (rather than coercing to a
 * number) is what keeps leading zeros (county codes, ZIPs, permit numbers)
 * intact. The index signature tolerates extra/renamed fields the live API
 * might add later (schema drift) -- this list is never assumed exhaustive.
 */
export type TxPermitRawRecord = {
  outlet_address?: string;
  outlet_city?: string;
  outlet_county_code?: string;
  outlet_first_sales_date?: string;
  outlet_inside_outside_city_limits_indicator?: string;
  outlet_naics_code?: string;
  outlet_name?: string;
  outlet_number?: string;
  outlet_permit_issue_date?: string;
  outlet_state?: string;
  outlet_zip_code?: string;
  taxpayer_address?: string;
  taxpayer_city?: string;
  taxpayer_county_code?: string;
  taxpayer_name?: string;
  taxpayer_number?: string;
  taxpayer_organization_type?: string;
  taxpayer_state?: string;
  taxpayer_zip_code?: string;
  [key: string]: unknown;
};

/**
 * One fetched row: the complete raw record, untouched, plus fetch/query
 * metadata attached alongside it -- never merged destructively into `raw`.
 * Derived/normalized values live in profiling code, never here.
 */
export type TxPermitObservation = {
  source_dataset_id: typeof TX_SALES_TAX_PERMITS_DATASET_ID;
  source_record_id: string;
  fetched_at: string;
  query_window_start: string;
  query_window_end: string;
  requested_counties: string[];
  source_url: string;
  raw: TxPermitRawRecord;
};

export function buildSourceRecordId(taxpayerNumber: string, outletNumber: string): string {
  return `${taxpayerNumber}:${outletNumber}`;
}

/**
 * Safely reads a raw field as a trimmed string without ever coercing a
 * JSON number back through `String()` in a way that could look like it
 * "fixes" a leading-zero loss that already happened at JSON.parse time --
 * it doesn't invent zeros that were already lost upstream, it just never
 * compounds the problem for values that are already correct strings.
 * Blank/whitespace-only values normalize to undefined (missing), same as
 * a genuinely absent field.
 */
export function toStringField(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return String(value);
}
