import { buildSoqlQuery, type QueryWindow } from "./query.ts";
import { buildSourceRecordId, toStringField, TX_SALES_TAX_PERMITS_DATASET_ID, TX_SALES_TAX_PERMITS_ENDPOINT } from "./types.ts";
import type { TxPermitObservation, TxPermitRawRecord } from "./types.ts";

/**
 * HTTP + pagination layer for the Texas sales-tax-permit profiler. Never
 * hard-codes SOCRATA_APP_TOKEN, never logs it, and never retries
 * indefinitely. All network/timing dependencies (fetch, sleep, jitter
 * source) are injectable so tests never make a real network call and never
 * actually wait out a backoff delay.
 */

export class TxPermitApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TxPermitApiError";
    this.status = status;
  }
}

export class TxPermitAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxPermitAuthError";
  }
}

/**
 * A plain fetch-shaped function, deliberately narrower than `typeof fetch`
 * (which in Bun's lib types also requires a static `preconnect` method) so
 * tests can pass a bare async function as a stub without extra ceremony.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Socrata's own per-request row cap; also a sane hard ceiling so a bad --page-size flag can't ask for an unbounded page. */
const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 1000;
/** Safe default when the caller doesn't pass --limit -- never an unbounded/statewide pull. */
const DEFAULT_LIMIT = 500;

export type TxPermitClientOptions = {
  endpoint?: string;
  appToken?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable source of randomness for backoff jitter -- tests supply a fixed sequence for determinism. */
  random?: () => number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function computeBackoffMs(attempt: number, random: () => number): number {
  const cap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  // Half fixed, half jittered -- avoids a thundering-herd retry storm while
  // still guaranteeing forward progress toward the cap.
  return Math.floor(cap / 2 + random() * (cap / 2));
}

type ResolvedFetchOptions = {
  endpoint: string;
  appToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
};

async function fetchPageOnce(query: string, options: ResolvedFetchOptions): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await options.fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-App-Token": options.appToken
        },
        body: JSON.stringify({ query }),
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TxPermitApiError(`Texas permit API request timed out after ${options.timeoutMs}ms.`);
      }
      throw new TxPermitApiError(`Texas permit API request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new TxPermitApiError(
        `Texas permit API responded ${response.status} ${response.statusText}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`,
        response.status
      );
    }

    try {
      return await response.json();
    } catch {
      throw new TxPermitApiError("Texas permit API returned malformed JSON.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageWithRetry(
  query: string,
  fetchOptions: ResolvedFetchOptions,
  retryOptions: { maxRetries: number; sleep: (ms: number) => Promise<void>; random: () => number }
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchPageOnce(query, fetchOptions);
    } catch (error) {
      const status = error instanceof TxPermitApiError ? error.status : undefined;
      const isTimeout = error instanceof TxPermitApiError && error.message.includes("timed out");
      const retryable = isTimeout || (status !== undefined && isRetryableStatus(status));

      if (!retryable || attempt >= retryOptions.maxRetries) {
        throw error;
      }

      await retryOptions.sleep(computeBackoffMs(attempt, retryOptions.random));
      attempt += 1;
    }
  }
}

/** Fails closed with a clear error rather than a schema-drift surprise deeper in the pipeline. */
export function assertBareArrayResponse(value: unknown): TxPermitRawRecord[] {
  if (!Array.isArray(value)) {
    throw new TxPermitApiError(
      "Texas permit API response was not a bare top-level JSON array (unexpected shape -- possible API/schema drift)."
    );
  }
  return value as TxPermitRawRecord[];
}

function resolveAppToken(options: TxPermitClientOptions): string {
  const token = options.appToken ?? process.env.SOCRATA_APP_TOKEN;
  if (!token) {
    throw new TxPermitAuthError(
      "SOCRATA_APP_TOKEN is not set. Export it (or pass an explicit token) before running a live Texas permit pull."
    );
  }
  return token;
}

/** Fetches exactly one page. Exposed for focused tests; fetchTxPermitObservations() is the normal entry point. */
export async function fetchTxPermitPage(
  window: QueryWindow,
  counties: readonly string[],
  page: { limit: number; offset: number },
  options: TxPermitClientOptions = {}
): Promise<TxPermitRawRecord[]> {
  const appToken = resolveAppToken(options);
  const endpoint = options.endpoint ?? TX_SALES_TAX_PERMITS_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const query = buildSoqlQuery(window, counties, page);
  const body = await fetchPageWithRetry(query, { endpoint, appToken, fetchImpl, timeoutMs }, { maxRetries, sleep, random });
  return assertBareArrayResponse(body);
}

export type FetchTxPermitObservationsOptions = TxPermitClientOptions & {
  pageSize?: number;
  limit?: number;
};

export type FetchTxPermitObservationsResult = {
  observations: TxPermitObservation[];
  pageCount: number;
  /** source_record_id repeats seen (and dropped) across pages. */
  duplicateCount: number;
  /** Rows missing taxpayer_number or outlet_number, so no stable source_record_id could be built -- skipped, never crashes the pull. */
  malformedCount: number;
  /** Total raw rows returned across all pages, before dedup/malformed filtering. */
  rawFetchedCount: number;
};

/**
 * Fetches a bounded, deterministically-ordered, deterministically-paginated
 * set of observations for the given window/counties. Always respects
 * `limit` (default 500) across pages -- never fetches the full statewide
 * dataset for a bounded query. A page short of the requested page size (or
 * genuinely empty) ends pagination; any unrecoverable error during
 * pagination propagates immediately rather than silently returning a
 * partial result.
 */
export async function fetchTxPermitObservations(
  window: QueryWindow,
  counties: readonly string[],
  options: FetchTxPermitObservationsOptions = {}
): Promise<FetchTxPermitObservationsResult> {
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`fetchTxPermitObservations(): pageSize must be a positive integer, got ${options.pageSize}.`);
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`fetchTxPermitObservations(): limit must be a positive integer, got ${options.limit}.`);
  }

  const endpoint = options.endpoint ?? TX_SALES_TAX_PERMITS_ENDPOINT;
  const fetchedAt = new Date().toISOString();

  const seenSourceRecordIds = new Set<string>();
  const observations: TxPermitObservation[] = [];
  let offset = 0;
  let pageCount = 0;
  let duplicateCount = 0;
  let malformedCount = 0;
  let rawFetchedCount = 0;

  while (observations.length < limit) {
    const remaining = limit - observations.length;
    const thisPageSize = Math.min(pageSize, remaining);
    const rows = await fetchTxPermitPage(window, counties, { limit: thisPageSize, offset }, options);
    pageCount += 1;
    rawFetchedCount += rows.length;

    if (rows.length === 0) break;

    for (const raw of rows) {
      const taxpayerNumber = toStringField(raw.taxpayer_number);
      const outletNumber = toStringField(raw.outlet_number);
      if (!taxpayerNumber || !outletNumber) {
        malformedCount += 1;
        continue;
      }

      const sourceRecordId = buildSourceRecordId(taxpayerNumber, outletNumber);
      if (seenSourceRecordIds.has(sourceRecordId)) {
        duplicateCount += 1;
        continue;
      }
      seenSourceRecordIds.add(sourceRecordId);

      observations.push({
        source_dataset_id: TX_SALES_TAX_PERMITS_DATASET_ID,
        source_record_id: sourceRecordId,
        fetched_at: fetchedAt,
        query_window_start: window.start,
        query_window_end: window.end,
        requested_counties: [...counties],
        source_url: endpoint,
        raw
      });

      if (observations.length >= limit) break;
    }

    if (rows.length < thisPageSize) break; // short page: no more data upstream
    offset += rows.length;
  }

  return { observations, pageCount, duplicateCount, malformedCount, rawFetchedCount };
}
