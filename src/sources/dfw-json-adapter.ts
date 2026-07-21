import { asEstimate, type Address, type Contact } from "../types.ts";
import type { LocationCandidateDraft, MappingResult, RawSourceRecord, SourceAdapter } from "./types.ts";

const DEFAULT_FIXTURE_PATH = "data/sources/dfw-json-sample.json";

/**
 * Local fixture adapter standing in for a future DFW chamber/business-journal
 * style JSON export. Proves the SourceAdapter shape until Emily's real feed
 * is available. Maps each raw row into one provisional CompanyIdentity +
 * LocationCandidate — the ingestion engine (source-agnostic) has no idea
 * this is DFW-specific JSON.
 */
export function createDfwJsonAdapter(filePath: string = DEFAULT_FIXTURE_PATH): SourceAdapter {
  return {
    sourceId: "dfw-json",
    sourceName: "DFW Chamber Discovery Feed (JSON)",

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

      const contacts: Contact[] = [];
      if (typeof data.contactName === "string" && data.contactName) {
        contacts.push({
          name: data.contactName,
          title: typeof data.contactTitle === "string" ? data.contactTitle : undefined,
          email: typeof data.contactEmail === "string" ? data.contactEmail : undefined,
          phone: typeof data.contactPhone === "string" ? data.contactPhone : undefined
        });
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

      const candidate: LocationCandidateDraft = {
        sourceUrl: typeof data.sourceUrl === "string" ? data.sourceUrl : undefined,
        capturedAt: typeof data.publishedAt === "string" ? data.publishedAt : new Date().toISOString(),
        company: {
          legalName: companyName,
          website: typeof data.website === "string" ? data.website : undefined
        },
        physicalAddress,
        phone: typeof data.phone === "string" ? data.phone : undefined,
        market: "DFW",
        employeeSizeSite: typeof data.employeeCount === "number" ? asEstimate(data.employeeCount) : undefined,
        description: typeof data.notes === "string" ? data.notes : undefined,
        contacts,
        evidence,
        rawSourceData: data
      };

      return { ok: true, candidate };
    }
  };
}
