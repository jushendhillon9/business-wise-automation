import { describe, expect, test } from "bun:test";
import { createDfwJsonAdapter } from "./dfw-json-adapter.ts";

describe("dfw json adapter", () => {
  test("maps a full record into a candidate draft", () => {
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
        publishedAt: "2026-07-14T09:00:00.000Z"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.companyName).toBe("Westline Freight Solutions");
    expect(result.candidate.city).toBe("Irving");
    expect(result.candidate.employeeCountEstimate).toBe(55);
    expect(result.candidate.sourceRecordId).toBe("dfw-2026-0001");
    expect(result.candidate.rawSourceData).toBeDefined();
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
    expect(result.candidate.employeeCountEstimate).toBeUndefined();
    expect(result.candidate.address).toBeUndefined();
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
