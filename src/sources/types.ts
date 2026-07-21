import type { CompanyIdentity, LocationCandidate } from "../types.ts";

/**
 * A single item pulled from an external source, before source-specific
 * mapping/validation turns it into a company identity + location candidate.
 */
export type RawSourceRecord = {
  /** Identifier for this record within the source, when the source provides one. */
  recordId?: string;
  data: Record<string, unknown>;
};

/** Everything a SourceAdapter can produce for the company-level side of an observation. */
export type CompanyIdentityDraft = Omit<CompanyIdentity, "id">;

/**
 * Everything a SourceAdapter can produce for one observation. The ingestion
 * engine fills in the remaining identity/provenance fields: `id` and
 * `company.id` (fresh per observation — see docs/COMPANY_LOCATION_MODEL.md
 * for why ingestion never merges company identities), plus the full `source`
 * provenance block (sourceId/sourceName come from the adapter itself,
 * sourceRecordId comes from the RawSourceRecord, fingerprint and ingestedAt
 * are computed by the engine). `sourceUrl` is collected here per-record
 * because it's source-specific, and folded into `source.sourceUrl` by the
 * engine.
 */
export type LocationCandidateDraft = Omit<LocationCandidate, "id" | "company" | "source"> & {
  company: CompanyIdentityDraft;
  sourceUrl?: string;
};

export type MappingResult =
  | { ok: true; candidate: LocationCandidateDraft }
  | { ok: false; reason: string };

/**
 * Boundary between an external source and the core pipeline. Source-specific
 * fetching, field names, and quirks stay inside the adapter; everything
 * downstream only ever sees CompanyIdentity/LocationCandidate records. A
 * source observation usually represents a possible company *location*, not
 * necessarily an entirely new company — the ingestion engine always builds
 * one provisional CompanyIdentity per observation and leaves it to entity
 * resolution to later decide whether several provisional identities are
 * really the same real-world company.
 */
export interface SourceAdapter {
  sourceId: string;
  sourceName: string;
  fetch(): Promise<RawSourceRecord[]>;
  toCandidate(record: RawSourceRecord): MappingResult;
}
