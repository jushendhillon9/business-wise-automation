import { Database } from "bun:sqlite";
import type { CandidateCompany, ExistingCompany, MatchResult } from "./types.ts";

export const DB_PATH = "data/sandbox.sqlite";

export function openDb(path: string = DB_PATH): Database {
  return new Database(path, { create: true });
}

export function createSchema(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS existing_companies (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      phone TEXT,
      website TEXT,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT,
      source_record_id TEXT,
      captured_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      company_name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      phone TEXT,
      website TEXT,
      linkedin_url TEXT,
      employee_count_estimate INTEGER,
      description TEXT,
      proposed_sic TEXT,
      contact_name TEXT,
      contact_title TEXT,
      evidence_json TEXT NOT NULL,
      raw_source_json TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_queue (
      candidate_id TEXT PRIMARY KEY,
      best_existing_company_id TEXT,
      match_score REAL NOT NULL,
      match_classification TEXT NOT NULL,
      match_reasons_json TEXT NOT NULL,
      completeness_score REAL NOT NULL,
      review_priority REAL NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'pending',
      reviewer_note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id)
    );

    -- One row per source ingestion invocation. Answers: which source ran,
    -- when, and how many raw/valid/new/duplicate/skipped records it produced.
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

    -- Ingestion-deduplication ledger: has this exact source item already been
    -- processed? Distinct from entity resolution, which asks whether a
    -- candidate matches an existing Business Wise company.
    CREATE TABLE IF NOT EXISTS source_records (
      source_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      source_record_id TEXT,
      candidate_id TEXT NOT NULL,
      first_run_id TEXT NOT NULL,
      first_ingested_at TEXT NOT NULL,
      PRIMARY KEY (source_id, fingerprint),
      FOREIGN KEY(candidate_id) REFERENCES candidates(id),
      FOREIGN KEY(first_run_id) REFERENCES source_runs(id)
    );
  `);
}

export function insertExistingCompany(db: Database, company: ExistingCompany): void {
  db.query(`
    INSERT OR REPLACE INTO existing_companies
      (id, company_name, address, city, state, postal_code, phone, website, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    company.id,
    company.companyName,
    company.address ?? null,
    company.city ?? null,
    company.state ?? null,
    company.postalCode ?? null,
    company.phone ?? null,
    company.website ?? null,
    company.status ?? null
  );
}

export function insertCandidate(db: Database, candidate: CandidateCompany): void {
  db.query(`
    INSERT OR REPLACE INTO candidates
      (id, source, source_id, source_url, source_record_id, captured_at, ingested_at,
       fingerprint, company_name, address, city, state,
       postal_code, phone, website, linkedin_url, employee_count_estimate,
       description, proposed_sic, contact_name, contact_title, evidence_json,
       raw_source_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.source,
    candidate.sourceId,
    candidate.sourceUrl ?? null,
    candidate.sourceRecordId ?? null,
    candidate.capturedAt,
    candidate.ingestedAt,
    candidate.fingerprint,
    candidate.companyName,
    candidate.address ?? null,
    candidate.city ?? null,
    candidate.state ?? null,
    candidate.postalCode ?? null,
    candidate.phone ?? null,
    candidate.website ?? null,
    candidate.linkedinUrl ?? null,
    candidate.employeeCountEstimate ?? null,
    candidate.description ?? null,
    candidate.proposedSic ?? null,
    candidate.contactName ?? null,
    candidate.contactTitle ?? null,
    JSON.stringify(candidate.evidence),
    candidate.rawSourceData !== undefined ? JSON.stringify(candidate.rawSourceData) : null,
    JSON.stringify(candidate)
  );
}

export function loadCandidates(db: Database): CandidateCompany[] {
  const rows = db.query(`SELECT raw_json FROM candidates`).all() as Array<{ raw_json: string }>;
  return rows.map((row) => JSON.parse(row.raw_json) as CandidateCompany);
}

export function loadExistingCompanies(db: Database): ExistingCompany[] {
  const rows = db.query(`
    SELECT id, company_name, address, city, state, postal_code, phone, website, status
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
    status: row.status as ExistingCompany["status"]
  }));
}

export function upsertReviewQueue(
  db: Database,
  candidateId: string,
  match: MatchResult,
  completeness: number,
  priority: number
): void {
  db.query(`
    INSERT INTO review_queue
      (candidate_id, best_existing_company_id, match_score, match_classification,
       match_reasons_json, completeness_score, review_priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET
      best_existing_company_id = excluded.best_existing_company_id,
      match_score = excluded.match_score,
      match_classification = excluded.match_classification,
      match_reasons_json = excluded.match_reasons_json,
      completeness_score = excluded.completeness_score,
      review_priority = excluded.review_priority
  `).run(
    candidateId,
    match.existingCompanyId ?? null,
    match.score,
    match.classification,
    JSON.stringify(match.reasons),
    completeness,
    priority,
    new Date().toISOString()
  );
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
): { candidateId: string } | undefined {
  const row = db.query(`
    SELECT candidate_id AS candidateId FROM source_records
    WHERE source_id = ? AND fingerprint = ?
  `).get(sourceId, fingerprint) as { candidateId: string } | null;

  return row ?? undefined;
}

export function insertSourceRecord(
  db: Database,
  record: {
    sourceId: string;
    fingerprint: string;
    sourceRecordId?: string;
    candidateId: string;
    firstRunId: string;
    firstIngestedAt: string;
  }
): void {
  db.query(`
    INSERT OR IGNORE INTO source_records
      (source_id, fingerprint, source_record_id, candidate_id, first_run_id, first_ingested_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    record.sourceId,
    record.fingerprint,
    record.sourceRecordId ?? null,
    record.candidateId,
    record.firstRunId,
    record.firstIngestedAt
  );
}
