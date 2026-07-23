import type { PublicationReadinessIssue } from "../publication-readiness.ts";
import type { LocationCandidate } from "../types.ts";
import { ALL_ENRICHMENT_FIELDS, type EnrichmentContext, type EnrichmentField, type EnrichmentProvider } from "./types.ts";

/** Why the planner decided a field is worth researching. Purely explanatory -- never drives readiness itself. */
export type EnrichmentPlanReason = "blocked_field" | "unresolved_field" | "optional_gap";

export type EnrichmentFieldPlan = {
  field: EnrichmentField;
  /** True only for fields backing a confirmed publication-readiness blocker. Never true for `optional_gap` entries -- the planner must not treat every optional field as mandatory. */
  mandatory: boolean;
  reason: EnrichmentPlanReason;
};

/** Maps one publication-readiness rule's `field` string onto the EnrichmentField(s) it corresponds to, when a research-provider concept exists for it yet (see the omissions list in ./types.ts). */
function readinessFieldToEnrichmentFields(field: string): EnrichmentField[] {
  switch (field) {
    case "company.legalName":
      return ["company.legalName"];
    case "company.alphasort":
      return ["company.alphasort"];
    case "location.physicalAddress":
      return ["location.physicalAddress"];
    case "location.phone":
      return ["location.phone"];
    case "location.siteType":
      return ["location.siteType"];
    case "location.employeeSizeSite":
      return ["location.employeeSizeSite"];
    case "company.startYear":
      return ["company.startYear"];
    case "company.sicCode":
      return ["company.sicCode"];
    case "location.employeeSizeCompanyWide":
      return ["location.employeeSizeCompanyWide"];
    case "contacts":
      return ["contact.name", "contact.email"];
    default:
      // No enrichment-field concept exists yet for this rule (e.g. buildingType,
      // estimatedAnnualRevenue, totalSites) -- documented omission, not guessed.
      return [];
  }
}

function isEnrichmentFieldPopulated(candidate: LocationCandidate, field: EnrichmentField, targetContactId?: string): boolean {
  switch (field) {
    case "company.legalName":
      return Boolean(candidate.company.legalName?.trim());
    case "company.website":
      return Boolean(candidate.company.website?.trim());
    case "company.alphasort":
      return Boolean(candidate.company.alphasort?.trim());
    case "company.startYear":
      return candidate.company.startYear !== undefined;
    case "company.sicCode":
      return Boolean(candidate.company.sicCode?.trim());
    case "company.relationship":
      return Boolean(candidate.company.relationship?.parentCompany?.trim() || candidate.company.relationship?.affiliate?.trim());
    case "location.physicalAddress":
      return Boolean(candidate.physicalAddress?.street?.trim() || candidate.physicalAddress?.city?.trim());
    case "location.mailingAddress":
      return Boolean(candidate.mailingAddress?.street?.trim() || candidate.mailingAddress?.city?.trim());
    case "location.phone":
      return Boolean(candidate.phone?.trim());
    case "location.market":
      return Boolean(candidate.market?.trim());
    case "location.county":
      return Boolean(candidate.county?.trim());
    case "location.siteType":
      return candidate.siteType !== undefined && candidate.siteType !== "unknown";
    case "location.employeeSizeSite":
      return Boolean(candidate.employeeSizeSite);
    case "location.employeeSizeCompanyWide":
      return Boolean(candidate.employeeSizeCompanyWide);
    case "contact.name": {
      const contact = candidate.contacts.find((c) => c.id === targetContactId);
      return Boolean(contact?.name?.trim());
    }
    case "contact.email": {
      const contact = candidate.contacts.find((c) => c.id === targetContactId);
      return Boolean(contact?.email?.trim());
    }
  }
}

function dedupeInOrder(fields: EnrichmentField[]): EnrichmentField[] {
  const seen = new Set<EnrichmentField>();
  const result: EnrichmentField[] = [];
  for (const field of fields) {
    if (!seen.has(field)) {
      seen.add(field);
      result.push(field);
    }
  }
  return result;
}

/**
 * Determines which fields are worth researching for one candidate, in
 * priority order: confirmed blockers first, then unresolved rules, then
 * opportunistic optional gaps. Filters out anything already populated,
 * anything no available provider supports, and anything the execution
 * policy excludes. Never returns every optional field as if it were
 * required -- only `blocked_field` entries are `mandatory: true`.
 */
export function planEnrichmentFields(context: EnrichmentContext, providers: readonly EnrichmentProvider[]): EnrichmentFieldPlan[] {
  const { candidate, readiness, policy, targetContactId } = context;

  const blockerFields = dedupeInOrder(readiness.blockers.flatMap((issue: PublicationReadinessIssue) => readinessFieldToEnrichmentFields(issue.field)));
  const unresolvedFields = dedupeInOrder(
    readiness.unresolvedRules.flatMap((issue: PublicationReadinessIssue) => readinessFieldToEnrichmentFields(issue.field))
  ).filter((field) => !blockerFields.includes(field));
  const optionalFields = ALL_ENRICHMENT_FIELDS.filter(
    (field) => !blockerFields.includes(field) && !unresolvedFields.includes(field) && !isEnrichmentFieldPopulated(candidate, field, targetContactId)
  );

  const supportedFields = new Set<EnrichmentField>(providers.flatMap((provider) => provider.supportedFields));
  const allowedFields = policy.allowedFields ? new Set(policy.allowedFields) : undefined;

  function eligible(field: EnrichmentField): boolean {
    if (!supportedFields.has(field)) return false;
    if (allowedFields && !allowedFields.has(field)) return false;
    if ((field === "contact.name" || field === "contact.email") && !targetContactId) return false;
    return true;
  }

  const plans: EnrichmentFieldPlan[] = [];
  for (const field of blockerFields) {
    if (!isEnrichmentFieldPopulated(candidate, field, targetContactId) && eligible(field)) {
      plans.push({ field, mandatory: true, reason: "blocked_field" });
    }
  }
  for (const field of unresolvedFields) {
    if (!isEnrichmentFieldPopulated(candidate, field, targetContactId) && eligible(field)) {
      plans.push({ field, mandatory: false, reason: "unresolved_field" });
    }
  }
  for (const field of optionalFields) {
    if (eligible(field)) {
      plans.push({ field, mandatory: false, reason: "optional_gap" });
    }
  }

  return plans;
}
