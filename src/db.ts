import { Database } from "bun:sqlite";
import { normalizeBwiLifecycleStatus } from "./bwi-codes.ts";
import { isPublicationReadyCompat, type PublicationReadinessAssessment } from "./publication-readiness.ts";
import type { MachineRecommendationSnapshot, ReviewDecision, ReviewFieldCorrection, ReviewQueueStatus } from "./review-decisions.ts";
import type { ResearchCompletenessResult } from "./scoring.ts";
import type { CompanyIdentity, EntityResolutionDecision, ExistingCompany, LocationCandidate, MatchResult } from "./types.ts";

export const DB_PATH = "data/sandbox.sqlite";

/**
 * Enables foreign-key enforcement on every connection this process opens --
 * `PRAGMA foreign_keys` is per-connection in SQLite, never persisted in the
 * database file itself, so it must be set here (not just once during
 * `createSchema()`) or every FOREIGN KEY declared in the schema is silently
 * decorative. See src/db.test.ts for the regression test.
 */
export function openDb(path: string = DB_PATH): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/**
 * Explicit, ordered DDL statements -- each executed as its own `db.exec()`
 * call rather than one large multi-statement string. This guarantees the
 * creation order is exactly what's listed here (in particular,
 * `review_decisions` and everything that depends on it, like its index,
 * only ever run after every table it could reference already exists), and
 * a failure on any one statement surfaces immediately with that statement's
 * own name attached, instead of manifesting later as a downstream "no such
 * table" error from whatever statement never got to run. See
 * src/db.test.ts's fresh-schema test for the regression coverage.
 */
const SCHEMA_STATEMENTS: Array<{ name: string; sql: string }> = [
  { name: "PRAGMA journal_mode", sql: `PRAGMA journal_mode = WAL;` },

  {
    // status is the exact raw BWI lifecycle code (e.g. "DIRE", "RDL"), never
    // normalized away. lifecycle_status is the normalized counterpart,
    // always recomputed from status via normalizeBwiLifecycleStatus() on
    // insert (src/bwi-codes.ts) so the two can never drift apart.
    name: "CREATE TABLE existing_companies",
    sql: `
      CREATE TABLE IF NOT EXISTS existing_companies (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        address TEXT,
        city TEXT,
        state TEXT,
        postal_code TEXT,
        phone TEXT,
        website TEXT,
        sic_code TEXT,
        status TEXT,
        lifecycle_status TEXT
      );
    `
  },

  {
    // Company-level identity: facts that should be true across every
    // location of the same company. Ingestion always creates a fresh,
    // provisional identity per observation (never merges across sources) --
    // see docs/COMPANY_LOCATION_MODEL.md. The schema still supports one
    // identity having many locations, for when entity resolution later
    // consolidates provisional identities.
    name: "CREATE TABLE company_identities",
    sql: `
      CREATE TABLE IF NOT EXISTS company_identities (
        id TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL,
        dba_name TEXT,
        website TEXT,
        email_format TEXT,
        sic_code TEXT,
        start_year INTEGER,
        relationship_json TEXT,
        international INTEGER,
        team_page_url TEXT,
        linkedin_url TEXT,
        raw_json TEXT NOT NULL
      );
    `
  },

  {
    // One observed location for a company, as reported by one source item.
    // Location-level facts live as columns here; company-level facts are
    // looked up via company_identity_id (and also embedded in raw_json, a
    // point-in-time snapshot of the full LocationCandidate as ingested).
    name: "CREATE TABLE location_candidates",
    sql: `
      CREATE TABLE IF NOT EXISTS location_candidates (
        id TEXT PRIMARY KEY,
        company_identity_id TEXT NOT NULL,
        company_legal_name TEXT NOT NULL,

        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_url TEXT,
        source_record_id TEXT,
        fingerprint TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,

        physical_street TEXT,
        physical_suite TEXT,
        physical_city TEXT,
        physical_state TEXT,
        physical_postal_code TEXT,
        mailing_address_json TEXT,

        phone TEXT,
        toll_free_phone TEXT,
        market TEXT,
        county TEXT,

        site_type TEXT,
        raw_site_type_code TEXT,
        building_name TEXT,
        building_type TEXT,
        lease_or_own TEXT,

        employee_size_site_json TEXT,
        employee_size_company_wide_json TEXT,
        employee_count_exact INTEGER,
        total_sites INTEGER,
        estimated_annual_revenue_json TEXT,

        description TEXT,
        contacts_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL,
        -- Field-level evidence and confidence (Task 6, docs/BWI_DOMAIN_RULES.md
        -- §15) -- FieldEvidence[] (src/types.ts), keyed to individual
        -- company/location/contact fields. Stored as its own column (mirroring
        -- evidence_json above) even though raw_json already contains it, for
        -- the same reason the other *_json columns exist. Defaults to '[]' so
        -- rows inserted before this column existed still load safely.
        field_evidence_json TEXT NOT NULL DEFAULT '[]',
        raw_source_json TEXT,
        raw_json TEXT NOT NULL,

        FOREIGN KEY(company_identity_id) REFERENCES company_identities(id)
      );
    `
  },

  {
    // Publication readiness is a structured, three-state assessment (see
    // PublicationReadinessAssessment in src/publication-readiness.ts) -- not a
    // weighted score, and not a plain boolean. research completeness is a
    // separate descriptive score of how much we know. Neither implies the
    // other, and neither implies approval or authorization to write/publish
    // in production (see docs/BWI_PRODUCTION_DB_DISCOVERY.md).
    //
    // publication_state is the source of truth: 'blocked' | 'provisionally_ready'
    // | 'confirmed_ready'. publication_ready is a TEMPORARY compatibility
    // column derived from it (1 only when publication_state = 'confirmed_ready')
    // for consumers not yet reading publication_state directly -- see
    // isPublicationReadyCompat() in src/publication-readiness.ts.
    // TODO(remove): drop publication_ready once every consumer reads publication_state.
    //
    // Two distinct entity-resolution layers are both persisted here, deliberately
    // kept in separate columns rather than overloading one "classification" value:
    //   - match_* / best_existing_company_id: the existing low-level similarity
    //     layer (src/entity-resolution.ts) -- score, likely_new/possible_duplicate/
    //     likely_duplicate, and the single best-scoring existing record, unchanged
    //     since before the business-outcome layer existed.
    //   - resolution_*: the richer, conservative business-outcome layer
    //     (src/entity-resolution-policy.ts) built on top of the above -- e.g.
    //     same_existing_location / new_branch_of_existing_company / ... plus
    //     ranked alternatives, explainable reason/conflict codes, and whether the
    //     decision needs extra human scrutiny.
    name: "CREATE TABLE review_queue",
    sql: `
      CREATE TABLE IF NOT EXISTS review_queue (
        location_candidate_id TEXT PRIMARY KEY,
        best_existing_company_id TEXT,
        match_score REAL NOT NULL,
        match_classification TEXT NOT NULL,
        match_reasons_json TEXT NOT NULL,
        match_evidence_json TEXT NOT NULL DEFAULT '{}',
        resolution_outcome TEXT NOT NULL,
        resolution_confidence REAL,
        resolution_reasons_json TEXT NOT NULL DEFAULT '[]',
        resolution_conflicts_json TEXT NOT NULL DEFAULT '[]',
        resolution_matched_existing_company_id TEXT,
        resolution_related_existing_company_ids_json TEXT NOT NULL DEFAULT '[]',
        resolution_alternative_matches_json TEXT NOT NULL DEFAULT '[]',
        resolution_requires_human_review INTEGER NOT NULL DEFAULT 0,
        completeness_score REAL NOT NULL,
        completeness_present_fields_json TEXT NOT NULL DEFAULT '[]',
        completeness_missing_fields_json TEXT NOT NULL DEFAULT '[]',
        publication_state TEXT NOT NULL DEFAULT 'blocked',
        publication_blockers_json TEXT NOT NULL DEFAULT '[]',
        publication_unresolved_rules_json TEXT NOT NULL DEFAULT '[]',
        publication_satisfied_requirements_json TEXT NOT NULL DEFAULT '[]',
        publication_optional_missing_fields_json TEXT NOT NULL DEFAULT '[]',
        publication_ready INTEGER NOT NULL DEFAULT 0,
        review_priority REAL NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending',
        reviewer_note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(location_candidate_id) REFERENCES location_candidates(id)
      );
    `
  },

  {
    // One row per source ingestion invocation. Answers: which source ran,
    // when, and how many raw/valid/new/duplicate/skipped records it produced.
    name: "CREATE TABLE source_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS source_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        raw_count INTEGER NOT NULL DEFAULT 0,
        valid_count INTEGER NOT NULL DEFAULT 0,
        new_candidate_count INTEGER NOT NULL DEFAULT 0,
        already_ingested_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );
    `
  },

  {
    // Ingestion-deduplication ledger: has this exact source item already been
    // processed? Distinct from entity resolution, which asks whether a
    // location candidate matches an existing Business Wise company/location.
    name: "CREATE TABLE source_records",
    sql: `
      CREATE TABLE IF NOT EXISTS source_records (
        source_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        source_record_id TEXT,
        location_candidate_id TEXT NOT NULL,
        first_run_id TEXT NOT NULL,
        first_ingested_at TEXT NOT NULL,
        PRIMARY KEY (source_id, fingerprint),
        FOREIGN KEY(location_candidate_id) REFERENCES location_candidates(id),
        FOREIGN KEY(first_run_id) REFERENCES source_runs(id)
      );
    `
  },

  {
    // Append-only reviewer-decision ledger (src/review-decisions.ts). This is
    // the source of truth for a candidate's review history -- review_queue's
    // review_status/reviewer_note columns are only ever a convenience cache
    // of the latest row here, kept in sync by recordReviewDecision(), never
    // written any other way. No code path ever UPDATEs or DELETEs a row in
    // this table; only INSERT. sequence is 1-based per location_candidate_id,
    // assigned inside the same BEGIN IMMEDIATE transaction as the insert so
    // concurrent calls can't allocate the same value -- the UNIQUE
    // constraint below is a defense-in-depth backstop, not the primary
    // guard. selected_bwi_record_id is the reviewer's own chosen target,
    // distinct from the machine's recommended match captured inside
    // machine_recommendation_json (see MachineRecommendationSnapshot).
    // field_corrections_json is captured for audit only in this commit --
    // never applied back to location_candidates/company_identities/
    // field evidence.
    //
    // Must be created (and populated) before the index below -- see
    // "CREATE INDEX idx_review_decisions_candidate" a few entries down,
    // which depends on this table already existing.
    name: "CREATE TABLE review_decisions",
    sql: `
      CREATE TABLE IF NOT EXISTS review_decisions (
        id TEXT PRIMARY KEY,
        location_candidate_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        reviewer TEXT NOT NULL,
        action TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        selected_bwi_record_id TEXT,
        notes TEXT,
        machine_recommendation_json TEXT NOT NULL,
        field_corrections_json TEXT NOT NULL DEFAULT '[]',
        decided_at TEXT NOT NULL,
        UNIQUE(location_candidate_id, sequence),
        FOREIGN KEY(location_candidate_id) REFERENCES location_candidates(id)
      );
    `
  },

  {
    // Depends on review_decisions (created immediately above) already
    // existing -- ordering here is enforced by SCHEMA_STATEMENTS's array
    // order, not by hoping a single multi-statement exec() runs in order.
    name: "CREATE INDEX idx_review_decisions_candidate",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_review_decisions_candidate
        ON review_decisions(location_candidate_id, sequence);
    `
  }
];

export function createSchema(db: Database): void {
  for (const statement of SCHEMA_STATEMENTS) {
    try {
      db.exec(statement.sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`createSchema(): failed executing "${statement.name}": ${message}`);
    }
  }
}

export function insertExistingCompany(db: Database, company: ExistingCompany): void {
  const lifecycleStatus = normalizeBwiLifecycleStatus(company.status).normalized;

  db.query(`
    INSERT OR REPLACE INTO existing_companies
      (id, company_name, address, city, state, postal_code, phone, website, sic_code, status, lifecycle_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    company.id,
    company.companyName,
    company.address ?? null,
    company.city ?? null,
    company.state ?? null,
    company.postalCode ?? null,
    company.phone ?? null,
    company.website ?? null,
    company.sicCode ?? null,
    company.status ?? null,
    lifecycleStatus
  );
}

export function insertCompanyIdentity(db: Database, identity: CompanyIdentity): void {
  db.query(`
    INSERT OR REPLACE INTO company_identities
      (id, legal_name, dba_name, website, email_format, sic_code, start_year,
       relationship_json, international, team_page_url, linkedin_url, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    identity.id,
    identity.legalName,
    identity.dbaName ?? null,
    identity.website ?? null,
    identity.emailFormat ?? null,
    identity.sicCode ?? null,
    identity.startYear ?? null,
    identity.relationship ? JSON.stringify(identity.relationship) : null,
    identity.international === undefined ? null : identity.international ? 1 : 0,
    identity.teamPageUrl ?? null,
    identity.linkedinUrl ?? null,
    JSON.stringify(identity)
  );
}

export function loadCompanyIdentities(db: Database): CompanyIdentity[] {
  const rows = db.query(`SELECT raw_json FROM company_identities`).all() as Array<{ raw_json: string }>;
  return rows.map((row) => JSON.parse(row.raw_json) as CompanyIdentity);
}

export function insertLocationCandidate(db: Database, candidate: LocationCandidate): void {
  db.query(`
    INSERT OR REPLACE INTO location_candidates
      (id, company_identity_id, company_legal_name, source_id, source_name, source_url,
       source_record_id, fingerprint, captured_at, ingested_at,
       physical_street, physical_suite, physical_city, physical_state, physical_postal_code,
       mailing_address_json, phone, toll_free_phone, market, county,
       site_type, raw_site_type_code, building_name, building_type, lease_or_own,
       employee_size_site_json, employee_size_company_wide_json, employee_count_exact,
       total_sites, estimated_annual_revenue_json, description, contacts_json,
       evidence_json, field_evidence_json, raw_source_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.company.id,
    candidate.company.legalName,
    candidate.source.sourceId,
    candidate.source.sourceName,
    candidate.source.sourceUrl ?? null,
    candidate.source.sourceRecordId ?? null,
    candidate.source.fingerprint,
    candidate.capturedAt,
    candidate.source.ingestedAt,
    candidate.physicalAddress?.street ?? null,
    candidate.physicalAddress?.suite ?? null,
    candidate.physicalAddress?.city ?? null,
    candidate.physicalAddress?.state ?? null,
    candidate.physicalAddress?.postalCode ?? null,
    candidate.mailingAddress ? JSON.stringify(candidate.mailingAddress) : null,
    candidate.phone ?? null,
    candidate.tollFreePhone ?? null,
    candidate.market ?? null,
    candidate.county ?? null,
    candidate.siteType ?? null,
    candidate.rawSiteTypeCode ?? null,
    candidate.buildingName ?? null,
    candidate.buildingType ?? null,
    candidate.leaseOrOwn ?? null,
    candidate.employeeSizeSite ? JSON.stringify(candidate.employeeSizeSite) : null,
    candidate.employeeSizeCompanyWide ? JSON.stringify(candidate.employeeSizeCompanyWide) : null,
    candidate.employeeCountExact ?? null,
    candidate.totalSites ?? null,
    candidate.estimatedAnnualRevenue ? JSON.stringify(candidate.estimatedAnnualRevenue) : null,
    candidate.description ?? null,
    JSON.stringify(candidate.contacts),
    JSON.stringify(candidate.evidence),
    JSON.stringify(candidate.fieldEvidence ?? []),
    candidate.rawSourceData !== undefined ? JSON.stringify(candidate.rawSourceData) : null,
    JSON.stringify(candidate)
  );
}

export function loadLocationCandidates(db: Database): LocationCandidate[] {
  const rows = db.query(`SELECT raw_json FROM location_candidates`).all() as Array<{ raw_json: string }>;
  return rows.map((row) => JSON.parse(row.raw_json) as LocationCandidate);
}

export function loadLocationCandidatesByCompanyId(db: Database, companyIdentityId: string): LocationCandidate[] {
  const rows = db.query(`
    SELECT raw_json FROM location_candidates WHERE company_identity_id = ?
  `).all(companyIdentityId) as Array<{ raw_json: string }>;
  return rows.map((row) => JSON.parse(row.raw_json) as LocationCandidate);
}

export function loadExistingCompanies(db: Database): ExistingCompany[] {
  const rows = db.query(`
    SELECT id, company_name, address, city, state, postal_code, phone, website, sic_code, status, lifecycle_status
    FROM existing_companies
  `).all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    companyName: String(row.company_name),
    address: row.address ? String(row.address) : undefined,
    city: row.city ? String(row.city) : undefined,
    state: row.state ? String(row.state) : undefined,
    postalCode: row.postal_code ? String(row.postal_code) : undefined,
    phone: row.phone ? String(row.phone) : undefined,
    website: row.website ? String(row.website) : undefined,
    sicCode: row.sic_code ? String(row.sic_code) : undefined,
    status: row.status as ExistingCompany["status"],
    lifecycleStatus: row.lifecycle_status as ExistingCompany["lifecycleStatus"]
  }));
}

export function upsertReviewQueue(
  db: Database,
  locationCandidateId: string,
  match: MatchResult,
  resolution: EntityResolutionDecision,
  completeness: ResearchCompletenessResult,
  publicationReadiness: PublicationReadinessAssessment,
  priority: number
): void {
  db.query(`
    INSERT INTO review_queue
      (location_candidate_id, best_existing_company_id, match_score, match_classification,
       match_reasons_json, match_evidence_json,
       resolution_outcome, resolution_confidence, resolution_reasons_json, resolution_conflicts_json,
       resolution_matched_existing_company_id, resolution_related_existing_company_ids_json,
       resolution_alternative_matches_json, resolution_requires_human_review,
       completeness_score, completeness_present_fields_json,
       completeness_missing_fields_json, publication_state, publication_blockers_json,
       publication_unresolved_rules_json, publication_satisfied_requirements_json,
       publication_optional_missing_fields_json, publication_ready, review_priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(location_candidate_id) DO UPDATE SET
      best_existing_company_id = excluded.best_existing_company_id,
      match_score = excluded.match_score,
      match_classification = excluded.match_classification,
      match_reasons_json = excluded.match_reasons_json,
      match_evidence_json = excluded.match_evidence_json,
      resolution_outcome = excluded.resolution_outcome,
      resolution_confidence = excluded.resolution_confidence,
      resolution_reasons_json = excluded.resolution_reasons_json,
      resolution_conflicts_json = excluded.resolution_conflicts_json,
      resolution_matched_existing_company_id = excluded.resolution_matched_existing_company_id,
      resolution_related_existing_company_ids_json = excluded.resolution_related_existing_company_ids_json,
      resolution_alternative_matches_json = excluded.resolution_alternative_matches_json,
      resolution_requires_human_review = excluded.resolution_requires_human_review,
      completeness_score = excluded.completeness_score,
      completeness_present_fields_json = excluded.completeness_present_fields_json,
      completeness_missing_fields_json = excluded.completeness_missing_fields_json,
      publication_state = excluded.publication_state,
      publication_blockers_json = excluded.publication_blockers_json,
      publication_unresolved_rules_json = excluded.publication_unresolved_rules_json,
      publication_satisfied_requirements_json = excluded.publication_satisfied_requirements_json,
      publication_optional_missing_fields_json = excluded.publication_optional_missing_fields_json,
      publication_ready = excluded.publication_ready,
      review_priority = excluded.review_priority
  `).run(
    locationCandidateId,
    match.existingCompanyId ?? null,
    match.score,
    match.classification,
    JSON.stringify(match.reasons),
    JSON.stringify({ companySimilarity: match.companySimilarity, locationSimilarity: match.locationSimilarity }),
    resolution.outcome,
    resolution.decisionConfidence ?? null,
    JSON.stringify(resolution.reasons),
    JSON.stringify(resolution.conflicts),
    resolution.matchedExistingCompanyId ?? null,
    JSON.stringify(resolution.relatedExistingCompanyIds ?? []),
    JSON.stringify(resolution.alternativeMatches),
    resolution.requiresHumanReview ? 1 : 0,
    completeness.score,
    JSON.stringify(completeness.presentFields),
    JSON.stringify(completeness.missingFields),
    publicationReadiness.state,
    JSON.stringify(publicationReadiness.blockers),
    JSON.stringify(publicationReadiness.unresolvedRules),
    JSON.stringify(publicationReadiness.satisfiedRequirements),
    JSON.stringify(publicationReadiness.optionalMissingFields),
    isPublicationReadyCompat(publicationReadiness) ? 1 : 0,
    priority,
    new Date().toISOString()
  );
}

export type ReviewQueueRow = {
  locationCandidateId: string;
  bestExistingCompanyId?: string;
  matchScore: number;
  matchClassification: string;
  matchReasons: string[];
  resolutionOutcome: string;
  resolutionConfidence?: number;
  resolutionReasons: string[];
  resolutionConflicts: string[];
  resolutionMatchedExistingCompanyId?: string;
  resolutionRelatedExistingCompanyIds: string[];
  resolutionAlternativeMatches: MatchResult[];
  resolutionRequiresHumanReview: boolean;
  completenessScore: number;
  publicationState: PublicationReadinessAssessment["state"];
  publicationBlockers: PublicationReadinessAssessment["blockers"];
  publicationUnresolvedRules: PublicationReadinessAssessment["unresolvedRules"];
  publicationSatisfiedRequirements: PublicationReadinessAssessment["satisfiedRequirements"];
  publicationOptionalMissingFields: string[];
  /** TEMPORARY compatibility boolean, derived from publicationState. TODO(remove) once consumers read publicationState directly. */
  publicationReady: boolean;
  reviewPriority: number;
  reviewStatus: ReviewQueueStatus;
};

function mapReviewQueueRow(row: Record<string, unknown>): ReviewQueueRow {
  return {
    locationCandidateId: String(row.location_candidate_id),
    bestExistingCompanyId: row.best_existing_company_id ? String(row.best_existing_company_id) : undefined,
    matchScore: Number(row.match_score),
    matchClassification: String(row.match_classification),
    matchReasons: JSON.parse(String(row.match_reasons_json)),
    resolutionOutcome: String(row.resolution_outcome),
    resolutionConfidence: row.resolution_confidence === null || row.resolution_confidence === undefined ? undefined : Number(row.resolution_confidence),
    resolutionReasons: JSON.parse(String(row.resolution_reasons_json)),
    resolutionConflicts: JSON.parse(String(row.resolution_conflicts_json)),
    resolutionMatchedExistingCompanyId: row.resolution_matched_existing_company_id
      ? String(row.resolution_matched_existing_company_id)
      : undefined,
    resolutionRelatedExistingCompanyIds: JSON.parse(String(row.resolution_related_existing_company_ids_json)),
    resolutionAlternativeMatches: JSON.parse(String(row.resolution_alternative_matches_json)),
    resolutionRequiresHumanReview: Boolean(row.resolution_requires_human_review),
    completenessScore: Number(row.completeness_score),
    publicationState: String(row.publication_state) as PublicationReadinessAssessment["state"],
    publicationBlockers: JSON.parse(String(row.publication_blockers_json)),
    publicationUnresolvedRules: JSON.parse(String(row.publication_unresolved_rules_json)),
    publicationSatisfiedRequirements: JSON.parse(String(row.publication_satisfied_requirements_json)),
    publicationOptionalMissingFields: JSON.parse(String(row.publication_optional_missing_fields_json)),
    publicationReady: Boolean(row.publication_ready),
    reviewPriority: Number(row.review_priority),
    reviewStatus: String(row.review_status) as ReviewQueueStatus
  };
}

/** Reads back everything persisted by `upsertReviewQueue`, including the richer business-resolution outcome. */
export function loadReviewQueue(db: Database): ReviewQueueRow[] {
  const rows = db.query(`SELECT * FROM review_queue`).all() as Array<Record<string, unknown>>;
  return rows.map(mapReviewQueueRow);
}

/** Single-row lookup by candidate id, used by `recordReviewDecision()` to read the current review_status/machine-recommendation data before recording a new decision. Returns undefined when the candidate hasn't been scored yet (no review_queue row exists). */
export function loadReviewQueueRowByCandidateId(db: Database, locationCandidateId: string): ReviewQueueRow | undefined {
  const row = db.query(`SELECT * FROM review_queue WHERE location_candidate_id = ?`).get(locationCandidateId) as Record<string, unknown> | null;
  return row ? mapReviewQueueRow(row) : undefined;
}

/** Updates only the two review_queue convenience columns a recorded decision derives -- never touches match/resolution/readiness/priority columns, so a later `upsertReviewQueue` re-score can't retroactively erase a decision's effect (matching that function's existing, deliberate omission of these two columns from its own UPDATE SET list). */
export function updateReviewQueueStatus(db: Database, locationCandidateId: string, reviewStatus: ReviewQueueStatus, reviewerNote?: string): void {
  db.query(`
    UPDATE review_queue SET review_status = ?, reviewer_note = ?
    WHERE location_candidate_id = ?
  `).run(reviewStatus, reviewerNote ?? null, locationCandidateId);
}

export type SourceRun = {
  id: string;
  sourceId: string;
  sourceName: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failed";
  rawCount: number;
  validCount: number;
  newCandidateCount: number;
  alreadyIngestedCount: number;
  skippedCount: number;
  errorMessage?: string;
};

export function startSourceRun(db: Database, run: Pick<SourceRun, "id" | "sourceId" | "sourceName" | "startedAt">): void {
  db.query(`
    INSERT INTO source_runs (id, source_id, source_name, started_at, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(run.id, run.sourceId, run.sourceName, run.startedAt);
}

export function finishSourceRun(
  db: Database,
  runId: string,
  result: {
    finishedAt: string;
    status: "success" | "failed";
    rawCount: number;
    validCount: number;
    newCandidateCount: number;
    alreadyIngestedCount: number;
    skippedCount: number;
    errorMessage?: string;
  }
): void {
  db.query(`
    UPDATE source_runs SET
      finished_at = ?,
      status = ?,
      raw_count = ?,
      valid_count = ?,
      new_candidate_count = ?,
      already_ingested_count = ?,
      skipped_count = ?,
      error_message = ?
    WHERE id = ?
  `).run(
    result.finishedAt,
    result.status,
    result.rawCount,
    result.validCount,
    result.newCandidateCount,
    result.alreadyIngestedCount,
    result.skippedCount,
    result.errorMessage ?? null,
    runId
  );
}

export function findSourceRecord(
  db: Database,
  sourceId: string,
  fingerprint: string
): { locationCandidateId: string } | undefined {
  const row = db.query(`
    SELECT location_candidate_id AS locationCandidateId FROM source_records
    WHERE source_id = ? AND fingerprint = ?
  `).get(sourceId, fingerprint) as { locationCandidateId: string } | null;

  return row ?? undefined;
}

export function insertSourceRecord(
  db: Database,
  record: {
    sourceId: string;
    fingerprint: string;
    sourceRecordId?: string;
    locationCandidateId: string;
    firstRunId: string;
    firstIngestedAt: string;
  }
): void {
  db.query(`
    INSERT OR IGNORE INTO source_records
      (source_id, fingerprint, source_record_id, location_candidate_id, first_run_id, first_ingested_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    record.sourceId,
    record.fingerprint,
    record.sourceRecordId ?? null,
    record.locationCandidateId,
    record.firstRunId,
    record.firstIngestedAt
  );
}

function mapReviewDecisionRow(row: Record<string, unknown>): ReviewDecision {
  return {
    id: String(row.id),
    locationCandidateId: String(row.location_candidate_id),
    sequence: Number(row.sequence),
    reviewer: String(row.reviewer),
    action: String(row.action) as ReviewDecision["action"],
    previousStatus: String(row.previous_status) as ReviewQueueStatus,
    newStatus: String(row.new_status) as ReviewQueueStatus,
    selectedBwiRecordId: row.selected_bwi_record_id ? String(row.selected_bwi_record_id) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    machineRecommendation: JSON.parse(String(row.machine_recommendation_json)) as MachineRecommendationSnapshot,
    fieldCorrections: JSON.parse(String(row.field_corrections_json)) as ReviewFieldCorrection[],
    decidedAt: String(row.decided_at)
  };
}

/**
 * Plain, unconditional INSERT -- no `OR REPLACE`/`OR IGNORE`/`ON CONFLICT`,
 * unlike every upsert-style writer elsewhere in this file. There is no
 * update/delete API for `review_decisions` rows anywhere in this codebase;
 * the table is append-only by construction, not just by convention. A
 * caller must go through `recordReviewDecision()` (src/review-decisions.ts),
 * which allocates `sequence` inside the same transaction as this insert.
 */
export function insertReviewDecision(db: Database, decision: ReviewDecision): void {
  db.query(`
    INSERT INTO review_decisions
      (id, location_candidate_id, sequence, reviewer, action, previous_status, new_status,
       selected_bwi_record_id, notes, machine_recommendation_json, field_corrections_json, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.id,
    decision.locationCandidateId,
    decision.sequence,
    decision.reviewer,
    decision.action,
    decision.previousStatus,
    decision.newStatus,
    decision.selectedBwiRecordId ?? null,
    decision.notes ?? null,
    JSON.stringify(decision.machineRecommendation),
    JSON.stringify(decision.fieldCorrections),
    decision.decidedAt
  );
}

/** Full decision history for one candidate, oldest first -- the append-only ledger is always readable independently of review_queue's convenience status. */
export function loadReviewDecisionsForCandidate(db: Database, locationCandidateId: string): ReviewDecision[] {
  const rows = db.query(`
    SELECT * FROM review_decisions WHERE location_candidate_id = ? ORDER BY sequence ASC
  `).all(locationCandidateId) as Array<Record<string, unknown>>;
  return rows.map(mapReviewDecisionRow);
}

/** The most recent decision for one candidate, or undefined if none has been recorded yet. */
export function loadLatestReviewDecisionForCandidate(db: Database, locationCandidateId: string): ReviewDecision | undefined {
  const row = db.query(`
    SELECT * FROM review_decisions WHERE location_candidate_id = ? ORDER BY sequence DESC LIMIT 1
  `).get(locationCandidateId) as Record<string, unknown> | null;
  return row ? mapReviewDecisionRow(row) : undefined;
}
