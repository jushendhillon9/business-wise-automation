import { describe, expect, test } from "bun:test";
import { computeFingerprint } from "./fingerprint.ts";

describe("computeFingerprint", () => {
  test("uses sourceId + sourceRecordId when a record id is available", () => {
    const fp = computeFingerprint("dfw-json", "dfw-2026-0001", { companyName: "Acme" });
    expect(fp).toBe("dfw-json:dfw-2026-0001");
  });

  test("is deterministic for the same stable fields when no record id exists", () => {
    const a = computeFingerprint("dfw-csv", undefined, { companyName: "Acme Logistics", city: "Dallas" });
    const b = computeFingerprint("dfw-csv", undefined, { companyName: "Acme Logistics", city: "Dallas" });
    expect(a).toBe(b);
  });

  test("differs when stable fields differ", () => {
    const a = computeFingerprint("dfw-csv", undefined, { companyName: "Acme Logistics", city: "Dallas" });
    const b = computeFingerprint("dfw-csv", undefined, { companyName: "Acme Logistics", city: "Fort Worth" });
    expect(a).not.toBe(b);
  });

  test("differs across sources for otherwise identical content", () => {
    const a = computeFingerprint("dfw-csv", undefined, { companyName: "Acme Logistics" });
    const b = computeFingerprint("dfw-json", undefined, { companyName: "Acme Logistics" });
    expect(a).not.toBe(b);
  });
});
