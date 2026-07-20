import { Database } from "bun:sqlite";
import type { CandidateCompany, ExistingCompany, MatchResult } from "./types.ts";

export const DB_PATH = "data/sandbox.sqlite";

export function openDb(): Database {
  return new Database(DB_PATH, { create: true });
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
      source_url TEXT,
      captured_at TEXT NOT NULL,
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
      (id, source, source_url, captured_at, company_name, address, city, state,
       postal_code, phone, website, linkedin_url, employee_count_estimate,
       description, proposed_sic, contact_name, contact_title, evidence_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.source,
    candidate.sourceUrl ?? null,
    candidate.capturedAt,
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
    JSON.stringify(candidate)
  );
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
