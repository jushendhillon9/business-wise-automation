import type { CandidateCompany, MatchResult } from "./types.ts";

export function completenessScore(candidate: CandidateCompany): number {
  const checks: Array<[boolean, number]> = [
    [Boolean(candidate.companyName), 0.2],
    [Boolean(candidate.address), 0.15],
    [Boolean(candidate.phone), 0.15],
    [Boolean(candidate.website), 0.1],
    [Boolean(candidate.employeeCountEstimate), 0.1],
    [Boolean(candidate.description), 0.1],
    [Boolean(candidate.proposedSic), 0.1],
    [Boolean(candidate.contactName), 0.1]
  ];

  return Number(
    checks.reduce((sum, [present, weight]) => sum + (present ? weight : 0), 0).toFixed(4)
  );
}

export function reviewPriority(
  candidate: CandidateCompany,
  match: MatchResult,
  completeness: number
): number {
  // Higher = review earlier.
  // Favor likely-new, reasonably complete records in BW's stated core segment.
  const likelyNewBonus = match.classification === "likely_new" ? 0.35 : 0;
  const coreSegmentBonus =
    candidate.employeeCountEstimate &&
    candidate.employeeCountEstimate >= 10 &&
    candidate.employeeCountEstimate <= 99
      ? 0.2
      : 0;
  const ambiguityPenalty = match.classification === "possible_duplicate" ? 0.15 : 0;

  return Number(
    Math.max(0, Math.min(1, completeness * 0.45 + likelyNewBonus + coreSegmentBonus - ambiguityPenalty)).toFixed(4)
  );
}
