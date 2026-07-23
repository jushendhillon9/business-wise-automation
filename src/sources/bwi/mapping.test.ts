import { describe, expect, test } from "bun:test";
import { BWI_CANONICAL_IMPORT_CONFIDENCE, mapRawBwiRecordToExistingLocation, type BwiMappingContext } from "./mapping.ts";
import type { RawBwiDirectoryRecord } from "./types.ts";

const FIXED_CONTEXT: BwiMappingContext = {
  sourceType: "bwi_snapshot",
  sourceId: "bwi-snapshot",
  sourceName: "BWI local read-only snapshot export",
  ingestedAt: "2026-01-01T00:00:00.000Z",
  capturedAt: "2025-12-31T00:00:00.000Z"
};

function raw(overrides: Partial<RawBwiDirectoryRecord> = {}): RawBwiDirectoryRecord {
  return {
    bwiLocationId: "bwi-1",
    companyName: "Acme Logistics LLC",
    address: "1200 Commerce St",
    city: "Dallas",
    state: "TX",
    phone: "214-555-0100",
    website: "https://acmelogistics.example",
    siteTypeCode: "H",
    statusCode: "DIRE",
    ...overrides
  };
}

describe("mapRawBwiRecordToExistingLocation — validation", () => {
  test("a valid row is accepted", () => {
    const result = mapRawBwiRecordToExistingLocation(raw(), FIXED_CONTEXT);
    expect(result.ok).toBe(true);
  });

  test("missing bwiLocationId is rejected", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ bwiLocationId: undefined }), FIXED_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/bwiLocationId/);
  });

  test("missing companyName is rejected", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ companyName: "" }), FIXED_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/companyName/);
    expect(result.rawRecordId).toBe("bwi-1");
  });

  test("a malformed audit date is rejected", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ lastUpdatedAt: "not-a-date" }), FIXED_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/lastUpdatedAt/);
  });

  test("optional fields are tolerated absent", () => {
    const result = mapRawBwiRecordToExistingLocation({ bwiLocationId: "bwi-2", companyName: "Sparse Co" }, FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing.address).toBeUndefined();
    expect(result.existing.phone).toBeUndefined();
    expect(result.existing.siteType).toBeUndefined();
  });

  test("an unknown raw site-type code is preserved, not silently coerced", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ siteTypeCode: "Q" }), FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing.siteType).toBe("unknown");
    expect(result.existing.rawSiteTypeCode).toBe("Q");
    expect(result.unknownSiteTypeCode).toBe("Q");
  });

  test("an unknown raw lifecycle code is preserved, not silently coerced", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ statusCode: "ZZZ" }), FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing.lifecycleStatus).toBe("unknown");
    expect(result.existing.status).toBe("ZZZ");
    expect(result.unknownLifecycleCode).toBe("ZZZ");
  });

  test("a row with no status code at all is not reported as an unknown code", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ statusCode: undefined }), FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing.lifecycleStatus).toBe("unknown");
    expect(result.unknownLifecycleCode).toBeUndefined();
  });
});

describe("mapRawBwiRecordToExistingLocation — raw/normalized mapping", () => {
  test("site type raw code is retained alongside the normalized value", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ siteTypeCode: " h " }), FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing.siteType).toBe("headquarters");
    expect(result.existing.rawSiteTypeCode).toBe(" h ");
  });

  test("lifecycle raw code is retained alongside the normalized value, RDL and RDEL both normalize to research_deleted", () => {
    const rdl = mapRawBwiRecordToExistingLocation(raw({ statusCode: "RDL" }), FIXED_CONTEXT);
    const rdel = mapRawBwiRecordToExistingLocation(raw({ bwiLocationId: "bwi-2", statusCode: "RDEL" }), FIXED_CONTEXT);
    expect(rdl.ok && rdl.existing.status).toBe("RDL");
    expect(rdl.ok && rdl.existing.lifecycleStatus).toBe("research_deleted");
    expect(rdel.ok && rdel.existing.status).toBe("RDEL");
    expect(rdel.ok && rdel.existing.lifecycleStatus).toBe("research_deleted");
  });

  test("known codes normalize correctly", () => {
    const result = mapRawBwiRecordToExistingLocation(raw({ siteTypeCode: "B", statusCode: "DEL" }), FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing.siteType).toBe("branch");
    expect(result.existing.lifecycleStatus).toBe("deleted");
  });
});

describe("mapRawBwiRecordToExistingLocation — field evidence", () => {
  test("field evidence is attached for fields the row genuinely supports, with a valid confidence", () => {
    const result = mapRawBwiRecordToExistingLocation(raw(), FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const evidence = result.existing.fieldEvidence ?? [];
    expect(evidence.length).toBeGreaterThan(0);
    for (const item of evidence) {
      expect(item.confidence).toBe(BWI_CANONICAL_IMPORT_CONFIDENCE);
      expect(item.source.sourceType).toBe("bwi_canonical_snapshot_import");
      expect(item.capturedAt).toBe("2025-12-31T00:00:00.000Z");
    }
  });

  test("no evidence is fabricated for a field the row didn't provide", () => {
    const result = mapRawBwiRecordToExistingLocation({ bwiLocationId: "bwi-3", companyName: "Sparse Co" }, FIXED_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fields = (result.existing.fieldEvidence ?? []).map((e) => e.path.field);
    expect(fields).toEqual(["companyName"]);
  });

  test("live-source evidence uses the live source type", () => {
    const liveContext: BwiMappingContext = { ...FIXED_CONTEXT, sourceType: "bwi_live", sourceId: "bwi-live" };
    const result = mapRawBwiRecordToExistingLocation(raw(), liveContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing.fieldEvidence?.[0]?.source.sourceType).toBe("bwi_canonical_live_import");
  });
});
