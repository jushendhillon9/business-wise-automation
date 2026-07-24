import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessWiseSnapshotAdapter } from "./business-wise-snapshot-adapter.ts";
import type { LocationCandidate } from "./types.ts";

/**
 * All fixtures here are synthetic and fabricated -- never real production
 * BWI rows (see data/private/bwi/README.md's "never use real rows in tests"
 * rule). Files are written to a throwaway temp directory per test, never
 * under data/private/bwi/.
 */

const RECORDS_HEADER = "bwi_location_id,company_name,alpha_sort,status_code,site_type_code,address,city,state,zip,phone,website,sic\n";
const RELATIONSHIPS_HEADER = "relationship_type,parent_bwi_id,child_bwi_id\n";

function recordRow(fields: {
  id: string;
  name: string;
  status?: string;
  siteType?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  website?: string;
  sic?: string;
}): string {
  return [
    fields.id,
    fields.name,
    fields.name,
    fields.status ?? "DIRE",
    fields.siteType ?? "S",
    fields.address ?? "",
    fields.city ?? "",
    fields.state ?? "",
    fields.zip ?? "",
    fields.phone ?? "",
    fields.website ?? "",
    fields.sic ?? ""
  ].join(",");
}

function syntheticCandidate(overrides: Partial<LocationCandidate> = {}): LocationCandidate {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    company: { id: crypto.randomUUID(), legalName: "Fabricated Test Company" },
    contacts: [],
    evidence: ["synthetic test fixture"],
    source: { sourceId: "test", sourceName: "test", fingerprint: `test:${crypto.randomUUID()}`, ingestedAt: now },
    capturedAt: now,
    ...overrides
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bwi-snapshot-adapter-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function loadAdapter(recordsBody: string, relationshipsBody: string): Promise<BusinessWiseSnapshotAdapter> {
  const recordsPath = join(tempDir, "records.csv");
  const relationshipsPath = join(tempDir, "relationships.csv");
  await Bun.write(recordsPath, RECORDS_HEADER + recordsBody);
  await Bun.write(relationshipsPath, RELATIONSHIPS_HEADER + relationshipsBody);
  return BusinessWiseSnapshotAdapter.load({ recordsPath, relationshipsPath });
}

describe("BusinessWiseSnapshotAdapter", () => {
  test("fails closed with a clear error when the records file is missing", async () => {
    const relationshipsPath = join(tempDir, "relationships.csv");
    await Bun.write(relationshipsPath, RELATIONSHIPS_HEADER);
    await expect(
      BusinessWiseSnapshotAdapter.load({ recordsPath: join(tempDir, "nope.csv"), relationshipsPath })
    ).rejects.toThrow(/not found/);
  });

  test("fails closed on duplicate bwi_location_id values", async () => {
    const body = [
      recordRow({ id: "LOC-1", name: "Acme Co" }),
      recordRow({ id: "LOC-1", name: "Acme Co Duplicate" })
    ].join("\n") + "\n";
    await expect(loadAdapter(body, "")).rejects.toThrow(/duplicate/i);
  });

  test("exact-phone retrieval finds the matching record", async () => {
    const body =
      recordRow({ id: "LOC-1", name: "Phone Match Co", phone: "972-555-0100" }) +
      "\n" +
      recordRow({ id: "LOC-2", name: "Unrelated Co", phone: "972-555-9999" }) +
      "\n";
    const adapter = await loadAdapter(body, "");
    const matches = await adapter.searchPotentialMatches(syntheticCandidate({ phone: "(972) 555-0100" }));
    expect(matches.map((m) => m.id)).toEqual(["LOC-1"]);
  });

  test("exact-domain retrieval finds the matching record", async () => {
    const body =
      recordRow({ id: "LOC-1", name: "Domain Match Co", website: "example-domain-match.test" }) + "\n";
    const adapter = await loadAdapter(body, "");
    const matches = await adapter.searchPotentialMatches(
      syntheticCandidate({ company: { id: "x", legalName: "Different Name", website: "https://www.example-domain-match.test/about" } })
    );
    expect(matches.map((m) => m.id)).toEqual(["LOC-1"]);
  });

  test("ZIP + similar-name retrieval finds a plausible match", async () => {
    const body = recordRow({ id: "LOC-1", name: "Ridgeline Precision Machining Inc", zip: "75006" }) + "\n";
    const adapter = await loadAdapter(body, "");
    const matches = await adapter.searchPotentialMatches(
      syntheticCandidate({
        company: { id: "x", legalName: "Ridgeline Precision Machining" },
        physicalAddress: { postalCode: "75006" }
      })
    );
    expect(matches.map((m) => m.id)).toEqual(["LOC-1"]);
  });

  test("empty-result behavior: no index produces a hit returns an empty array, never an invented match", async () => {
    const body = recordRow({ id: "LOC-1", name: "Some Real-Sounding Co", zip: "75006", phone: "972-555-0100" }) + "\n";
    const adapter = await loadAdapter(body, "");
    const matches = await adapter.searchPotentialMatches(
      syntheticCandidate({ company: { id: "x", legalName: "Zzz Nothing In Common Zzz" } })
    );
    expect(matches).toEqual([]);
  });

  test("candidate results are bounded even when many records share the same signal", async () => {
    const rows: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      rows.push(recordRow({ id: `LOC-${i}`, name: `Shared Name Co ${i}`, phone: "972-555-0100" }));
    }
    const adapter = await loadAdapter(rows.join("\n") + "\n", "");
    const matches = await adapter.searchPotentialMatches(syntheticCandidate({ phone: "972-555-0100" }));
    expect(matches.length).toBeLessThanOrEqual(25);
  });

  test("a parent absent from the records file does not break relationship retrieval", async () => {
    const recordsBody = recordRow({ id: "CHILD-1", name: "Branch Co", phone: "972-555-0200" }) + "\n";
    const relationshipsBody = "HQTR,OUT-OF-STATE-PARENT,CHILD-1\n";
    const adapter = await loadAdapter(recordsBody, relationshipsBody);
    const matches = await adapter.searchPotentialMatches(syntheticCandidate({ phone: "972-555-0200" }));
    expect(matches.map((m) => m.id)).toEqual(["CHILD-1"]);
    expect(adapter.getParentId("CHILD-1")).toBe("OUT-OF-STATE-PARENT");
  });

  test("one parent with multiple children is retrievable both ways", async () => {
    const recordsBody =
      recordRow({ id: "PARENT-1", name: "HQ Co" }) + "\n" +
      recordRow({ id: "CHILD-1", name: "Branch One" }) + "\n" +
      recordRow({ id: "CHILD-2", name: "Branch Two" }) + "\n";
    const relationshipsBody = "HQTR,PARENT-1,CHILD-1\nHQTR,PARENT-1,CHILD-2\n";
    const adapter = await loadAdapter(recordsBody, relationshipsBody);
    expect(adapter.getChildIds("PARENT-1").sort()).toEqual(["CHILD-1", "CHILD-2"]);
  });

  test("preserves raw status and site-type codes on returned ExistingCompany rows", async () => {
    const body = recordRow({ id: "LOC-1", name: "Keep Status Co", status: "KEEP", siteType: "R", phone: "972-555-0300" }) + "\n";
    const adapter = await loadAdapter(body, "");
    const matches = await adapter.searchPotentialMatches(syntheticCandidate({ phone: "972-555-0300" }));
    expect(matches[0]?.status).toBe("KEEP");
  });

  test("AFFL and HQTR relationship types are both loaded", async () => {
    const recordsBody = recordRow({ id: "A", name: "A Co" }) + "\n" + recordRow({ id: "B", name: "B Co" }) + "\n" + recordRow({ id: "C", name: "C Co" }) + "\n";
    const relationshipsBody = "HQTR,A,B\nAFFL,A,C\n";
    const adapter = await loadAdapter(recordsBody, relationshipsBody);
    const counts = adapter.getRelationshipTypeCounts();
    expect(counts.HQTR).toBe(1);
    expect(counts.AFFL).toBe(1);
  });

  test("getRelationshipTypesForRecord reports which relationship types a record participates in, as either parent or child", async () => {
    const recordsBody = recordRow({ id: "A", name: "A Co" }) + "\n" + recordRow({ id: "B", name: "B Co" }) + "\n" + recordRow({ id: "C", name: "C Co" }) + "\n";
    const relationshipsBody = "HQTR,A,B\nAFFL,A,C\n";
    const adapter = await loadAdapter(recordsBody, relationshipsBody);
    expect(adapter.getRelationshipTypesForRecord("A").sort()).toEqual(["AFFL", "HQTR"]);
    expect(adapter.getRelationshipTypesForRecord("B")).toEqual(["HQTR"]);
    expect(adapter.getRelationshipTypesForRecord("C")).toEqual(["AFFL"]);
    expect(adapter.getRelationshipTypesForRecord("NO-SUCH-RECORD")).toEqual([]);
  });

  test("reports aggregate load stats without exposing individual rows", async () => {
    const body = recordRow({ id: "LOC-1", name: "Co One" }) + "\n" + recordRow({ id: "LOC-2", name: "Co Two" }) + "\n";
    const adapter = await loadAdapter(body, "");
    const stats = adapter.getLoadStats();
    expect(stats.recordCount).toBe(2);
    expect(stats.relationshipCount).toBe(0);
    expect(typeof stats.loadDurationMs).toBe("number");
  });

  test("stageApprovedCandidate is not implemented -- adapter never writes anywhere", async () => {
    const body = recordRow({ id: "LOC-1", name: "Co One" }) + "\n";
    const adapter = await loadAdapter(body, "");
    await expect(adapter.stageApprovedCandidate(syntheticCandidate())).rejects.toThrow(/read-only/i);
  });

  test("exposes no other write/publish methods beyond the BusinessWiseAdapter interface", async () => {
    const body = recordRow({ id: "LOC-1", name: "Co One" }) + "\n";
    const adapter = await loadAdapter(body, "");
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
    const suspiciousNames = methodNames.filter((name) => /write|publish|insert|update|delete|save/i.test(name));
    expect(suspiciousNames).toEqual([]);
  });
});
