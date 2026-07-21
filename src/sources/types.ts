import type { CandidateCompany } from "../types.ts";

/**
 * A single item pulled from an external source, before source-specific
 * mapping/validation turns it into a CandidateCompany.
 */
export type RawSourceRecord = {
  /** Identifier for this record within the source, when the source provides one. */
  recordId?: string;
  data: Record<string, unknown>;
};

/**
 * Everything a SourceAdapter can produce for a candidate. The ingestion
 * engine fills in the remaining identity/provenance fields (id, source,
 * sourceId, ingestedAt, fingerprint).
 */
export type CandidateDraft = Omit<
  CandidateCompany,
  "id" | "source" | "sourceId" | "ingestedAt" | "fingerprint"
>;

export type MappingResult =
  | { ok: true; candidate: CandidateDraft }
  | { ok: false; reason: string };

/**
 * Boundary between an external source and the core pipeline. Source-specific
 * fetching, field names, and quirks stay inside the adapter; everything
 * downstream only ever sees CandidateCompany records.
 */
export interface SourceAdapter {
  sourceId: string;
  sourceName: string;
  fetch(): Promise<RawSourceRecord[]>;
  toCandidate(record: RawSourceRecord): MappingResult;
}
