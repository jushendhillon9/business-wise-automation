export type CandidateCompany = {
  id: string;
  source: string;
  sourceUrl?: string;
  capturedAt: string;
  companyName: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  website?: string;
  linkedinUrl?: string;
  employeeCountEstimate?: number;
  description?: string;
  proposedSic?: string;
  contactName?: string;
  contactTitle?: string;
  evidence: string[];
};

export type ExistingCompany = {
  id: string;
  companyName: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  website?: string;
  status?: "DIRE" | "research" | "RDL" | "DEL";
};

export type MatchClassification =
  | "likely_duplicate"
  | "possible_duplicate"
  | "likely_new";

export type MatchResult = {
  existingCompanyId?: string;
  score: number;
  classification: MatchClassification;
  reasons: string[];
};

export type ReviewQueueItem = {
  candidate: CandidateCompany;
  bestMatch: MatchResult;
  completenessScore: number;
  reviewPriority: number;
};
