import { normalizeCompanyName } from "../../../normalize.ts";
import type { PublicationReadinessAssessment } from "../../../publication-readiness.ts";
import type { EntityResolutionDecision, ExistingCompany, LocationCandidate, MatchResult } from "../../../types.ts";
import { isPoBoxLikeAddress, isResidentialRiskHeuristic } from "../profile.ts";
import { mulberry32, seededShuffle } from "../sample.ts";
import { toStringField } from "../types.ts";
import type { TxPermitObservation } from "../types.ts";

/**
 * Deterministic, outcome-diverse private review-packet selection for a
 * shadow-pilot run. Reuses the same seeded-PRNG/round-robin-across-strata
 * technique already used for the profiler's own pilot sample
 * (src/sources/tx-sales-tax-permits/sample.ts) rather than a second
 * implementation. Unlike that 70/30 split, every selected case here is
 * "priority" -- the whole point of this packet is deliberate outcome/risk
 * diversity for a small (default 20) human-inspection set, not an unbiased
 * statistical sample.
 *
 * This packet legitimately contains real source and BWI data (unlike every
 * other pilot output) -- see README's "Texas Sales-Tax Permit Shadow Pilot"
 * section for the handling rules. It never includes BWI contact data (the
 * BWI snapshot model has no contact fields to begin with).
 */

export type PilotReviewCandidateInput = {
  candidate: LocationCandidate;
  match: MatchResult;
  resolution: EntityResolutionDecision;
  readiness: PublicationReadinessAssessment;
  matchedExisting?: ExistingCompany;
  relationshipTypes: string[];
  retrievalCount: number;
};

export type PilotReviewCase = {
  source: {
    source_record_id: string;
    taxpayer_name?: string;
    outlet_name?: string;
    outlet_address?: string;
    outlet_city?: string;
    outlet_state?: string;
    outlet_zip_code?: string;
    organization_type?: string;
    naics_code?: string;
    permit_issue_date?: string;
    first_sales_date?: string;
    taxpayer_has_multiple_outlets: boolean;
    taxpayer_name_differs_from_outlet_name: boolean;
    po_box_like_address: boolean;
    residential_risk_heuristic: boolean;
    county_code?: string;
  };
  machine: {
    recommended_outcome: string;
    confidence?: number;
    matched_bwi_id?: string;
    matched_bwi_summary?: {
      company_name: string;
      address?: string;
      city?: string;
      state?: string;
      status?: string;
      lifecycle_status?: string;
    };
    match_reasons: string[];
    conflicts: string[];
    relationship_context: string[];
    readiness_state: string;
    blockers: Array<{ rule_id: string; explanation: string }>;
    optional_missing_fields: string[];
  };
  selection: {
    stratum: string;
  };
};

function observationOf(input: PilotReviewCandidateInput): TxPermitObservation {
  return input.candidate.rawSourceData as TxPermitObservation;
}

function computeReviewStratumKey(input: PilotReviewCandidateInput, taxpayerOutletCounts: Map<string, number>): string {
  const raw = observationOf(input).raw;
  const outletName = toStringField(raw.outlet_name);
  const taxpayerName = toStringField(raw.taxpayer_name);
  const nameDiffers = Boolean(outletName && taxpayerName && normalizeCompanyName(outletName) !== normalizeCompanyName(taxpayerName));

  const outletAddress = toStringField(raw.outlet_address);
  const addressRisk = isPoBoxLikeAddress(outletAddress) || isResidentialRiskHeuristic(outletAddress);

  const naics = toStringField(raw.outlet_naics_code);
  const naicsPrefix = naics && naics.length >= 2 ? naics.slice(0, 2) : "unknown_naics";
  const county = toStringField(raw.outlet_county_code) ?? "unknown_county";

  const noRetrieval = input.retrievalCount === 0;
  const lifecycleRisk =
    input.matchedExisting?.lifecycleStatus === "deleted" || input.matchedExisting?.lifecycleStatus === "research_deleted";

  return [
    `outcome:${input.resolution.outcome}`,
    `retrieval:${noRetrieval ? "none" : "found"}`,
    `lifecycle:${lifecycleRisk ? "deleted_or_research_deleted" : "other"}`,
    `namediff:${nameDiffers}`,
    `risk:${addressRisk}`,
    `naics:${naicsPrefix}`,
    `county:${county}`
  ].join("|");
}

function buildReviewCase(
  input: PilotReviewCandidateInput,
  taxpayerOutletCounts: Map<string, number>,
  stratumByRecordId: Map<string, string>
): PilotReviewCase {
  const observation = observationOf(input);
  const raw = observation.raw;

  const outletName = toStringField(raw.outlet_name);
  const taxpayerName = toStringField(raw.taxpayer_name);
  const outletAddress = toStringField(raw.outlet_address);
  const taxpayerNumber = toStringField(raw.taxpayer_number);
  const outletCount = taxpayerNumber ? (taxpayerOutletCounts.get(taxpayerNumber) ?? 1) : 1;
  const matchedExisting = input.matchedExisting;

  return {
    source: {
      source_record_id: observation.source_record_id,
      taxpayer_name: taxpayerName,
      outlet_name: outletName,
      outlet_address: outletAddress,
      outlet_city: toStringField(raw.outlet_city),
      outlet_state: toStringField(raw.outlet_state),
      outlet_zip_code: toStringField(raw.outlet_zip_code),
      organization_type: toStringField(raw.taxpayer_organization_type),
      naics_code: toStringField(raw.outlet_naics_code),
      permit_issue_date: toStringField(raw.outlet_permit_issue_date),
      first_sales_date: toStringField(raw.outlet_first_sales_date),
      taxpayer_has_multiple_outlets: outletCount > 1,
      taxpayer_name_differs_from_outlet_name: Boolean(
        outletName && taxpayerName && normalizeCompanyName(outletName) !== normalizeCompanyName(taxpayerName)
      ),
      po_box_like_address: isPoBoxLikeAddress(outletAddress),
      residential_risk_heuristic: isResidentialRiskHeuristic(outletAddress),
      county_code: toStringField(raw.outlet_county_code)
    },
    machine: {
      recommended_outcome: input.resolution.outcome,
      confidence: input.resolution.decisionConfidence,
      matched_bwi_id: input.resolution.matchedExistingCompanyId ?? input.match.existingCompanyId,
      matched_bwi_summary: matchedExisting
        ? {
            company_name: matchedExisting.companyName,
            address: matchedExisting.address,
            city: matchedExisting.city,
            state: matchedExisting.state,
            status: matchedExisting.status,
            lifecycle_status: matchedExisting.lifecycleStatus
          }
        : undefined,
      match_reasons: input.resolution.reasons,
      conflicts: input.resolution.conflicts,
      relationship_context: input.relationshipTypes,
      readiness_state: input.readiness.state,
      blockers: input.readiness.blockers.map((blocker) => ({ rule_id: blocker.ruleId, explanation: blocker.explanation })),
      optional_missing_fields: input.readiness.optionalMissingFields
    },
    selection: {
      stratum: stratumByRecordId.get(observation.source_record_id) ?? "unknown"
    }
  };
}

export type SelectReviewSampleOptions = {
  sampleSize?: number;
  seed?: number;
};

const DEFAULT_REVIEW_SAMPLE_SIZE = 20;

/**
 * Selects a deterministic, outcome-diverse review packet, capped at
 * `sampleSize` (default 20). Spreads selection round-robin across every
 * observed (outcome × retrieval × lifecycle × name-diff × address-risk ×
 * NAICS × county) stratum combination -- reproducible for a fixed `seed`,
 * and never dominated by whichever outcome happens to be most common.
 */
export function selectReviewSample(
  inputs: readonly PilotReviewCandidateInput[],
  options: SelectReviewSampleOptions = {}
): PilotReviewCase[] {
  const sampleSize = options.sampleSize ?? DEFAULT_REVIEW_SAMPLE_SIZE;
  const seed = options.seed ?? 1;
  const random = mulberry32(seed);

  // Deterministic base ordering regardless of processing order.
  const sorted = [...inputs].sort((a, b) => observationOf(a).source_record_id.localeCompare(observationOf(b).source_record_id));

  const taxpayerOutletCounts = new Map<string, number>();
  for (const input of sorted) {
    const taxpayerNumber = toStringField(observationOf(input).raw.taxpayer_number);
    if (taxpayerNumber) taxpayerOutletCounts.set(taxpayerNumber, (taxpayerOutletCounts.get(taxpayerNumber) ?? 0) + 1);
  }

  const target = Math.min(sampleSize, sorted.length);

  const stratumByRecordId = new Map<string, string>();
  const strataGroups = new Map<string, PilotReviewCandidateInput[]>();
  for (const input of sorted) {
    const key = computeReviewStratumKey(input, taxpayerOutletCounts);
    stratumByRecordId.set(observationOf(input).source_record_id, key);
    const group = strataGroups.get(key);
    if (group) group.push(input);
    else strataGroups.set(key, [input]);
  }

  const strataKeys = [...strataGroups.keys()].sort();
  const shuffledStrata = new Map<string, PilotReviewCandidateInput[]>();
  for (const key of strataKeys) {
    shuffledStrata.set(key, seededShuffle(strataGroups.get(key)!, random));
  }

  const selected: PilotReviewCandidateInput[] = [];
  const selectedIds = new Set<string>();
  let cursor = 0;
  while (selected.length < target) {
    let addedThisRound = false;
    for (const key of strataKeys) {
      if (selected.length >= target) break;
      const group = shuffledStrata.get(key)!;
      const candidateInput = group[cursor];
      if (candidateInput) {
        const sourceRecordId = observationOf(candidateInput).source_record_id;
        if (!selectedIds.has(sourceRecordId)) {
          selectedIds.add(sourceRecordId);
          selected.push(candidateInput);
          addedThisRound = true;
        }
      }
    }
    cursor += 1;
    if (!addedThisRound) break; // every stratum exhausted before hitting the target
  }

  return selected.map((input) => buildReviewCase(input, taxpayerOutletCounts, stratumByRecordId));
}

const CSV_COLUMNS: Array<{ header: string; value: (reviewCase: PilotReviewCase) => string }> = [
  { header: "source_record_id", value: (c) => c.source.source_record_id },
  { header: "taxpayer_name", value: (c) => c.source.taxpayer_name ?? "" },
  { header: "outlet_name", value: (c) => c.source.outlet_name ?? "" },
  { header: "outlet_address", value: (c) => c.source.outlet_address ?? "" },
  { header: "outlet_city", value: (c) => c.source.outlet_city ?? "" },
  { header: "outlet_state", value: (c) => c.source.outlet_state ?? "" },
  { header: "outlet_zip_code", value: (c) => c.source.outlet_zip_code ?? "" },
  { header: "organization_type", value: (c) => c.source.organization_type ?? "" },
  { header: "naics_code", value: (c) => c.source.naics_code ?? "" },
  { header: "permit_issue_date", value: (c) => c.source.permit_issue_date ?? "" },
  { header: "first_sales_date", value: (c) => c.source.first_sales_date ?? "" },
  { header: "multi_outlet", value: (c) => String(c.source.taxpayer_has_multiple_outlets) },
  { header: "name_differs", value: (c) => String(c.source.taxpayer_name_differs_from_outlet_name) },
  { header: "po_box_like", value: (c) => String(c.source.po_box_like_address) },
  { header: "residential_risk", value: (c) => String(c.source.residential_risk_heuristic) },
  { header: "county_code", value: (c) => c.source.county_code ?? "" },
  { header: "recommended_outcome", value: (c) => c.machine.recommended_outcome },
  { header: "confidence", value: (c) => (c.machine.confidence !== undefined ? String(c.machine.confidence) : "") },
  { header: "matched_bwi_id", value: (c) => c.machine.matched_bwi_id ?? "" },
  { header: "matched_bwi_company_name", value: (c) => c.machine.matched_bwi_summary?.company_name ?? "" },
  { header: "matched_bwi_status", value: (c) => c.machine.matched_bwi_summary?.status ?? "" },
  { header: "relationship_context", value: (c) => c.machine.relationship_context.join("; ") },
  { header: "readiness_state", value: (c) => c.machine.readiness_state },
  { header: "stratum", value: (c) => c.selection.stratum }
];

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Human-skimmable CSV rendition of a review packet -- same content as the JSON, no full raw rows duplicated beyond what the JSON already carries. */
export function reviewSampleToCsv(cases: readonly PilotReviewCase[]): string {
  const header = CSV_COLUMNS.map((column) => column.header).join(",");
  const rows = cases.map((reviewCase) => CSV_COLUMNS.map((column) => csvEscape(column.value(reviewCase))).join(","));
  return [header, ...rows].join("\n") + (cases.length > 0 ? "\n" : "");
}
