import { normalizeBwiSiteType } from "../bwi-codes.ts";
import {
  asEstimate,
  companyFieldPath,
  contactFieldPath,
  createFieldEvidence,
  locationFieldPath,
  SINGLE_SOURCE_OBSERVED_CONFIDENCE,
  type Address,
  type Contact,
  type FieldEvidence,
  type FieldEvidenceSource,
  type SiteType
} from "../types.ts";
import { parseCsvRecords } from "./csv.ts";
import type { LocationCandidateDraft, MappingResult, RawSourceRecord, SourceAdapter } from "./types.ts";

const DEFAULT_FIXTURE_PATH = "data/sources/dfw-county-licenses-sample.csv";
const SOURCE_ID = "dfw-csv";
const SOURCE_NAME = "DFW County Business License Export (CSV)";

/**
 * Local fixture adapter standing in for a future county business-license CSV
 * export. Proves the SourceAdapter shape until a real license dataset is
 * wired in. Maps each raw row into one provisional CompanyIdentity +
 * LocationCandidate — the ingestion engine (source-agnostic) has no idea
 * this is DFW-specific CSV.
 */
export function createDfwCsvAdapter(filePath: string = DEFAULT_FIXTURE_PATH): SourceAdapter {
  return {
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,

    async fetch(): Promise<RawSourceRecord[]> {
      const text = await Bun.file(filePath).text();
      const rows = parseCsvRecords(text);
      return rows.map((data) => ({
        recordId: data.license_id || undefined,
        data
      }));
    },

    toCandidate(record: RawSourceRecord): MappingResult {
      const data = record.data as Record<string, string>;
      const companyName = (data.business_name ?? "").trim();

      if (!companyName) {
        return { ok: false, reason: "missing business_name" };
      }

      const capturedAt = data.issued_date ? new Date(data.issued_date).toISOString() : undefined;

      const fieldSource: FieldEvidenceSource = {
        sourceType: "county_business_license",
        sourceId: SOURCE_ID,
        sourceName: SOURCE_NAME,
        sourceRecordId: record.recordId
      };

      const fieldEvidence: FieldEvidence[] = [];
      const observe = (path: Parameters<typeof createFieldEvidence>[0]["path"], value: unknown, rawValue?: unknown) => {
        fieldEvidence.push(
          createFieldEvidence({
            path,
            value,
            rawValue: rawValue ?? value,
            confidence: SINGLE_SOURCE_OBSERVED_CONFIDENCE,
            source: fieldSource,
            capturedAt,
            derivation: "directly_observed"
          })
        );
      };

      observe(companyFieldPath("legalName"), companyName, data.business_name);
      if (data.website) observe(companyFieldPath("website"), data.website);

      const contacts: Contact[] = [];
      if (data.contact_name || data.contact_email) {
        const contactId = crypto.randomUUID();
        contacts.push({
          id: contactId,
          name: data.contact_name || undefined,
          email: data.contact_email || undefined,
          phone: data.contact_phone || undefined
        });
        if (data.contact_name) observe(contactFieldPath(contactId, "name"), data.contact_name);
        if (data.contact_email) observe(contactFieldPath(contactId, "email"), data.contact_email);
      }

      const physicalAddress: Address | undefined =
        data.address || data.city || data.state || data.zip
          ? {
              street: data.address || undefined,
              city: data.city || undefined,
              state: data.state || undefined,
              postalCode: data.zip || undefined
            }
          : undefined;
      if (physicalAddress) observe(locationFieldPath("physicalAddress"), physicalAddress);
      if (data.phone) observe(locationFieldPath("phone"), data.phone);

      // Raw BWI-style site-type code (S/H/B/R/U), when the source provides one. Uses the
      // centralized normalizer rather than comparing the code ad hoc -- see src/bwi-codes.ts.
      let siteType: SiteType | undefined;
      let rawSiteTypeCode: string | undefined;
      if (data.site_type_code) {
        const result = normalizeBwiSiteType(data.site_type_code);
        siteType = result.normalized;
        rawSiteTypeCode = result.rawCode;
        observe(locationFieldPath("siteType"), siteType, rawSiteTypeCode);
      }

      const employeeSizeSite = data.employees ? asEstimate(Number(data.employees) || undefined) : undefined;
      if (employeeSizeSite) observe(locationFieldPath("employeeSizeSite"), employeeSizeSite, data.employees);

      const candidate: LocationCandidateDraft = {
        capturedAt: capturedAt ?? new Date().toISOString(),
        company: {
          legalName: companyName,
          website: data.website || undefined
        },
        physicalAddress,
        phone: data.phone || undefined,
        market: "DFW",
        county: data.county || undefined,
        siteType,
        rawSiteTypeCode,
        employeeSizeSite,
        contacts,
        evidence: ["county business license record"],
        fieldEvidence,
        rawSourceData: data
      };

      return { ok: true, candidate };
    }
  };
}
