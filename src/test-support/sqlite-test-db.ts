import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { createSchema, openDb } from "../db.ts";

/**
 * Shared test-only helpers for the disposable per-file sqlite databases used
 * by db.test.ts, ingestion.test.ts, and review-decisions.test.ts. `journal_mode
 * = WAL` (see createSchema()) means every one of these databases can leave
 * "-wal"/"-shm" sidecar files behind; removing only the main file (as each of
 * those tests used to) leaves those sidecars on disk. This centralizes the
 * cleanup so it happens the same, complete way everywhere rather than being
 * re-implemented (and potentially re-forgotten) per test file.
 */

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Not present -- nothing to clean up.
  }
}

/** Removes a test sqlite db file and its WAL/SHM sidecars, ignoring any that don't exist. */
export function removeTestDbFiles(path: string): void {
  unlinkIfExists(path);
  unlinkIfExists(`${path}-wal`);
  unlinkIfExists(`${path}-shm`);
}

/** Starts a test from a guaranteed-fresh database: clears any prior file (+ sidecars), opens, and creates the schema. */
export function openFreshTestDb(path: string): Database {
  removeTestDbFiles(path);
  const db = openDb(path);
  createSchema(db);
  return db;
}

/** Closes the connection and removes the db file + its WAL/SHM sidecars. */
export function closeAndRemoveTestDb(db: Database, path: string): void {
  db.close();
  removeTestDbFiles(path);
}
