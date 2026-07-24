import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntityResolutionCases } from "./load-cases.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "entity-eval-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function writeDataset(filename: string, dataset: unknown): Promise<string> {
  const path = join(dir, filename);
  await Bun.write(path, JSON.stringify(dataset));
  return path;
}

function baseValidCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: "case-1",
    candidate: {
      id: "loc-1",
      company: { id: "co-1", legalName: "Acme Robotics" },
      contacts: [],
      evidence: [],
      source: { sourceId: "s", sourceName: "s", fingerprint: "f", ingestedAt: "2026-01-01T00:00:00.000Z" },
      capturedAt: "2026-01-01T00:00:00.000Z"
    },
    existingCompanies: [{ id: "bw-1", companyName: "Acme Robotics Inc." }],
    expected: { outcome: "same_existing_location", matchedExistingCompanyId: "bw-1" },
    provenance: { source: "synthetic" },
    ...overrides
  };
}

function baseValidDataset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    datasetId: "dataset-1",
    schemaVersion: "1.0",
    cases: [baseValidCase()],
    ...overrides
  };
}

describe("loadEntityResolutionCases", () => {
  test("loads a valid single-file dataset", async () => {
    const path = await writeDataset("a.json", baseValidDataset());
    const { datasets, errors } = await loadEntityResolutionCases([path]);

    expect(errors).toEqual([]);
    expect(datasets.length).toBe(1);
    expect(datasets[0]?.datasetId).toBe("dataset-1");
    expect(datasets[0]?.cases.length).toBe(1);
    expect(datasets[0]?.cases[0]?.caseId).toBe("case-1");
  });

  test("rejects a bare top-level array with a migration-oriented message", async () => {
    const path = await writeDataset("array.json", [baseValidCase()]);
    const { datasets, errors } = await loadEntityResolutionCases([path]);

    expect(datasets).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/versioned dataset envelope/i);
  });

  test("rejects an unsupported schemaVersion", async () => {
    const path = await writeDataset("a.json", baseValidDataset({ schemaVersion: "9.9" }));
    const { errors } = await loadEntityResolutionCases([path]);

    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/schemaVersion/);
  });

  test("rejects a blank datasetId", async () => {
    const path = await writeDataset("a.json", baseValidDataset({ datasetId: "  " }));
    const { errors } = await loadEntityResolutionCases([path]);

    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/datasetId/);
  });

  test("rejects a duplicate datasetId across two files", async () => {
    const pathA = await writeDataset("a.json", baseValidDataset({ datasetId: "shared", cases: [baseValidCase({ caseId: "case-a" })] }));
    const pathB = await writeDataset("b.json", baseValidDataset({ datasetId: "shared", cases: [baseValidCase({ caseId: "case-b" })] }));

    const { datasets, errors } = await loadEntityResolutionCases([pathA, pathB]);

    expect(datasets.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/Duplicate datasetId/);
  });

  test("rejects a duplicate caseId across two different datasets", async () => {
    const pathA = await writeDataset("a.json", baseValidDataset({ datasetId: "set-a", cases: [baseValidCase({ caseId: "shared-case" })] }));
    const pathB = await writeDataset(
      "b.json",
      baseValidDataset({ datasetId: "set-b", cases: [baseValidCase({ caseId: "shared-case", expected: { outcome: "likely_new_company" } })] })
    );

    const { datasets, errors } = await loadEntityResolutionCases([pathA, pathB]);

    const totalLoadedCases = datasets.reduce((sum, d) => sum + d.cases.length, 0);
    expect(totalLoadedCases).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/Duplicate caseId/);
  });

  test("rejects a duplicate existing-company id within one case", async () => {
    const path = await writeDataset(
      "a.json",
      baseValidDataset({
        cases: [
          baseValidCase({
            existingCompanies: [
              { id: "bw-1", companyName: "Acme Robotics Inc." },
              { id: "bw-1", companyName: "A different row with the same id" }
            ]
          })
        ]
      })
    );

    const { errors } = await loadEntityResolutionCases([path]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/duplicate existing-company id/);
  });

  test("rejects a missing matchedExistingCompanyId when the outcome requires one", async () => {
    const path = await writeDataset(
      "a.json",
      baseValidDataset({ cases: [baseValidCase({ expected: { outcome: "same_existing_location" } })] })
    );

    const { errors } = await loadEntityResolutionCases([path]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/requires expected.matchedExistingCompanyId/);
  });

  test("rejects a matchedExistingCompanyId when the outcome forbids one", async () => {
    const path = await writeDataset(
      "a.json",
      baseValidDataset({ cases: [baseValidCase({ expected: { outcome: "likely_new_company", matchedExistingCompanyId: "bw-1" } })] })
    );

    const { errors } = await loadEntityResolutionCases([path]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/must not specify expected.matchedExistingCompanyId/);
  });

  test("allows ambiguous_manual_review with no matchedExistingCompanyId (optional)", async () => {
    const path = await writeDataset(
      "a.json",
      baseValidDataset({ cases: [baseValidCase({ expected: { outcome: "ambiguous_manual_review" } })] })
    );

    const { errors } = await loadEntityResolutionCases([path]);
    expect(errors).toEqual([]);
  });

  test("rejects a matchedExistingCompanyId that does not appear in the case's existingCompanies", async () => {
    const path = await writeDataset(
      "a.json",
      baseValidDataset({ cases: [baseValidCase({ expected: { outcome: "same_existing_location", matchedExistingCompanyId: "bw-does-not-exist" } })] })
    );

    const { errors } = await loadEntityResolutionCases([path]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/does not appear in this case's existingCompanies/);
  });

  test("rejects an unrecognized expected.outcome", async () => {
    const path = await writeDataset(
      "a.json",
      baseValidDataset({ cases: [baseValidCase({ expected: { outcome: "not_a_real_outcome" } })] })
    );

    const { errors } = await loadEntityResolutionCases([path]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/not a recognized EntityResolutionOutcome/);
  });

  test("loading a directory merges every *.json file inside it, deterministically ordered by datasetId", async () => {
    await writeDataset("z-second.json", baseValidDataset({ datasetId: "zzz", cases: [baseValidCase({ caseId: "case-z" })] }));
    await writeDataset("a-first.json", baseValidDataset({ datasetId: "aaa", cases: [baseValidCase({ caseId: "case-a" })] }));

    const { datasets, errors } = await loadEntityResolutionCases([dir]);

    expect(errors).toEqual([]);
    expect(datasets.map((d) => d.datasetId)).toEqual(["aaa", "zzz"]);
  });
});
