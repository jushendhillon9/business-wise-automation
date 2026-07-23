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
    expect(result.candidate.contacts.length).toBe(1);
    expect(result.candidate.contacts[0]).toMatchObject({
      name: "Morgan Ellis",
      title: "Operations Director",
      email: "morgan.ellis@westlinefreight.example",
      phone: undefined
    });
    expect(result.candidate.contacts[0]?.id).toBeTruthy();
  });

  test("attaches field-level evidence for values genuinely present on the source record", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0001",
      data: {
        reportId: "dfw-2026-0001",
        companyName: "Westline Freight Solutions",
        website: "westlinefreight.example",
        sourceUrl: "https://dfwchamber.example/reports/2026/0001",
        contactName: "Morgan Ellis",
        contactEmail: "morgan.ellis@westlinefreight.example",
        publishedAt: "2026-07-14T09:00:00.000Z"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fieldEvidence = result.candidate.fieldEvidence ?? [];
    expect(fieldEvidence.length).toBeGreaterThan(0);
    for (const item of fieldEvidence) {
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
      expect(item.source.sourceType).toBe("chamber_of_commerce");
      expect(item.source.sourceUrl).toBe("https://dfwchamber.example/reports/2026/0001");
      // this fixture supplies a captured time, so it must be carried through, never fabricated separately
      expect(item.capturedAt).toBe("2026-07-14T09:00:00.000Z");
    }

    const contactId = result.candidate.contacts[0]?.id;
    const contactNameEvidence = fieldEvidence.find((e) => e.path.scope === "contact" && e.path.contactId === contactId && e.path.field === "name");
    expect(contactNameEvidence?.value).toBe("Morgan Ellis");
  });

  test("does not fabricate a capturedAt for field evidence when the source gives no publish time", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0002",
      data: { reportId: "dfw-2026-0002", companyName: "Trinity Grove Bakery Co" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fieldEvidence = result.candidate.fieldEvidence ?? [];
    expect(fieldEvidence.length).toBeGreaterThan(0);
    for (const item of fieldEvidence) {
      expect(item.capturedAt).toBeUndefined();
    }
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

  test("maps a recognized siteTypeCode via the centralized BWI normalizer, preserving the raw code", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0099",
      data: { reportId: "dfw-2026-0099", companyName: "Test Co", siteTypeCode: "H" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.siteType).toBe("headquarters");
    expect(result.candidate.rawSiteTypeCode).toBe("H");
  });

  test("an unrecognized siteTypeCode does not crash ingestion and is preserved as unknown", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0098",
      data: { reportId: "dfw-2026-0098", companyName: "Test Co", siteTypeCode: "Q" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.siteType).toBe("unknown");
    expect(result.candidate.rawSiteTypeCode).toBe("Q");
  });

  test("a record with no siteTypeCode leaves siteType/rawSiteTypeCode undefined", () => {
    const adapter = createDfwJsonAdapter();
    const result = adapter.toCandidate({
      recordId: "dfw-2026-0097",
      data: { reportId: "dfw-2026-0097", companyName: "Test Co" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.siteType).toBeUndefined();
    expect(result.candidate.rawSiteTypeCode).toBeUndefined();
  });
});
