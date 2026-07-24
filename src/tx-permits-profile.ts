import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchTxPermitObservations, TxPermitApiError, TxPermitAuthError } from "./sources/tx-sales-tax-permits/client.ts";
import { resolveOutputDir, todayPullDate } from "./sources/tx-sales-tax-permits/paths.ts";
import { printTxPermitProfile } from "./sources/tx-sales-tax-permits/profile-format.ts";
import { profileTxPermitObservations } from "./sources/tx-sales-tax-permits/profile.ts";
import { parseCountyCodes, resolveQueryWindow } from "./sources/tx-sales-tax-permits/query.ts";
import { generatePilotSample } from "./sources/tx-sales-tax-permits/sample.ts";
import { TX_SALES_TAX_PERMITS_DATASET_ID, TX_SALES_TAX_PERMITS_ENDPOINT } from "./sources/tx-sales-tax-permits/types.ts";

/**
 * `bun run source:tx-permits:profile` -- source PROFILING only. Pulls a
 * bounded set of recent Texas sales-tax permit observations from the
 * official Socrata API, saves them privately, and prints aggregate
 * source-quality metrics. Does not instantiate the BWI snapshot adapter,
 * run entity resolution, touch the review queue, or build a permanent
 * SourceAdapter -- see README's "Texas sales-tax permit source (profiling
 * only)" section.
 */

const DEFAULT_LIMIT = 500;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_SEED = 1;

function readCliArg(argv: string[], flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`ERROR: --${flag} must be a positive integer, got "${raw}".`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const argv = process.argv;

  const daysArg = readCliArg(argv, "days");
  const fromArg = readCliArg(argv, "from");
  const toArg = readCliArg(argv, "to");
  const countiesArg = readCliArg(argv, "counties");
  const outputArg = readCliArg(argv, "output");
  const seedArg = readCliArg(argv, "seed");

  const limit = parsePositiveInt(readCliArg(argv, "limit"), "limit", DEFAULT_LIMIT);
  const pageSize = parsePositiveInt(readCliArg(argv, "page-size"), "page-size", DEFAULT_PAGE_SIZE);
  const seed = seedArg !== undefined ? Number(seedArg) : DEFAULT_SEED;
  if (!Number.isInteger(seed)) {
    console.error(`ERROR: --seed must be an integer, got "${seedArg}".`);
    process.exit(1);
  }

  let window;
  let counties;
  try {
    window = resolveQueryWindow({
      days: daysArg !== undefined ? Number(daysArg) : undefined,
      from: fromArg,
      to: toArg
    });
    counties = parseCountyCodes(countiesArg);
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exit(1);
    return;
  }

  console.log(`Dataset: ${TX_SALES_TAX_PERMITS_DATASET_ID} (Texas Comptroller sales-tax permit holders, official API)`);
  console.log(`Query window: ${window.start} (inclusive) .. ${window.end} (exclusive)`);
  console.log(`Counties: ${counties.join(", ")}`);
  console.log(`Limit: ${limit}, page size: ${pageSize}`);
  console.log("");

  let result;
  try {
    result = await fetchTxPermitObservations(window, counties, { limit, pageSize });
  } catch (error) {
    if (error instanceof TxPermitAuthError) {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
      return;
    }
    if (error instanceof TxPermitApiError) {
      console.error(`ERROR: Texas permit API call failed: ${error.message}`);
      process.exit(1);
      return;
    }
    throw error;
  }

  console.log(`Pages fetched: ${result.pageCount}`);
  console.log(`Observations retrieved: ${result.observations.length}`);
  console.log(`Duplicate source_record_id across pages: ${result.duplicateCount}`);
  console.log(`Malformed rows (missing taxpayer/outlet id): ${result.malformedCount}`);
  console.log("");

  const profile = profileTxPermitObservations(result.observations);
  printTxPermitProfile(profile);
  console.log("");

  const sample = generatePilotSample(result.observations, { seed });
  console.log(
    `Pilot sample: ${sample.sampleSize} (${sample.priorityCount} priority-stratified, ${sample.controlCount} random-control), seed=${sample.seed}`
  );
  console.log("");

  const pullDate = todayPullDate();
  const outputDir = resolveOutputDir(outputArg, pullDate);
  mkdirSync(outputDir, { recursive: true });

  const rawPath = `${outputDir}/raw.ndjson`;
  const profilePath = `${outputDir}/profile.json`;
  const samplePath = `${outputDir}/pilot-sample.json`;
  const manifestPath = `${outputDir}/manifest.json`;

  const rawNdjson = result.observations.map((observation) => JSON.stringify(observation)).join("\n") + (result.observations.length > 0 ? "\n" : "");
  const profileJson = JSON.stringify(profile, null, 2);
  const sampleJson = JSON.stringify(sample, null, 2);

  const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

  writeFileSync(rawPath, rawNdjson);
  writeFileSync(profilePath, profileJson);
  writeFileSync(samplePath, sampleJson);

  const manifest = {
    dataset_id: TX_SALES_TAX_PERMITS_DATASET_ID,
    source_url: TX_SALES_TAX_PERMITS_ENDPOINT,
    fetched_at: new Date().toISOString(),
    query_window_start: window.start,
    query_window_end: window.end,
    requested_counties: counties,
    row_count: result.observations.length,
    page_count: result.pageCount,
    duplicate_count: result.duplicateCount,
    malformed_count: result.malformedCount,
    limit,
    page_size: pageSize,
    seed,
    files: {
      "raw.ndjson": { sha256: sha256(rawNdjson) },
      "profile.json": { sha256: sha256(profileJson) },
      "pilot-sample.json": { sha256: sha256(sampleJson) }
    }
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Elapsed: ${Date.now() - startedAt}ms`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`  ${rawPath}`);
  console.log(`  ${profilePath}`);
  console.log(`  ${samplePath}`);
  console.log(`  ${manifestPath}`);
}

await main();
