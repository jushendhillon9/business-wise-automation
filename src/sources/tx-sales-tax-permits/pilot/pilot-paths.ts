/**
 * Path resolution for the Texas permit shadow-pilot: where the local
 * profiler-generated source snapshot is read from, and where the pilot's
 * own private, isolated output goes. Mirrors the precedence pattern already
 * used for the BWI snapshot drop folder (src/bwi-snapshot/paths.ts) and the
 * profiler's own output folder (src/sources/tx-sales-tax-permits/paths.ts).
 */

/**
 * Convenience default pointing at the one real local profiler run already
 * captured for this pilot -- not a general guarantee that this exact dated
 * directory will exist or stay current. Always pass --source-dir explicitly
 * for any run against a different profiler pull.
 */
export const DEFAULT_SOURCE_DIR = "data/private/sources/tx-sales-tax-permits/2026-07-24-7d-2000";

const DEFAULT_PILOT_OUTPUT_ROOT = "data/private/pilots/tx-sales-tax-permits";

export function resolveSourceDir(explicit: string | undefined): string {
  return explicit || DEFAULT_SOURCE_DIR;
}

/** Timestamp-based, filesystem-safe run id so each pilot run gets its own isolated output directory by default. */
export function generateRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function resolvePilotOutputDir(explicit: string | undefined, runId: string): string {
  return explicit || `${DEFAULT_PILOT_OUTPUT_ROOT}/${runId}`;
}

export function resolvePilotDbPath(explicit: string | undefined, outputDir: string): string {
  return explicit || `${outputDir}/pilot.sqlite`;
}
