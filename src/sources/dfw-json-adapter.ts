import type { CandidateDraft, MappingResult, RawSourceRecord, SourceAdapter } from "./types.ts";

const DEFAULT_FIXTURE_PATH = "data/sources/dfw-json-sample.json";

/**
 * Local fixture adapter standing in for a future DFW chamber/business-journal
 * style JSON export. Proves the SourceAdapter shape until Emily's real feed
 * is available.
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

      const candidate: CandidateDraft = {
        sourceUrl: typeof data.sourceUrl === "string" ? data.sourceUrl : undefined,
        sourceRecordId: record.recordId,
        capturedAt: typeof data.publishedAt === "string" ? data.publishedAt : new Date().toISOString(),
        companyName,
        address: typeof data.address === "string" ? data.address : undefined,
        city: typeof data.city === "string" ? data.city : undefined,
        state: typeof data.state === "string" ? data.state : undefined,
        postalCode: typeof data.postalCode === "string" ? data.postalCode : undefined,
        phone: typeof data.phone === "string" ? data.phone : undefined,
        website: typeof data.website === "string" ? data.website : undefined,
        employeeCountEstimate: typeof data.employeeCount === "number" ? data.employeeCount : undefined,
        description: typeof data.notes === "string" ? data.notes : undefined,
        evidence,
        rawSourceData: data
      };

      return { ok: true, candidate };
    }
  };
}
