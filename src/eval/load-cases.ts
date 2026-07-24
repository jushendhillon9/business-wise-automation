import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EntityResolutionOutcome } from "../types.ts";
import {
  ALL_ENTITY_RESOLUTION_OUTCOMES,
  EXISTING_RELATED_OUTCOMES,
  NEW_COMPANY_OUTCOME,
  SUPPORTED_CASE_SCHEMA_VERSIONS,
  type CaseValidationError,
  type EntityResolutionCaseDataset,
  type LabeledEntityResolutionCase,
  type LoadCasesResult,
  type LoadedDataset
} from "./types.ts";

type MatchedIdRequirement = "required" | "forbidden" | "optional";

/** Same required/forbidden/optional idiom as Commit 2's selectedBwiIdRequirementForAction, applied to expected outcomes instead of reviewer actions. */
function matchedIdRequirementForOutcome(outcome: EntityResolutionOutcome): MatchedIdRequirement {
  if (outcome === NEW_COMPANY_OUTCOME) return "forbidden";
  if (EXISTING_RELATED_OUTCOMES.includes(outcome)) return "required";
  return "optional"; // ambiguous_manual_review
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Resolves each input path to a sorted list of *.json file paths -- a file is used as-is, a directory is listed alphabetically so loading is deterministic regardless of filesystem read order. */
function resolveJsonFilePaths(inputPath: string): string[] {
  const stats = statSync(inputPath);
  if (stats.isDirectory()) {
    return readdirSync(inputPath)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(inputPath, name));
  }
  return [inputPath];
}

/**
 * Loads and validates one or more labeled-case dataset files/directories.
 * Every structural problem is collected as an attributable
 * `CaseValidationError` (sourcePath/datasetId/caseId + message) rather than
 * thrown -- the caller (the CLI) decides whether any error means the whole
 * evaluation is refused (see evaluate-entity-resolution.ts's fail-closed
 * behavior). This function itself never partially "fixes" a bad case; an
 * invalid case is simply excluded from the returned dataset's `cases`.
 *
 * Returned datasets are sorted by `datasetId`, and each dataset's cases are
 * sorted by `caseId`, so downstream evaluation output is deterministic
 * regardless of input path order or filesystem listing order.
 */
export async function loadEntityResolutionCases(inputPaths: readonly string[]): Promise<LoadCasesResult> {
  const errors: CaseValidationError[] = [];
  const datasets: LoadedDataset[] = [];
  const seenDatasetIds = new Map<string, string>(); // datasetId -> sourcePath of first occurrence
  const seenCaseIds = new Map<string, string>(); // caseId -> sourcePath of first occurrence, global across every loaded dataset

  const filePaths = inputPaths.flatMap((inputPath) => resolveJsonFilePaths(inputPath));

  for (const filePath of filePaths) {
    let parsed: unknown;
    try {
      const text = await Bun.file(filePath).text();
      parsed = JSON.parse(text);
    } catch (error) {
      errors.push({ sourcePath: filePath, message: `Could not read/parse as JSON: ${(error as Error).message}` });
      continue;
    }

    if (Array.isArray(parsed)) {
      errors.push({
        sourcePath: filePath,
        message: "Top-level JSON is a bare array. This loader requires a versioned dataset envelope: { datasetId, schemaVersion, cases: [...] }."
      });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      errors.push({ sourcePath: filePath, message: "Top-level JSON must be an object (a dataset envelope), not a primitive." });
      continue;
    }

    const dataset = parsed as Partial<EntityResolutionCaseDataset>;

    if (!isNonBlankString(dataset.datasetId)) {
      errors.push({ sourcePath: filePath, message: "datasetId is required and must be a non-blank string." });
      continue;
    }
    const datasetId = dataset.datasetId;

    if (typeof dataset.schemaVersion !== "string" || !SUPPORTED_CASE_SCHEMA_VERSIONS.includes(dataset.schemaVersion)) {
      errors.push({
        sourcePath: filePath,
        datasetId,
        message: `Unsupported or missing schemaVersion "${String(dataset.schemaVersion)}". Supported versions: ${SUPPORTED_CASE_SCHEMA_VERSIONS.join(", ")}.`
      });
      continue;
    }

    const existingDatasetPath = seenDatasetIds.get(datasetId);
    if (existingDatasetPath !== undefined) {
      errors.push({
        sourcePath: filePath,
        datasetId,
        message: `Duplicate datasetId "${datasetId}" -- already loaded from "${existingDatasetPath}". Dataset IDs must be unique across every loaded file.`
      });
      continue;
    }
    seenDatasetIds.set(datasetId, filePath);

    if (!Array.isArray(dataset.cases)) {
      errors.push({ sourcePath: filePath, datasetId, message: "cases must be an array." });
      continue;
    }

    const validCases: LabeledEntityResolutionCase[] = [];

    for (const [index, rawCase] of dataset.cases.entries()) {
      const caseErrors = validateCase(rawCase, index, filePath, datasetId, seenCaseIds);
      if (caseErrors.length > 0) {
        errors.push(...caseErrors);
        continue;
      }
      validCases.push(rawCase as LabeledEntityResolutionCase);
    }

    validCases.sort((a, b) => a.caseId.localeCompare(b.caseId));
    datasets.push({ datasetId, schemaVersion: dataset.schemaVersion, sourcePath: filePath, cases: validCases });
  }

  datasets.sort((a, b) => a.datasetId.localeCompare(b.datasetId));

  return { datasets, errors };
}

function validateCase(
  rawCase: unknown,
  index: number,
  sourcePath: string,
  datasetId: string,
  seenCaseIds: Map<string, string>
): CaseValidationError[] {
  const errors: CaseValidationError[] = [];
  const errorLabel = `case at index ${index}`;

  if (typeof rawCase !== "object" || rawCase === null) {
    return [{ sourcePath, datasetId, message: `${errorLabel}: must be an object.` }];
  }
  const c = rawCase as Partial<LabeledEntityResolutionCase>;

  if (!isNonBlankString(c.caseId)) {
    return [{ sourcePath, datasetId, message: `${errorLabel}: caseId is required and must be a non-blank string.` }];
  }
  const caseId = c.caseId;

  const existingCaseSourcePath = seenCaseIds.get(caseId);
  if (existingCaseSourcePath !== undefined) {
    return [
      {
        sourcePath,
        datasetId,
        caseId,
        message: `Duplicate caseId "${caseId}" -- already loaded from "${existingCaseSourcePath}". Case IDs must be unique across every loaded dataset.`
      }
    ];
  }
  seenCaseIds.set(caseId, sourcePath);

  if (!c.candidate || typeof c.candidate !== "object") {
    errors.push({ sourcePath, datasetId, caseId, message: "candidate is required and must be a LocationCandidate object." });
  } else if (!isNonBlankString(c.candidate.id) || !c.candidate.company || !isNonBlankString(c.candidate.company.legalName)) {
    errors.push({ sourcePath, datasetId, caseId, message: "candidate must have a non-blank id and a company.legalName." });
  }

  if (!Array.isArray(c.existingCompanies)) {
    errors.push({ sourcePath, datasetId, caseId, message: "existingCompanies is required and must be an array (may be empty)." });
  } else {
    const ids = new Set<string>();
    for (const existing of c.existingCompanies) {
      const id = (existing as { id?: unknown } | null)?.id;
      if (!isNonBlankString(id)) {
        errors.push({ sourcePath, datasetId, caseId, message: "every existingCompanies entry must have a non-blank id." });
        continue;
      }
      if (ids.has(id)) {
        errors.push({ sourcePath, datasetId, caseId, message: `duplicate existing-company id "${id}" within this case's existingCompanies.` });
      }
      ids.add(id);
    }
  }

  if (!c.expected || typeof c.expected !== "object") {
    errors.push({ sourcePath, datasetId, caseId, message: "expected is required and must specify at least an outcome." });
    return errors;
  }

  const expectedOutcome = c.expected.outcome;
  if (typeof expectedOutcome !== "string" || !ALL_ENTITY_RESOLUTION_OUTCOMES.includes(expectedOutcome as EntityResolutionOutcome)) {
    errors.push({
      sourcePath,
      datasetId,
      caseId,
      message: `expected.outcome "${String(expectedOutcome)}" is not a recognized EntityResolutionOutcome (${ALL_ENTITY_RESOLUTION_OUTCOMES.join(", ")}).`
    });
    return errors;
  }

  const requirement = matchedIdRequirementForOutcome(expectedOutcome as EntityResolutionOutcome);
  const matchedId = c.expected.matchedExistingCompanyId;
  const hasMatchedId = isNonBlankString(matchedId);

  if (requirement === "forbidden" && hasMatchedId) {
    errors.push({
      sourcePath,
      datasetId,
      caseId,
      message: `expected.outcome "${expectedOutcome}" must not specify expected.matchedExistingCompanyId (got "${matchedId}").`
    });
  }
  if (requirement === "required" && !hasMatchedId) {
    errors.push({
      sourcePath,
      datasetId,
      caseId,
      message: `expected.outcome "${expectedOutcome}" requires expected.matchedExistingCompanyId identifying which existing record it names.`
    });
  }
  if (hasMatchedId && Array.isArray(c.existingCompanies)) {
    const found = c.existingCompanies.some((existing) => (existing as { id?: unknown })?.id === matchedId);
    if (!found) {
      errors.push({
        sourcePath,
        datasetId,
        caseId,
        message: `expected.matchedExistingCompanyId "${matchedId}" does not appear in this case's existingCompanies.`
      });
    }
  }

  if (!c.provenance || typeof c.provenance !== "object" || !isNonBlankString(c.provenance.source)) {
    errors.push({ sourcePath, datasetId, caseId, message: "provenance.source is required (\"synthetic\" or \"real_reviewer_case\")." });
  } else if (c.provenance.source !== "synthetic" && c.provenance.source !== "real_reviewer_case") {
    errors.push({ sourcePath, datasetId, caseId, message: `provenance.source must be "synthetic" or "real_reviewer_case" (got "${c.provenance.source}").` });
  }

  return errors;
}
