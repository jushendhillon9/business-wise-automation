import { describe, expect, test } from "bun:test";
import { createDfwCsvAdapter } from "./dfw-csv-adapter.ts";

describe("dfw csv adapter", () => {
  test("maps a full CSV row into company + location drafts", () => {
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
    expect(result.candidate.company.legalName).toBe("Ridgeline Precision Machining");
    expect(result.candidate.company.website).toBe("ridgelineprecision.example");
    expect(result.candidate.physicalAddress?.city).toBe("Carrollton");
    expect(result.candidate.employeeSizeSite?.estimate).toBe(34);
    expect(result.candidate.market).toBe("DFW");
    expect(result.candidate.contacts.length).toBe(1);
    expect(result.candidate.contacts[0]).toMatchObject({
      name: "Dana Whitfield",
      email: "dana.whitfield@ridgelineprecision.example",
      phone: undefined
    });
    expect(result.candidate.contacts[0]?.id).toBeTruthy();
  });

  test("attaches field-level evidence for values genuinely present on the source row", () => {
    const adapter = createDfwCsvAdapter();
    const result = adapter.toCandidate({
      recordId: "DCL-88231",
      data: {
        license_id: "DCL-88231",
        business_name: "Ridgeline Precision Machining",
        website: "ridgelineprecision.example",
        city: "Carrollton",
        state: "TX",
        phone: "972-555-0161",
        contact_name: "Dana Whitfield",
        contact_email: "dana.whitfield@ridgelineprecision.example"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fieldEvidence = result.candidate.fieldEvidence ?? [];
    expect(fieldEvidence.length).toBeGreaterThan(0);
    for (const item of fieldEvidence) {
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
      expect(item.source.sourceType).toBe("county_business_license");
      expect(item.source.sourceId).toBe("dfw-csv");
    }

    const companyNameEvidence = fieldEvidence.find((e) => e.path.scope === "company" && e.path.field === "legalName");
    expect(companyNameEvidence?.value).toBe("Ridgeline Precision Machining");

    const contactId = result.candidate.contacts[0]?.id;
    const contactEmailEvidence = fieldEvidence.find((e) => e.path.scope === "contact" && e.path.contactId === contactId && e.path.field === "email");
    expect(contactEmailEvidence?.value).toBe("dana.whitfield@ridgelineprecision.example");
  });

  test("does not fabricate evidence for fields absent from the source row", () => {
    const adapter = createDfwCsvAdapter();
    const result = adapter.toCandidate({
      recordId: "DCL-88240",
      data: { license_id: "DCL-88240", business_name: "Sparse Co" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fields = (result.candidate.fieldEvidence ?? []).map((e) => e.path.field);
    expect(fields).toEqual(["legalName"]);
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

  test("maps a lowercase site_type_code via the centralized BWI normalizer, preserving the raw code", () => {
    const adapter = createDfwCsvAdapter();
    const result = adapter.toCandidate({
      recordId: "DCL-99999",
      data: { license_id: "DCL-99999", business_name: "Test Co", site_type_code: "b" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.siteType).toBe("branch");
    expect(result.candidate.rawSiteTypeCode).toBe("b");
  });

  test("a row with no site_type_code column value leaves siteType/rawSiteTypeCode undefined", () => {
    const adapter = createDfwCsvAdapter();
    const result = adapter.toCandidate({
      recordId: "DCL-99998",
      data: { license_id: "DCL-99998", business_name: "Test Co" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.siteType).toBeUndefined();
    expect(result.candidate.rawSiteTypeCode).toBeUndefined();
  });
});
