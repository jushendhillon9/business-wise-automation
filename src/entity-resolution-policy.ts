import { rankCandidateMatches } from "./entity-resolution.ts";
import type {
  EntityResolutionConflictCode,
  EntityResolutionDecision,
  EntityResolutionOutcome,
  EntityResolutionReasonCode,
  ExistingCompany,
  LocationCandidate,
  MatchResult,
  RankedMatch
} from "./types.ts";

/**
 * Conservative business-decision policy layer, built entirely on top of the
 * existing similarity engine (src/entity-resolution.ts). It does NOT change
 * the similarity score formula, field weights, or the low-level
 * likely_new/possible_duplicate/likely_duplicate classification — those stay
 * exactly as `scoreCandidateAgainstExisting()` produces them. This module
 * only interprets that evidence into the richer, operational question a
 * Business Wise researcher actually needs answered (see
 * docs/COMPANY_LOCATION_MODEL.md for outcome definitions and the
 * conservative-ambiguity policy in depth).
 *
 * All numeric cutoffs below are named constants, deliberately re-using the
 * same 0-1 similarity scale `scoreCandidateAgainstExisting()` already
 * produces. They are deterministic heuristics chosen to be conservative,
 * not a statistically calibrated model — see the module docs and README for
 * the known-limitations note about needing a labeled evaluation dataset.
 */

// -- Named thresholds -------------------------------------------------------
// company-name score (CompanySimilarity.nameScore, 0-1)
const STRONG_COMPANY_NAME_SCORE = 0.85;
const MODERATE_COMPANY_NAME_SCORE = 0.7;
const WEAK_COMPANY_NAME_SCORE = 0.5;

// address score (LocationSimilarity.addressScore, 0-1)
const STRONG_ADDRESS_SCORE = 0.85;
const MODERATE_ADDRESS_SCORE = 0.6;

// overall score (MatchResult.score, 0-1) below which there is no credible
// signal at all -- distinct from the low-level 0.68/0.9 classification
// thresholds, which answer a different question (duplicate strength, not
// business interpretation).
const MEANINGFUL_MATCH_SCORE = 0.3;

// if the top two ranked matches' overall scores differ by less than this,
// and point at two different existing records, treat the pick between them
// as unsafe rather than trusting whichever happened to rank first.
const AMBIGUOUS_SCORE_MARGIN = 0.05;

// -- Evidence predicates ------------------------------------------------------

/** Company identity evidence strong enough to say "this is very likely the same company." */
function hasStrongCompanyIdentity(match: MatchResult): boolean {
  const { nameScore, domainMatch, sicMatch } = match.companySimilarity;
  if (nameScore >= STRONG_COMPANY_NAME_SCORE) return true;
  if ((domainMatch || sicMatch) && nameScore >= MODERATE_COMPANY_NAME_SCORE) return true;
  return false;
}

/**
 * Location evidence strong enough to say "this is very likely the same
 * physical site." A company-name match alone never satisfies this.
 */
function hasStrongLocationEvidence(match: MatchResult): boolean {
  const { addressScore, phoneMatch, cityStateMatch } = match.locationSimilarity;
  if (addressScore >= STRONG_ADDRESS_SCORE) return true;
  if (phoneMatch && cityStateMatch) return true;
  if (addressScore >= MODERATE_ADDRESS_SCORE && cityStateMatch) return true;
  return false;
}

/** Domain or phone match: a stable identity signal independent of the (possibly changed) company name. */
function supportsIdentityContinuity(match: MatchResult): boolean {
  return match.companySimilarity.domainMatch || match.locationSimilarity.phoneMatch;
}

function collectMatchReasons(match: MatchResult): EntityResolutionReasonCode[] {
  const reasons: EntityResolutionReasonCode[] = [];
  const { nameScore, domainMatch, sicMatch } = match.companySimilarity;
  const { addressScore, phoneMatch, cityStateMatch } = match.locationSimilarity;

  if (domainMatch) reasons.push("exact_domain_match");
  if (sicMatch) reasons.push("sic_match");
  if (nameScore >= STRONG_COMPANY_NAME_SCORE) reasons.push("strong_company_name_match");
  else if (nameScore >= MODERATE_COMPANY_NAME_SCORE) reasons.push("similar_company_name_match");
  if (addressScore >= STRONG_ADDRESS_SCORE) reasons.push("exact_normalized_address_match");
  else if (addressScore >= MODERATE_ADDRESS_SCORE) reasons.push("strong_normalized_address_match");
  if (phoneMatch) reasons.push("exact_phone_match");
  if (cityStateMatch) reasons.push("city_state_match");

  return reasons;
}

/** BWI rows in a deleted/research-deleted lifecycle still get matched -- they're just flagged, never excluded or auto-resurrected. */
function lifecycleConflictFor(existing: ExistingCompany): EntityResolutionConflictCode | undefined {
  if (existing.lifecycleStatus === "deleted") return "existing_location_is_deleted";
  if (existing.lifecycleStatus === "research_deleted") return "existing_location_is_research_deleted";
  return undefined;
}

/**
 * Deterministic heuristic confidence, directly derived from the existing
 * similarity score -- NOT a statistically calibrated probability. Capped
 * down whenever the decision needs human review, since "requires review"
 * inherently means the automated read is less certain.
 */
function computeDecisionConfidence(best: RankedMatch | undefined, requiresHumanReview: boolean): number {
  if (!best) return 1;
  const confidence = requiresHumanReview ? Math.min(best.match.score, 0.6) : best.match.score;
  return Number(confidence.toFixed(4));
}

function buildDecision(
  outcome: EntityResolutionOutcome,
  ranked: RankedMatch[],
  reasons: EntityResolutionReasonCode[],
  conflicts: EntityResolutionConflictCode[],
  requiresHumanReview: boolean,
  matchedExistingCompanyId?: string,
  relatedExistingCompanyIds?: string[]
): EntityResolutionDecision {
  const best = ranked[0];
  const related = relatedExistingCompanyIds?.filter((id) => id !== matchedExistingCompanyId);

  return {
    outcome,
    decisionConfidence: computeDecisionConfidence(best, requiresHumanReview),
    bestMatch: best?.match,
    alternativeMatches: ranked.slice(1, 3).map((r) => r.match),
    matchedExistingCompanyId,
    relatedExistingCompanyIds: related && related.length > 0 ? related : undefined,
    reasons,
    conflicts,
    requiresHumanReview
  };
}

/**
 * Conservative business interpretation of a candidate's ranked matches
 * against known Business Wise records. Considers records across every
 * lifecycle status (published/research/deleted/research_deleted/unknown) --
 * never excludes deleted or research-deleted rows, never resurrects them,
 * never changes a lifecycle status, and never picks a confident branch/
 * headquarters/move/name-change interpretation when the evidence doesn't
 * clearly support it. See docs/COMPANY_LOCATION_MODEL.md for the full
 * outcome-by-outcome rationale.
 */
export function resolveCandidateAgainstExisting(
  candidate: LocationCandidate,
  existingCompanies: ExistingCompany[]
): EntityResolutionDecision {
  const ranked = rankCandidateMatches(candidate, existingCompanies);

  if (ranked.length === 0) {
    return buildDecision("likely_new_company", ranked, ["no_existing_locations_to_compare"], [], false);
  }

  const best = ranked[0]!;
  const second = ranked[1];
  const reasons = collectMatchReasons(best.match);
  const conflicts: EntityResolutionConflictCode[] = [];

  // Guard: two plausible, close matches pointing at different existing
  // records is unsafe to pick between automatically, regardless of what
  // either one alone would otherwise suggest.
  if (
    second &&
    best.existing.id !== second.existing.id &&
    best.match.score >= MEANINGFUL_MATCH_SCORE &&
    second.match.score >= MEANINGFUL_MATCH_SCORE &&
    best.match.score - second.match.score < AMBIGUOUS_SCORE_MARGIN
  ) {
    return buildDecision("ambiguous_manual_review", ranked, reasons, ["multiple_close_existing_location_matches"], true);
  }

  const bestStrongCompany = hasStrongCompanyIdentity(best.match);
  const bestStrongLocation = hasStrongLocationEvidence(best.match);

  // 1. same_existing_location: both company and location evidence are strong.
  // A company-name match alone can never reach this branch (bestStrongLocation
  // requires location-specific evidence, not name similarity).
  if (bestStrongCompany && bestStrongLocation) {
    const lifecycleConflict = lifecycleConflictFor(best.existing);
    if (lifecycleConflict) conflicts.push(lifecycleConflict);

    return buildDecision(
      "same_existing_location",
      ranked,
      reasons,
      conflicts,
      Boolean(lifecycleConflict),
      best.existing.id
    );
  }

  // 2. Strong company identity, but this location is materially different --
  // new branch, new HQ, or a possible move, depending on what evidence is available.
  if (bestStrongCompany && !bestStrongLocation) {
    const relatedIds = ranked.filter((r) => hasStrongCompanyIdentity(r.match)).map((r) => r.existing.id);

    if (candidate.siteType === "branch") {
      reasons.push("candidate_site_type_branch", "existing_company_other_location_found");
      return buildDecision("new_branch_of_existing_company", ranked, reasons, conflicts, false, best.existing.id, relatedIds);
    }

    if (candidate.siteType === "headquarters") {
      reasons.push("candidate_site_type_headquarters", "existing_company_other_location_found");
      // Never automatically claim the former HQ closed/moved -- always flag for human review.
      return buildDecision("new_headquarters_of_existing_company", ranked, reasons, conflicts, true, best.existing.id, relatedIds);
    }

    // Site type doesn't resolve a confident branch/HQ call. If more than one
    // existing record plausibly belongs to the same company, a new branch is
    // at least as plausible as "this is a changed/moved location" -- that's
    // a genuine competing interpretation, not a safe default.
    if (relatedIds.length >= 2) {
      return buildDecision("ambiguous_manual_review", ranked, reasons, ["multiple_close_existing_location_matches"], true);
    }

    reasons.push(candidate.siteType === "unknown" ? "candidate_site_type_unknown" : "candidate_site_type_missing");
    if (best.match.locationSimilarity.addressScore < MODERATE_ADDRESS_SCORE) {
      conflicts.push("candidate_address_differs_from_best_existing_location");
    }
    return buildDecision("possible_changed_location", ranked, reasons, conflicts, true, best.existing.id);
  }

  // 3. Strong location evidence, but the company name looks materially
  // different -- only a possible name change if another stable identity
  // signal (domain or phone) supports continuity. An address match alone is
  // never sufficient: unrelated businesses can occupy the same property.
  if (bestStrongLocation && best.match.companySimilarity.nameScore < WEAK_COMPANY_NAME_SCORE && supportsIdentityContinuity(best.match)) {
    conflicts.push("company_name_materially_different");
    return buildDecision("possible_name_change", ranked, reasons, conflicts, true, best.existing.id);
  }

  // 4. Strong location evidence with no confident read on identity (neither
  // clearly the same company nor clearly a supported name change) -- one
  // signal matches strongly while identity is unresolved; stay conservative.
  if (bestStrongLocation) {
    conflicts.push("company_name_materially_different");
    return buildDecision("ambiguous_manual_review", ranked, reasons, conflicts, true);
  }

  // 5. Nothing credible anywhere -> genuinely a new company.
  if (best.match.score < MEANINGFUL_MATCH_SCORE) {
    return buildDecision("likely_new_company", ranked, ["weak_or_no_match_evidence"], conflicts, false);
  }

  // 6. Some non-trivial signal exists, but it didn't fit any confident
  // pattern above -- the conservative fallback, never guessed away.
  return buildDecision("ambiguous_manual_review", ranked, reasons, conflicts, true);
}
