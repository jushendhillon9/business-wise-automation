import { describe, expect, test } from "bun:test";
import { DEFAULT_SOURCE_DIR, generateRunId, resolvePilotDbPath, resolvePilotOutputDir, resolveSourceDir } from "./pilot-paths.ts";

describe("resolveSourceDir", () => {
  test("defaults to the documented convenience source directory", () => {
    expect(resolveSourceDir(undefined)).toBe(DEFAULT_SOURCE_DIR);
  });

  test("an explicit --source-dir overrides the default", () => {
    expect(resolveSourceDir("/tmp/custom-source")).toBe("/tmp/custom-source");
  });
});

describe("generateRunId", () => {
  test("produces a filesystem-safe, colon/dot-free id", () => {
    const id = generateRunId(new Date("2026-07-24T15:30:00.123Z"));
    expect(id).not.toContain(":");
    expect(id).not.toContain(".");
  });

  test("distinct timestamps produce distinct run ids", () => {
    const a = generateRunId(new Date("2026-07-24T15:30:00.000Z"));
    const b = generateRunId(new Date("2026-07-24T15:30:01.000Z"));
    expect(a).not.toBe(b);
  });
});

describe("resolvePilotOutputDir", () => {
  test("defaults to the private pilot root + run id", () => {
    expect(resolvePilotOutputDir(undefined, "RUN-1")).toBe("data/private/pilots/tx-sales-tax-permits/RUN-1");
  });

  test("an explicit --output overrides the default", () => {
    expect(resolvePilotOutputDir("/tmp/custom-output", "RUN-1")).toBe("/tmp/custom-output");
  });
});

describe("resolvePilotDbPath", () => {
  test("defaults to pilot.sqlite inside the output directory", () => {
    expect(resolvePilotDbPath(undefined, "/tmp/output-dir")).toBe("/tmp/output-dir/pilot.sqlite");
  });

  test("an explicit --db overrides the default", () => {
    expect(resolvePilotDbPath("/tmp/custom.sqlite", "/tmp/output-dir")).toBe("/tmp/custom.sqlite");
  });
});
