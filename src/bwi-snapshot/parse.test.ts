import { describe, expect, test } from "bun:test";
import { BwiSnapshotHeaderError, normalizeNullish, parseBwiRecordsCsv, parseBwiRelationshipsCsv } from "./parse.ts";

const RECORDS_HEADER =
  "bwi_location_id,company_name,alpha_sort,status_code,status_description,market_id,market_name,market_abbreviation," +
  "site_type_code,site_type_description,address,building_number,street,suite_number,city,state,zip,zip_plus,county," +
  "phone,website,sic,naics,start_year,site_size_code,site_employee_count,company_size_code,number_of_sites," +
  "building_type_code,address_type_code,address_validation_code,latitude,longitude,entered_date,base_date,researched_date";

function recordsCsv(rows: string): string {
  return `${RECORDS_HEADER}\r\n${rows}`;
}

const RELATIONSHIPS_HEADER =
  "relationship_type,relationship_description,parent_bwi_id,parent_company_name,parent_alpha_sort," +
  "parent_is_fortune_1000,parent_city,parent_state,parent_country,parent_stock_ticker,child_bwi_id," +
  "child_company_name,child_status,child_site_type,child_market_id,child_city,child_state";

function relationshipsCsv(rows: string): string {
  return `${RELATIONSHIPS_HEADER}\r\n${rows}`;
}

describe("normalizeNullish", () => {
  test("blank and literal NULL/None become undefined without damaging real text", () => {
    expect(normalizeNullish("")).toBeUndefined();
    expect(normalizeNullish("   ")).toBeUndefined();
    expect(normalizeNullish("NULL")).toBeUndefined();
    expect(normalizeNullish("null")).toBeUndefined();
    expect(normalizeNullish("None")).toBeUndefined();
    expect(normalizeNullish("none")).toBeUndefined();
    expect(normalizeNullish("  Acme Corp  ")).toBe("Acme Corp");
    expect(normalizeNullish("Nonesuch Industries")).toBe("Nonesuch Industries");
  });
});

describe("parseBwiRecordsCsv", () => {
  test("parses by header name regardless of column order", () => {
    const shuffled = "company_name,bwi_location_id,status_code,site_type_code\r\nAcme Testing Co,LOC-1,DIRE,S\r\n";
    const result = parseBwiRecordsCsv(shuffled);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ bwiLocationId: "LOC-1", companyName: "Acme Testing Co", statusCode: "DIRE", siteTypeCode: "S" });
  });

  test("throws BwiSnapshotHeaderError when a required header is missing", () => {
    expect(() => parseBwiRecordsCsv("company_name,status_code\r\nAcme,DIRE\r\n")).toThrow(BwiSnapshotHeaderError);
  });

  test("throws on a completely empty file", () => {
    expect(() => parseBwiRecordsCsv("")).toThrow(BwiSnapshotHeaderError);
  });

  test("handles quoted fields with embedded commas", () => {
    const csv = recordsCsv('LOC-1,"Acme, Inc.",A1,DIRE,Active,,,,S,,"123 Main St, Suite 5",,,,,,,,,,,,,,,,,,,,,,,\r\n');
    const result = parseBwiRecordsCsv(csv);
    expect(result.records[0]?.companyName).toBe("Acme, Inc.");
    expect(result.records[0]?.address).toBe("123 Main St, Suite 5");
  });

  test("handles CRLF line endings between rows", () => {
    const csv = recordsCsv(
      "LOC-1,Acme Co,A1,DIRE,,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,\r\nLOC-2,Beta Co,B1,KEEP,,,,,H,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n"
    );
    const result = parseBwiRecordsCsv(csv);
    expect(result.records).toHaveLength(2);
    expect(result.records[1]?.bwiLocationId).toBe("LOC-2");
  });

  test("preserves whitespace-padded legacy CHAR-style values by trimming, not truncating", () => {
    const csv = recordsCsv("LOC-1,  Acme Co  ,A1,DIRE ,,,,,  S  ,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n");
    const result = parseBwiRecordsCsv(csv);
    expect(result.records[0]?.companyName).toBe("Acme Co");
    expect(result.records[0]?.statusCode).toBe("DIRE");
    expect(result.records[0]?.siteTypeCode).toBe("S");
  });

  test("preserves leading zeros in ZIP/SIC/NAICS/code fields", () => {
    const csv = recordsCsv("LOC-1,Acme Co,A1,DIRE,,,,,S,,,,,,,,07501,,,,,01234,001234,,,,,,,,,,,,,\r\n");
    const result = parseBwiRecordsCsv(csv);
    expect(result.records[0]?.zip).toBe("07501");
    expect(result.records[0]?.sic).toBe("01234");
    expect(result.records[0]?.naics).toBe("001234");
  });

  test("normalizes literal NULL and None strings to undefined without damaging legitimate text", () => {
    const csv = recordsCsv("LOC-1,Acme Co,NULL,DIRE,None,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n");
    const result = parseBwiRecordsCsv(csv);
    expect(result.records[0]?.alphaSort).toBeUndefined();
    expect(result.records[0]?.statusDescription).toBeUndefined();
  });

  test("counts malformed rows (missing a required field) and skips them without throwing", () => {
    const csv = recordsCsv("LOC-1,Acme Co,A1,DIRE,,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n,Missing Id Co,,DIRE,,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n");
    const result = parseBwiRecordsCsv(csv);
    expect(result.records).toHaveLength(1);
    expect(result.malformedCount).toBe(1);
  });

  test("detects duplicate bwi_location_id values", () => {
    const csv = recordsCsv(
      "LOC-1,Acme Co,A1,DIRE,,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,\r\nLOC-1,Acme Co Again,A2,DIRE,,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n"
    );
    const result = parseBwiRecordsCsv(csv);
    expect(result.records).toHaveLength(1);
    expect(result.duplicateIds).toEqual(["LOC-1"]);
    expect(result.duplicateRowCount).toBe(1);
  });

  test("preserves all five lifecycle statuses", () => {
    const statuses = ["DIRE", "KEEP", "RSCH", "RDEL", "DELE"];
    const rows = statuses.map((status, i) => `LOC-${i},Co ${i},A${i},${status},,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,`).join("\r\n");
    const result = parseBwiRecordsCsv(recordsCsv(`${rows}\r\n`));
    expect(result.records.map((r) => r.statusCode)).toEqual(statuses);
  });

  test("preserves all five site types", () => {
    const siteTypes = ["S", "H", "B", "R", "U"];
    const rows = siteTypes.map((site, i) => `LOC-${i},Co ${i},A${i},DIRE,,,,,${site},,,,,,,,,,,,,,,,,,,,,,,,,,`).join("\r\n");
    const result = parseBwiRecordsCsv(recordsCsv(`${rows}\r\n`));
    expect(result.records.map((r) => r.siteTypeCode)).toEqual(siteTypes);
  });
});

describe("parseBwiRelationshipsCsv", () => {
  test("throws BwiSnapshotHeaderError when a required header is missing", () => {
    expect(() => parseBwiRelationshipsCsv("relationship_type,parent_bwi_id\r\nHQTR,LOC-1\r\n")).toThrow(BwiSnapshotHeaderError);
  });

  test("parses AFFL and HQTR relationship types", () => {
    const csv = relationshipsCsv("HQTR,,PARENT-1,Parent Co,,,,,,,CHILD-1,Child Co,DIRE,B,,,\r\nAFFL,,PARENT-2,Other Parent,,,,,,,CHILD-2,Other Child,DIRE,S,,,\r\n");
    const result = parseBwiRelationshipsCsv(csv);
    expect(result.relationships.map((r) => r.relationshipType)).toEqual(["HQTR", "AFFL"]);
  });

  test("allows a parent_bwi_id absent from the records file (parent may have no DFW location row)", () => {
    const csv = relationshipsCsv("HQTR,,OUT-OF-STATE-PARENT,National HQ,,,,,,,CHILD-1,Child Co,DIRE,B,,,\r\n");
    const result = parseBwiRelationshipsCsv(csv);
    expect(result.relationships[0]?.parentBwiId).toBe("OUT-OF-STATE-PARENT");
    expect(result.relationships).toHaveLength(1);
  });

  test("one parent can have multiple children", () => {
    const csv = relationshipsCsv(
      "HQTR,,PARENT-1,Parent Co,,,,,,,CHILD-1,Child One,DIRE,B,,,\r\nHQTR,,PARENT-1,Parent Co,,,,,,,CHILD-2,Child Two,DIRE,B,,,\r\n"
    );
    const result = parseBwiRelationshipsCsv(csv);
    expect(result.relationships.filter((r) => r.parentBwiId === "PARENT-1")).toHaveLength(2);
  });

  test("counts malformed relationship rows and skips them without throwing", () => {
    const csv = relationshipsCsv("HQTR,,PARENT-1,Parent Co,,,,,,,CHILD-1,Child Co,DIRE,B,,,\r\n,,,,,,,,,,,,,,,,\r\n");
    const result = parseBwiRelationshipsCsv(csv);
    expect(result.relationships).toHaveLength(1);
    expect(result.malformedCount).toBe(1);
  });
});
