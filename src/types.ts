export type CandidateCompany = {
  id: string;
  /** Human-readable source name, e.g. "DFW Chamber Discovery Feed (JSON)". */
  source: string;
  /** Stable adapter identifier, e.g. "dfw-json". Matches SourceAdapter.sourceId. */
  sourceId: string;
  sourceUrl?: string;
  /** Identifier of this record within the source, when the source provides one. */
  sourceRecordId?: string;
  /** When the source claims the record was discovered/published. */
  capturedAt: string;
  /** When this pipeline ingested the record. */
  ingestedAt: string;
  /** Idempotency key for ingestion: sourceId + sourceRecordId, or a content hash. */
  fingerprint: string;
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
  /** Original raw source record, kept for audit/debugging. */
  rawSourceData?: unknown;
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
