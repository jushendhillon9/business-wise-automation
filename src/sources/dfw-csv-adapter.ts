import type { Contact } from "../types.ts";
import { parseCsvRecords } from "./csv.ts";
import type { CandidateDraft, MappingResult, RawSourceRecord, SourceAdapter } from "./types.ts";

const DEFAULT_FIXTURE_PATH = "data/sources/dfw-county-licenses-sample.csv";

/**
 * Local fixture adapter standing in for a future county business-license CSV
 * export. Proves the SourceAdapter shape until a real license dataset is
 * wired in.
 */
export function createDfwCsvAdapter(filePath: string = DEFAULT_FIXTURE_PATH): SourceAdapter {
  return {
    sourceId: "dfw-csv",
    sourceName: "DFW County Business License Export (CSV)",

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

      const contacts: Contact[] = [];
      if (data.contact_name || data.contact_email) {
        contacts.push({
          name: data.contact_name || undefined,
          email: data.contact_email || undefined,
          phone: data.contact_phone || undefined
        });
      }

      const candidate: CandidateDraft = {
        sourceRecordId: record.recordId,
        capturedAt: data.issued_date ? new Date(data.issued_date).toISOString() : new Date().toISOString(),
        companyName,
        address: data.address || undefined,
        city: data.city || undefined,
        state: data.state || undefined,
        postalCode: data.zip || undefined,
        phone: data.phone || undefined,
        website: data.website || undefined,
        employeeCountEstimate: data.employees ? Number(data.employees) || undefined : undefined,
        contacts,
        evidence: ["county business license record"],
        rawSourceData: data
      };

      return { ok: true, candidate };
    }
  };
}
