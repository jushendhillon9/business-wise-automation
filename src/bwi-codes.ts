import { BW_CODE_TO_SITE_TYPE, type BwiLifecycleStatus, type BwSiteTypeCode, type SiteType } from "./types.ts";

/**
 * Centralized BWI legacy-code normalization. Business Wise inherited
 * shorthand codes from the original printed-directory/Delphi systems (site
 * type S/H/B/R/U, lifecycle status DIRE/DEL/RDL/RDEL/research); the rest of
 * the codebase should call the functions here rather than comparing raw
 * strings ad hoc. Both normalizers are pure, deterministic, tolerant of
 * case/whitespace/already-normalized input, and never throw — an
 * unrecognized code degrades to a safe "unknown" value with `recognized:
 * false` rather than crashing ingestion or silently pretending to be a
 * known value.
 *
 * This module deliberately does NOT include employee-size or revenue band
 * code normalization: docs/BWI_DOMAIN_RULES.md §11 explicitly states "The
 * complete BWI code dictionary for employee and revenue bands has not yet
 * been captured." Inventing a mapping table without that evidence would
 * fabricate domain knowledge we don't have — see EmployeeSizeValue/
 * RevenueValue (src/types.ts), which already has a `rawCode` field for
 * preserving whatever a source gives us, without inferring a range from it.
 */

export type BwiSiteTypeNormalization = {
  normalized: SiteType;
  /** Exact original input, untouched (not trimmed/uppercased), so it round-trips losslessly. */
  rawCode?: string;
  /** True if rawCode was a known BWI site-type code (S/H/B/R/U) or an already-normalized SiteType value. */
  recognized: boolean;
};

export type BwiLifecycleNormalization = {
  normalized: BwiLifecycleStatus;
  /** Exact original input, untouched (not trimmed/uppercased), so it round-trips losslessly. */
  rawCode?: string;
  /** True if rawCode was a known BWI lifecycle code (DIRE/DEL/RDL/RDEL/research) or an already-normalized value. */
  recognized: boolean;
};

const KNOWN_SITE_TYPE_CODES = new Set<string>(Object.keys(BW_CODE_TO_SITE_TYPE));
const KNOWN_SITE_TYPE_VALUES = new Set<string>(Object.values(BW_CODE_TO_SITE_TYPE));

/**
 * Normalizes a raw BWI site-type code (S/H/B/R/U) into a typed SiteType,
 * while preserving the exact raw input. Tolerant of surrounding whitespace,
 * lowercase input, and already-normalized values (e.g. "headquarters").
 * "U" is BWI's own explicit "unknown" code and normalizes to "unknown" with
 * `recognized: true`; a code that isn't S/H/B/R/U at all also normalizes to
 * "unknown", but with `recognized: false` so the distinction isn't lost.
 */
export function normalizeBwiSiteType(raw: string | undefined): BwiSiteTypeNormalization {
  if (raw === undefined) {
    return { normalized: "unknown", rawCode: undefined, recognized: false };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { normalized: "unknown", rawCode: raw, recognized: false };
  }

  const upperCode = trimmed.toUpperCase();
  if (KNOWN_SITE_TYPE_CODES.has(upperCode)) {
    return { normalized: BW_CODE_TO_SITE_TYPE[upperCode as BwSiteTypeCode], rawCode: raw, recognized: true };
  }

  const lowerValue = trimmed.toLowerCase().replace(/\s+/g, "_");
  if (KNOWN_SITE_TYPE_VALUES.has(lowerValue)) {
    return { normalized: lowerValue as SiteType, rawCode: raw, recognized: true };
  }

  return { normalized: "unknown", rawCode: raw, recognized: false };
}

const LIFECYCLE_CODE_TO_STATUS: Record<string, BwiLifecycleStatus> = {
  DIRE: "published",
  DEL: "deleted",
  RDL: "research_deleted",
  RDEL: "research_deleted",
  RESEARCH: "research"
};

const KNOWN_LIFECYCLE_VALUES = new Set<BwiLifecycleStatus>(["published", "research", "deleted", "research_deleted"]);

/**
 * Normalizes a raw BWI lifecycle/status code (DIRE/DEL/RDL/RDEL/research)
 * into a typed BwiLifecycleStatus, while preserving the exact raw input.
 * Both "RDL" and "RDEL" normalize to the same `research_deleted` value —
 * per docs/BWI_DOMAIN_RULES.md §4, which raw spelling is actually stored is
 * unresolved, so neither is treated as canonical and the exact raw string
 * must be kept alongside this normalized value (see
 * `ExistingCompany.status` vs `ExistingCompany.lifecycleStatus`).
 */
export function normalizeBwiLifecycleStatus(raw: string | undefined): BwiLifecycleNormalization {
  if (raw === undefined) {
    return { normalized: "unknown", rawCode: undefined, recognized: false };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { normalized: "unknown", rawCode: raw, recognized: false };
  }

  const upperCode = trimmed.toUpperCase();
  const mapped = LIFECYCLE_CODE_TO_STATUS[upperCode];
  if (mapped) {
    return { normalized: mapped, rawCode: raw, recognized: true };
  }

  const lowerValue = trimmed.toLowerCase() as BwiLifecycleStatus;
  if (KNOWN_LIFECYCLE_VALUES.has(lowerValue)) {
    return { normalized: lowerValue, rawCode: raw, recognized: true };
  }

  return { normalized: "unknown", rawCode: raw, recognized: false };
}
