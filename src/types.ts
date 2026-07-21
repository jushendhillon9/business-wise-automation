/**
 * A person Business Wise could contact at a candidate company. All fields are
 * optional in the type system (a source may only give us a name, or only an
 * email), but publication readiness treats a Contact as "meaningful" only if
 * it carries at least a name or an email — see `isMeaningfulContact`.
 */
export type Contact = {
  name?: string;
  title?: string;
  email?: string;
  phone?: string;
};

export function isMeaningfulContact(contact: Contact): boolean {
  return Boolean(contact.name?.trim() || contact.email?.trim());
}

export function hasMeaningfulContact(contacts: Contact[]): boolean {
  return contacts.some(isMeaningfulContact);
}

/**
 * Internal, readable representation of Business Wise's Site Type field.
 * BW's own data uses single-letter codes (S/H/B/R); those codes should only
 * appear at the BW integration boundary, via SITE_TYPE_TO_BW_CODE /
 * BW_CODE_TO_SITE_TYPE below.
 */
export type SiteType = "single_site" | "headquarters" | "branch" | "regional_headquarters";

export type BwSiteTypeCode = "S" | "H" | "B" | "R";

export const SITE_TYPE_TO_BW_CODE: Record<SiteType, BwSiteTypeCode> = {
  single_site: "S",
  headquarters: "H",
  branch: "B",
  regional_headquarters: "R"
};

export const BW_CODE_TO_SITE_TYPE: Record<BwSiteTypeCode, SiteType> = {
  S: "single_site",
  H: "headquarters",
  B: "branch",
  R: "regional_headquarters"
};

/** Corporate relationship fields from Emily's document. All unconfirmed as publication-blocking. */
export type Relationship = {
  parentCompany?: string;
  affiliate?: string;
  /** Only applicable when the company (or its parent) is publicly traded. */
  tickerSymbol?: string;
};

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
  /** "Doing business as" name, when it differs from the legal/registered name. */
  dbaName?: string;

  /** Local phone number. BW convention: 000-000-0000 may mean "confirmed to exist, number non-published" rather than unknown. */
  phone?: string;
  tollFreePhone?: string;

  /** Physical street address. */
  address?: string;
  suite?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  county?: string;
  mailingAddress?: string;

  siteType?: SiteType;
  /** Employee Size, Site — headcount at this specific location. */
  employeeCountEstimate?: number;
  /** Employee Size, Co-Wide — only meaningful for single_site/headquarters records. */
  employeeSizeCompanyWide?: number;
  /** Total Sites — only meaningful for single_site/headquarters records. */
  totalSites?: number;

  startYear?: number;
  /** Estimated Annual Revenue — only meaningful for single_site/headquarters records. */
  estimatedAnnualRevenue?: number;

  website?: string;
  emailFormat?: string;
  linkedinUrl?: string;
  /** Internal-only research field, not a BW publish field. */
  teamPageUrl?: string;

  proposedSic?: string;
  relationship?: Relationship;
  description?: string;

  /** Minimum one meaningful contact is required to publish a BW record. */
  contacts: Contact[];

  evidence: string[];
  /** Original raw source record, kept for audit/debugging. */
  rawSourceData?: unknown;
};

/**
 * Emily's document defines DIRE (published/active), DEL (previously published,
 * now deleted), and RDEL (added for research but never completed/published).
 * Earlier discovery notes in this repo instead used "RDL" and a "research"
 * status. That discrepancy is NOT resolved — do not silently normalize one to
 * the other. All four values are kept below until Emily/Rif/Randall confirm
 * which strings are actually persisted in BW's system.
 */
export type ExistingCompanyStatus = "DIRE" | "DEL" | "RDEL" | "RDL" | "research";

export type ExistingCompany = {
  id: string;
  companyName: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  website?: string;
  status?: ExistingCompanyStatus;
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

/**
 * Conceptual shape of one queue row, kept here for reference. Note the four
 * concepts stay separate and none of them imply the others:
 * - entityResolution: does this candidate already exist in BW?
 * - researchCompleteness: how much do we know about it?
 * - publicationReadiness: does it satisfy BW's actual required-field rules?
 * - reviewPriority: which candidate should a human look at first?
 * See src/scoring.ts and src/publication-readiness.ts for the real return types.
 */
export type ReviewQueueItem = {
  candidate: CandidateCompany;
  entityResolution: MatchResult;
  researchCompleteness: { score: number; presentFields: string[]; missingFields: string[] };
  publicationReadiness: { ready: boolean; blockingReasons: string[]; unresolvedRequirements: string[] };
  reviewPriority: number;
};
