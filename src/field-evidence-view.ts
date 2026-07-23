import {
  companyFieldPath,
  contactFieldPath,
  evidenceForField,
  fieldPathKey,
  locationFieldPath,
  type FieldEvidence,
  type LocationCandidate
} from "./types.ts";

/**
 * Readable, per-field summary of a LocationCandidate's evidence — the thing
 * a reviewer actually wants to scan, not a raw dump of FieldEvidence[].
 * Built for `bun run queue`'s terminal output (see formatFieldEvidenceBlock
 * below), but kept pure/data-only so it's independently testable without a
 * database or console.
 */
export type FieldEvidenceSummary = {
  fieldKey: string;
  hasValue: boolean;
  evidenceCount: number;
  /** True when this field has a value but zero FieldEvidence records — the case reviewers most need surfaced, never silently treated as "confirmed". */
  missingEvidence: boolean;
  /** True when 2+ evidence records disagree on value (compared by JSON identity of `value`). */
  conflicting: boolean;
  confidences: number[];
  sourceTypes: string[];
  /** sourceUrl when present, else a non-URL reference (sourceRecordId/sourceObservationId/sourceName) -- never blank for evidence that exists. */
  sourceRefs: string[];
  evidenceTexts: string[];
};

/**
 * The fixed set of company/location fields checked for evidence coverage.
 * Deliberately mirrors the fields `researchCompleteness()` (src/scoring.ts)
 * and `evaluatePublicationReadiness()` (src/publication-readiness.ts) already
 * care about, so the queue's evidence section lines up with the same fields
 * a reviewer sees elsewhere. This list is purely for display — it never
 * drives readiness, completeness, or priority.
 */
const DISPLAY_FIELDS: Array<{ path: ReturnType<typeof companyFieldPath> | ReturnType<typeof locationFieldPath>; hasValue: (c: LocationCandidate) => boolean }> = [
  { path: companyFieldPath("legalName"), hasValue: (c) => Boolean(c.company.legalName?.trim()) },
  { path: companyFieldPath("website"), hasValue: (c) => Boolean(c.company.website?.trim()) },
  { path: companyFieldPath("sicCode"), hasValue: (c) => Boolean(c.company.sicCode?.trim()) },
  { path: companyFieldPath("alphasort"), hasValue: (c) => Boolean(c.company.alphasort?.trim()) },
  { path: companyFieldPath("startYear"), hasValue: (c) => c.company.startYear !== undefined },
  { path: locationFieldPath("physicalAddress"), hasValue: (c) => Boolean(c.physicalAddress?.street?.trim() || c.physicalAddress?.city?.trim()) },
  { path: locationFieldPath("phone"), hasValue: (c) => Boolean(c.phone?.trim()) },
  { path: locationFieldPath("siteType"), hasValue: (c) => c.siteType !== undefined },
  { path: locationFieldPath("employeeSizeSite"), hasValue: (c) => Boolean(c.employeeSizeSite) }
];

function summarizeOneField(candidate: LocationCandidate, path: FieldEvidence["path"], hasValue: boolean): FieldEvidenceSummary {
  const items = evidenceForField(candidate.fieldEvidence, path);
  const distinctValues = new Set(items.map((item) => JSON.stringify(item.value)));

  return {
    fieldKey: fieldPathKey(path),
    hasValue,
    evidenceCount: items.length,
    missingEvidence: hasValue && items.length === 0,
    conflicting: distinctValues.size > 1,
    confidences: items.map((item) => item.confidence),
    sourceTypes: items.map((item) => item.source.sourceType),
    sourceRefs: items.map((item) => item.source.sourceUrl ?? item.source.sourceObservationId ?? item.source.sourceRecordId ?? item.source.sourceName),
    evidenceTexts: items.flatMap((item) => (item.evidenceText ? [item.evidenceText] : []))
  };
}

/** Company/location field-evidence summaries for one candidate, in a fixed, deterministic order. */
export function summarizeCandidateFieldEvidence(candidate: LocationCandidate): FieldEvidenceSummary[] {
  return DISPLAY_FIELDS.map(({ path, hasValue }) => summarizeOneField(candidate, path, hasValue(candidate)));
}

/** Per-contact field-evidence summaries (name/email), in contacts array order. Contacts without an id (legacy fixtures) are still summarized, just with no evidence linkage possible. */
export function summarizeContactFieldEvidence(candidate: LocationCandidate): Array<{ contactIndex: number; contactId?: string; fields: FieldEvidenceSummary[] }> {
  return candidate.contacts.map((contact, contactIndex) => {
    if (!contact.id) {
      return { contactIndex, contactId: undefined, fields: [] };
    }
    const fields = [
      summarizeOneField(candidate, contactFieldPath(contact.id, "name"), Boolean(contact.name?.trim())),
      summarizeOneField(candidate, contactFieldPath(contact.id, "email"), Boolean(contact.email?.trim()))
    ];
    return { contactIndex, contactId: contact.id, fields };
  });
}

function formatConfidence(confidences: number[]): string {
  if (confidences.length === 0) return "-";
  return confidences.map((c) => c.toFixed(2)).join(", ");
}

function formatFieldLine(label: string, summary: FieldEvidenceSummary): string | undefined {
  if (!summary.hasValue && summary.evidenceCount === 0) {
    // Nothing to say: no value, no evidence. Skip rather than pad the report with empty fields.
    return undefined;
  }
  if (summary.missingEvidence) {
    return `    ${label}: value present, NO EVIDENCE recorded`;
  }

  const flags = summary.conflicting ? " [CONFLICTING]" : "";
  const sources = summary.sourceTypes.map((type, i) => `${type}@${summary.sourceRefs[i] ?? "-"}`).join(" | ");
  return `    ${label}: confidence=${formatConfidence(summary.confidences)} sources=[${sources}]${flags}`;
}

/**
 * Readable, multi-line evidence report for one candidate — the terminal
 * queue's evidence detail section. Deliberately text lines, not a raw
 * console.table of FieldEvidence[], so conflicts and missing evidence stay
 * scannable instead of drowning in JSON. Never throws: a candidate with no
 * fieldEvidence at all (a legacy fixture) still produces a readable report.
 */
export function formatCandidateEvidenceReport(candidate: LocationCandidate): string[] {
  const lines: string[] = [`  ${candidate.company.legalName} (${candidate.id})`];

  for (const summary of summarizeCandidateFieldEvidence(candidate)) {
    const line = formatFieldLine(summary.fieldKey, summary);
    if (line) lines.push(line);
  }

  for (const { contactIndex, contactId, fields } of summarizeContactFieldEvidence(candidate)) {
    const contact = candidate.contacts[contactIndex];
    const label = contact?.name || contact?.email || `contact[${contactIndex}]`;
    if (!contactId) {
      lines.push(`    contact "${label}": no stable contact id (legacy fixture) — evidence linkage unavailable`);
      continue;
    }
    for (const summary of fields) {
      const line = formatFieldLine(`${label}.${summary.fieldKey.split(".").pop()}`, summary);
      if (line) lines.push(line);
    }
  }

  if (lines.length === 1) {
    lines.push("    (no evidence-tracked fields have values)");
  }

  return lines;
}

/** Full evidence report across every candidate, ready to `console.log(...lines)` or join with "\n". */
export function formatFieldEvidenceBlock(candidates: LocationCandidate[]): string[] {
  const lines: string[] = ["Field evidence detail:"];
  for (const candidate of candidates) {
    lines.push(...formatCandidateEvidenceReport(candidate));
  }
  return lines;
}
