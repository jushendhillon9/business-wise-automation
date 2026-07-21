import type { Database } from "bun:sqlite";
import {
  findSourceRecord,
  finishSourceRun,
  insertCompanyIdentity,
  insertLocationCandidate,
  insertSourceRecord,
  startSourceRun
} from "./db.ts";
import { computeFingerprint } from "./sources/fingerprint.ts";
import type { SourceAdapter } from "./sources/types.ts";
import type { CompanyIdentity, LocationCandidate } from "./types.ts";

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
 * Fetches raw records from a SourceAdapter, maps/validates them into a
 * provisional CompanyIdentity + LocationCandidate pair, deduplicates against
 * previously-ingested source items, and persists new records. Does not touch
 * entity resolution or scoring — that stays in the existing pipeline
 * (run.ts) and operates on whatever candidates end up persisted here.
 *
 * Ingestion never merges company identities across sources or across rows:
 * every valid, not-yet-seen source item gets its own fresh CompanyIdentity.
 * Deciding whether two provisional identities are the same real-world
 * company is entity resolution's job, done later (see
 * docs/COMPANY_LOCATION_MODEL.md).
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
      const fingerprint = computeFingerprint(adapter.sourceId, rawRecord.recordId, {
        companyName: draft.company.legalName,
        city: draft.physicalAddress?.city,
        state: draft.physicalAddress?.state,
        address: draft.physicalAddress?.street,
        sourceUrl: draft.sourceUrl
      });

      const existing = findSourceRecord(db, adapter.sourceId, fingerprint);
      if (existing) {
        alreadyIngestedCount += 1;
        continue;
      }

      const { sourceUrl, company: companyDraft, ...locationFields } = draft;

      const companyIdentity: CompanyIdentity = { ...companyDraft, id: crypto.randomUUID() };
      insertCompanyIdentity(db, companyIdentity);

      const ingestedAt = new Date().toISOString();
      const locationCandidate: LocationCandidate = {
        ...locationFields,
        id: crypto.randomUUID(),
        company: companyIdentity,
        source: {
          sourceId: adapter.sourceId,
          sourceName: adapter.sourceName,
          sourceUrl,
          sourceRecordId: rawRecord.recordId,
          fingerprint,
          ingestedAt
        }
      };

      insertLocationCandidate(db, locationCandidate);
      insertSourceRecord(db, {
        sourceId: adapter.sourceId,
        fingerprint,
        sourceRecordId: rawRecord.recordId,
        locationCandidateId: locationCandidate.id,
        firstRunId: runId,
        firstIngestedAt: ingestedAt
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
