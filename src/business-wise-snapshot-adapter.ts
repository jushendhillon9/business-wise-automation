import type { BusinessWiseAdapter } from "./business-wise-adapter.ts";
import { normalizeBwiLifecycleStatus } from "./bwi-codes.ts";
import { parseBwiRecordsCsv, parseBwiRelationshipsCsv } from "./bwi-snapshot/parse.ts";
import { resolveRecordsSnapshotPath, resolveRelationshipsSnapshotPath } from "./bwi-snapshot/paths.ts";
import { countByRelationshipType, countBySiteTypeCode, countByStatusCode } from "./bwi-snapshot/stats.ts";
import type { BwiSnapshotRecord } from "./bwi-snapshot/types.ts";
import { diceSimilarity, normalizeAddress, normalizeCompanyName, normalizeDomain, normalizePhone } from "./normalize.ts";
import type { ExistingCompany, LocationCandidate } from "./types.ts";

/**
 * Real local CSV-backed BusinessWiseAdapter (see docs/BWI_PRODUCTION_DB_DISCOVERY.md
 * §17 guardrails and README.md's "Real BWI Snapshot — Local Only" section).
 * Reads the two private DFW production snapshots (data/private/bwi/README.md)
 * entirely locally, builds bounded in-memory retrieval indexes, and never:
 *
 * - connects to production SQL;
 * - contains credentials;
 * - mutates either CSV;
 * - implements a production write/publish method (`stageApprovedCandidate`
 *   always throws -- see below).
 *
 * `searchPotentialMatches()` only retrieves a bounded, credible candidate
 * set from indexed exact/near signals (phone, domain, address, ZIP+name,
 * city/state+name, exact name, known parent/child relationship). It never
 * scores or interprets those candidates -- that stays entirely in
 * src/entity-resolution.ts / src/entity-resolution-policy.ts, unchanged.
 */

const MAX_CANDIDATES = 25;
const NAME_SIMILARITY_THRESHOLD = 0.55;

export type BwiSnapshotLoadStats = {
  recordCount: number;
  relationshipCount: number;
  malformedRecordCount: number;
  malformedRelationshipCount: number;
  duplicateRecordIdCount: number;
  recordsPath: string;
  relationshipsPath: string;
  recordsFileSizeBytes: number;
  relationshipsFileSizeBytes: number;
  loadDurationMs: number;
};

function addToIndex(index: Map<string, string[]>, key: string | undefined, id: string): void {
  if (!key) return;
  const bucket = index.get(key);
  if (bucket) bucket.push(id);
  else index.set(key, [id]);
}

function cityStateKey(city?: string, state?: string): string | undefined {
  if (!city || !state) return undefined;
  return `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
}

function addRelationshipType(map: Map<string, Set<string>>, id: string, type: string): void {
  const set = map.get(id);
  if (set) set.add(type);
  else map.set(id, new Set([type]));
}

export class BusinessWiseSnapshotAdapter implements BusinessWiseAdapter {
  private readonly recordsById = new Map<string, BwiSnapshotRecord>();
  private readonly phoneIndex = new Map<string, string[]>();
  private readonly domainIndex = new Map<string, string[]>();
  private readonly addressIndex = new Map<string, string[]>();
  private readonly zipIndex = new Map<string, string[]>();
  private readonly cityStateIndex = new Map<string, string[]>();
  private readonly nameIndex = new Map<string, string[]>();
  private readonly childrenByParentId = new Map<string, string[]>();
  private readonly parentIdByChildId = new Map<string, string>();
  /** Distinct relationship types (HQTR/AFFL) each BWI record id participates in, as either parent or child. Additive lookup only -- never consulted by searchPotentialMatches()/matching logic. */
  private readonly relationshipTypesByRecordId = new Map<string, Set<string>>();
  private relationshipTypeCounts: Record<string, number> | undefined;
  private loadStats: BwiSnapshotLoadStats | undefined;

  private constructor() {}

  /**
   * Loads and indexes both snapshots from disk. Path precedence (highest
   * first): explicit `recordsPath`/`relationshipsPath` argument > the
   * BWI_RECORDS_SNAPSHOT_PATH/BWI_RELATIONSHIPS_SNAPSHOT_PATH env vars >
   * data/private/bwi/'s documented default filenames.
   */
  static async load(options?: { recordsPath?: string; relationshipsPath?: string }): Promise<BusinessWiseSnapshotAdapter> {
    const adapter = new BusinessWiseSnapshotAdapter();
    await adapter.loadFromDisk(options?.recordsPath, options?.relationshipsPath);
    return adapter;
  }

  private async loadFromDisk(recordsPathArg?: string, relationshipsPathArg?: string): Promise<void> {
    const startedAt = Date.now();
    const recordsPath = resolveRecordsSnapshotPath(recordsPathArg);
    const relationshipsPath = resolveRelationshipsSnapshotPath(relationshipsPathArg);

    const recordsFile = Bun.file(recordsPath);
    const relationshipsFile = Bun.file(relationshipsPath);

    if (!(await recordsFile.exists())) {
      throw new Error(
        `BWI records snapshot not found at "${recordsPath}". Drop the file there or set BWI_RECORDS_SNAPSHOT_PATH. See data/private/bwi/README.md.`
      );
    }
    if (!(await relationshipsFile.exists())) {
      throw new Error(
        `BWI relationships snapshot not found at "${relationshipsPath}". Drop the file there or set BWI_RELATIONSHIPS_SNAPSHOT_PATH. See data/private/bwi/README.md.`
      );
    }

    const [recordsText, relationshipsText] = await Promise.all([recordsFile.text(), relationshipsFile.text()]);

    const parsedRecords = parseBwiRecordsCsv(recordsText);
    if (parsedRecords.duplicateIds.length > 0) {
      throw new Error(
        `BWI records snapshot has ${parsedRecords.duplicateIds.length} duplicate bwi_location_id value(s) ` +
          `(e.g. "${parsedRecords.duplicateIds[0]}"). Refusing to load an ambiguous snapshot -- each record must be ` +
          `keyed by a unique bwi_location_id.`
      );
    }

    const parsedRelationships = parseBwiRelationshipsCsv(relationshipsText);

    for (const record of parsedRecords.records) {
      this.indexRecord(record);
    }

    for (const relationship of parsedRelationships.relationships) {
      const children = this.childrenByParentId.get(relationship.parentBwiId);
      if (children) children.push(relationship.childBwiId);
      else this.childrenByParentId.set(relationship.parentBwiId, [relationship.childBwiId]);

      // A messy export could in principle list more than one parent edge for
      // the same child; keep the first seen rather than silently overwrite.
      if (!this.parentIdByChildId.has(relationship.childBwiId)) {
        this.parentIdByChildId.set(relationship.childBwiId, relationship.parentBwiId);
      }

      addRelationshipType(this.relationshipTypesByRecordId, relationship.parentBwiId, relationship.relationshipType);
      addRelationshipType(this.relationshipTypesByRecordId, relationship.childBwiId, relationship.relationshipType);
    }
    this.relationshipTypeCounts = countByRelationshipType(parsedRelationships.relationships);

    this.loadStats = {
      recordCount: parsedRecords.records.length,
      relationshipCount: parsedRelationships.relationships.length,
      malformedRecordCount: parsedRecords.malformedCount,
      malformedRelationshipCount: parsedRelationships.malformedCount,
      duplicateRecordIdCount: parsedRecords.duplicateIds.length,
      recordsPath,
      relationshipsPath,
      recordsFileSizeBytes: recordsFile.size,
      relationshipsFileSizeBytes: relationshipsFile.size,
      loadDurationMs: Date.now() - startedAt
    };
  }

  private indexRecord(record: BwiSnapshotRecord): void {
    this.recordsById.set(record.bwiLocationId, record);

    addToIndex(this.phoneIndex, normalizePhone(record.phone) || undefined, record.bwiLocationId);
    addToIndex(this.domainIndex, normalizeDomain(record.website) || undefined, record.bwiLocationId);
    addToIndex(this.addressIndex, normalizeAddress(record.address ?? record.street) || undefined, record.bwiLocationId);
    addToIndex(this.zipIndex, record.zip, record.bwiLocationId);
    addToIndex(this.cityStateIndex, cityStateKey(record.city, record.state), record.bwiLocationId);
    addToIndex(this.nameIndex, normalizeCompanyName(record.companyName) || undefined, record.bwiLocationId);
  }

  private assertLoaded(): void {
    if (!this.loadStats) {
      throw new Error("BusinessWiseSnapshotAdapter used before load() completed.");
    }
  }

  getLoadStats(): BwiSnapshotLoadStats {
    this.assertLoaded();
    return this.loadStats!;
  }

  getStatusCounts(): Record<string, number> {
    return countByStatusCode([...this.recordsById.values()]);
  }

  getSiteTypeCounts(): Record<string, number> {
    return countBySiteTypeCode([...this.recordsById.values()]);
  }

  getRelationshipTypeCounts(): Record<string, number> {
    this.assertLoaded();
    return this.relationshipTypeCounts ?? {};
  }

  getChildIds(parentBwiId: string): string[] {
    return this.childrenByParentId.get(parentBwiId) ?? [];
  }

  getParentId(childBwiId: string): string | undefined {
    return this.parentIdByChildId.get(childBwiId);
  }

  /** Distinct relationship types (e.g. "HQTR", "AFFL") this BWI record participates in, as either parent or child. Empty array when the record has no known relationship edge. */
  getRelationshipTypesForRecord(bwiLocationId: string): string[] {
    return [...(this.relationshipTypesByRecordId.get(bwiLocationId) ?? [])];
  }

  private toExistingCompany(record: BwiSnapshotRecord): ExistingCompany {
    const lifecycle = normalizeBwiLifecycleStatus(record.statusCode);
    return {
      id: record.bwiLocationId,
      companyName: record.companyName,
      address: record.address ?? record.street,
      city: record.city,
      state: record.state,
      postalCode: record.zip,
      phone: record.phone,
      website: record.website,
      sicCode: record.sic,
      // Raw status as observed in the snapshot -- see the ExistingCompanyStatus
      // widening note in src/types.ts for why KEEP/RSCH/DELE are valid here.
      status: record.statusCode as ExistingCompany["status"],
      lifecycleStatus: lifecycle.normalized
    };
  }

  /**
   * Retrieves a bounded, credible candidate set for a LocationCandidate using
   * indexed exact/near signals only -- never a full scan of all ~241k
   * records per lookup. Returns an empty array rather than inventing a match
   * when no index produces a hit. Scoring/interpretation of these candidates
   * is entirely the caller's job (rankCandidateMatches() /
   * resolveCandidateAgainstExisting()).
   */
  async searchPotentialMatches(candidate: LocationCandidate): Promise<ExistingCompany[]> {
    this.assertLoaded();
    const matchedIds = new Set<string>();

    const phoneKey = normalizePhone(candidate.phone);
    if (phoneKey) for (const id of this.phoneIndex.get(phoneKey) ?? []) matchedIds.add(id);

    const domainKey = normalizeDomain(candidate.company.website);
    if (domainKey) for (const id of this.domainIndex.get(domainKey) ?? []) matchedIds.add(id);

    const addressKey = normalizeAddress(candidate.physicalAddress?.street);
    if (addressKey) for (const id of this.addressIndex.get(addressKey) ?? []) matchedIds.add(id);

    const candidateNameNormalized = normalizeCompanyName(candidate.company.legalName);

    const zip = candidate.physicalAddress?.postalCode?.trim();
    if (zip) {
      for (const id of this.zipIndex.get(zip) ?? []) {
        if (matchedIds.has(id)) continue;
        const record = this.recordsById.get(id);
        if (record && this.namesLookSimilar(candidateNameNormalized, record)) matchedIds.add(id);
      }
    }

    const cityState = cityStateKey(candidate.physicalAddress?.city, candidate.physicalAddress?.state);
    if (cityState) {
      for (const id of this.cityStateIndex.get(cityState) ?? []) {
        if (matchedIds.has(id)) continue;
        const record = this.recordsById.get(id);
        if (record && this.namesLookSimilar(candidateNameNormalized, record)) matchedIds.add(id);
      }
    }

    if (candidateNameNormalized) {
      for (const id of this.nameIndex.get(candidateNameNormalized) ?? []) matchedIds.add(id);
    }

    // Relationship-graph bonus signal: a matched record's known parent/children
    // are plausible related candidates too (e.g. HQ found -> surface a branch).
    if (matchedIds.size > 0 && matchedIds.size < MAX_CANDIDATES) {
      const related: string[] = [];
      for (const id of matchedIds) {
        related.push(...(this.childrenByParentId.get(id) ?? []));
        const parentId = this.parentIdByChildId.get(id);
        if (parentId) related.push(parentId);
      }
      for (const id of related) {
        if (matchedIds.size >= MAX_CANDIDATES) break;
        if (this.recordsById.has(id)) matchedIds.add(id);
      }
    }

    return [...matchedIds]
      .slice(0, MAX_CANDIDATES)
      .map((id) => this.recordsById.get(id))
      .filter((record): record is BwiSnapshotRecord => Boolean(record))
      .map((record) => this.toExistingCompany(record));
  }

  private namesLookSimilar(candidateNameNormalized: string, record: BwiSnapshotRecord): boolean {
    if (!candidateNameNormalized) return false;
    return diceSimilarity(candidateNameNormalized, normalizeCompanyName(record.companyName)) >= NAME_SIMILARITY_THRESHOLD;
  }

  /**
   * Intentionally unimplemented. This adapter is read-only local-snapshot
   * retrieval only -- Project 1 stays read-only toward Business Wise, and
   * Delphi remains the final human write surface (docs/BWI_PRODUCTION_DB_DISCOVERY.md
   * §17). Any approved candidate must go through that existing manual workflow.
   */
  async stageApprovedCandidate(_candidate: LocationCandidate): Promise<{ stagedId: string }> {
    throw new Error(
      "BusinessWiseSnapshotAdapter is read-only and implements no write/publish path. " +
        "Approved candidates must go through the existing manual Business Wise/Delphi entry workflow."
    );
  }
}

/** Convenience wrapper matching the CSV-fixture adapters' factory-function naming (see src/sources/*). */
export async function createBusinessWiseSnapshotAdapter(options?: {
  recordsPath?: string;
  relationshipsPath?: string;
}): Promise<BusinessWiseSnapshotAdapter> {
  return BusinessWiseSnapshotAdapter.load(options);
}
