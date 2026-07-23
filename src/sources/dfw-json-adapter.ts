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
import type { LocationCandidateDraft, MappingResult, RawSourceRecord, SourceAdapter } from "./types.ts";

const DEFAULT_FIXTURE_PATH = "data/sources/dfw-json-sample.json";
const SOURCE_ID = "dfw-json";
const SOURCE_NAME = "DFW Chamber Discovery Feed (JSON)";

/**
 * Local fixture adapter standing in for a future DFW chamber/business-journal
 * style JSON export. Proves the SourceAdapter shape until Emily's real feed
 * is available. Maps each raw row into one provisional CompanyIdentity +
 * LocationCandidate — the ingestion engine (source-agnostic) has no idea
 * this is DFW-specific JSON.
 */
export function createDfwJsonAdapter(filePath: string = DEFAULT_FIXTURE_PATH): SourceAdapter {
  return {
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,

    async fetch(): Promise<RawSourceRecord[]> {
      const text = await Bun.file(filePath).text();
      const rows = JSON.parse(text) as Array<Record<string, unknown>>;
      return rows.map((data) => ({
        recordId: typeof data.reportId === "string" ? data.reportId : undefined,
        data
      }));
    },

    toCandidate(record: RawSourceRecord): MappingResult {
      const data = record.data;
      const companyName = typeof data.companyName === "string" ? data.companyName.trim() : "";

      if (!companyName) {
        return { ok: false, reason: "missing companyName" };
      }

      const evidence = ["DFW chamber discovery feed"];
      if (typeof data.website === "string" && data.website) evidence.push("company website");
      if (typeof data.sourceUrl === "string" && data.sourceUrl) evidence.push("chamber report URL");

      const sourceUrl = typeof data.sourceUrl === "string" ? data.sourceUrl : undefined;
      const capturedAt = typeof data.publishedAt === "string" ? data.publishedAt : undefined;

      const fieldSource: FieldEvidenceSource = {
        sourceType: "chamber_of_commerce",
        sourceId: SOURCE_ID,
        sourceName: SOURCE_NAME,
        sourceUrl,
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

      observe(companyFieldPath("legalName"), companyName, data.companyName);
      if (typeof data.website === "string" && data.website) observe(companyFieldPath("website"), data.website);

      const contacts: Contact[] = [];
      if (typeof data.contactName === "string" && data.contactName) {
        const contactId = crypto.randomUUID();
        contacts.push({
          id: contactId,
          name: data.contactName,
          title: typeof data.contactTitle === "string" ? data.contactTitle : undefined,
          email: typeof data.contactEmail === "string" ? data.contactEmail : undefined,
          phone: typeof data.contactPhone === "string" ? data.contactPhone : undefined
        });
        observe(contactFieldPath(contactId, "name"), data.contactName);
        if (typeof data.contactEmail === "string" && data.contactEmail) {
          observe(contactFieldPath(contactId, "email"), data.contactEmail);
        }
      }

      const physicalAddress: Address | undefined =
        data.address || data.city || data.state || data.postalCode
          ? {
              street: typeof data.address === "string" ? data.address : undefined,
              city: typeof data.city === "string" ? data.city : undefined,
              state: typeof data.state === "string" ? data.state : undefined,
              postalCode: typeof data.postalCode === "string" ? data.postalCode : undefined
            }
          : undefined;
      if (physicalAddress) observe(locationFieldPath("physicalAddress"), physicalAddress);
      if (typeof data.phone === "string" && data.phone) observe(locationFieldPath("phone"), data.phone);

      // Raw BWI-style site-type code (S/H/B/R/U), when the source provides one. Uses the
      // centralized normalizer rather than comparing the code ad hoc -- see src/bwi-codes.ts.
      let siteType: SiteType | undefined;
      let rawSiteTypeCode: string | undefined;
      if (typeof data.siteTypeCode === "string") {
        const result = normalizeBwiSiteType(data.siteTypeCode);
        siteType = result.normalized;
        rawSiteTypeCode = result.rawCode;
        observe(locationFieldPath("siteType"), siteType, rawSiteTypeCode);
      }

      const employeeSizeSite = typeof data.employeeCount === "number" ? asEstimate(data.employeeCount) : undefined;
      if (employeeSizeSite) observe(locationFieldPath("employeeSizeSite"), employeeSizeSite, data.employeeCount);

      const candidate: LocationCandidateDraft = {
        sourceUrl,
        capturedAt: capturedAt ?? new Date().toISOString(),
        company: {
          legalName: companyName,
          website: typeof data.website === "string" ? data.website : undefined
        },
        physicalAddress,
        phone: typeof data.phone === "string" ? data.phone : undefined,
        market: "DFW",
        siteType,
        rawSiteTypeCode,
        employeeSizeSite,
        description: typeof data.notes === "string" ? data.notes : undefined,
        contacts,
        evidence,
        fieldEvidence,
        rawSourceData: data
      };

      return { ok: true, candidate };
    }
  };
}
