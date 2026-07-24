import { describe, expect, test } from "bun:test";
import { buildSoqlQuery, DEFAULT_DFW_COUNTY_CODES, parseCountyCodes, resolveQueryWindow } from "./query.ts";

describe("resolveQueryWindow", () => {
  test("defaults to a 7-day lookback window ending today", () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const window = resolveQueryWindow({ now });
    expect(window).toEqual({ start: "2026-07-17", end: "2026-07-24" });
  });

  test("--days overrides the default lookback", () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const window = resolveQueryWindow({ days: 30, now });
    expect(window).toEqual({ start: "2026-06-24", end: "2026-07-24" });
  });

  test("--from/--to together define an explicit window", () => {
    const window = resolveQueryWindow({ from: "2026-01-01", to: "2026-01-15" });
    expect(window).toEqual({ start: "2026-01-01", end: "2026-01-15" });
  });

  test("providing only --from throws a clear error", () => {
    expect(() => resolveQueryWindow({ from: "2026-01-01" })).toThrow(/both be provided together/);
  });

  test("providing only --to throws a clear error", () => {
    expect(() => resolveQueryWindow({ to: "2026-01-15" })).toThrow(/both be provided together/);
  });

  test("--from must be earlier than --to", () => {
    expect(() => resolveQueryWindow({ from: "2026-01-15", to: "2026-01-01" })).toThrow(/must be earlier than/);
    expect(() => resolveQueryWindow({ from: "2026-01-01", to: "2026-01-01" })).toThrow(/must be earlier than/);
  });

  test("rejects non-ISO date strings", () => {
    expect(() => resolveQueryWindow({ from: "01/01/2026", to: "2026-01-15" })).toThrow(/ISO dates/);
  });

  test("rejects a non-positive --days", () => {
    expect(() => resolveQueryWindow({ days: 0 })).toThrow(/positive integer/);
    expect(() => resolveQueryWindow({ days: -3 })).toThrow(/positive integer/);
  });
});

describe("parseCountyCodes", () => {
  test("defaults to the four DFW county codes when --counties is omitted", () => {
    expect(parseCountyCodes(undefined)).toEqual([...DEFAULT_DFW_COUNTY_CODES]);
  });

  test("parses a comma-separated list, trimming whitespace", () => {
    expect(parseCountyCodes("043, 057,061 ,220")).toEqual(["043", "057", "061", "220"]);
  });

  test("supports a configured county list different from the DFW default", () => {
    expect(parseCountyCodes("201")).toEqual(["201"]);
  });

  test("rejects an empty --counties value", () => {
    expect(() => parseCountyCodes("")).toThrow(/must not be empty/);
    expect(() => parseCountyCodes(",,")).toThrow(/must not be empty/);
  });
});

describe("buildSoqlQuery", () => {
  test("includes the county IN filter, permit-issue-date window, deterministic ORDER BY, and LIMIT/OFFSET", () => {
    const query = buildSoqlQuery({ start: "2026-07-17", end: "2026-07-24" }, ["043", "057"], { limit: 100, offset: 0 });

    expect(query).toContain(`outlet_county_code IN ('043', '057')`);
    expect(query).toContain(`outlet_permit_issue_date >= '2026-07-17T00:00:00.000'`);
    expect(query).toContain(`outlet_permit_issue_date < '2026-07-24T00:00:00.000'`);
    expect(query).toContain("ORDER BY outlet_permit_issue_date, taxpayer_number, outlet_number");
    expect(query).toContain("LIMIT 100 OFFSET 0");
  });

  test("reflects the requested page's offset", () => {
    const query = buildSoqlQuery({ start: "2026-07-17", end: "2026-07-24" }, ["043"], { limit: 50, offset: 150 });
    expect(query).toContain("LIMIT 50 OFFSET 150");
  });

  test("does not depend on implicit API ordering -- ORDER BY is always present", () => {
    const query = buildSoqlQuery({ start: "2026-01-01", end: "2026-01-02" }, ["061"], { limit: 10, offset: 0 });
    expect(query).toMatch(/ORDER BY outlet_permit_issue_date, taxpayer_number, outlet_number/);
  });

  test("escapes single quotes in county codes defensively", () => {
    const query = buildSoqlQuery({ start: "2026-01-01", end: "2026-01-02" }, ["04'3"], { limit: 10, offset: 0 });
    expect(query).toContain("'04''3'");
  });

  test("rejects an empty county list", () => {
    expect(() => buildSoqlQuery({ start: "2026-01-01", end: "2026-01-02" }, [], { limit: 10, offset: 0 })).toThrow(/must not be empty/);
  });

  test("rejects a non-positive limit or negative offset", () => {
    expect(() => buildSoqlQuery({ start: "2026-01-01", end: "2026-01-02" }, ["043"], { limit: 0, offset: 0 })).toThrow();
    expect(() => buildSoqlQuery({ start: "2026-01-01", end: "2026-01-02" }, ["043"], { limit: 10, offset: -1 })).toThrow();
  });
});
