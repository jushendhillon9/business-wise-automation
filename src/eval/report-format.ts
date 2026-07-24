import type { EntityResolutionOutcome } from "../types.ts";
import { ALL_ENTITY_RESOLUTION_OUTCOMES, type EvaluationReport } from "./types.ts";

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

/** Top summary block: dataset provenance, overall accuracy trio, retrieval, and directional error rates. Kept as plain text lines (not a table) since it's mostly prose, not a grid. */
export function formatSummaryLines(report: EvaluationReport): string[] {
  const lines: string[] = [];

  lines.push(`Loaded ${report.datasets.length} dataset(s), ${report.totalCaseCount} case(s):`);
  for (const dataset of report.datasets) {
    lines.push(`  ${dataset.datasetId} (schema ${dataset.schemaVersion}, ${dataset.caseCount} case(s)) -- ${dataset.sourcePath}`);
  }

  lines.push("");
  lines.push("Overall accuracy:");
  lines.push(`  outcome accuracy:        ${pct(report.overall.accuracy.outcomeAccuracy)} (${report.overall.accuracy.count} cases)`);
  lines.push(`  matched-record accuracy: ${pct(report.overall.accuracy.matchedRecordAccuracy)}`);
  lines.push(`  full-case accuracy:      ${pct(report.overall.accuracy.fullCaseAccuracy)}`);

  lines.push("");
  lines.push(`Retrieval (over ${report.overall.retrieval.applicableCases} retrieval-applicable case(s)):`);
  lines.push(`  recall@1: ${pct(report.overall.retrieval.recallAt1)}  recall@3: ${pct(report.overall.retrieval.recallAt3)}  recall@5: ${pct(report.overall.retrieval.recallAt5)}`);
  lines.push(`  mean reciprocal rank: ${num(report.overall.retrieval.meanReciprocalRank)}`);
  lines.push(`  mean rank: ${num(report.overall.retrieval.meanRank)}  median rank: ${num(report.overall.retrieval.medianRank)}`);

  lines.push("");
  lines.push("Directional error rates (ambiguous_manual_review reported separately, never counted as either):");
  lines.push(`  false duplicate / false existing-link rate: ${pct(report.overall.directional.falseExistingLinkRate)} (of ${report.overall.directional.newExpectedCount} expected-new case(s))`);
  lines.push(`  false-new rate:                              ${pct(report.overall.directional.falseNewRate)} (of ${report.overall.directional.existingRelatedExpectedCount} expected-existing-related case(s))`);
  lines.push(`  abstention rate:                             ${pct(report.overall.directional.abstentionRate)}`);

  return lines;
}

/** One row per expected outcome, console.table-friendly. */
export function buildOutcomeBreakdownTable(report: EvaluationReport): Array<Record<string, string | number>> {
  return ALL_ENTITY_RESOLUTION_OUTCOMES.map((outcome) => {
    const breakdown = report.byExpectedOutcome[outcome];
    return {
      expectedOutcome: outcome,
      count: breakdown.accuracy.count,
      outcomeAccuracy: pct(breakdown.accuracy.outcomeAccuracy),
      matchedRecordAccuracy: pct(breakdown.accuracy.matchedRecordAccuracy),
      fullCaseAccuracy: pct(breakdown.accuracy.fullCaseAccuracy),
      requiresHumanReviewRate: pct(breakdown.requiresHumanReviewRate),
      abstentionRate: pct(breakdown.abstentionRate)
    };
  });
}

/** Confusion matrix as console.table-friendly rows -- rows are expected outcomes, columns are actual outcomes. Outcome-only, no record-id dimension. */
export function buildConfusionMatrixTable(report: EvaluationReport): Array<Record<string, string | number>> {
  return report.confusionMatrix.outcomes.map((expected) => {
    const row: Record<string, string | number> = { expectedOutcome: expected };
    for (const actual of report.confusionMatrix.outcomes) {
      row[actual as string] = report.confusionMatrix.counts[expected][actual as EntityResolutionOutcome];
    }
    return row;
  });
}

export function buildConfidenceCalibrationTable(report: EvaluationReport): Array<Record<string, string | number>> {
  return report.confidenceCalibration.map((band) => ({
    band: band.band,
    caseCount: band.caseCount,
    fullCaseAccuracy: pct(band.fullCaseAccuracy),
    outcomeAccuracy: pct(band.outcomeAccuracy),
    meanConfidence: num(band.meanConfidence)
  }));
}

/** Text lines listing every case that wasn't fully correct, for quick debugging -- capped so a large real dataset doesn't flood the terminal. */
export function formatMissesLines(report: EvaluationReport, limit = 25): string[] {
  const misses = report.cases.filter((c) => !c.fullyCorrect);
  if (misses.length === 0) return ["No misses -- every case was fully correct."];

  const lines = [`${misses.length} miss(es) (showing up to ${limit}):`];
  for (const miss of misses.slice(0, limit)) {
    const targetPart =
      miss.expectedMatchedExistingCompanyId !== undefined
        ? ` expectedRecord=${miss.expectedMatchedExistingCompanyId} actualRecord=${miss.actualMatchedExistingCompanyId ?? "-"}`
        : "";
    lines.push(`  [${miss.datasetId}/${miss.caseId}] expected=${miss.expectedOutcome} actual=${miss.actualOutcome}${targetPart}`);
    if (miss.notes) lines.push(`      notes: ${miss.notes}`);
  }
  return lines;
}
