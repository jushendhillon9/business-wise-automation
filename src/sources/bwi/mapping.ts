import { normalizeBwiLifecycleStatus, normalizeBwiSiteType } from "../../bwi-codes.ts";
import {
  companyFieldPath,
  createFieldEvidence,
  locationFieldPath,
  type ExistingCompany,
  type FieldEvidence,
  type FieldEvidenceSource,
  type Relationship,
  type SourceProvenance
} from "../../types.ts";
import type { BwiImportRowResult, RawBwiDirectoryRecord } from "./types.ts";

/**
 * Confidence assigned to field evidence attached to a record read from the
 * canonical BWI directory (live or snapshot). Deliberately distinct from
 * `SINGLE_SOURCE_OBSERVED_CONFIDENCE` (src/types.ts, used for a single
 * unverified external source row) — this represents a different claim:
 * "this is the value currently stored in BWI's own system of record," not
 * "this value is independently re-verified as objectively current/correct."
 * BWI being the canonical system does not by itself mean the value is
 * fresh or accurate; it could be years stale. Chosen higher than the
 * external-source default (0.6) because it comes from BWI's own
 * system-of-record rather than a third party, but deliberately not 1.0/"as
 * good as human-confirmed" for the same reason.
 * Needs confirmation from Jushen: this exact value is not calibrated
 * against any measured outcome — it is a documented placeholder, like
 * SINGLE_SOURCE_OBSERVED_CONFIDENCE.
 */
export const BWI_CANONICAL_IMPORT_CONFIDENCE = 0.7;

/**
 * Everything the mapping function needs beyond the raw row itself. Every
 * timestamp is injected, never computed with `Date.now()` inside this pure
 * function — see the `ingestedAt`/`capturedAt` doc comments below.
 */
export type BwiMappingContext = {
  sourceType: "bwi_snapshot" | "bwi_live";
  sourceId: string;
  sourceName: string;
  sourceUrl?: string;
  /** SourceProvenance.ingestedAt — when this import run processed the row. Supplied by the orchestrator's injected clock, never computed here. */
  ingestedAt: string;
  /** When the snapshot/export was produced or the live read executed, if known. Never fabricated — omit rather than guess for a snapshot file with no recorded export time. */
  capturedAt?: string;
};

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The single, shared normalization path from a `RawBwiDirectoryRecord`
 * (produced identically by the snapshot and live adapters) into the
 * canonical `ExistingCompany` (`ExistingBwiLocation`) domain type. Reuses
 * `normalizeBwiSiteType()`/`normalizeBwiLifecycleStatus()` (src/bwi-codes.ts)
 * rather than re-implementing BWI code normalization — an unrecognized raw
 * code normalizes to "unknown" (never silently coerced into a known value)
 * while the exact raw string is always preserved. Never throws for bad
 * *data*: unusable rows are reported via `{ ok: false, reason }`, matching
 * the existing SourceAdapter convention (src/sources/types.ts).
 */
export function mapRawBwiRecordToExistingLocation(raw: RawBwiDirectoryRecord, context: BwiMappingContext): BwiImportRowResult {
  const bwiLocationId = nonEmpty(raw.bwiLocationId);
  if (!bwiLocationId) {
    return { ok: false, reason: "missing bwiLocationId" };
  }

  const companyName = nonEmpty(raw.companyName);
  if (!companyName) {
    return { ok: false, reason: "missing companyName", rawRecordId: bwiLocationId };
  }

  let lastUpdatedAt: string | undefined;
  if (raw.lastUpdatedAt !== undefined && raw.lastUpdatedAt !== "") {
    const parsed = new Date(raw.lastUpdatedAt);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, reason: `malformed lastUpdatedAt: "${raw.lastUpdatedAt}"`, rawRecordId: bwiLocationId };
    }
    lastUpdatedAt = parsed.toISOString();
  }

  const siteTypeResult = raw.siteTypeCode !== undefined && raw.siteTypeCode !== "" ? normalizeBwiSiteType(raw.siteTypeCode) : undefined;

  // Unlike siteType, lifecycleStatus is always computed (even for a row with
  // no raw status text at all), mirroring insertExistingCompany()'s own
  // invariant (src/db.ts: "lifecycle_status is always derived from status,
  // never passed through independently"). normalizeBwiLifecycleStatus(undefined)
  // safely returns {normalized:"unknown", rawCode:undefined, recognized:false}
  // -- computing it here too (rather than leaving lifecycleStatus undefined)
  // keeps a freshly-mapped record and its post-round-trip reload identical,
  // so a rerun of unchanged source data reports `unchanged`, not `updated`.
  const lifecycleResult = normalizeBwiLifecycleStatus(raw.statusCode);
  const lifecycleCodeWasGiven = raw.statusCode !== undefined && raw.statusCode !== "";

  const source: SourceProvenance = {
    sourceId: context.sourceId,
    sourceName: context.sourceName,
    sourceUrl: context.sourceUrl,
    sourceRecordId: bwiLocationId,
    fingerprint: `${context.sourceType}:${bwiLocationId}`,
    ingestedAt: context.ingestedAt
  };

  const parentCompany = nonEmpty(raw.parentCompany);
  const affiliate = nonEmpty(raw.affiliate);
  const relationship: Relationship | undefined = parentCompany || affiliate ? { parentCompany, affiliate } : undefined;

  const employeeSizeSiteEstimate = toNumber(raw.employeeSizeSite);
  const employeeSizeSiteRawCode = nonEmpty(raw.employeeSizeSiteRawCode);
  const employeeSizeSite =
    employeeSizeSiteEstimate !== undefined || employeeSizeSiteRawCode !== undefined
      ? { estimate: employeeSizeSiteEstimate, rawCode: employeeSizeSiteRawCode }
      : undefined;

  const employeeSizeCompanyWideEstimate = toNumber(raw.employeeSizeCompanyWide);
  const employeeSizeCompanyWideRawCode = nonEmpty(raw.employeeSizeCompanyWideRawCode);
  const employeeSizeCompanyWide =
    employeeSizeCompanyWideEstimate !== undefined || employeeSizeCompanyWideRawCode !== undefined
      ? { estimate: employeeSizeCompanyWideEstimate, rawCode: employeeSizeCompanyWideRawCode }
      : undefined;

  const evidenceSource: FieldEvidenceSource = {
    sourceType: context.sourceType === "bwi_live" ? "bwi_canonical_live_import" : "bwi_canonical_snapshot_import",
    sourceId: context.sourceId,
    sourceName: context.sourceName,
    sourceUrl: context.sourceUrl,
    sourceRecordId: bwiLocationId
  };

  const fieldEvidence: FieldEvidence[] = [];
  const observe = (path: Parameters<typeof createFieldEvidence>[0]["path"], value: unknown, rawValue?: unknown) => {
    if (value === undefined || value === "") return;
    fieldEvidence.push(
      createFieldEvidence({
        path,
        value,
        rawValue: rawValue ?? value,
        confidence: BWI_CANONICAL_IMPORT_CONFIDENCE,
        source: evidenceSource,
        capturedAt: context.capturedAt,
        derivation: "directly_observed"
      })
    );
  };

  observe(companyFieldPath("companyName"), companyName, raw.companyName);
  const website = nonEmpty(raw.website);
  if (website) observe(companyFieldPath("website"), website);
  const sicCode = nonEmpty(raw.sicCode);
  if (sicCode) observe(companyFieldPath("sicCode"), sicCode);
  const address = nonEmpty(raw.address);
  if (address) observe(locationFieldPath("address"), address);
  const phone = nonEmpty(raw.phone);
  if (phone) observe(locationFieldPath("phone"), phone);
  if (siteTypeResult) observe(locationFieldPath("siteType"), siteTypeResult.normalized, siteTypeResult.rawCode);
  // Only attach status evidence when the source actually gave a raw status
  // code -- lifecycleResult itself is always computed (see above), but
  // fabricating evidence for a field the source never mentioned is not okay.
  if (lifecycleCodeWasGiven) observe(locationFieldPath("status"), lifecycleResult.normalized, lifecycleResult.rawCode);

  const existing: ExistingCompany = {
    id: bwiLocationId,
    companyName,
    alphasort: nonEmpty(raw.alphasort),
    address,
    mailingAddress: nonEmpty(raw.mailingAddress),
    city: nonEmpty(raw.city),
    state: nonEmpty(raw.state),
    postalCode: nonEmpty(raw.postalCode),
    phone,
    website,
    sicCode,
    status: nonEmpty(raw.statusCode),
    lifecycleStatus: lifecycleResult.normalized,
    siteType: siteTypeResult?.normalized,
    rawSiteTypeCode: siteTypeResult?.rawCode,
    relationship,
    market: nonEmpty(raw.market),
    county: nonEmpty(raw.county),
    employeeSizeSite,
    employeeSizeCompanyWide,
    lastUpdatedAt,
    source,
    fieldEvidence: fieldEvidence.length > 0 ? fieldEvidence : undefined
  };

  return {
    ok: true,
    existing,
    unknownSiteTypeCode: siteTypeResult && !siteTypeResult.recognized ? siteTypeResult.rawCode : undefined,
    unknownLifecycleCode: lifecycleCodeWasGiven && !lifecycleResult.recognized ? lifecycleResult.rawCode : undefined
  };
}
