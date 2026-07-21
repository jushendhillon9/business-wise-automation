import { normalizePhone } from "./normalize.ts";
import { hasMeaningfulContact, type Address, type LocationCandidate } from "./types.ts";

/**
 * "confirmed_required" rules come directly from an explicit statement in
 * Emily's document and gate `ready`. "unresolved" rules are known BW fields
 * whose bold/italic (required/optional) status we could not reliably
 * recover from the parsed document — they're reported for transparency but
 * never block readiness. Promote a rule to confirmed_required only once
 * Emily/Rif/Randall confirm it, or once the original formatting is
 * inspected directly.
 */
export type PublicationRequirementStatus = "confirmed_required" | "unresolved";

export type PublicationRequirementCheck = {
  id: string;
  label: string;
  status: PublicationRequirementStatus;
  /** Whether this candidate currently satisfies the rule, independent of whether it blocks. */
  satisfied: boolean;
  note: string;
};

export type PublicationReadinessResult = {
  ready: boolean;
  blockingReasons: string[];
  /** ids of unresolved (non-blocking) requirements the candidate does not currently satisfy. */
  unresolvedRequirements: string[];
  /** Full detail for every rule evaluated, confirmed and unresolved alike. */
  requirements: PublicationRequirementCheck[];
};

/**
 * BW convention per Emily's document: a firm confirmed to exist but with a
 * non-published phone number may be recorded as 000-000-0000. That is a
 * deliberate placeholder, not missing data, so it counts as "present" here.
 * This helper exists so the exception can be reused once phone is promoted
 * to a confirmed requirement; it is not itself a blocking rule today.
 */
export function isAcceptablePhoneValue(phone?: string): boolean {
  if (!phone) return false;
  return normalizePhone(phone).length === 10;
}

function isPopulatedAddress(address?: Address): boolean {
  return Boolean(address?.street?.trim() || address?.city?.trim());
}

/**
 * BW allows "Not Listed" for the physical street address only when the
 * physical ZIP is known AND a valid mailing address exists. This function
 * models that exception so it can be reused later; it is not itself a
 * blocking rule today because the full required/optional address rules are
 * unconfirmed.
 */
export function hasAcceptablePhysicalAddress(candidate: LocationCandidate): boolean {
  const physical = candidate.physicalAddress;
  const hasFullStreetAddress = Boolean(
    physical?.street?.trim() && physical?.city?.trim() && physical?.state?.trim() && physical?.postalCode?.trim()
  );
  const hasZipWithMailingFallback = Boolean(physical?.postalCode?.trim() && isPopulatedAddress(candidate.mailingAddress));
  return hasFullStreetAddress || hasZipWithMailingFallback;
}

function buildRequirements(candidate: LocationCandidate): PublicationRequirementCheck[] {
  return [
    {
      id: "min_one_contact",
      label: "At least one contact",
      status: "confirmed_required",
      satisfied: hasMeaningfulContact(candidate.contacts),
      note: "Explicitly stated in Emily's document: minimum 1 contact required to publish."
    },
    {
      id: "company_name_present",
      label: "Company name present",
      status: "confirmed_required",
      satisfied: Boolean(candidate.company.legalName?.trim()),
      note: "A record cannot be published without a name. Ingestion validation should already guarantee this; checked again here defensively."
    },
    {
      id: "local_phone_or_placeholder",
      label: "Local phone number (or confirmed non-published placeholder)",
      status: "unresolved",
      satisfied: isAcceptablePhoneValue(candidate.phone),
      note: "Listed as a BW key field; bold/italic (required/optional) status not confirmed from the source document's formatting."
    },
    {
      id: "physical_address_or_exception",
      label: "Physical address (or ZIP + valid mailing address exception)",
      status: "unresolved",
      satisfied: hasAcceptablePhysicalAddress(candidate),
      note: "BW allows 'Not Listed' street address only with known ZIP + valid mailing address; required/optional status not confirmed."
    },
    {
      id: "sic_code",
      label: "SIC code",
      status: "unresolved",
      satisfied: Boolean(candidate.company.sicCode?.trim()),
      note: "Listed as a BW key field; required/optional status not confirmed."
    },
    {
      id: "website",
      label: "Website",
      status: "unresolved",
      satisfied: Boolean(candidate.company.website?.trim()),
      note: "Listed as a BW key field; required/optional status not confirmed."
    },
    {
      id: "site_type",
      label: "Site Type (S/H/B/R)",
      status: "unresolved",
      satisfied: Boolean(candidate.siteType),
      note: "Listed as a BW key field; required/optional status not confirmed."
    }
  ];
}

/**
 * Rule-based evaluator: does this location candidate — together with its
 * associated company identity — satisfy BW's actual required-field rules?
 * Reads company-level fields from candidate.company, location-level fields
 * from the candidate itself, and contacts from candidate.contacts.
 * Deliberately conservative — a candidate is only `ready` if every
 * confirmed_required rule passes. Unresolved rules are surfaced but never
 * block, because the source document's bold/italic (required/optional)
 * formatting was not reliably preserved. This is not a weighted score; it is
 * a pass/fail gate with a transparent reason list.
 */
export function evaluatePublicationReadiness(candidate: LocationCandidate): PublicationReadinessResult {
  const requirements = buildRequirements(candidate);

  const blockingReasons = requirements
    .filter((r) => r.status === "confirmed_required" && !r.satisfied)
    .map((r) => r.id);

  const unresolvedRequirements = requirements
    .filter((r) => r.status === "unresolved" && !r.satisfied)
    .map((r) => r.id);

  return {
    ready: blockingReasons.length === 0,
    blockingReasons,
    unresolvedRequirements,
    requirements
  };
}
