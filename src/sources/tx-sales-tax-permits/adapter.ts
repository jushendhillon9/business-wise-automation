import { existsSync, statSync } from "node:fs";
import { normalizeCompanyName } from "../../normalize.ts";
import {
  companyFieldPath,
  createFieldEvidence,
  locationFieldPath,
  SINGLE_SOURCE_OBSERVED_CONFIDENCE,
  type Address,
  type FieldEvidence,
  type FieldEvidenceSource
} from "../../types.ts";
import type { LocationCandidateDraft, MappingResult, RawSourceRecord, SourceAdapter } from "../types.ts";
import { DEFAULT_SOURCE_DIR } from "./pilot/pilot-paths.ts";
import { toStringField, TX_SALES_TAX_PERMITS_DATASET_ID } from "./types.ts";
import type { TxPermitObservation } from "./types.ts";

/**
 * Real Texas sales-tax-permit SourceAdapter, using the repository's existing
 * SourceAdapter abstraction. Reads the local, already-downloaded profiler
 * output (raw.ndjson) -- makes no network call itself; the profiler
 * (src/tx-permits-profile.ts) remains solely responsible for acquiring the
 * snapshot. Maps one raw permit observation into one provisional
 * CompanyIdentity + LocationCandidate, same as src/sources/dfw-csv-adapter.ts
 * / dfw-json-adapter.ts.
 */

export const TX_SALES_TAX_PERMIT_SOURCE_ID = "tx-sales-tax-permits";
const SOURCE_NAME = `Texas Comptroller Sales-Tax Permit Holders (official Socrata API, dataset ${TX_SALES_TAX_PERMITS_DATASET_ID})`;

export class TxSalesTaxPermitSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxSalesTaxPermitSourceError";
  }
}

type ManifestShape = { row_count?: number; [key: string]: unknown };

async function assertManifestAgrees(sourceDir: string, observedCount: number): Promise<void> {
  const manifestFile = Bun.file(`${sourceDir}/manifest.json`);
  if (!(await manifestFile.exists())) return; // manifest.json is optional -- validated only when present

  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(await manifestFile.text()) as ManifestShape;
  } catch {
    throw new TxSalesTaxPermitSourceError(`Texas permit source snapshot "${sourceDir}/manifest.json" is not valid JSON.`);
  }

  if (typeof manifest.row_count === "number" && manifest.row_count !== observedCount) {
    throw new TxSalesTaxPermitSourceError(
      `Texas permit source snapshot "${sourceDir}": manifest.json reports row_count=${manifest.row_count}, but raw.ndjson ` +
        `contains ${observedCount} valid observation(s). Refusing to ingest a snapshot whose manifest disagrees with its data.`
    );
  }
}

export type TxSalesTaxPermitSourceAdapterOptions = {
  /** Directory containing raw.ndjson (and optionally manifest.json). Default: pilot/pilot-paths.ts's DEFAULT_SOURCE_DIR. */
  sourceDir?: string;
  /** Caps how many observations fetch() returns. Applied AFTER full-snapshot validation (identity/duplicate/manifest checks always run against the whole file, never just the bounded slice). */
  limit?: number;
};

/**
 * Creates the Texas sales-tax-permit SourceAdapter. `source_record_id`
 * (`taxpayer_number:outlet_number`, already computed by the profiler) is
 * used as `RawSourceRecord.recordId`, so ingestion's existing fingerprinting
 * (`${sourceId}:${sourceRecordId}`) makes repeated pilot runs against the
 * same snapshot idempotent for free -- no adapter-specific dedup logic
 * needed. The adapter never merges candidates itself; one outlet row always
 * produces exactly one LocationCandidate.
 */
export function createTxSalesTaxPermitSourceAdapter(options: TxSalesTaxPermitSourceAdapterOptions = {}): SourceAdapter {
  const sourceDir = options.sourceDir || DEFAULT_SOURCE_DIR;
  const limit = options.limit;

  // Populated by fetch(), consulted by toCandidate() -- the ingestion engine
  // (src/ingestion.ts) always calls fetch() once, then toCandidate() once per
  // returned record, so this ordering is safe without threading extra state
  // through the SourceAdapter interface itself.
  let taxpayerOutletCounts = new Map<string, number>();

  return {
    sourceId: TX_SALES_TAX_PERMIT_SOURCE_ID,
    sourceName: SOURCE_NAME,

    async fetch(): Promise<RawSourceRecord[]> {
      if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
        throw new TxSalesTaxPermitSourceError(
          `Texas permit source directory not found: "${sourceDir}". Run \`bun run source:tx-permits:profile\` first, or pass --source-dir.`
        );
      }

      const rawPath = `${sourceDir}/raw.ndjson`;
      const rawFile = Bun.file(rawPath);
      if (!(await rawFile.exists())) {
        throw new TxSalesTaxPermitSourceError(`Texas permit source snapshot is missing "${rawPath}".`);
      }

      const text = await rawFile.text();
      const lines = text.split("\n").filter((line) => line.trim().length > 0);

      const observations: TxPermitObservation[] = [];
      const seenIds = new Set<string>();
      const duplicateIds = new Set<string>();

      lines.forEach((line, index) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new TxSalesTaxPermitSourceError(`Texas permit source snapshot "${rawPath}": line ${index + 1} is not valid JSON.`);
        }

        const observation = parsed as Partial<TxPermitObservation>;
        const raw = observation.raw as Record<string, unknown> | undefined;
        const taxpayerNumber = toStringField(raw?.taxpayer_number);
        const outletNumber = toStringField(raw?.outlet_number);
        const sourceRecordId = toStringField(observation.source_record_id);

        // Structurally invalid identity is a hard failure during a pilot run
        // -- never silently skipped one row at a time (that leniency is for
        // ordinary optional-field gaps in toCandidate() below, not for a
        // corrupt/incomplete snapshot file).
        if (!sourceRecordId || !taxpayerNumber || !outletNumber) {
          throw new TxSalesTaxPermitSourceError(
            `Texas permit source snapshot "${rawPath}": line ${index + 1} is missing a required identity field ` +
              `(source_record_id/taxpayer_number/outlet_number).`
          );
        }

        if (seenIds.has(sourceRecordId)) {
          duplicateIds.add(sourceRecordId);
        }
        seenIds.add(sourceRecordId);

        observations.push(observation as TxPermitObservation);
      });

      if (duplicateIds.size > 0) {
        throw new TxSalesTaxPermitSourceError(
          `Texas permit source snapshot "${rawPath}": ${duplicateIds.size} duplicate source_record_id value(s) found ` +
            `(e.g. "${[...duplicateIds][0]}"). Refusing to ingest an ambiguous snapshot.`
        );
      }

      await assertManifestAgrees(sourceDir, observations.length);

      taxpayerOutletCounts = new Map<string, number>();
      for (const observation of observations) {
        const taxpayerNumber = toStringField(observation.raw.taxpayer_number);
        if (taxpayerNumber) taxpayerOutletCounts.set(taxpayerNumber, (taxpayerOutletCounts.get(taxpayerNumber) ?? 0) + 1);
      }

      const bounded = limit !== undefined ? observations.slice(0, limit) : observations;

      return bounded.map((observation) => ({
        recordId: observation.source_record_id,
        data: observation as unknown as Record<string, unknown>
      }));
    },

    toCandidate(record: RawSourceRecord): MappingResult {
      const observation = record.data as unknown as TxPermitObservation;
      const raw = observation.raw;

      const taxpayerNumber = toStringField(raw.taxpayer_number);
      const outletNumber = toStringField(raw.outlet_number);
      if (!taxpayerNumber || !outletNumber) {
        return { ok: false, reason: "missing taxpayer_number/outlet_number" };
      }

      // Outlet is the operating-location candidate: prefer outlet_name as the
      // operating display name, falling back to taxpayer_name only when
      // outlet_name is genuinely absent. Neither name is ever discarded --
      // taxpayer_name is preserved as its own evidence entry below.
      const outletName = toStringField(raw.outlet_name);
      const taxpayerName = toStringField(raw.taxpayer_name);
      const legalName = outletName ?? taxpayerName;
      if (!legalName) {
        return { ok: false, reason: "missing both outlet_name and taxpayer_name" };
      }

      const fieldSource: FieldEvidenceSource = {
        sourceType: "state_sales_tax_permit",
        sourceId: TX_SALES_TAX_PERMIT_SOURCE_ID,
        sourceName: SOURCE_NAME,
        sourceUrl: observation.source_url,
        sourceRecordId: record.recordId
      };

      const capturedAt = observation.fetched_at;
      const fieldEvidence: FieldEvidence[] = [];
      const observe = (
        path: Parameters<typeof createFieldEvidence>[0]["path"],
        value: unknown,
        rawValue?: unknown,
        capturedAtOverride?: string
      ): void => {
        fieldEvidence.push(
          createFieldEvidence({
            path,
            value,
            rawValue: rawValue ?? value,
            confidence: SINGLE_SOURCE_OBSERVED_CONFIDENCE,
            source: fieldSource,
            capturedAt: capturedAtOverride ?? capturedAt,
            derivation: "directly_observed"
          })
        );
      };

      observe(companyFieldPath("legalName"), legalName, outletName ?? taxpayerName);
      // taxpayer_name is preserved distinctly and auditably, even when it's
      // also legalName's fallback value or differs from outlet_name -- never
      // silently overwritten or discarded.
      if (taxpayerName) observe(companyFieldPath("taxpayerName"), taxpayerName);
      if (raw.taxpayer_organization_type) observe(companyFieldPath("organizationType"), raw.taxpayer_organization_type);
      // NAICS is its own evidence field -- never written into company.sicCode
      // and never auto-converted to a SIC code (no mapping table exists, and
      // inventing one would fabricate domain knowledge this source doesn't
      // provide).
      if (raw.outlet_naics_code) observe(companyFieldPath("naicsCode"), raw.outlet_naics_code);

      const physicalAddress: Address | undefined =
        raw.outlet_address || raw.outlet_city || raw.outlet_state || raw.outlet_zip_code
          ? {
              street: toStringField(raw.outlet_address),
              city: toStringField(raw.outlet_city),
              state: toStringField(raw.outlet_state),
              postalCode: toStringField(raw.outlet_zip_code)
            }
          : undefined;
      if (physicalAddress) observe(locationFieldPath("physicalAddress"), physicalAddress);

      // Permit-issue and first-sales dates are preserved as evidence only --
      // never mapped onto company.startYear, which would fabricate a
      // founding-year claim this source does not support.
      if (raw.outlet_permit_issue_date) {
        observe(locationFieldPath("permitIssueDate"), raw.outlet_permit_issue_date, undefined, toStringField(raw.outlet_permit_issue_date));
      }
      if (raw.outlet_first_sales_date) {
        observe(locationFieldPath("firstSalesDate"), raw.outlet_first_sales_date, undefined, toStringField(raw.outlet_first_sales_date));
      }

      // Source signals only -- never a business classification. The BWI
      // retrieval + entity-resolution policy downstream make the final call.
      const nameDiffers = Boolean(
        outletName && taxpayerName && normalizeCompanyName(outletName) !== normalizeCompanyName(taxpayerName)
      );
      const outletCount = taxpayerOutletCounts.get(taxpayerNumber) ?? 1;
      const multiOutlet = outletCount > 1;

      const evidence: string[] = [
        `Texas Comptroller sales-tax permit outlet observation (official Socrata API, dataset ${TX_SALES_TAX_PERMITS_DATASET_ID})`
      ];
      if (nameDiffers) evidence.push("taxpayer name differs from outlet name (source signal only, not a business classification)");
      if (multiOutlet) {
        evidence.push(
          `taxpayer has ${outletCount} outlets within this local snapshot (source signal only, not an automatic branch classification)`
        );
      }

      const candidate: LocationCandidateDraft = {
        sourceUrl: observation.source_url,
        capturedAt: observation.fetched_at,
        company: {
          legalName
          // sicCode intentionally left undefined -- see naicsCode evidence above.
        },
        physicalAddress,
        // Raw county code, not a resolved county name -- no name-mapping
        // table is asserted here (see src/sources/tx-sales-tax-permits/query.ts's
        // DFW_COUNTY_NAMES note: documentation only, never a final mapping).
        county: toStringField(raw.outlet_county_code),
        contacts: [],
        evidence,
        fieldEvidence,
        // Untouched original observation (raw record + fetch/query metadata),
        // preserved for audit -- never printed to the terminal by this
        // adapter or the pilot CLI.
        rawSourceData: observation
      };

      return { ok: true, candidate };
    }
  };
}
