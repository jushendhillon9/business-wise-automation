/**
 * A person Business Wise could contact at a candidate location. All fields
 * are optional in the type system (a source may only give us a name, or only
 * an email), but publication readiness treats a Contact as "meaningful" only
 * if it carries at least a name or an email — see `isMeaningfulContact`.
 * Contacts stay associated with a single LocationCandidate for now; there is
 * no company-wide contact graph yet.
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
 * A postal address. Used for both LocationCandidate.physicalAddress and
 * LocationCandidate.mailingAddress — every field is optional since sources
 * frequently give a partial address (e.g. city+state only).
 */
export type Address = {
  street?: string;
  suite?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

/**
 * Internal, readable representation of Business Wise's Site Type field.
 * BW's own data uses single-letter codes (S/H/B/R/U); those codes should
 * only appear at the BW integration boundary, via SITE_TYPE_TO_BW_CODE /
 * BW_CODE_TO_SITE_TYPE below, or the tolerant `normalizeBwiSiteType()` in
 * src/bwi-codes.ts (preferred for anything parsing a raw source value,
 * since it also handles blank/lowercase/unrecognized input safely).
 * "unknown" is BWI's own explicit "U" code, not merely an absent value —
 * see src/bwi-codes.ts for how an unrecognized (not S/H/B/R/U) raw code is
 * also normalized to "unknown", distinguished from "U" only by a
 * `recognized: false` flag, not a different SiteType value.
 */
export type SiteType = "single_site" | "headquarters" | "branch" | "regional_headquarters" | "unknown";

export type BwSiteTypeCode = "S" | "H" | "B" | "R" | "U";

export const SITE_TYPE_TO_BW_CODE: Record<SiteType, BwSiteTypeCode> = {
  single_site: "S",
  headquarters: "H",
  branch: "B",
  regional_headquarters: "R",
  unknown: "U"
};

export const BW_CODE_TO_SITE_TYPE: Record<BwSiteTypeCode, SiteType> = {
  S: "single_site",
  H: "headquarters",
  B: "branch",
  R: "regional_headquarters",
  U: "unknown"
};

/**
 * Normalized BWI lifecycle status (docs/BWI_DOMAIN_RULES.md §4). Both `RDL`
 * and `RDEL` — the unresolved raw spelling for "research delete" — normalize
 * to `research_deleted`; the exact raw string is preserved separately (see
 * `ExistingCompany.status`), never collapsed into one canonical spelling.
 * Use `normalizeBwiLifecycleStatus()` in src/bwi-codes.ts to compute this
 * from a raw status string.
 */
export type BwiLifecycleStatus = "published" | "research" | "deleted" | "research_deleted" | "unknown";

/** Corporate relationship fields (see docs/BWI_DOMAIN_RULES.md §6.1 and §12.5). All unconfirmed as publication-blocking. */
export type Relationship = {
  parentCompany?: string;
  affiliate?: string;
  /** Only applicable when the company (or its parent) is publicly traded. */
  tickerSymbol?: string;
};

/**
 * A categorical/banded value (e.g. Business Wise employee-size or revenue
 * bands) that may also carry a raw source estimate. Deliberately loose: a
 * source might give us an exact number, a min/max band, a label like "10-49
 * employees", a raw BWI code, or some combination — this preserves whatever
 * we actually have instead of forcing everything into one number.
 */
export type BandedValue = {
  estimate?: number;
  minimum?: number;
  maximum?: number;
  bandLabel?: string;
  rawCode?: string;
};

export type EmployeeSizeValue = BandedValue;
export type RevenueValue = BandedValue;

/** Wraps a plain numeric estimate (e.g. from a source that only gives a headcount) into a BandedValue. */
export function asEstimate(value?: number): BandedValue | undefined {
  return value === undefined ? undefined : { estimate: value };
}

/**
 * Company-level identity: facts that are true of the company regardless of
 * which location you're looking at. In the real BWI "Duplicate" workflow,
 * these are the fields copied forward when a researcher adds a new location
 * for an already-known company.
 */
export type CompanyIdentity = {
  id: string;
  legalName: string;
  /** "Doing business as" name, when it differs from the legal/registered name. */
  dbaName?: string;
  /**
   * Search/sort name (docs/BWI_DOMAIN_RULES.md §6.1). Confirmed required on the blank BWI New
   * Company Profile (§8.2). Minimally modeled here (presence only, no formatting rules) so
   * src/publication-readiness.ts can check it; see docs/COMPANY_LOCATION_MODEL.md's gaps list.
   */
  alphasort?: string;

  website?: string;
  emailFormat?: string;

  sicCode?: string;
  startYear?: number;

  relationship?: Relationship;
  international?: boolean;

  /** Internal-only research field, not a BW publish field. */
  teamPageUrl?: string;
  linkedinUrl?: string;
};

/**
 * Source provenance for one ingested observation. Answers: where did we find
 * this, which source produced it, and can we recognize it if we see it
 * again? `fingerprint` is the ingestion-deduplication key — see
 * src/sources/fingerprint.ts. This is deliberately unrelated to entity
 * resolution (src/entity-resolution.ts), which asks whether the observation
 * matches an existing Business Wise company/location.
 */
export type SourceProvenance = {
  sourceId: string;
  sourceName: string;
  sourceUrl?: string;
  /** Identifier of this record within the source, when the source provides one. */
  sourceRecordId?: string;
  fingerprint: string;
  /** When this pipeline ingested the record. */
  ingestedAt: string;
};

/**
 * A single observed location for a company, as reported by one source item.
 * Business Wise is location-centric — a real company may have a
 * headquarters, several branches, and a regional HQ, each with its own
 * address, phone, site type, employee count, and contacts, while sharing one
 * CompanyIdentity. Ingestion produces one LocationCandidate per source item;
 * it does not decide whether two LocationCandidates belong to the same
 * company (see docs/COMPANY_LOCATION_MODEL.md) or the same existing BW
 * location (see src/entity-resolution.ts) — both are downstream concerns.
 */
export type LocationCandidate = {
  id: string;
  company: CompanyIdentity;

  physicalAddress?: Address;
  mailingAddress?: Address;

  /** Local phone number. BW convention: 000-000-0000 may mean "confirmed to exist, number non-published" rather than unknown. */
  phone?: string;
  tollFreePhone?: string;

  /** BW metro market, e.g. "DFW", "Atlanta", "Charlotte". */
  market?: string;
  county?: string;

  siteType?: SiteType;
  /** Exact raw site-type code as given by the source/BWI (e.g. "H", " h ", "S"), preserved verbatim even after normalization into `siteType`. See src/bwi-codes.ts. */
  rawSiteTypeCode?: string;
  buildingName?: string;
  /** Free text: BW's categorical building-type codes are not confirmed yet. */
  buildingType?: string;
  leaseOrOwn?: "lease" | "own";

  /** Employee Size, Site — headcount at this specific location. */
  employeeSizeSite?: EmployeeSizeValue;
  /** Employee Size, Co-Wide — only meaningful for single_site/headquarters records. */
  employeeSizeCompanyWide?: EmployeeSizeValue;
  employeeCountExact?: number;
  /** Total Sites — only meaningful for single_site/headquarters records. */
  totalSites?: number;

  /** Estimated Annual Revenue — only meaningful for single_site/headquarters records. */
  estimatedAnnualRevenue?: RevenueValue;

  description?: string;
  /** Minimum one meaningful contact is required to publish a BW record. */
  contacts: Contact[];

  source: SourceProvenance;
  /** When the source claims the record was discovered/published. */
  capturedAt: string;

  evidence: string[];
  /** Original raw source record, kept for audit/debugging. */
  rawSourceData?: unknown;
};

/**
 * docs/BWI_DOMAIN_RULES.md §4 defines DIRE (published/active), DEL (previously
 * published, now deleted), and RDL/RDEL (research delete, never published —
 * "Unresolved spelling" per that document). Earlier discovery notes in this
 * repo instead used "RDL" and a plain "research" status. That discrepancy is
 * NOT resolved — do not silently normalize one to the other; see open domain
 * questions §23.1–2. All five raw-looking values are kept below until
 * Emily/Rif/Randall confirm which strings are actually persisted in BW's
 * system. This is the raw value — see `ExistingCompany.lifecycleStatus` for
 * the normalized counterpart, computed by `normalizeBwiLifecycleStatus()` in
 * src/bwi-codes.ts, which maps both "RDL" and "RDEL" to the same
 * `research_deleted` semantic value without erasing which raw spelling was
 * actually stored.
 */
export type ExistingCompanyStatus = "DIRE" | "DEL" | "RDEL" | "RDL" | "research";

/**
 * A known Business Wise location record to match candidates against. Kept
 * flat (company + location facts together) since it represents one existing
 * BWI location row, not a company-wide identity — BW's own master-data
 * model for existing records is out of scope for this project. (Not
 * renamed to `ExistingLocation` in this task — see the naming note in
 * docs/COMPANY_LOCATION_MODEL.md.) `id` is what `MatchResult.existingCompanyId`
 * and `EntityResolutionDecision.matchedExistingCompanyId` refer to.
 */
export type ExistingCompany = {
  id: string;
  companyName: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  website?: string;
  sicCode?: string;
  /** Exact raw BWI status string (e.g. "DIRE", "RDL"). Never normalized away. */
  status?: ExistingCompanyStatus;
  /** Normalized semantic lifecycle derived from `status` — see src/bwi-codes.ts. Always recomputed from `status` on insert (src/db.ts), so the two never drift apart. */
  lifecycleStatus?: BwiLifecycleStatus;
};

export type MatchClassification =
  | "likely_duplicate"
  | "possible_duplicate"
  | "likely_new";

/** Company-level match evidence: facts that should hold across all of a company's locations. */
export type CompanySimilarity = {
  nameScore: number;
  domainMatch: boolean;
  sicMatch: boolean;
};

/** Location-level match evidence: facts specific to this physical site. */
export type LocationSimilarity = {
  addressScore: number;
  phoneMatch: boolean;
  cityStateMatch: boolean;
};

/**
 * Result of comparing a LocationCandidate against one ExistingCompany.
 * companySimilarity/locationSimilarity are kept separate so future, richer
 * outcomes (same_existing_location, new_branch_of_existing_company,
 * headquarters_move, ...) can be derived from their combination without
 * reworking the matching evidence again. Only likely_new/possible_duplicate/
 * likely_duplicate are produced today.
 */
export type MatchResult = {
  existingCompanyId?: string;
  companySimilarity: CompanySimilarity;
  locationSimilarity: LocationSimilarity;
  score: number;
  classification: MatchClassification;
  reasons: string[];
};

/**
 * One existing BWI record, ranked and paired with its similarity evidence.
 * `rankCandidateMatches()` (src/entity-resolution.ts) returns these in a
 * deterministic best-to-worst order; the business-decision policy layer
 * (src/entity-resolution-policy.ts) reads the ranked list to pick a
 * business outcome without recomputing similarity.
 */
export type RankedMatch = {
  existing: ExistingCompany;
  match: MatchResult;
};

/**
 * The operational question a Business Wise researcher actually needs
 * answered — distinct from (and built on top of) `MatchClassification`,
 * which only describes raw similarity strength. See
 * docs/COMPANY_LOCATION_MODEL.md for full definitions of each outcome and
 * docs/BWI_DOMAIN_RULES.md §12.4 for the aspirational full taxonomy this is
 * a deliberately conservative, simplified version of (that section's
 * `possible_same_location_changed_details` and `possible_headquarters_move`
 * are merged here into one `possible_changed_location`).
 */
export type EntityResolutionOutcome =
  | "same_existing_location"
  | "possible_changed_location"
  | "new_branch_of_existing_company"
  | "new_headquarters_of_existing_company"
  | "possible_name_change"
  | "likely_new_company"
  | "ambiguous_manual_review";

/**
 * Stable, machine-readable identifiers for *why* a decision was reached.
 * Kept as a closed union (not free-text prose) so the queue/detail views and
 * any future automation can rely on exact values. Not every reason is used
 * by every outcome — see src/entity-resolution-policy.ts for which reasons
 * a given outcome can produce.
 */
export type EntityResolutionReasonCode =
  | "no_existing_locations_to_compare"
  | "exact_domain_match"
  | "sic_match"
  | "strong_company_name_match"
  | "similar_company_name_match"
  | "exact_normalized_address_match"
  | "strong_normalized_address_match"
  | "exact_phone_match"
  | "city_state_match"
  | "candidate_site_type_branch"
  | "candidate_site_type_headquarters"
  | "candidate_site_type_unknown"
  | "candidate_site_type_missing"
  | "existing_company_other_location_found"
  | "weak_or_no_match_evidence";

/**
 * Stable, machine-readable identifiers for evidence that conflicts with (or
 * complicates) the chosen outcome. See src/entity-resolution-policy.ts.
 */
export type EntityResolutionConflictCode =
  | "multiple_close_existing_location_matches"
  | "company_name_materially_different"
  | "candidate_address_differs_from_best_existing_location"
  | "existing_location_is_deleted"
  | "existing_location_is_research_deleted";

/**
 * The richer, conservative business-resolution decision for one
 * LocationCandidate, built on top of (never replacing) the low-level
 * MatchResult evidence. `bestMatch`/`alternativeMatches` are the same
 * MatchResult values `scoreCandidateAgainstExisting()` always produced —
 * this layer only interprets them, it does not recompute or recalibrate
 * the underlying score/classification. See
 * src/entity-resolution-policy.ts's `resolveCandidateAgainstExisting()`.
 */
export type EntityResolutionDecision = {
  outcome: EntityResolutionOutcome;
  /**
   * Deterministic heuristic derived from the existing similarity score —
   * NOT a statistically calibrated probability. Omit from any UI copy that
   * implies otherwise. See src/entity-resolution-policy.ts for how it's
   * computed.
   */
  decisionConfidence?: number;

  bestMatch?: MatchResult;
  /** Up to 2 next-best matches, in the same deterministic order as `rankCandidateMatches()`. */
  alternativeMatches: MatchResult[];

  /** The existing BWI record (location row) this decision is about, when the outcome names one. */
  matchedExistingCompanyId?: string;
  /** Other existing records that plausibly belong to the same company identity (e.g. other locations found for a new-branch/new-HQ outcome). */
  relatedExistingCompanyIds?: string[];

  reasons: EntityResolutionReasonCode[];
  conflicts: EntityResolutionConflictCode[];

  /**
   * True when this decision should get extra human scrutiny beyond the
   * normal review-queue flow (e.g. the matched record is deleted, or the
   * outcome is inherently non-definitive). Every candidate still goes
   * through human review regardless — this flags the cases where the
   * automated interpretation itself is uncertain or historically sensitive.
   */
  requiresHumanReview: boolean;
};

/**
 * Conceptual shape of one queue row, kept here for reference. Note the four
 * concepts stay separate and none of them imply the others:
 * - entityResolution: does this location candidate already exist in BW?
 * - researchCompleteness: how much do we know about it?
 * - publicationReadiness: does it satisfy BW's actual required-field rules?
 * - reviewPriority: which candidate should a human look at first?
 * See src/scoring.ts and src/publication-readiness.ts for the real return
 * types, and src/entity-resolution-policy.ts for `EntityResolutionDecision`,
 * the richer business-outcome layer built on top of `entityResolution`.
 */
export type ReviewQueueItem = {
  candidate: LocationCandidate;
  entityResolution: MatchResult;
  entityResolutionDecision: EntityResolutionDecision;
  researchCompleteness: { score: number; presentFields: string[]; missingFields: string[] };
  /** See `PublicationReadinessAssessment` in src/publication-readiness.ts for the real, structured shape. */
  publicationReadiness: { state: "blocked" | "provisionally_ready" | "confirmed_ready" };
  reviewPriority: number;
};
