import { normalizeCompanyName } from "../../normalize.ts";
import { isPoBoxLikeAddress, isResidentialRiskHeuristic } from "./profile.ts";
import { toStringField } from "./types.ts";
import type { TxPermitObservation } from "./types.ts";

/**
 * Deterministic pilot-sample selection: ~70% priority-stratified (spread
 * across observed dimension combinations so no group is silently excluded)
 * plus ~30% random-control drawn from the full eligible population (so
 * future filtering assumptions can be measured against an unbiased slice).
 * Reproducible for a fixed seed + fixed observation set, regardless of the
 * observations' original fetch/page order (everything is sorted by
 * source_record_id before any random step).
 */

const DEFAULT_MAX_SAMPLE_SIZE = 100;
const PRIORITY_RATIO = 0.7;

export type PilotSampleSelection = "priority_stratified" | "random_control";

/** References the source record rather than duplicating the full raw row -- see README's data-safety rules. */
export type PilotSampleItem = {
  source_record_id: string;
  selection: PilotSampleSelection;
  stratum: string;
};

export type PilotSample = {
  seed: number;
  totalEligible: number;
  sampleSize: number;
  priorityCount: number;
  controlCount: number;
  items: PilotSampleItem[];
};

/** Small deterministic PRNG (mulberry32) -- Math.random() isn't seedable, and this sample must be reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Composite stratification key across the dimensions listed in the task:
 * organization type, NAICS-2 prefix, multi-outlet taxpayer, first-sales
 * date present/absent, taxpayer/outlet name difference, address-risk
 * heuristic, and county. Never used to exclude a record -- only to spread
 * priority selection across every observed combination.
 */
function computeStratumKey(observation: TxPermitObservation, taxpayerOutletCounts: Map<string, number>): string {
  const raw = observation.raw;
  const orgType = toStringField(raw.taxpayer_organization_type) ?? "unknown_org_type";

  const naics = toStringField(raw.outlet_naics_code);
  const naicsPrefix = naics && naics.length >= 2 ? naics.slice(0, 2) : "unknown_naics";

  const taxpayerNumber = toStringField(raw.taxpayer_number);
  const multiOutlet = taxpayerNumber ? (taxpayerOutletCounts.get(taxpayerNumber) ?? 0) > 1 : false;

  const firstSalesPresent = Boolean(toStringField(raw.outlet_first_sales_date));

  const taxpayerName = toStringField(raw.taxpayer_name);
  const outletName = toStringField(raw.outlet_name);
  const nameDiffers = Boolean(taxpayerName && outletName && normalizeCompanyName(taxpayerName) !== normalizeCompanyName(outletName));

  const outletAddress = toStringField(raw.outlet_address);
  const addressRisk = isPoBoxLikeAddress(outletAddress) || isResidentialRiskHeuristic(outletAddress);

  const county = toStringField(raw.outlet_county_code) ?? "unknown_county";

  return [
    `org:${orgType}`,
    `naics:${naicsPrefix}`,
    `multi:${multiOutlet}`,
    `fsd:${firstSalesPresent}`,
    `namediff:${nameDiffers}`,
    `risk:${addressRisk}`,
    `county:${county}`
  ].join("|");
}

export type GeneratePilotSampleOptions = {
  seed?: number;
  maxSampleSize?: number;
};

export function generatePilotSample(
  observations: readonly TxPermitObservation[],
  options: GeneratePilotSampleOptions = {}
): PilotSample {
  const seed = options.seed ?? 1;
  const maxSampleSize = options.maxSampleSize ?? DEFAULT_MAX_SAMPLE_SIZE;
  const random = mulberry32(seed);

  // Deterministic base ordering regardless of fetch/page order, so the same
  // underlying set + seed always produces the same sample.
  const sorted = [...observations].sort((a, b) => a.source_record_id.localeCompare(b.source_record_id));

  const taxpayerOutletCounts = new Map<string, number>();
  for (const observation of sorted) {
    const taxpayerNumber = toStringField(observation.raw.taxpayer_number);
    if (taxpayerNumber) taxpayerOutletCounts.set(taxpayerNumber, (taxpayerOutletCounts.get(taxpayerNumber) ?? 0) + 1);
  }

  // Scales down proportionally (never asks for more than exists) when the
  // eligible population is smaller than maxSampleSize.
  const sampleSize = Math.min(maxSampleSize, sorted.length);
  const priorityTarget = Math.round(sampleSize * PRIORITY_RATIO);
  const controlTarget = sampleSize - priorityTarget;

  const stratumOf = new Map<string, string>();
  const strataGroups = new Map<string, TxPermitObservation[]>();
  for (const observation of sorted) {
    const key = computeStratumKey(observation, taxpayerOutletCounts);
    stratumOf.set(observation.source_record_id, key);
    const group = strataGroups.get(key);
    if (group) group.push(observation);
    else strataGroups.set(key, [observation]);
  }

  // Shuffle within each stratum deterministically, then interleave
  // round-robin across strata (in sorted-key order) so priority selection
  // spreads across every observed dimension combination instead of
  // exhausting one stratum before moving to the next -- no group (sole
  // proprietors, a NAICS code, a county, ...) is silently skipped just
  // because it sorts late.
  const strataKeys = [...strataGroups.keys()].sort();
  const shuffledStrata = new Map<string, TxPermitObservation[]>();
  for (const key of strataKeys) {
    shuffledStrata.set(key, seededShuffle(strataGroups.get(key)!, random));
  }

  const selected = new Set<string>();
  const priorityItems: PilotSampleItem[] = [];
  let cursor = 0;
  while (priorityItems.length < priorityTarget) {
    let addedThisRound = false;
    for (const key of strataKeys) {
      if (priorityItems.length >= priorityTarget) break;
      const group = shuffledStrata.get(key)!;
      const candidate = group[cursor];
      if (candidate && !selected.has(candidate.source_record_id)) {
        selected.add(candidate.source_record_id);
        priorityItems.push({ source_record_id: candidate.source_record_id, selection: "priority_stratified", stratum: key });
        addedThisRound = true;
      }
    }
    cursor += 1;
    if (!addedThisRound) break; // every stratum exhausted before hitting the target
  }

  // Random-control draws from the full remaining eligible population (not a
  // pre-filtered subgroup), so it can measure future filtering assumptions
  // against an unbiased slice.
  const remainingPool = sorted.filter((observation) => !selected.has(observation.source_record_id));
  const shuffledRemaining = seededShuffle(remainingPool, random);
  const controlItems: PilotSampleItem[] = shuffledRemaining.slice(0, controlTarget).map((observation) => ({
    source_record_id: observation.source_record_id,
    selection: "random_control" as const,
    stratum: stratumOf.get(observation.source_record_id) ?? "unknown"
  }));

  return {
    seed,
    totalEligible: sorted.length,
    sampleSize: priorityItems.length + controlItems.length,
    priorityCount: priorityItems.length,
    controlCount: controlItems.length,
    items: [...priorityItems, ...controlItems]
  };
}
