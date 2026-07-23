import { normalizePhone } from "./normalize.ts";
import { hasMeaningfulContact, type Address, type BandedValue, type LocationCandidate, type SiteType } from "./types.ts";

/**
 * "Publication readiness" in this repository means domain completeness for a
 * human-reviewed BWI research packet — NOT authorization to write directly to
 * production Business Wise systems. Per docs/BWI_PRODUCTION_DB_DISCOVERY.md,
 * direct SQL writeback, ResearchData/ResearchContacts, batch creation, and
 * Pub* publication procedures are all out of scope for this project's pilot.
 * A `confirmed_ready` assessment still ends in manual entry through the
 * existing authorized Business Wise/Delphi workflow (docs/BWI_DOMAIN_RULES.md
 * §19's write policy).
 */

export type PublicationReadinessState = "blocked" | "provisionally_ready" | "confirmed_ready";

/** Which part of the domain model a readiness rule is about. */
export type ReadinessRuleScope = "company" | "location" | "contact";

/**
 * Stable, machine-readable rule identifiers — never free text — so the
 * queue/detail views and any future automation can rely on exact values.
 * Confirmed base requirements 1-10 and conditional requirements come
 * directly from docs/BWI_DOMAIN_RULES.md §8.2/§8.3 (the blank BWI "New
 * Company Profile"'s confirmed base blockers, evidence-labeled Confirmed).
 */
export type PublicationReadinessRuleId =
  | "company_name_present"
  | "alphasort_present"
  | "physical_address_or_exception"
  | "local_phone_or_exception"
  | "building_type_present"
  | "site_type_present"
  | "site_employee_band_present"
  | "start_year_present"
  | "sic_code_present"
  | "min_one_contact"
  | "company_wide_employee_band_present"
  | "estimated_revenue_present"
  | "total_sites_present";

/** One unmet or unresolved rule — a blocker or an unresolved rule, always both machine- and human-readable. */
export type PublicationReadinessIssue = {
  ruleId: PublicationReadinessRuleId;
  scope: ReadinessRuleScope;
  /** Field or domain area this issue is about, e.g. "company.legalName", "location.phone". */
  field: string;
  /** Plain-language explanation of why this issue exists. */
  explanation: string;
  /** Whether a BW-documented approved exception could satisfy this rule (see docs/BWI_DOMAIN_RULES.md §9-§10). */
  exceptionApplicable: boolean;
  /** Normalized value considered, when useful for audit (e.g. normalized SiteType). */
  normalizedValue?: string;
  /** Exact raw/source value considered, when useful for audit (e.g. raw phone/site-type string). */
  rawValue?: string;
};

/** A confirmed or conditional requirement this candidate currently satisfies. */
export type PublicationReadinessRequirement = {
  ruleId: PublicationReadinessRuleId;
  scope: ReadinessRuleScope;
  field: string;
  explanation: string;
};

/**
 * The structured, explainable publication-readiness result for one
 * LocationCandidate. This is the source of truth for readiness — there is no
 * separate binary readiness calculation anywhere else in the codebase.
 * `state` alone tells a caller how to treat the candidate; `blockers`/
 * `unresolvedRules`/`satisfiedRequirements`/`optionalMissingFields` explain
 * exactly why, for both a reviewer and any downstream automation.
 */
export type PublicationReadinessAssessment = {
  state: PublicationReadinessState;
  /** Confirmed requirements this candidate definitely fails. Any entry here forces `state: "blocked"`. */
  blockers: PublicationReadinessIssue[];
  /** Material rules that cannot yet be confirmed one way or the other. Drives `state: "provisionally_ready"` when non-empty and there are no blockers. */
  unresolvedRules: PublicationReadinessIssue[];
  /** Confirmed and applicable conditional requirements this candidate satisfies. */
  satisfiedRequirements: PublicationReadinessRequirement[];
  /** Optional fields (docs/BWI_DOMAIN_RULES.md §8.4) that are absent. Reported for transparency; never affects `state`. */
  optionalMissingFields: string[];
};

/**
 * BW convention per docs/BWI_DOMAIN_RULES.md §9: a firm confirmed to exist
 * but with a non-published phone number may be recorded as 000-000-0000 —
 * a deliberate placeholder, not missing data. This helper treats either a
 * real 10-digit number or that placeholder as "a phone value is present";
 * `classifyLocalPhone` below distinguishes which one it actually is.
 */
export function isAcceptablePhoneValue(phone?: string): boolean {
  if (!phone) return false;
  return normalizePhone(phone).length === 10;
}

const PLACEHOLDER_PHONE_DIGITS = "0000000000";

type LocalPhoneState = "valid_phone" | "approved_exception" | "exception_potentially_applicable" | "absent";

/**
 * Distinguishes the four local-phone readiness states BW's documented
 * exception (§9) requires: an actual local phone, the approved
 * 000-000-0000 non-published placeholder, a plausible-but-unconfirmed
 * exception path (physical location confirmed, but no phone or placeholder
 * given yet), or neither phone nor any basis for an exception at all.
 */
function classifyLocalPhone(candidate: LocationCandidate): LocalPhoneState {
  const digits = candidate.phone ? normalizePhone(candidate.phone) : "";

  if (digits.length === 10) {
    return digits === PLACEHOLDER_PHONE_DIGITS ? "approved_exception" : "valid_phone";
  }

  // No usable phone value. BW may still publish via the placeholder once a
  // physical location is confirmed to exist (§9) — that precondition being
  // met makes the exception path plausible, not yet approved.
  return hasAcceptablePhysicalAddress(candidate) ? "exception_potentially_applicable" : "absent";
}

function isPopulatedAddress(address?: Address): boolean {
  return Boolean(address?.street?.trim() || address?.city?.trim());
}

/**
 * BW allows "Not Listed" for the physical street address only when the
 * physical ZIP is known AND a valid mailing address exists
 * (docs/BWI_DOMAIN_RULES.md §10).
 */
export function hasAcceptablePhysicalAddress(candidate: LocationCandidate): boolean {
  const physical = candidate.physicalAddress;
  const hasFullStreetAddress = Boolean(
    physical?.street?.trim() && physical?.city?.trim() && physical?.state?.trim() && physical?.postalCode?.trim()
  );
  const hasZipWithMailingFallback = Boolean(physical?.postalCode?.trim() && isPopulatedAddress(candidate.mailingAddress));
  return hasFullStreetAddress || hasZipWithMailingFallback;
}

function hasBandedValue(value?: BandedValue): boolean {
  return Boolean(
    value && (value.estimate !== undefined || value.minimum !== undefined || value.maximum !== undefined || value.bandLabel?.trim() || value.rawCode?.trim())
  );
}

/** single_site/headquarters carry BW's conditional corporate-office requirements (§8.3); branch/regional_headquarters do not. */
function isConditionalCorporateOfficeSiteType(siteType: SiteType): boolean {
  return siteType === "single_site" || siteType === "headquarters";
}

type RuleOutcome = {
  ruleId: PublicationReadinessRuleId;
  scope: ReadinessRuleScope;
  field: string;
  satisfied: boolean;
  explanation: string;
  exceptionApplicable: boolean;
  normalizedValue?: string;
  rawValue?: string;
};

function toIssue(rule: RuleOutcome): PublicationReadinessIssue {
  return {
    ruleId: rule.ruleId,
    scope: rule.scope,
    field: rule.field,
    explanation: rule.explanation,
    exceptionApplicable: rule.exceptionApplicable,
    normalizedValue: rule.normalizedValue,
    rawValue: rule.rawValue
  };
}

function toRequirement(rule: RuleOutcome): PublicationReadinessRequirement {
  return { ruleId: rule.ruleId, scope: rule.scope, field: rule.field, explanation: rule.explanation };
}

/** The 10 confirmed base requirements from docs/BWI_DOMAIN_RULES.md §8.2, applicable to every candidate regardless of site type. */
function buildBaseRuleOutcomes(candidate: LocationCandidate): RuleOutcome[] {
  const localPhoneState = classifyLocalPhone(candidate);

  return [
    {
      ruleId: "company_name_present",
      scope: "company",
      field: "company.legalName",
      satisfied: Boolean(candidate.company.legalName?.trim()),
      explanation: "Company name is a confirmed base requirement (docs/BWI_DOMAIN_RULES.md §8.2).",
      exceptionApplicable: false
    },
    {
      ruleId: "alphasort_present",
      scope: "company",
      field: "company.alphasort",
      satisfied: Boolean(candidate.company.alphasort?.trim()),
      explanation: "Alphasort (search/sort name) is a confirmed base requirement (docs/BWI_DOMAIN_RULES.md §8.2).",
      exceptionApplicable: false
    },
    {
      ruleId: "physical_address_or_exception",
      scope: "location",
      field: "location.physicalAddress",
      satisfied: hasAcceptablePhysicalAddress(candidate),
      explanation:
        "A full physical address, or the documented ZIP + valid mailing address exception, is required (docs/BWI_DOMAIN_RULES.md §8.2, §10).",
      exceptionApplicable: true
    },
    {
      ruleId: "local_phone_or_exception",
      scope: "location",
      field: "location.phone",
      satisfied: localPhoneState === "valid_phone" || localPhoneState === "approved_exception",
      explanation:
        localPhoneState === "exception_potentially_applicable"
          ? "No local phone value is present, but the physical location is confirmed, so the 000-000-0000 non-published-phone exception (docs/BWI_DOMAIN_RULES.md §9) may apply — not yet confirmed."
          : "A local phone number, or the approved 000-000-0000 non-published-phone placeholder, is required (docs/BWI_DOMAIN_RULES.md §8.2, §9).",
      exceptionApplicable: true,
      rawValue: candidate.phone
    },
    {
      ruleId: "building_type_present",
      scope: "location",
      field: "location.buildingType",
      satisfied: Boolean(candidate.buildingType?.trim()),
      explanation: "Building type is a confirmed base requirement (docs/BWI_DOMAIN_RULES.md §8.2).",
      exceptionApplicable: false
    },
    {
      ruleId: "site_type_present",
      scope: "location",
      field: "location.siteType",
      satisfied: candidate.siteType !== undefined && candidate.siteType !== "unknown",
      explanation: "Site type (Single Site / Headquarters / Branch / Regional HQ) is a confirmed base requirement (docs/BWI_DOMAIN_RULES.md §3, §8.2).",
      exceptionApplicable: false,
      normalizedValue: candidate.siteType,
      rawValue: candidate.rawSiteTypeCode
    },
    {
      ruleId: "site_employee_band_present",
      scope: "location",
      field: "location.employeeSizeSite",
      satisfied: hasBandedValue(candidate.employeeSizeSite),
      explanation: "Employee size at this site is a confirmed base requirement (docs/BWI_DOMAIN_RULES.md §8.2).",
      exceptionApplicable: false
    },
    {
      ruleId: "start_year_present",
      scope: "company",
      field: "company.startYear",
      satisfied: candidate.company.startYear !== undefined,
      explanation: "Start year is a confirmed base requirement (docs/BWI_DOMAIN_RULES.md §8.2).",
      exceptionApplicable: false
    },
    {
      ruleId: "sic_code_present",
      scope: "company",
      field: "company.sicCode",
      satisfied: Boolean(candidate.company.sicCode?.trim()),
      explanation: "SIC code is a confirmed base requirement (docs/BWI_DOMAIN_RULES.md §8.2).",
      exceptionApplicable: false
    },
    {
      ruleId: "min_one_contact",
      scope: "contact",
      field: "contacts",
      satisfied: hasMeaningfulContact(candidate.contacts),
      explanation: hasMeaningfulContact(candidate.contacts)
        ? "At least one contact with a name or email is present (docs/BWI_DOMAIN_RULES.md §7)."
        : "At least one meaningful contact (name or email) is required to publish (docs/BWI_DOMAIN_RULES.md §7); an empty contact object or a contact with only a phone number does not count.",
      exceptionApplicable: false
    }
  ];
}

/**
 * Conditional corporate-office requirements (docs/BWI_DOMAIN_RULES.md §8.3),
 * applicable only to single_site/headquarters candidates. Returns `applicable:
 * false` rules for branch/regional_headquarters (never reported as issues),
 * and `undefined` when the site type itself is unresolved — the caller must
 * surface that ambiguity explicitly rather than silently skip these rules.
 */
function buildConditionalRuleOutcomes(candidate: LocationCandidate): { applicable: boolean; outcomes: RuleOutcome[] } | undefined {
  if (candidate.siteType === undefined || candidate.siteType === "unknown") {
    return undefined;
  }

  if (!isConditionalCorporateOfficeSiteType(candidate.siteType)) {
    return { applicable: false, outcomes: [] };
  }

  return {
    applicable: true,
    outcomes: [
      {
        ruleId: "company_wide_employee_band_present",
        scope: "company",
        field: "location.employeeSizeCompanyWide",
        satisfied: hasBandedValue(candidate.employeeSizeCompanyWide),
        explanation: "Company-wide employee size is a confirmed conditional requirement for Single Site/Headquarters records (docs/BWI_DOMAIN_RULES.md §8.3).",
        exceptionApplicable: false
      },
      {
        ruleId: "estimated_revenue_present",
        scope: "company",
        field: "location.estimatedAnnualRevenue",
        satisfied: hasBandedValue(candidate.estimatedAnnualRevenue),
        explanation: "Estimated revenue band is a confirmed conditional requirement for Single Site/Headquarters records (docs/BWI_DOMAIN_RULES.md §8.3).",
        exceptionApplicable: false
      },
      {
        ruleId: "total_sites_present",
        scope: "company",
        field: "location.totalSites",
        satisfied: candidate.totalSites !== undefined,
        explanation: "Total sites is a confirmed conditional requirement for Single Site/Headquarters records (docs/BWI_DOMAIN_RULES.md §8.3).",
        exceptionApplicable: false
      }
    ]
  };
}

/**
 * Optional fields (docs/BWI_DOMAIN_RULES.md §8.4) that must never block
 * readiness on their own. Square footage and lease expiration are also
 * §8.4 optional fields, but have no dedicated LocationCandidate field yet
 * (docs/COMPANY_LOCATION_MODEL.md's gaps list) — nothing to report until
 * they're modeled; not invented here.
 */
function buildOptionalMissingFields(candidate: LocationCandidate): string[] {
  const missing: string[] = [];
  if (!candidate.company.emailFormat?.trim()) missing.push("company.emailFormat");
  if (!candidate.company.relationship?.parentCompany?.trim() && !candidate.company.relationship?.affiliate?.trim()) {
    missing.push("company.relationship");
  }
  return missing;
}

/**
 * Deterministic, pure readiness evaluator: does this location candidate —
 * together with its associated company identity — satisfy BW's confirmed
 * publication requirements? This is the single source of truth for
 * publication readiness; no other binary readiness calculation exists
 * anywhere else in this codebase.
 *
 * State semantics:
 * - `blocked`: at least one confirmed base or applicable conditional
 *   requirement is definitely unsatisfied.
 * - `provisionally_ready`: no definite blocker, but at least one material
 *   rule (currently: an unresolved local-phone exception path) still needs
 *   human confirmation.
 * - `confirmed_ready`: every confirmed base and applicable conditional
 *   requirement is satisfied and no material rule remains unresolved.
 *   Optional missing fields never affect this.
 */
export function evaluatePublicationReadiness(candidate: LocationCandidate): PublicationReadinessAssessment {
  const baseOutcomes = buildBaseRuleOutcomes(candidate);
  const conditional = buildConditionalRuleOutcomes(candidate);

  const blockers: PublicationReadinessIssue[] = [];
  const unresolvedRules: PublicationReadinessIssue[] = [];
  const satisfiedRequirements: PublicationReadinessRequirement[] = [];

  for (const rule of baseOutcomes) {
    if (rule.satisfied) {
      satisfiedRequirements.push(toRequirement(rule));
    } else if (rule.ruleId === "local_phone_or_exception" && classifyLocalPhone(candidate) === "exception_potentially_applicable") {
      unresolvedRules.push(toIssue(rule));
    } else {
      blockers.push(toIssue(rule));
    }
  }

  if (conditional === undefined) {
    // Site type itself is missing/unknown (already a base blocker above), so
    // whether the §8.3 conditional requirements even apply is unresolved.
    // Surfaced explicitly rather than silently skipped.
    unresolvedRules.push({
      ruleId: "site_type_present",
      scope: "location",
      field: "location.employeeSizeCompanyWide|estimatedAnnualRevenue|totalSites",
      explanation:
        "Whether the Single Site/Headquarters conditional requirements (company-wide employee size, revenue band, total sites) apply cannot be determined until site type is confirmed.",
      exceptionApplicable: false,
      normalizedValue: candidate.siteType
    });
  } else if (conditional.applicable) {
    for (const rule of conditional.outcomes) {
      if (rule.satisfied) {
        satisfiedRequirements.push(toRequirement(rule));
      } else {
        blockers.push(toIssue(rule));
      }
    }
  }

  const optionalMissingFields = buildOptionalMissingFields(candidate);

  let state: PublicationReadinessState;
  if (blockers.length > 0) {
    state = "blocked";
  } else if (unresolvedRules.length > 0) {
    state = "provisionally_ready";
  } else {
    state = "confirmed_ready";
  }

  return { state, blockers, unresolvedRules, satisfiedRequirements, optionalMissingFields };
}

/**
 * Temporary compatibility boolean for consumers not yet migrated to the
 * structured assessment (e.g. persisted/tabular views). Always derived from
 * `assessment.state` — never calculated independently. `provisionally_ready`
 * is deliberately NOT publication-ready.
 *
 * TODO(remove): delete once every consumer reads `assessment.state` directly.
 */
export function isPublicationReadyCompat(assessment: PublicationReadinessAssessment): boolean {
  return assessment.state === "confirmed_ready";
}
