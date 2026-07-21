import { describe, expect, test } from "bun:test";
import { normalizeBwiLifecycleStatus, normalizeBwiSiteType } from "./bwi-codes.ts";

describe("normalizeBwiSiteType", () => {
  test("H normalizes to headquarters while preserving the raw code", () => {
    const result = normalizeBwiSiteType("H");
    expect(result.normalized).toBe("headquarters");
    expect(result.rawCode).toBe("H");
    expect(result.recognized).toBe(true);
  });

  test("S normalizes to single_site", () => {
    expect(normalizeBwiSiteType("S").normalized).toBe("single_site");
  });

  test("B normalizes to branch", () => {
    expect(normalizeBwiSiteType("B").normalized).toBe("branch");
  });

  test("R normalizes to regional_headquarters", () => {
    expect(normalizeBwiSiteType("R").normalized).toBe("regional_headquarters");
  });

  test("U normalizes to unknown but is still a recognized BWI code", () => {
    const result = normalizeBwiSiteType("U");
    expect(result.normalized).toBe("unknown");
    expect(result.recognized).toBe(true);
  });

  test("lowercase and surrounding-whitespace input normalizes correctly", () => {
    expect(normalizeBwiSiteType("  h  ").normalized).toBe("headquarters");
    expect(normalizeBwiSiteType("s").normalized).toBe("single_site");
  });

  test("already-normalized values pass through recognized", () => {
    const result = normalizeBwiSiteType("headquarters");
    expect(result.normalized).toBe("headquarters");
    expect(result.recognized).toBe(true);
  });

  test("an unknown site-type code is preserved and marked unrecognized, not silently mapped to a real site type", () => {
    const result = normalizeBwiSiteType("Q");
    expect(result.normalized).toBe("unknown");
    expect(result.rawCode).toBe("Q");
    expect(result.recognized).toBe(false);
  });

  test("blank and undefined input are handled safely without crashing", () => {
    expect(normalizeBwiSiteType("").recognized).toBe(false);
    expect(normalizeBwiSiteType("   ").recognized).toBe(false);
    expect(normalizeBwiSiteType(undefined).recognized).toBe(false);
    expect(normalizeBwiSiteType(undefined).rawCode).toBeUndefined();
  });

  test("preserves the exact original raw string, not a trimmed/uppercased copy", () => {
    expect(normalizeBwiSiteType(" h ").rawCode).toBe(" h ");
  });
});

describe("normalizeBwiLifecycleStatus", () => {
  test("DIRE normalizes to published", () => {
    const result = normalizeBwiLifecycleStatus("DIRE");
    expect(result.normalized).toBe("published");
    expect(result.recognized).toBe(true);
  });

  test("research normalizes to research", () => {
    expect(normalizeBwiLifecycleStatus("research").normalized).toBe("research");
  });

  test("DEL normalizes to deleted", () => {
    expect(normalizeBwiLifecycleStatus("DEL").normalized).toBe("deleted");
  });

  test("both RDL and RDEL normalize to research_deleted", () => {
    expect(normalizeBwiLifecycleStatus("RDL").normalized).toBe("research_deleted");
    expect(normalizeBwiLifecycleStatus("RDEL").normalized).toBe("research_deleted");
  });

  test("RDL and RDEL retain their distinct raw strings despite sharing a normalized value", () => {
    const rdl = normalizeBwiLifecycleStatus("RDL");
    const rdel = normalizeBwiLifecycleStatus("RDEL");
    expect(rdl.rawCode).toBe("RDL");
    expect(rdel.rawCode).toBe("RDEL");
    expect(rdl.normalized).toBe(rdel.normalized);
    expect(rdl.rawCode).not.toBe(rdel.rawCode);
  });

  test("neither RDL nor RDEL is treated as more canonical than the other", () => {
    // Both are equally "recognized" -- there is no preferred spelling.
    expect(normalizeBwiLifecycleStatus("RDL").recognized).toBe(true);
    expect(normalizeBwiLifecycleStatus("RDEL").recognized).toBe(true);
  });

  test("an unknown lifecycle code is preserved safely rather than crashing or guessing", () => {
    const result = normalizeBwiLifecycleStatus("ARCHIVED");
    expect(result.normalized).toBe("unknown");
    expect(result.rawCode).toBe("ARCHIVED");
    expect(result.recognized).toBe(false);
  });

  test("lowercase and surrounding-whitespace input normalizes correctly", () => {
    expect(normalizeBwiLifecycleStatus("  dire  ").normalized).toBe("published");
    expect(normalizeBwiLifecycleStatus("rdel").normalized).toBe("research_deleted");
  });

  test("blank and undefined input are handled safely without crashing", () => {
    expect(normalizeBwiLifecycleStatus("").recognized).toBe(false);
    expect(normalizeBwiLifecycleStatus(undefined).recognized).toBe(false);
    expect(normalizeBwiLifecycleStatus(undefined).normalized).toBe("unknown");
  });
});
