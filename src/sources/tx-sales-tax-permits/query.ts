/**
 * Query-window resolution, county-filter parsing, and SoQL query
 * construction for the Texas sales-tax-permit profiler. Kept separate from
 * client.ts (the HTTP/retry layer) so query correctness can be tested
 * without any network mocking at all.
 */

export const DEFAULT_DFW_COUNTY_CODES: readonly string[] = ["043", "057", "061", "220"];

/**
 * Documentation only -- not an authoritative or final definition of
 * Business Wise's DFW market. Do not hard-code an assumption elsewhere in
 * this module that these four counties are final; --counties always
 * overrides this default.
 */
export const DFW_COUNTY_NAMES: Readonly<Record<string, string>> = {
  "043": "Collin",
  "057": "Dallas",
  "061": "Denton",
  "220": "Tarrant"
};

const DEFAULT_WINDOW_DAYS = 7;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type QueryWindow = {
  /** Inclusive window start, calendar date (YYYY-MM-DD). */
  start: string;
  /** Exclusive window end, calendar date (YYYY-MM-DD). */
  end: string;
};

export type QueryWindowInput = {
  days?: number;
  from?: string;
  to?: string;
  /** Injectable "now" for deterministic tests of the --days path. */
  now?: Date;
};

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves the query window from either an explicit --from/--to pair or a
 * --days lookback (default 7). --from/--to must both be provided together
 * and --from must be strictly earlier than --to; either error is reported
 * clearly rather than silently picking one flag over the other.
 */
export function resolveQueryWindow(input: QueryWindowInput = {}): QueryWindow {
  if (input.from !== undefined || input.to !== undefined) {
    if (input.from === undefined || input.to === undefined) {
      throw new Error("resolveQueryWindow(): --from and --to must both be provided together.");
    }
    if (!ISO_DATE_PATTERN.test(input.from) || !ISO_DATE_PATTERN.test(input.to)) {
      throw new Error(`resolveQueryWindow(): --from/--to must be ISO dates (YYYY-MM-DD), got "${input.from}"/"${input.to}".`);
    }
    if (input.from >= input.to) {
      throw new Error(`resolveQueryWindow(): --from ("${input.from}") must be earlier than --to ("${input.to}").`);
    }
    return { start: input.from, end: input.to };
  }

  const days = input.days ?? DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`resolveQueryWindow(): --days must be a positive integer, got ${input.days}.`);
  }

  const now = input.now ?? new Date();
  const end = toDateOnly(now);
  const start = toDateOnly(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  return { start, end };
}

/** Parses a comma-separated --counties flag, falling back to the default DFW county codes. */
export function parseCountyCodes(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_DFW_COUNTY_CODES];
  const codes = raw
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  if (codes.length === 0) {
    throw new Error("parseCountyCodes(): --counties must not be empty.");
  }
  return codes;
}

export type SoqlPage = {
  limit: number;
  offset: number;
};

function escapeSoqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Builds the SoQL query for one bounded, deterministically-ordered page:
 * county filter + permit-issue-date window filter, ordered by
 * (outlet_permit_issue_date, taxpayer_number, outlet_number) so pagination
 * never depends on implicit API ordering, with explicit LIMIT/OFFSET.
 */
export function buildSoqlQuery(window: QueryWindow, counties: readonly string[], page: SoqlPage): string {
  if (counties.length === 0) {
    throw new Error("buildSoqlQuery(): counties must not be empty.");
  }
  if (!Number.isInteger(page.limit) || page.limit <= 0) {
    throw new Error(`buildSoqlQuery(): page.limit must be a positive integer, got ${page.limit}.`);
  }
  if (!Number.isInteger(page.offset) || page.offset < 0) {
    throw new Error(`buildSoqlQuery(): page.offset must be a non-negative integer, got ${page.offset}.`);
  }

  const countyList = counties.map((code) => `'${escapeSoqlLiteral(code)}'`).join(", ");
  const where = [
    `outlet_county_code IN (${countyList})`,
    `outlet_permit_issue_date >= '${window.start}T00:00:00.000'`,
    `outlet_permit_issue_date < '${window.end}T00:00:00.000'`
  ].join(" AND ");

  return (
    `SELECT * WHERE ${where} ` +
    `ORDER BY outlet_permit_issue_date, taxpayer_number, outlet_number ` +
    `LIMIT ${page.limit} OFFSET ${page.offset}`
  );
}
