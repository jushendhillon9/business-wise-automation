import { hasMeaningfulContact, type CandidateCompany, type MatchResult } from "./types.ts";

export type ResearchCompletenessResult = {
  score: number;
  presentFields: string[];
  missingFields: string[];
};

type CompletenessCheck = {
  field: string;
  weight: number;
  present: (candidate: CandidateCompany) => boolean;
};

const COMPLETENESS_CHECKS: CompletenessCheck[] = [
  { field: "companyName", weight: 0.2, present: (c) => Boolean(c.companyName) },
  { field: "address", weight: 0.15, present: (c) => Boolean(c.address) },
  { field: "phone", weight: 0.15, present: (c) => Boolean(c.phone) },
  { field: "website", weight: 0.1, present: (c) => Boolean(c.website) },
  { field: "employeeCountEstimate", weight: 0.1, present: (c) => Boolean(c.employeeCountEstimate) },
  { field: "description", weight: 0.1, present: (c) => Boolean(c.description) },
  { field: "proposedSic", weight: 0.1, present: (c) => Boolean(c.proposedSic) },
  { field: "contacts", weight: 0.1, present: (c) => hasMeaningfulContact(c.contacts) }
];

/**
 * "How much useful research data do we have?" This is purely descriptive —
 * it does not imply the candidate is ready to publish. See
 * publication-readiness.ts for the separate, rule-based publish gate.
 */
export function researchCompleteness(candidate: CandidateCompany): ResearchCompletenessResult {
  const presentFields: string[] = [];
  const missingFields: string[] = [];
  let score = 0;

  for (const check of COMPLETENESS_CHECKS) {
    if (check.present(candidate)) {
      presentFields.push(check.field);
      score += check.weight;
    } else {
      missingFields.push(check.field);
    }
  }

  return {
    score: Number(score.toFixed(4)),
    presentFields,
    missingFields
  };
}

/**
 * Which candidate should a human review first. Independent of publication
 * readiness on purpose: a high-priority record may still be missing
 * required fields, and readiness never determines priority (or vice versa).
 */
export function reviewPriority(
  candidate: CandidateCompany,
  match: MatchResult,
  researchCompletenessScore: number
): number {
  // Higher = review earlier.
  // Favor likely-new, reasonably complete records in BW's stated core segment:
  // single-site/HQ companies with 10-99 employees. Records with at least a
  // few employees but outside that band still get a smaller relevance bump,
  // per Emily's "4+ employees generally" guidance.
  const likelyNewBonus = match.classification === "likely_new" ? 0.35 : 0;

  const employeeCount = candidate.employeeCountEstimate;
  const isCoreSiteType = candidate.siteType === undefined || candidate.siteType === "single_site" || candidate.siteType === "headquarters";
  const inCoreEmployeeRange = employeeCount !== undefined && employeeCount >= 10 && employeeCount <= 99;
  const coreSegmentBonus = inCoreEmployeeRange && isCoreSiteType ? 0.2 : 0;
  const generalRelevanceBonus = !inCoreEmployeeRange && employeeCount !== undefined && employeeCount >= 4 ? 0.05 : 0;

  const ambiguityPenalty = match.classification === "possible_duplicate" ? 0.15 : 0;

  return Number(
    Math.max(
      0,
      Math.min(1, researchCompletenessScore * 0.45 + likelyNewBonus + coreSegmentBonus + generalRelevanceBonus - ambiguityPenalty)
    ).toFixed(4)
  );
}
