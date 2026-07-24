/**
 * Private local output location for the Texas permit profiler. Mirrors the
 * precedence pattern already used for the BWI snapshot drop folder (see
 * src/bwi-snapshot/paths.ts): explicit --output argument > default
 * data/private/sources/tx-sales-tax-permits/<pull-date>/.
 */

const DEFAULT_OUTPUT_ROOT = "data/private/sources/tx-sales-tax-permits";

export function todayPullDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function resolveOutputDir(explicit: string | undefined, pullDate: string): string {
  return explicit || `${DEFAULT_OUTPUT_ROOT}/${pullDate}`;
}
