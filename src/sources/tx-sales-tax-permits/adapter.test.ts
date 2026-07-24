import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTxSalesTaxPermitSourceAdapter, TxSalesTaxPermitSourceError } from "./adapter.ts";
import type { TxPermitObservation, TxPermitRawRecord } from "./types.ts";

/** All fixtures are fabricated -- no real API rows. */
function observation(raw: TxPermitRawRecord, overrides: Partial<TxPermitObservation> = {}): TxPermitObservation {
  return {
    source_dataset_id: "jrea-zgmq",
    source_record_id: `${raw.taxpayer_number}:${raw.outlet_number}`,
    fetched_at: "2026-07-24T12:00:00.000Z",
    query_window_start: "2026-07-17",
    query_window_end: "2026-07-24",
    requested_counties: ["043", "057", "061", "220"],
    source_url: "https://data.texas.gov/api/v3/views/jrea-zgmq/query.json",
    raw,
    ...overrides
  };
}

function fakeRow(overrides: Partial<TxPermitRawRecord> = {}): TxPermitRawRecord {
  return {
    outlet_name: "Fabricated Diner",
    taxpayer_name: "Fabricated Diner Holdings LLC",
    taxpayer_number: "1000000001",
    outlet_number: "001",
    outlet_address: "500 Fabricated Ave",
    outlet_city: "Testville",
    outlet_state: "TX",
    outlet_county_code: "057",
    outlet_zip_code: "75001",
    outlet_naics_code: "722511",
    outlet_permit_issue_date: "2026-07-20T00:00:00.000",
    outlet_first_sales_date: "2026-07-21T00:00:00.000",
    taxpayer_organization_type: "LIMITED LIABILITY CO",
    ...overrides
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tx-permits-adapter-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function writeSnapshot(observations: TxPermitObservation[], manifest?: Record<string, unknown>): Promise<string> {
  const ndjson = observations.map((o) => JSON.stringify(o)).join("\n") + (observations.length > 0 ? "\n" : "");
  await Bun.write(join(tempDir, "raw.ndjson"), ndjson);
  if (manifest) {
    await Bun.write(join(tempDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  return tempDir;
}

describe("createTxSalesTaxPermitSourceAdapter -- fetch()", () => {
  test("fails clearly when the source directory does not exist", async () => {
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: join(tempDir, "does-not-exist") });
    await expect(adapter.fetch()).rejects.toThrow(TxSalesTaxPermitSourceError);
  });

  test("fails clearly when raw.ndjson is missing", async () => {
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: tempDir });
    await expect(adapter.fetch()).rejects.toThrow(/missing/);
  });

  test("fails clearly on an invalid JSON line", async () => {
    await Bun.write(join(tempDir, "raw.ndjson"), '{"not valid json"\n');
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: tempDir });
    await expect(adapter.fetch()).rejects.toThrow(/not valid JSON/);
  });

  test("fails clearly when required identity fields are absent, rather than silently skipping the row", async () => {
    const dir = await writeSnapshot([observation(fakeRow({ taxpayer_number: undefined }))]);
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    await expect(adapter.fetch()).rejects.toThrow(/required identity field/);
  });

  test("fails clearly on duplicate source_record_id values", async () => {
    const dir = await writeSnapshot([observation(fakeRow()), observation(fakeRow())]);
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    await expect(adapter.fetch()).rejects.toThrow(/duplicate source_record_id/);
  });

  test("fails clearly when manifest.json row_count disagrees with the raw file", async () => {
    const dir = await writeSnapshot([observation(fakeRow())], { row_count: 5 });
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    await expect(adapter.fetch()).rejects.toThrow(/manifest.json reports row_count/);
  });

  test("succeeds when manifest.json row_count agrees with the raw file", async () => {
    const dir = await writeSnapshot([observation(fakeRow())], { row_count: 1 });
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    const rows = await adapter.fetch();
    expect(rows).toHaveLength(1);
  });

  test("manifest.json is optional -- fetch succeeds without one", async () => {
    const dir = await writeSnapshot([observation(fakeRow())]);
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    const rows = await adapter.fetch();
    expect(rows).toHaveLength(1);
  });

  test("parses NDJSON into one RawSourceRecord per line, keyed by source_record_id", async () => {
    const dir = await writeSnapshot([
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1" }))
    ]);
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    const rows = await adapter.fetch();
    expect(rows.map((r) => r.recordId)).toEqual(["1:1", "2:1"]);
  });

  test("respects a --limit option, applied after full-snapshot validation", async () => {
    const dir = await writeSnapshot([
      observation(fakeRow({ taxpayer_number: "1", outlet_number: "1" })),
      observation(fakeRow({ taxpayer_number: "2", outlet_number: "1" })),
      observation(fakeRow({ taxpayer_number: "3", outlet_number: "1" }))
    ]);
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir, limit: 2 });
    const rows = await adapter.fetch();
    expect(rows).toHaveLength(2);
  });

  test("source snapshot idempotency: fetching the same snapshot twice returns the same identities", async () => {
    const dir = await writeSnapshot([observation(fakeRow({ taxpayer_number: "1", outlet_number: "1" }))]);
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    const first = await adapter.fetch();
    const second = await adapter.fetch();
    expect(first.map((r) => r.recordId)).toEqual(second.map((r) => r.recordId));
  });
});

describe("createTxSalesTaxPermitSourceAdapter -- toCandidate()", () => {
  async function fetchOne(raw: TxPermitRawRecord, allRaws: TxPermitRawRecord[] = [raw]) {
    const dir = await writeSnapshot(allRaws.map((r) => observation(r)));
    const adapter = createTxSalesTaxPermitSourceAdapter({ sourceDir: dir });
    const rows = await adapter.fetch();
    const target = rows.find((r) => r.recordId === `${raw.taxpayer_number}:${raw.outlet_number}`)!;
    return adapter.toCandidate(target);
  }

  test("prefers outlet_name over taxpayer_name for the operating display name", async () => {
    const result = await fetchOne(fakeRow({ outlet_name: "Outlet Display Name", taxpayer_name: "Taxpayer Legal Name" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.company.legalName).toBe("Outlet Display Name");
  });

  test("falls back to taxpayer_name when outlet_name is missing", async () => {
    const result = await fetchOne(fakeRow({ outlet_name: undefined, taxpayer_name: "Taxpayer Legal Name" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.company.legalName).toBe("Taxpayer Legal Name");
  });

  test("both names are preserved -- taxpayer_name survives as its own field evidence even when outlet_name is used as legalName", async () => {
    const result = await fetchOne(fakeRow({ outlet_name: "Outlet Display Name", taxpayer_name: "Taxpayer Legal Name" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const taxpayerNameEvidence = result.candidate.fieldEvidence?.find(
      (e) => e.path.scope === "company" && e.path.field === "taxpayerName"
    );
    expect(taxpayerNameEvidence?.value).toBe("Taxpayer Legal Name");
    expect(result.candidate.company.legalName).toBe("Outlet Display Name");
  });

  test("legal/trade-name difference is preserved and auditable via a descriptive evidence string", async () => {
    const result = await fetchOne(fakeRow({ outlet_name: "Outlet Display Name", taxpayer_name: "Totally Different Legal Name" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.evidence.some((e) => e.includes("taxpayer name differs from outlet name"))).toBe(true);
  });

  test("preserves leading zeros in taxpayer/outlet identifiers", async () => {
    const result = await fetchOne(fakeRow({ taxpayer_number: "00012345", outlet_number: "007" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const taxpayerNumberEvidence = result.candidate.rawSourceData as TxPermitObservation;
    expect(taxpayerNumberEvidence.raw.taxpayer_number).toBe("00012345");
    expect(taxpayerNumberEvidence.raw.outlet_number).toBe("007");
  });

  test("maps outlet address/city/state/ZIP into physicalAddress", async () => {
    const result = await fetchOne(fakeRow({ outlet_address: "1 Fabricated Way", outlet_city: "Testville", outlet_state: "TX", outlet_zip_code: "75002" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.physicalAddress).toEqual({
      street: "1 Fabricated Way",
      city: "Testville",
      state: "TX",
      postalCode: "75002"
    });
  });

  test("NAICS is preserved as evidence but never placed into company.sicCode", async () => {
    const result = await fetchOne(fakeRow({ outlet_naics_code: "445110" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.company.sicCode).toBeUndefined();
    const naicsEvidence = result.candidate.fieldEvidence?.find((e) => e.path.scope === "company" && e.path.field === "naicsCode");
    expect(naicsEvidence?.value).toBe("445110");
  });

  test("permit-issue and first-sales dates are preserved as evidence but never mapped to company.startYear", async () => {
    const result = await fetchOne(fakeRow({ outlet_permit_issue_date: "2026-07-20T00:00:00.000", outlet_first_sales_date: "2026-07-21T00:00:00.000" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.company.startYear).toBeUndefined();
    const permitEvidence = result.candidate.fieldEvidence?.find((e) => e.path.scope === "location" && e.path.field === "permitIssueDate");
    const firstSalesEvidence = result.candidate.fieldEvidence?.find((e) => e.path.scope === "location" && e.path.field === "firstSalesDate");
    expect(permitEvidence?.value).toBe("2026-07-20T00:00:00.000");
    expect(firstSalesEvidence?.value).toBe("2026-07-21T00:00:00.000");
  });

  test("unsupported fields (phone, website, contacts, employee count, revenue, building type, total sites) remain undefined -- never fabricated", async () => {
    const result = await fetchOne(fakeRow());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.phone).toBeUndefined();
    expect(result.candidate.company.website).toBeUndefined();
    expect(result.candidate.contacts).toEqual([]);
    expect(result.candidate.employeeSizeSite).toBeUndefined();
    expect(result.candidate.estimatedAnnualRevenue).toBeUndefined();
    expect(result.candidate.buildingType).toBeUndefined();
    expect(result.candidate.totalSites).toBeUndefined();
  });

  test("a multi-outlet taxpayer is flagged as source metadata but never automatically classified as a branch", async () => {
    const rows = [
      fakeRow({ taxpayer_number: "5", outlet_number: "1" }),
      fakeRow({ taxpayer_number: "5", outlet_number: "2" })
    ];
    const result = await fetchOne(rows[0]!, rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.evidence.some((e) => e.includes("2 outlets"))).toBe(true);
    expect(result.candidate.siteType).toBeUndefined();
  });

  test("no site type is ever fabricated for a single-outlet taxpayer either", async () => {
    const result = await fetchOne(fakeRow());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.siteType).toBeUndefined();
    expect(result.candidate.rawSiteTypeCode).toBeUndefined();
  });

  test("field evidence is attached only for fields the source actually supports", async () => {
    const result = await fetchOne(
      fakeRow({
        outlet_address: undefined,
        outlet_city: undefined,
        outlet_state: undefined,
        outlet_zip_code: undefined,
        outlet_naics_code: undefined,
        outlet_permit_issue_date: undefined,
        outlet_first_sales_date: undefined,
        taxpayer_organization_type: undefined,
        taxpayer_name: undefined
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fields = (result.candidate.fieldEvidence ?? []).map((e) => `${e.path.scope}.${e.path.field}`);
    expect(fields).toEqual(["company.legalName"]);
  });

  test("field evidence never claims human confirmation and uses the existing single-source-observed confidence convention", async () => {
    const result = await fetchOne(fakeRow());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const item of result.candidate.fieldEvidence ?? []) {
      expect(item.derivation).toBe("directly_observed");
      expect(item.confidence).toBeGreaterThan(0);
      expect(item.confidence).toBeLessThan(1);
      expect(item.source.sourceType).toBe("state_sales_tax_permit");
    }
  });

  test("the raw observation is preserved unchanged in rawSourceData", async () => {
    const raw = fakeRow({ outlet_address: "  1 Fabricated Way  " });
    const result = await fetchOne(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preserved = (result.candidate.rawSourceData as TxPermitObservation).raw;
    expect(preserved.outlet_address).toBe("  1 Fabricated Way  ");
  });

  test("rejects a row missing both outlet_name and taxpayer_name", async () => {
    const result = await fetchOne(fakeRow({ outlet_name: undefined, taxpayer_name: undefined }));
    expect(result.ok).toBe(false);
  });
});
