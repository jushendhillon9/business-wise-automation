import { describe, expect, test } from "bun:test";
import { resolveOutputDir, todayPullDate } from "./paths.ts";

describe("todayPullDate", () => {
  test("formats as an ISO calendar date", () => {
    const date = todayPullDate(new Date("2026-07-24T15:30:00.000Z"));
    expect(date).toBe("2026-07-24");
  });
});

describe("resolveOutputDir", () => {
  test("defaults to the private local pull-date directory", () => {
    expect(resolveOutputDir(undefined, "2026-07-24")).toBe("data/private/sources/tx-sales-tax-permits/2026-07-24");
  });

  test("an explicit --output argument overrides the default", () => {
    expect(resolveOutputDir("/tmp/custom-output", "2026-07-24")).toBe("/tmp/custom-output");
  });
});
