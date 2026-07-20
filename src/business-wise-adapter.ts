import type { CandidateCompany, ExistingCompany } from "./types.ts";

/**
 * Integration boundary for the real Business Wise architecture.
 * Keep Project 1 logic dependent on this interface, not Delphi/Azure/ADF details.
 * Rif/Randall discovery determines the production implementation later.
 */
export interface BusinessWiseAdapter {
  searchPotentialMatches(candidate: CandidateCompany): Promise<ExistingCompany[]>;
  stageApprovedCandidate(candidate: CandidateCompany): Promise<{ stagedId: string }>;
}
