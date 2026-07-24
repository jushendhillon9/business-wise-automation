import { evaluateEntityResolution } from "./eval/evaluate.ts";
import { loadEntityResolutionCases } from "./eval/load-cases.ts";
import { buildConfidenceCalibrationTable, buildConfusionMatrixTable, buildOutcomeBreakdownTable, formatMissesLines, formatSummaryLines } from "./eval/report-format.ts";

/**
 * Labeled entity-resolution evaluation harness CLI. Calls the exact
 * production `rankCandidateMatches`/`resolveCandidateAgainstExisting`
 * functions used by `run.ts` -- never a second matching implementation --
 * against one or more labeled case datasets. Never touches the sandbox
 * database, never calls a real BWI system, never modifies matching
 * weights/thresholds.
 *
 * Usage:
 *   bun run evaluate
 *   bun run evaluate --cases=data/eval/entity-resolution-cases.sample.json
 *   bun run evaluate --cases=data/eval/synthetic,data/eval/real --format=json --out=report.json
 *   bun run evaluate --json --out=report.json    (--json is an alias for --format=json)
 */
function argValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

const DEFAULT_CASES_PATH = "data/eval/entity-resolution-cases.sample.json";

const casePaths = (argValue("cases") ?? DEFAULT_CASES_PATH).split(",").map((p) => p.trim()).filter(Boolean);
const format = hasFlag("json") || argValue("format") === "json" ? "json" : "text";
const outPath = argValue("out");

const { datasets, errors } = await loadEntityResolutionCases(casePaths);

if (errors.length > 0) {
  console.error(`Refusing to evaluate: ${errors.length} validation error(s) found across the loaded case dataset(s).`);
  console.error("No evaluation report was produced -- fix every error below, then re-run.");
  for (const error of errors) {
    const location = [error.sourcePath, error.datasetId ? `dataset=${error.datasetId}` : undefined, error.caseId ? `case=${error.caseId}` : undefined]
      .filter(Boolean)
      .join(" ");
    console.error(`  [${location}] ${error.message}`);
  }
  process.exit(1);
}

if (datasets.length === 0 || datasets.every((d) => d.cases.length === 0)) {
  console.error("No cases were loaded -- nothing to evaluate.");
  process.exit(1);
}

const report = evaluateEntityResolution(datasets, casePaths);

if (format === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const line of formatSummaryLines(report)) console.log(line);
  console.log("");
  console.log("By expected outcome:");
  console.table(buildOutcomeBreakdownTable(report));
  console.log("Confusion matrix (rows = expected, columns = actual):");
  console.table(buildConfusionMatrixTable(report));
  console.log("Confidence calibration:");
  console.table(buildConfidenceCalibrationTable(report));
  for (const line of formatMissesLines(report)) console.log(line);
}

if (outPath) {
  await Bun.write(outPath, JSON.stringify(report, null, 2));
  console.error(`Wrote JSON report to ${outPath}`);
}
