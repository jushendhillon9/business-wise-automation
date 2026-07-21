import { describe, expect, test } from "bun:test";
import { createDfwCsvAdapter } from "./dfw-csv-adapter.ts";

describe("dfw csv adapter", () => {
  test("maps a full CSV row into a candidate draft", () => {
    const adapter = createDfwCsvAdapter();
    const result = adapter.toCandidate({
      recordId: "DCL-88231",
      data: {
        license_id: "DCL-88231",
        business_name: "Ridgeline Precision Machining",
        address: "1180 Enterprise Dr",
        city: "Carrollton",
        state: "TX",
        zip: "75006",
        phone: "972-555-0161",
        website: "ridgelineprecision.example",
        employees: "34",
        issued_date: "2026-06-02",
        contact_name: "Dana Whitfield",
        contact_email: "dana.whitfield@ridgelineprecision.example"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.companyName).toBe("Ridgeline Precision Machining");
    expect(result.candidate.employeeCountEstimate).toBe(34);
    expect(result.candidate.sourceRecordId).toBe("DCL-88231");
    expect(result.candidate.contacts).toEqual([
      { name: "Dana Whitfield", email: "dana.whitfield@ridgelineprecision.example", phone: undefined }
    ]);
  });

  test("rejects a row with no business name", () => {
    const adapter = createDfwCsvAdapter();
    const result = adapter.toCandidate({
      recordId: "DCL-88236",
      data: { license_id: "DCL-88236", business_name: "", city: "Dallas", state: "TX" }
    });

    expect(result.ok).toBe(false);
  });

  test("a row with no contact columns produces no contacts", () => {
    const adapter = createDfwCsvAdapter();
    const result = adapter.toCandidate({
      recordId: "DCL-88233",
      data: { license_id: "DCL-88233", business_name: "Summit Peak Electrical Services", city: "North Richland Hills", state: "TX" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts).toEqual([]);
  });

  test("fetch parses the fixture CSV, including quoted fields", async () => {
    const adapter = createDfwCsvAdapter();
    const rows = await adapter.fetch();
    expect(rows.length).toBe(6);
    expect(rows[0]?.data.business_name).toBe("Ridgeline Precision Machining");
  });

  test("a malformed row does not crash the whole fetch/mapping pass", async () => {
    const adapter = createDfwCsvAdapter();
    const rows = await adapter.fetch();
    const results = rows.map((row) => adapter.toCandidate(row));
    expect(results.some((r) => !r.ok)).toBe(true);
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(0);
  });
});
