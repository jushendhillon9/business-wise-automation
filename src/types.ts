/**
 * A person Business Wise could contact at a candidate location. All fields
 * are optional in the type system (a source may only give us a name, or only
 * an email), but publication readiness treats a Contact as "meaningful" only
 * if it carries at least a name or an email — see `isMeaningfulContact`.
 * Contacts stay associated with a single LocationCandidate for now; there is
 * no company-wide contact graph yet.
 */
export type Contact = {
  /**
   * Stable identifier for this contact within its LocationCandidate, used so
   * field-level evidence (see FieldEvidence/FieldPath below) can stay linked
   * to the right contact even if the contacts array is reordered or grows.
   * Optional for backward compatibility with hand-built fixtures/tests that
   * predate Task 6 and don't need evidence linkage.
   */
  id?: string;
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
 * Field-level evidence and confidence (docs/BWI_DOMAIN_RULES.md §15). Answers,
 * for one proposed value on one company/location/contact field: where did
 * this specific value come from, how confident are we in it, and — for
 * inherited/derived values — why was it proposed? This is deliberately
 * separate from `SourceProvenance` above (which describes where the whole
 * `LocationCandidate` observation came from) and from `EntityResolutionDecision
 * .decisionConfidence` (which measures match confidence, a different
 * question entirely — see docs/COMPANY_LOCATION_MODEL.md). Field confidence
 * never feeds publication readiness, entity-resolution outcomes, or review
 * priority; it exists purely so a reviewer can audit a proposed value.
 */

/** Which part of the domain model a field-evidence record is about. Mirrors ReadinessRuleScope (src/publication-readiness.ts) — kept as a separate type here to avoid a circular import, since publication-readiness.ts already imports from this file. */
export type EvidenceScope = "company" | "location" | "contact";

/**
 * Stable identifier for the field a piece of evidence supports. Company/
 * location fields use a plain "scope.field" pair (matching the same
 * namespaced-field convention `ResearchCompletenessResult` and
 * `PublicationReadinessIssue` already use, e.g. "company.website",
 * "location.phone"). Contact fields additionally carry the contact's own
 * stable `Contact.id` so evidence never depends on array position — see
 * "Contact evidence" note on `Contact.id` above.
 */
export type FieldPath =
  | { scope: "company"; field: string }
  | { scope: "location"; field: string }
  | { scope: "contact"; contactId: string; field: string };

/** Deterministic string key for grouping/looking up evidence by field — never used as a display label. */
export function fieldPathKey(path: FieldPath): string {
  return path.scope === "contact" ? `contact.${path.contactId}.${path.field}` : `${path.scope}.${path.field}`;
}

export function companyFieldPath(field: string): FieldPath {
  return { scope: "company", field };
}

export function locationFieldPath(field: string): FieldPath {
  return { scope: "location", field };
}

export function contactFieldPath(contactId: string, field: string): FieldPath {
  return { scope: "contact", contactId, field };
}

/**
 * Confidence scale for field-level evidence: 0 (no confidence) through 1
 * (fully confirmed) — the same 0–1 convention already used by
 * `MatchResult.score` and `EntityResolutionDecision.decisionConfidence`,
 * per docs/BWI_DOMAIN_RULES.md §15. Missing confidence is never treated as
 * 1 (perfect) — every FieldEvidence record requires an explicit value.
 */
export function isValidFieldEvidenceConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Throws when confidence is outside the documented [0, 1] scale, instead of silently clamping or accepting it. */
export function assertValidFieldEvidenceConfidence(value: number): number {
  if (!isValidFieldEvidenceConfidence(value)) {
    throw new RangeError(`FieldEvidence confidence must be a number between 0 and 1 (got ${value}).`);
  }
  return value;
}

/**
 * Deliberately conservative starting confidence for a value read directly
 * from one external, unverified source record (the common case for the
 * current DFW fixture adapters — a single chamber/license row, not
 * independently confirmed). Not a tuned/calibrated value.
 * Needs confirmation from Jushen: the exact confidence scale/calibration
 * BW reviewers should expect is not yet defined anywhere in the domain docs.
 */
export const SINGLE_SOURCE_OBSERVED_CONFIDENCE = 0.6;

/**
 * Research source categories a piece of field evidence can come from.
 * Matches docs/BWI_DOMAIN_RULES.md §15's "Current research source types"
 * list, plus a few sources that naturally have no URL (an existing BWI
 * export, a human research judgment call, a locally supplied CSV/manual
 * record) and a fallback for anything not yet categorized.
 */
export type FieldEvidenceSourceType =
  | "company_website"
  | "team_page"
  | "linkedin"
  | "perplexity_research"
  | "hunter_email_verification"
  | "google_search"
  | "secretary_of_state_filing"
  | "business_journal"
  | "chamber_of_commerce"
  | "economic_development_org"
  | "county_business_license"
  | "research_on_demand_request"
  | "existing_bwi_record"
  | "human_research_decision"
  /** A field value read from a Task 7 local BWI snapshot export (CSV/JSON), not a live database connection. */
  | "bwi_canonical_snapshot_import"
  /** A field value read directly from the canonical BWI directory layer (DirCompany/DirCompanyDirectory) via the Task 7 read-only live adapter. */
  | "bwi_canonical_live_import"
  | "other";

/**
 * Identifies where one field-level evidence record came from. Deliberately
 * reuses `SourceProvenance`'s own field names (`sourceId`/`sourceName`/
 * `sourceUrl`/`sourceRecordId`) via `Pick` rather than inventing a second,
 * incompatible source taxonomy — this is the same source identity concept,
 * scoped down to what one field-level observation needs. `sourceUrl` stays
 * optional because not every source naturally has one (an authorized BWI
 * export, a human research decision, a local CSV row); `sourceObservationId`
 * is the fallback stable reference for those cases, distinct from
 * `sourceRecordId` when the two aren't the same thing (e.g. a dedup
 * fingerprint, or a manually assigned id for a non-ingested source).
 */
export type FieldEvidenceSource = Pick<SourceProvenance, "sourceId" | "sourceName" | "sourceUrl" | "sourceRecordId"> & {
  sourceType: FieldEvidenceSourceType;
  sourceObservationId?: string;
};

/**
 * How a proposed value came to be, distinct from the confidence in it. A
 * `directly_observed` value with low confidence and an `inherited` value
 * with high confidence are both legitimate — derivation and confidence are
 * independent axes.
 */
export type FieldEvidenceDerivation =
  | "directly_observed"
  | "normalized"
  | "derived"
  | "inherited"
  | "human_confirmed";

/**
 * Present only when `derivation === "inherited"`. Preserves *why* an
 * existing company/location value was proposed for a new candidate, and
 * whether the new candidate has any evidence of its own confirming it —
 * never assume independent confirmation just because a value was inherited.
 * This type only describes the shape; no inheritance-proposal logic is
 * implemented as part of Task 6 (entity-resolution/inheritance rules are
 * explicitly out of scope here — see docs/COMPANY_LOCATION_MODEL.md
 * §12.5's "Field inheritance" gap).
 */
export type FieldEvidenceInheritance = {
  /** The existing BWI record (ExistingCompany.id) this value was proposed from, when known. */
  fromExistingCompanyId?: string;
  /** The prior source observation (another FieldEvidence's sourceObservationId/fingerprint) this was proposed from, when known. */
  fromSourceObservationId?: string;
  reason: string;
  independentlyConfirmed: boolean;
};

/**
 * One piece of evidence supporting a proposed value on one field. A field
 * may have zero (see "Missing-evidence behavior" in the README), one, or
 * many `FieldEvidence` records — including several that agree and some
 * that conflict; nothing in this model ever overwrites or discards earlier
 * evidence for the same field.
 */
export type FieldEvidence<T = unknown> = {
  path: FieldPath;
  /** The value this evidence supports, in whatever form the source actually gave it (may equal normalizedValue). */
  value: T;
  /** The normalized/typed interpretation of `value`, when it differs (e.g. a normalized SiteType vs. a raw site-type code). */
  normalizedValue?: T;
  /** Raw source value as originally given, when useful for audit and distinct from `value`. */
  rawValue?: unknown;
  confidence: number;
  source: FieldEvidenceSource;
  /** When the source claims this value was captured. Never fabricated for historical evidence when unknown — omit rather than guess. */
  capturedAt?: string;
  /** Optional supporting excerpt/quote from the source. */
  evidenceText?: string;
  derivation?: FieldEvidenceDerivation;
  inheritance?: FieldEvidenceInheritance;
};

export type FieldEvidenceCollection = FieldEvidence[];

/** Validates confidence and returns the evidence unchanged — the canonical way to construct a FieldEvidence so invalid confidence can never silently enter the collection. */
export function createFieldEvidence<T>(evidence: FieldEvidence<T>): FieldEvidence<T> {
  assertValidFieldEvidenceConfidence(evidence.confidence);
  return evidence;
}

/** Appends one validated evidence record without mutating or overwriting any existing evidence for other fields (or the same field). */
export function addFieldEvidence(collection: FieldEvidenceCollection, evidence: FieldEvidence): FieldEvidenceCollection {
  return [...collection, createFieldEvidence(evidence)];
}

/** All evidence recorded for one specific field, in insertion order. Returns an empty array (not undefined) when none exists. */
export function evidenceForField(collection: FieldEvidenceCollection | undefined, path: FieldPath): FieldEvidence[] {
  if (!collection) return [];
  const key = fieldPathKey(path);
  return collection.filter((item) => fieldPathKey(item.path) === key);
}

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
  /**
   * Field-level evidence and confidence (see FieldEvidence above), keyed to
   * individual company/location/contact fields. Optional and defaults to
   * "no evidence recorded" (never "confirmed" and never confidence 1.0) so
   * legacy candidates/fixtures created before Task 6 keep loading safely —
   * see evidenceForField()/hasFieldEvidence() for reading it without special
   * casing the undefined case. Additive alongside the free-text `evidence`
   * list above and `rawSourceData` below; neither is replaced by this.
   */
  fieldEvidence?: FieldEvidenceCollection;
  /** Original raw source record, kept for audit/debugging. */
  rawSourceData?: unknown;
};

/** True when at least one FieldEvidence record exists for this field. False (not an exception) is the correct, expected answer for a legacy candidate or a field a source didn't support with evidence. */
export function hasFieldEvidence(candidate: LocationCandidate, path: FieldPath): boolean {
  return evidenceForField(candidate.fieldEvidence, path).length > 0;
}

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
export type ExistingCompanyStatus =
  | "DIRE"
  | "DEL"
  | "RDEL"
  | "RDL"
  | "research"
  // Widened (not a plain closed union) starting Task 7: a real/snapshot BWI
  // import may surface a raw status code beyond these five documented
  // values. Preserving it verbatim (never coercing an unrecognized code
  // into one of the five, and never dropping it) matters more than a fully
  // closed type here — see normalizeBwiLifecycleStatus() in src/bwi-codes.ts
  // for how an unrecognized raw value still normalizes safely to "unknown"
  // on `lifecycleStatus` without losing the original string on `status`.
  | (string & {});

/**
 * A known Business Wise location record to match candidates against. Kept
 * flat (company + location facts together) since it represents one existing
 * BWI location row, not a company-wide identity — BW's own master-data
 * model for existing records is out of scope for this project. (Not
 * renamed to `ExistingLocation` in this task — see the naming note in
 * docs/COMPANY_LOCATION_MODEL.md.) `id` is what `MatchResult.existingCompanyId`
 * and `EntityResolutionDecision.matchedExistingCompanyId` refer to. Since
 * Task 7, `id` is also the stable BWI identifier when this record came from
 * a real BWI import (live or snapshot) — see docs/BWI_READ_ONLY_IMPORT.md.
 */
export type ExistingCompany = {
  id: string;
  companyName: string;
  /** Search/sort name, when the source provides one. Mirrors CompanyIdentity.alphasort. */
  alphasort?: string;
  address?: string;
  /** Mailing address, when it differs from `address` and the source provides one. Kept as a flat string, matching `address`'s shape rather than LocationCandidate's structured `Address` — see the naming note above for why this type stays flat. */
  mailingAddress?: string;
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
  /** Normalized BWI site type for this existing location, when the source provides one. Informational only — scoreCandidateAgainstExisting() (src/entity-resolution.ts) does not compare this field; adding it here must never change Task 4 scoring. */
  siteType?: SiteType;
  /** Exact raw site-type code as given by the source, preserved verbatim — see src/bwi-codes.ts. */
  rawSiteTypeCode?: string;
  /** Parent/affiliate relationship, when the source provides one. Informational only, same non-scoring caveat as `siteType`. */
  relationship?: Relationship;
  /** BW metro market, e.g. "DFW". */
  market?: string;
  county?: string;
  employeeSizeSite?: EmployeeSizeValue;
  employeeSizeCompanyWide?: EmployeeSizeValue;
  /**
   * Last-updated/audit timestamp from the source system, when known — never
   * fabricated. Needs confirmation from Jushen: the exact production
   * audit-date column(s) and semantics (DirEntity's audit metadata is
   * confirmed to exist at the table level per
   * docs/BWI_PRODUCTION_DB_DISCOVERY.md §3.1, but individual column meaning
   * is not independently confirmed there).
   */
  lastUpdatedAt?: string;
  /** Where this existing-record snapshot came from (a Task 7 BWI live/snapshot import). Absent for records that predate Task 7 (e.g. seed.ts fixtures) or were entered another way. */
  source?: SourceProvenance;
  /** Field-level evidence for this record's individual fields, when imported with evidence attached — see docs/BWI_READ_ONLY_IMPORT.md. Optional for the same backward-compatibility reason as `LocationCandidate.fieldEvidence`. */
  fieldEvidence?: FieldEvidenceCollection;
};

/**
 * Alias naming `ExistingCompany` by its Task 7 role: the canonical
 * existing-BWI-location record entity resolution compares incoming
 * candidates against. Not a separate type or a second domain model —
 * `ExistingCompany` already *is* this concept (see the naming note above);
 * this alias just gives Task 7 code and docs a name that matches
 * docs/BWI_PRODUCTION_DB_DISCOVERY.md's vocabulary without triggering a
 * repo-wide rename (deferred — see the naming note).
 */
export type ExistingBwiLocation = ExistingCompany;

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
