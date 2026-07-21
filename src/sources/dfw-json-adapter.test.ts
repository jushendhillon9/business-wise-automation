import { describe, expect, test } from "bun:test";
import { createDfwJsonAdapter } from "./dfw-json-adapter.ts";

describe("dfw json adapter", () => {
  test("maps a full record into company + location drafts", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0001",
      data: {
        reportId: "dfw-2026-0001",
        companyName: "Westline Freight Solutions",
        address: "4500 Regent Blvd",
        city: "Irving",
        state: "TX",
        postalCode: "75063",
        phone: "972-555-0133",
        website: "westlinefreight.example",
        employeeCount: 55,
        sourceUrl: "https://dfwchamber.example/reports/2026/0001",
        contactName: "Morgan Ellis",
        contactTitle: "Operations Director",
        contactEmail: "morgan.ellis@westlinefreight.example",
        publishedAt: "2026-07-14T09:00:00.000Z"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // company-level fields land on candidate.company
    expect(result.candidate.company.legalName).toBe("Westline Freight Solutions");
    expect(result.candidate.company.website).toBe("westlinefreight.example");
    // location-level fields land on the candidate itself
    expect(result.candidate.physicalAddress?.city).toBe("Irving");
    expect(result.candidate.employeeSizeSite?.estimate).toBe(55);
    expect(result.candidate.market).toBe("DFW");
    expect(result.candidate.sourceUrl).toBe("https://dfwchamber.example/reports/2026/0001");
    expect(result.candidate.rawSourceData).toBeDefined();
    expect(result.candidate.contacts).toEqual([
      { name: "Morgan Ellis", title: "Operations Director", email: "morgan.ellis@westlinefreight.example", phone: undefined }
    ]);
  });

  test("keeps optional fields optional for a sparse record", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0002",
      data: { reportId: "dfw-2026-0002", companyName: "Trinity Grove Bakery Co", city: "Grapevine", state: "TX" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.phone).toBeUndefined();
    expect(result.candidate.employeeSizeSite).toBeUndefined();
    expect(result.candidate.physicalAddress?.street).toBeUndefined();
    expect(result.candidate.physicalAddress?.city).toBe("Grapevine");
    expect(result.candidate.contacts).toEqual([]);
  });

  test("rejects a record with no company name", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0006",
      data: { reportId: "dfw-2026-0006", companyName: "", city: "Dallas", state: "TX" }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/companyName/);
  });

  test("fetch reads the fixture file and returns every raw row", async () => {
    const adapter = createDfwJsonAdapter();
    const rows = await adapter.fetch();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.recordId).toBe("dfw-2026-0001");
  });
});
