import type {
  CompanyIdentity,
  EntityResolutionDecision,
  FieldEvidence,
  FieldEvidenceCollection,
  FieldPath,
  LocationCandidate,
  SourceProvenance
} from "../types.ts";
import type { PublicationReadinessAssessment, PublicationReadinessIssue } from "../publication-readiness.ts";

/**
 * The publication fields a future research/enrichment provider may propose
 * values for. Deliberately reuses `FieldPath`'s existing "scope.field"
 * naming (see src/types.ts) rather than inventing a second field taxonomy --
 * `enrichmentFieldToPath()` below is the only place that translates between
 * the two.
 *
 * Omissions (no valid representation yet, not forced into this list):
 * - buildingType, estimatedAnnualRevenue, totalSites: these are confirmed
 *   publication-readiness blockers (see src/publication-readiness.ts) but
 *   have no distinct research-provider concept defined yet.
 * - "domain" as distinct from "website": the domain model has one
 *   `website` string field; no separate normalized-domain field exists.
 * - dbaName: not a confirmed base/conditional requirement; the base
 *   "canonical/display name" concept is covered by `company.legalName`.
 * - Creating a brand-new contact (one with no `Contact.id` yet): contact
 *   fields below can only enrich a contact that already exists, since
 *   `contactFieldPath()` requires a stable contact id. Proposing a first
 *   contact for a candidate with zero contacts is out of scope for this
 *   commit.
 */
export type EnrichmentField =
  | "company.legalName"
  | "company.website"
  | "company.alphasort"
  | "company.startYear"
  | "company.sicCode"
  | "company.relationship"
  | "location.physicalAddress"
  | "location.mailingAddress"
  | "location.phone"
  | "location.market"
  | "location.county"
  | "location.siteType"
  | "location.employeeSizeSite"
  | "location.employeeSizeCompanyWide"
  | "contact.name"
  | "contact.email";

export const ALL_ENRICHMENT_FIELDS: readonly EnrichmentField[] = [
  "company.legalName",
  "company.website",
  "company.alphasort",
  "company.startYear",
  "company.sicCode",
  "company.relationship",
  "location.physicalAddress",
  "location.mailingAddress",
  "location.phone",
  "location.market",
  "location.county",
  "location.siteType",
  "location.employeeSizeSite",
  "location.employeeSizeCompanyWide",
  "contact.name",
  "contact.email"
];

/**
 * Translates an `EnrichmentField` into the `FieldPath` the rest of the
 * codebase already understands. Contact fields require a `contactId` --
 * without one there is no addressable path (see the contact-creation
 * omission above), so this returns `undefined` rather than guessing one.
 */
export function enrichmentFieldToPath(field: EnrichmentField, contactId?: string): FieldPath | undefined {
  switch (field) {
    case "company.legalName":
      return { scope: "company", field: "legalName" };
    case "company.website":
      return { scope: "company", field: "website" };
    case "company.alphasort":
      return { scope: "company", field: "alphasort" };
    case "company.startYear":
      return { scope: "company", field: "startYear" };
    case "company.sicCode":
      return { scope: "company", field: "sicCode" };
    case "company.relationship":
      return { scope: "company", field: "relationship" };
    case "location.physicalAddress":
      return { scope: "location", field: "physicalAddress" };
    case "location.mailingAddress":
      return { scope: "location", field: "mailingAddress" };
    case "location.phone":
      return { scope: "location", field: "phone" };
    case "location.market":
      return { scope: "location", field: "market" };
    case "location.county":
      return { scope: "location", field: "county" };
    case "location.siteType":
      return { scope: "location", field: "siteType" };
    case "location.employeeSizeSite":
      return { scope: "location", field: "employeeSizeSite" };
    case "location.employeeSizeCompanyWide":
      return { scope: "location", field: "employeeSizeCompanyWide" };
    case "contact.name":
      return contactId ? { scope: "contact", contactId, field: "name" } : undefined;
    case "contact.email":
      return contactId ? { scope: "contact", contactId, field: "email" } : undefined;
  }
}

/**
 * Execution-policy restrictions available to the planner/orchestrator.
 * Deliberately minimal for this commit -- no provider credentials or
 * provider-specific configuration belong here (see EnrichmentContext).
 */
export type EnrichmentExecutionPolicy = {
  /** When set, only these fields may be researched, regardless of what providers support. Undefined means no restriction beyond provider support. */
  allowedFields?: readonly EnrichmentField[];
  /** Caps how many providers the orchestrator will execute in one run. Undefined means no cap. */
  maxProvidersPerRun?: number;
};

/**
 * Everything a provider needs to decide whether/how to run, without ever
 * carrying credentials or provider-specific configuration -- those stay
 * with whatever wires up a concrete provider in a future commit.
 */
export type EnrichmentContext = {
  candidate: LocationCandidate;
  company: CompanyIdentity;
  sourceProvenance: SourceProvenance;
  readiness: PublicationReadinessAssessment;
  /** The existing match/resolution decision for this candidate, when one has already been computed. */
  resolution?: EntityResolutionDecision;
  /** Fields this run is permitted to research, after planning and policy restrictions have both been applied. */
  permittedFields: readonly EnrichmentField[];
  policy: EnrichmentExecutionPolicy;
  /** The first existing contact's id, when one exists -- the only contact providers may currently attach evidence to (see the contact-creation omission above). */
  targetContactId?: string;
};

export type EnrichmentRunMetadata = {
  runId: string;
  startedAt: string;
};

/**
 * One provider invocation's worth of input: which fields are being asked
 * for, what's already known about them, and why (current blockers).
 */
export type EnrichmentRequest = {
  candidate: LocationCandidate;
  fields: readonly EnrichmentField[];
  /** Existing FieldEvidence for each requested field, keyed by EnrichmentField, so a provider can avoid proposing something already well-established. */
  existingEvidence: Partial<Record<EnrichmentField, FieldEvidence[]>>;
  blockers: readonly PublicationReadinessIssue[];
  run?: EnrichmentRunMetadata;
  targetContactId?: string;
};

export type EnrichmentErrorCategory = "network_error" | "parse_error" | "provider_error" | "timeout" | "unexpected_error";

/** One field-level outcome within a single provider invocation. */
export type EnrichmentFieldOutcome =
  | { field: EnrichmentField; status: "success"; proposal: FieldEvidence }
  | { field: EnrichmentField; status: "not_found"; reason: string }
  /** The provider itself found multiple plausible, disagreeing values and could not pick one -- distinct from the orchestrator-level merge conflict (a proposal disagreeing with an existing candidate value). */
  | { field: EnrichmentField; status: "conflict"; proposals: FieldEvidence[]; reason: string }
  | { field: EnrichmentField; status: "skipped"; reason: string };

/**
 * The result of one `EnrichmentProvider.enrich()` call. A whole invocation
 * either completes (with per-field outcomes, each of which may itself be
 * success/not_found/conflict/skipped) or fails outright -- an uncaught
 * provider exception is converted into this `failed` shape by the
 * orchestrator, never allowed to propagate and abort other providers.
 */
export type EnrichmentProviderResult =
  | { status: "completed"; providerId: string; outcomes: EnrichmentFieldOutcome[] }
  | { status: "failed"; providerId: string; errorCategory: EnrichmentErrorCategory; message: string };

/**
 * Boundary a future website/geocoding/SIC/company-size/contact-research
 * provider must implement. No live provider exists yet -- see
 * src/enrichment/test-provider.ts for the only implementation in this
 * commit, used exclusively by tests.
 */
export interface EnrichmentProvider {
  readonly id: string;
  readonly supportedFields: readonly EnrichmentField[];
  canRun(context: EnrichmentContext): boolean;
  enrich(request: EnrichmentRequest): Promise<EnrichmentProviderResult>;
}

export type { FieldEvidenceCollection };
