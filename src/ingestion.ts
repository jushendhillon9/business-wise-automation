import type { Database } from "bun:sqlite";
import {
  findSourceRecord,
  finishSourceRun,
  insertCandidate,
  insertSourceRecord,
  startSourceRun
} from "./db.ts";
import { computeFingerprint } from "./sources/fingerprint.ts";
import type { SourceAdapter } from "./sources/types.ts";
import type { CandidateCompany } from "./types.ts";

export type IngestionSummary = {
  runId: string;
  sourceId: string;
  sourceName: string;
  status: "success" | "failed";
  rawCount: number;
  validCount: number;
  newCandidateCount: number;
  alreadyIngestedCount: number;
  skippedCount: number;
  skipReasons: string[];
  errorMessage?: string;
};

/**
 * Fetches raw records from a SourceAdapter, maps/validates them into
 * CandidateCompany records, deduplicates against previously-ingested source
 * items, and persists new candidates. Does not touch entity resolution or
 * scoring — that stays in the existing pipeline (run.ts) and operates on
 * whatever candidates end up persisted here.
 */
export async function runIngestion(db: Database, adapter: SourceAdapter): Promise<IngestionSummary> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  startSourceRun(db, { id: runId, sourceId: adapter.sourceId, sourceName: adapter.sourceName, startedAt });

  let rawCount = 0;
  let validCount = 0;
  let newCandidateCount = 0;
  let alreadyIngestedCount = 0;
  let skippedCount = 0;
  const skipReasons: string[] = [];

  try {
    const rawRecords = await adapter.fetch();
    rawCount = rawRecords.length;

    for (const rawRecord of rawRecords) {
      let mapping;
      try {
        mapping = adapter.toCandidate(rawRecord);
      } catch (error) {
        skippedCount += 1;
        skipReasons.push(`unexpected mapping error: ${(error as Error).message}`);
        continue;
      }

      if (!mapping.ok) {
        skippedCount += 1;
        skipReasons.push(mapping.reason);
        continue;
      }

      validCount += 1;
      const draft = mapping.candidate;
      const fingerprint = computeFingerprint(adapter.sourceId, draft.sourceRecordId, {
        companyName: draft.companyName,
        city: draft.city,
        state: draft.state,
        address: draft.address,
        sourceUrl: draft.sourceUrl
      });

      const existing = findSourceRecord(db, adapter.sourceId, fingerprint);
      if (existing) {
        alreadyIngestedCount += 1;
        continue;
      }

      const candidate: CandidateCompany = {
        ...draft,
        id: crypto.randomUUID(),
        source: adapter.sourceName,
        sourceId: adapter.sourceId,
        ingestedAt: new Date().toISOString(),
        fingerprint
      };

      insertCandidate(db, candidate);
      insertSourceRecord(db, {
        sourceId: adapter.sourceId,
        fingerprint,
        sourceRecordId: draft.sourceRecordId,
        candidateId: candidate.id,
        firstRunId: runId,
        firstIngestedAt: candidate.ingestedAt
      });
      newCandidateCount += 1;
    }

    finishSourceRun(db, runId, {
      finishedAt: new Date().toISOString(),
      status: "success",
      rawCount,
      validCount,
      newCandidateCount,
      alreadyIngestedCount,
      skippedCount
    });

    return {
      runId,
      sourceId: adapter.sourceId,
      sourceName: adapter.sourceName,
      status: "success",
      rawCount,
      validCount,
      newCandidateCount,
      alreadyIngestedCount,
      skippedCount,
      skipReasons
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    finishSourceRun(db, runId, {
      finishedAt: new Date().toISOString(),
      status: "failed",
      rawCount,
      validCount,
      newCandidateCount,
      alreadyIngestedCount,
      skippedCount,
      errorMessage
    });

    return {
      runId,
      sourceId: adapter.sourceId,
      sourceName: adapter.sourceName,
      status: "failed",
      rawCount,
      validCount,
      newCandidateCount,
      alreadyIngestedCount,
      skippedCount,
      skipReasons,
      errorMessage
    };
  }
}
