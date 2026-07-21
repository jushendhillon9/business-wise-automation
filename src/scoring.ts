import { hasMeaningfulContact, type LocationCandidate, type MatchResult } from "./types.ts";

export type ResearchCompletenessResult = {
  score: number;
  presentFields: string[];
  missingFields: string[];
};

type CompletenessCheck = {
  /**
   * Namespaced field identifier: "company.*" for CompanyIdentity fields, "location.*" for
   * LocationCandidate fields, following docs/BWI_DOMAIN_RULES.md §13's convention. That section's
   * example list also includes "company.startYear", which is not currently one of the checks below
   * (see docs/COMPANY_LOCATION_MODEL.md's gaps section) — its list is illustrative, not exhaustive.
   */
  field: string;
  weight: number;
  present: (candidate: LocationCandidate) => boolean;
};

const COMPLETENESS_CHECKS: CompletenessCheck[] = [
  { field: "company.legalName", weight: 0.2, present: (c) => Boolean(c.company.legalName) },
  { field: "location.physicalAddress", weight: 0.15, present: (c) => Boolean(c.physicalAddress?.street) },
  { field: "location.phone", weight: 0.15, present: (c) => Boolean(c.phone) },
  { field: "company.website", weight: 0.1, present: (c) => Boolean(c.company.website) },
  { field: "location.employeeSizeSite", weight: 0.1, present: (c) => Boolean(c.employeeSizeSite?.estimate) },
  { field: "location.description", weight: 0.1, present: (c) => Boolean(c.description) },
  { field: "company.sicCode", weight: 0.1, present: (c) => Boolean(c.company.sicCode) },
  { field: "contacts", weight: 0.1, present: (c) => hasMeaningfulContact(c.contacts) }
];

/**
 * "How much useful research data do we have?" Evaluates company-level and
 * location-level fields together, but this is purely descriptive — it does
 * not imply the candidate is ready to publish. See publication-readiness.ts
 * for the separate, rule-based publish gate. Same weights/meaning as before
 * the company/location split; only where each field is read from changed.
 */
export function researchCompleteness(candidate: LocationCandidate): ResearchCompletenessResult {
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
  candidate: LocationCandidate,
  match: MatchResult,
  researchCompletenessScore: number
): number {
  // Higher = review earlier.
  // Favor likely-new, reasonably complete records in BW's stated core segment:
  // single-site/HQ companies with 10-99 employees (docs/BWI_DOMAIN_RULES.md
  // §14). Records with at least a few employees but outside that band still
  // get a smaller relevance bump, per the same section's "generally
  // prioritize companies with 4+ employees" guidance.
  const likelyNewBonus = match.classification === "likely_new" ? 0.35 : 0;

  const employeeCount = candidate.employeeSizeSite?.estimate;
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
