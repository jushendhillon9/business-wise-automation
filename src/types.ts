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
 * model for existing records is out of scope for this project.
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
 * Conceptual shape of one queue row, kept here for reference. Note the four
 * concepts stay separate and none of them imply the others:
 * - entityResolution: does this location candidate already exist in BW?
 * - researchCompleteness: how much do we know about it?
 * - publicationReadiness: does it satisfy BW's actual required-field rules?
 * - reviewPriority: which candidate should a human look at first?
 * See src/scoring.ts and src/publication-readiness.ts for the real return types.
 */
export type ReviewQueueItem = {
  candidate: LocationCandidate;
  entityResolution: MatchResult;
  researchCompleteness: { score: number; presentFields: string[]; missingFields: string[] };
  publicationReadiness: { ready: boolean; blockingReasons: string[]; unresolvedRequirements: string[] };
  reviewPriority: number;
};
