import { addFieldEvidence, evidenceForField, type Address, type BandedValue, type FieldEvidence, type FieldPath, type LocationCandidate, type Relationship } from "../types.ts";

/** One proposal that disagreed with a value already on the candidate (or with another proposal in the same run) and was preserved for human review rather than applied. */
export type MergeConflict = {
  path: FieldPath;
  existingValue: unknown;
  proposal: FieldEvidence;
};

export type MergeResult = {
  candidate: LocationCandidate;
  conflicts: MergeConflict[];
  /** Number of proposals that were applied to the candidate's actual field value (not just added as supporting evidence). */
  filledFieldCount: number;
};

function normalize(value: unknown): string {
  return JSON.stringify(value);
}

function getFieldValue(candidate: LocationCandidate, path: FieldPath): unknown {
  if (path.scope === "company") {
    switch (path.field) {
      case "legalName":
        return candidate.company.legalName;
      case "website":
        return candidate.company.website;
      case "alphasort":
        return candidate.company.alphasort;
      case "startYear":
        return candidate.company.startYear;
      case "sicCode":
        return candidate.company.sicCode;
      case "relationship":
        return candidate.company.relationship;
      default:
        return undefined;
    }
  }
  if (path.scope === "location") {
    switch (path.field) {
      case "physicalAddress":
        return candidate.physicalAddress;
      case "mailingAddress":
        return candidate.mailingAddress;
      case "phone":
        return candidate.phone;
      case "market":
        return candidate.market;
      case "county":
        return candidate.county;
      case "siteType":
        return candidate.siteType;
      case "employeeSizeSite":
        return candidate.employeeSizeSite;
      case "employeeSizeCompanyWide":
        return candidate.employeeSizeCompanyWide;
      default:
        return undefined;
    }
  }
  const contact = candidate.contacts.find((c) => c.id === path.contactId);
  if (!contact) return undefined;
  return path.field === "name" ? contact.name : path.field === "email" ? contact.email : undefined;
}

function isPopulatedValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function setFieldValue(candidate: LocationCandidate, path: FieldPath, value: unknown): LocationCandidate {
  if (path.scope === "company") {
    const company = { ...candidate.company };
    switch (path.field) {
      case "legalName":
        company.legalName = value as string;
        break;
      case "website":
        company.website = value as string;
        break;
      case "alphasort":
        company.alphasort = value as string;
        break;
      case "startYear":
        company.startYear = value as number;
        break;
      case "sicCode":
        company.sicCode = value as string;
        break;
      case "relationship":
        company.relationship = value as Relationship;
        break;
      default:
        return candidate;
    }
    return { ...candidate, company };
  }
  if (path.scope === "location") {
    switch (path.field) {
      case "physicalAddress":
        return { ...candidate, physicalAddress: value as Address };
      case "mailingAddress":
        return { ...candidate, mailingAddress: value as Address };
      case "phone":
        return { ...candidate, phone: value as string };
      case "market":
        return { ...candidate, market: value as string };
      case "county":
        return { ...candidate, county: value as string };
      case "siteType":
        return { ...candidate, siteType: value as LocationCandidate["siteType"] };
      case "employeeSizeSite":
        return { ...candidate, employeeSizeSite: value as BandedValue };
      case "employeeSizeCompanyWide":
        return { ...candidate, employeeSizeCompanyWide: value as BandedValue };
      default:
        return candidate;
    }
  }
  const contacts = candidate.contacts.map((c) =>
    c.id === path.contactId ? { ...c, [path.field === "name" ? "name" : "email"]: value } : c
  );
  return { ...candidate, contacts };
}

function sameSource(a: FieldEvidence, b: FieldEvidence): boolean {
  return (
    a.source.sourceId === b.source.sourceId &&
    a.source.sourceType === b.source.sourceType &&
    (a.source.sourceObservationId ?? a.source.sourceRecordId ?? a.source.sourceUrl) ===
      (b.source.sourceObservationId ?? b.source.sourceRecordId ?? b.source.sourceUrl)
  );
}

function normalizedValueOf(evidence: FieldEvidence): unknown {
  return evidence.normalizedValue ?? evidence.value;
}

/**
 * Applies one evidence-backed proposal to a candidate, following the
 * deterministic rules from the Commit 1 plan:
 * - an existing human-confirmed value for this field is never overwritten;
 * - an identical rerun of the same provider/value is not duplicated;
 * - an identical value from elsewhere adds supporting evidence (and fills
 *   the field if it was empty);
 * - a different value produces a conflict instead of overwriting;
 * - a genuinely empty field with no prior evidence accepts the proposal.
 */
export function mergeFieldProposal(candidate: LocationCandidate, proposal: FieldEvidence): MergeResult {
  const path = proposal.path;
  const existingEvidence = evidenceForField(candidate.fieldEvidence, path);
  const currentValue = getFieldValue(candidate, path);
  const proposedNormalized = normalizedValueOf(proposal);

  const isHumanConfirmed = existingEvidence.some((e) => e.derivation === "human_confirmed");

  const isDuplicateRerun = existingEvidence.some((e) => sameSource(e, proposal) && normalize(normalizedValueOf(e)) === normalize(proposedNormalized));
  if (isDuplicateRerun) {
    return { candidate, conflicts: [], filledFieldCount: 0 };
  }

  const agreesWithExisting = existingEvidence.some((e) => normalize(normalizedValueOf(e)) === normalize(proposedNormalized));
  const disagreesWithExisting = existingEvidence.some((e) => normalize(normalizedValueOf(e)) !== normalize(proposedNormalized));

  if (isHumanConfirmed) {
    // Never overwrite a human-confirmed value. Still record the proposal as
    // evidence (for audit) when it agrees; a disagreeing proposal is a
    // conflict preserved for review, never applied.
    const withEvidence = { ...candidate, fieldEvidence: addFieldEvidence(candidate.fieldEvidence ?? [], proposal) };
    if (agreesWithExisting) {
      return { candidate: withEvidence, conflicts: [], filledFieldCount: 0 };
    }
    return { candidate: withEvidence, conflicts: [{ path, existingValue: currentValue, proposal }], filledFieldCount: 0 };
  }

  if (disagreesWithExisting) {
    // Some prior evidence (from this or an earlier field) already disagrees
    // -- preserve for review rather than pick a side.
    const withEvidence = { ...candidate, fieldEvidence: addFieldEvidence(candidate.fieldEvidence ?? [], proposal) };
    return { candidate: withEvidence, conflicts: [{ path, existingValue: currentValue, proposal }], filledFieldCount: 0 };
  }

  const withEvidence = { ...candidate, fieldEvidence: addFieldEvidence(candidate.fieldEvidence ?? [], proposal) };

  if (!isPopulatedValue(currentValue)) {
    // Empty field, no conflicting evidence -- safe to fill.
    return { candidate: setFieldValue(withEvidence, path, proposedNormalized), conflicts: [], filledFieldCount: 1 };
  }

  if (agreesWithExisting || normalize(currentValue) === normalize(proposedNormalized)) {
    // Field already carries this same value (e.g. an adapter-observed value
    // now corroborated by a provider) -- add supporting evidence only.
    return { candidate: withEvidence, conflicts: [], filledFieldCount: 0 };
  }

  // Field is populated with a different value and no evidence explains why
  // -- treat as a conflict rather than silently overwrite.
  return { candidate: withEvidence, conflicts: [{ path, existingValue: currentValue, proposal }], filledFieldCount: 0 };
}

/**
 * Records one of several proposals a provider itself could not choose
 * between (its "conflict" outcome): the proposal is appended as evidence
 * and the disagreement is preserved for human review, but the actual field
 * value is never touched -- unlike `mergeFieldProposal`, this never fills
 * an empty field, since the provider explicitly signaled it doesn't know
 * which value (if any) is correct.
 */
export function recordProviderConflict(candidate: LocationCandidate, proposal: FieldEvidence): MergeResult {
  const currentValue = getFieldValue(candidate, proposal.path);
  const withEvidence = { ...candidate, fieldEvidence: addFieldEvidence(candidate.fieldEvidence ?? [], proposal) };
  return { candidate: withEvidence, conflicts: [{ path: proposal.path, existingValue: currentValue, proposal }], filledFieldCount: 0 };
}

/** Applies every proposal in order, threading the candidate/conflicts through so later proposals see earlier merges. */
export function mergeFieldProposals(candidate: LocationCandidate, proposals: readonly FieldEvidence[]): MergeResult {
  let current = candidate;
  const conflicts: MergeConflict[] = [];
  let filledFieldCount = 0;

  for (const proposal of proposals) {
    const result = mergeFieldProposal(current, proposal);
    current = result.candidate;
    conflicts.push(...result.conflicts);
    filledFieldCount += result.filledFieldCount;
  }

  return { candidate: current, conflicts, filledFieldCount };
}
