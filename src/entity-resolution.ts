import {
  diceSimilarity,
  normalizeAddress,
  normalizeCompanyName,
  normalizeDomain,
  normalizePhone
} from "./normalize.ts";
import type { CandidateCompany, ExistingCompany, MatchResult } from "./types.ts";

export function scoreCandidateAgainstExisting(
  candidate: CandidateCompany,
  existing: ExistingCompany
): MatchResult {
  const reasons: string[] = [];

  const candidateName = normalizeCompanyName(candidate.companyName);
  const existingName = normalizeCompanyName(existing.companyName);
  const nameScore = diceSimilarity(candidateName, existingName);

  const candidateAddress = normalizeAddress(candidate.address);
  const existingAddress = normalizeAddress(existing.address);
  const addressScore = candidateAddress && existingAddress
    ? diceSimilarity(candidateAddress, existingAddress)
    : 0;

  const candidatePhone = normalizePhone(candidate.phone);
  const existingPhone = normalizePhone(existing.phone);
  const phoneExact = Boolean(candidatePhone && existingPhone && candidatePhone === existingPhone);

  const candidateDomain = normalizeDomain(candidate.website);
  const existingDomain = normalizeDomain(existing.website);
  const domainExact = Boolean(candidateDomain && existingDomain && candidateDomain === existingDomain);

  let score = nameScore * 0.5 + addressScore * 0.3;
  if (phoneExact) score += 0.15;
  if (domainExact) score += 0.05;

  if (phoneExact) reasons.push("exact phone match");
  if (domainExact) reasons.push("exact website domain match");
  if (nameScore >= 0.9) reasons.push("very similar normalized company name");
  else if (nameScore >= 0.7) reasons.push("similar normalized company name");
  if (addressScore >= 0.9) reasons.push("very similar normalized address");
  else if (addressScore >= 0.7) reasons.push("similar normalized address");

  // Exact phone is a powerful duplicate signal in the current BW workflow.
  if (phoneExact && nameScore >= 0.65) score = Math.max(score, 0.93);
  if (domainExact && nameScore >= 0.8) score = Math.max(score, 0.9);

  score = Math.min(1, Number(score.toFixed(4)));

  const classification =
    score >= 0.9
      ? "likely_duplicate"
      : score >= 0.68
        ? "possible_duplicate"
        : "likely_new";

  return {
    existingCompanyId: existing.id,
    score,
    classification,
    reasons
  };
}

export function findBestMatch(
  candidate: CandidateCompany,
  existingCompanies: ExistingCompany[]
): MatchResult {
  if (existingCompanies.length === 0) {
    return {
      score: 0,
      classification: "likely_new",
      reasons: ["no comparison records available"]
    };
  }

  return existingCompanies
    .map((existing) => scoreCandidateAgainstExisting(candidate, existing))
    .sort((a, b) => b.score - a.score)[0]!;
}
