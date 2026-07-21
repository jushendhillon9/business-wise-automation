import type { ExistingCompany, LocationCandidate } from "./types.ts";

/**
 * Integration boundary for the real Business Wise architecture.
 * Keep Project 1 logic dependent on this interface, not Delphi/Azure/ADF details.
 * Rif/Randall discovery determines the production implementation later.
 *
 * A future implementation of this interface is where raw BWI rows get
 * mapped into the normalized internal model (and back). That mapping should
 * reuse src/bwi-codes.ts rather than re-deriving code translation:
 *
 * - raw BWI row -> normalized model + preserved raw codes: build an
 *   ExistingCompany the same way src/db.ts's insertExistingCompany does --
 *   keep the raw `status` string verbatim, and set `lifecycleStatus` via
 *   `normalizeBwiLifecycleStatus(status).normalized`. Same pattern for a
 *   LocationCandidate's `siteType`/`rawSiteTypeCode` via
 *   `normalizeBwiSiteType()`, as src/sources/dfw-json-adapter.ts and
 *   src/sources/dfw-csv-adapter.ts already do for fixture sources.
 * - approved normalized model -> explicit BWI legacy codes (writeback
 *   direction): for site type, `SITE_TYPE_TO_BW_CODE` (src/types.ts) is
 *   already a complete, lossless reverse mapping and can be used directly.
 *   For lifecycle status there is deliberately no reverse mapping yet --
 *   `research_deleted` could round-trip as either "RDL" or "RDEL", and
 *   docs/BWI_DOMAIN_RULES.md §4 explicitly leaves that spelling unresolved.
 *   Picking one now would fabricate certainty we don't have; that decision
 *   is deferred until Emily/Rif/Randall confirm the actual stored spelling.
 *
 * No implementation of this interface exists yet, and none should connect
 * to a real database as part of this project.
 */
export interface BusinessWiseAdapter {
  searchPotentialMatches(candidate: LocationCandidate): Promise<ExistingCompany[]>;
  stageApprovedCandidate(candidate: LocationCandidate): Promise<{ stagedId: string }>;
}
