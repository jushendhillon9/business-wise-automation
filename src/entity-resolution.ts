import {
  diceSimilarity,
  normalizeAddress,
  normalizeCompanyName,
  normalizeDomain,
  normalizePhone
} from "./normalize.ts";
import type { ExistingCompany, LocationCandidate, MatchResult } from "./types.ts";

/**
 * Compares one LocationCandidate against one known ExistingCompany (what
 * docs/BWI_DOMAIN_RULES.md §2 calls an "ExistingLocation" — see the naming
 * note in docs/COMPANY_LOCATION_MODEL.md), reasoning separately about
 * company-level evidence (name, domain, SIC — facts that should hold
 * regardless of which location we're looking at) and location-level
 * evidence (address, phone, city/state — facts specific to this physical
 * site), per the comparison layers in docs/BWI_DOMAIN_RULES.md §12.2. That
 * section also lists parent/affiliate relationship and start year as
 * company-similarity signals, and market/county/ZIP as location-similarity
 * signals; those are not yet compared here (see docs/COMPANY_LOCATION_MODEL.md's
 * gaps section). The overall score/classification formula is unchanged from
 * the prior flat-model version; only the field sources and the addition of
 * structured evidence are new. Keeping companySimilarity and
 * locationSimilarity separate lets future work derive the richer outcome
 * taxonomy in docs/BWI_DOMAIN_RULES.md §12.4 (same_existing_location,
 * new_branch_of_existing_company, headquarters_move, ...) without reworking
 * the matching evidence again.
 */
export function scoreCandidateAgainstExisting(
  candidate: LocationCandidate,
  existing: ExistingCompany
): MatchResult {
  const reasons: string[] = [];

  // Company-level evidence.
  const candidateName = normalizeCompanyName(candidate.company.legalName);
  const existingName = normalizeCompanyName(existing.companyName);
  const nameScore = diceSimilarity(candidateName, existingName);

  const candidateDomain = normalizeDomain(candidate.company.website);
  const existingDomain = normalizeDomain(existing.website);
  const domainMatch = Boolean(candidateDomain && existingDomain && candidateDomain === existingDomain);

  const sicMatch = Boolean(
    candidate.company.sicCode && existing.sicCode && candidate.company.sicCode === existing.sicCode
  );

  // Location-level evidence.
  const candidateAddress = normalizeAddress(candidate.physicalAddress?.street);
  const existingAddress = normalizeAddress(existing.address);
  const addressScore = candidateAddress && existingAddress
    ? diceSimilarity(candidateAddress, existingAddress)
    : 0;

  const candidatePhone = normalizePhone(candidate.phone);
  const existingPhone = normalizePhone(existing.phone);
  const phoneMatch = Boolean(candidatePhone && existingPhone && candidatePhone === existingPhone);

  const cityStateMatch = Boolean(
    candidate.physicalAddress?.city &&
    candidate.physicalAddress?.state &&
    existing.city &&
    existing.state &&
    candidate.physicalAddress.city.trim().toLowerCase() === existing.city.trim().toLowerCase() &&
    candidate.physicalAddress.state.trim().toLowerCase() === existing.state.trim().toLowerCase()
  );

  let score = nameScore * 0.5 + addressScore * 0.3;
  if (phoneMatch) score += 0.15;
  if (domainMatch) score += 0.05;

  if (phoneMatch) reasons.push("exact phone match");
  if (domainMatch) reasons.push("exact website domain match");
  if (sicMatch) reasons.push("matching SIC code");
  if (cityStateMatch) reasons.push("matching city/state");
  if (nameScore >= 0.9) reasons.push("very similar normalized company name");
  else if (nameScore >= 0.7) reasons.push("similar normalized company name");
  if (addressScore >= 0.9) reasons.push("very similar normalized address");
  else if (addressScore >= 0.7) reasons.push("similar normalized address");

  // Exact phone is a powerful duplicate signal in the current BW workflow.
  if (phoneMatch && nameScore >= 0.65) score = Math.max(score, 0.93);
  if (domainMatch && nameScore >= 0.8) score = Math.max(score, 0.9);

  score = Math.min(1, Number(score.toFixed(4)));

  const classification =
    score >= 0.9
      ? "likely_duplicate"
      : score >= 0.68
        ? "possible_duplicate"
        : "likely_new";

  return {
    existingCompanyId: existing.id,
    companySimilarity: { nameScore, domainMatch, sicMatch },
    locationSimilarity: { addressScore, phoneMatch, cityStateMatch },
    score,
    classification,
    reasons
  };
}

export function findBestMatch(
  candidate: LocationCandidate,
  existingCompanies: ExistingCompany[]
): MatchResult {
  if (existingCompanies.length === 0) {
    return {
      companySimilarity: { nameScore: 0, domainMatch: false, sicMatch: false },
      locationSimilarity: { addressScore: 0, phoneMatch: false, cityStateMatch: false },
      score: 0,
      classification: "likely_new",
      reasons: ["no comparison records available"]
    };
  }

  return existingCompanies
    .map((existing) => scoreCandidateAgainstExisting(candidate, existing))
    .sort((a, b) => b.score - a.score)[0]!;
}
