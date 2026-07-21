# Business Wise BWI Domain Rules

**Status:** Working source of truth for Project 1  
**Last updated:** July 2026  
**Scope:** Business Wise company/location research, publication readiness, lifecycle, client utility, and human review  
**Not in scope:** Underlying SQL schema, ADF/sync architecture, Delphi write behavior, or production writeback

**Related documents:** [`README.md`](../README.md) (how the code implements a subset of these rules today) and
[`docs/COMPANY_LOCATION_MODEL.md`](./COMPANY_LOCATION_MODEL.md) (the `CompanyIdentity`/`LocationCandidate` domain
model this document informs, plus a running list of gaps between this document and the current implementation).

---

## 1. Purpose

This document consolidates the current evidence about how Business Wise represents, researches, completes, publishes, and exposes company data.

It is intended to guide:

- internal domain types
- source-adapter mapping
- entity resolution
- research completeness
- publication-readiness rules
- review-queue design
- future BWI adapters
- pilot metrics

It should prevent implementation decisions from being spread across transcripts, screenshots, meeting notes, and code comments.

### Evidence labels

Rules are marked as:

- **Confirmed** — directly demonstrated in BWI, explicitly stated by Emily/Jen, or visible in the client application.
- **Conditional** — confirmed, but only under a specific site type or exception.
- **Inferred** — strongly suggested by the UI/workflow but not yet technically verified.
- **Unresolved** — requires confirmation from Emily, Jen, Rif, Randall, or direct database inspection.

---

## 2. Core domain principle: Business Wise is location-centric

**Confirmed**

A real-world company may have multiple BWI rows:

- single site
- headquarters
- branch
- regional headquarters
- deleted historical location
- unfinished research location

Each BWI row represents a specific company location while also carrying facts that may be shared across the broader company.

### Company-level facts

These are typically reusable across locations and are copied by Delphi's **Duplicate** action:

- company/legal/DBA name
- website/domain
- email format
- SIC code and description
- start year
- parent / affiliate / headquarters relationship data
- ticker symbol for public companies
- international/foreign-parent context

### Location-level facts

These must be researched for the specific site:

- physical address
- mailing address
- local phone
- site type
- employee size at this site
- building type
- lease/ownership attributes
- local contacts
- market and county
- location status and audit history

### Implementation rule

The internal model should separate:

```text
CompanyIdentity
    +
LocationCandidate / ExistingLocation
```

Ingestion must not prematurely merge provisional company identities across sources. Entity resolution performs that decision later.

---

## 3. Site types

**Confirmed**

| Internal value | BWI code | Meaning |
|---|---:|---|
| `single_site` | `S` | Company has one office/location; top executives work here |
| `headquarters` | `H` | Company has multiple locations; top executives work here |
| `branch` | `B` | Non-corporate operating location |
| `regional_headquarters` | `R` | Regional corporate office for a large multi-location company |

### Business meaning

- Single Site and Headquarters are both corporate-office records.
- Clients frequently target Single Site and Headquarters because decision-makers are more likely to work there.
- Regional Headquarters are uncommon.
- Branches may still be valuable, but usually do not carry all corporate-level fields.

> **Implementation status (Task 3):** `src/bwi-codes.ts`'s `normalizeBwiSiteType()` implements the S/H/B/R mapping
> above in code (case/whitespace-tolerant, raw code always preserved). It also accepts a `U` code, mapped to an
> `unknown` normalized value — this is *not* evidenced in the table above; it exists so a genuinely unrecognized
> code has somewhere safe to normalize to (`recognized: false`) without being confused with a real site type. See
> `docs/COMPANY_LOCATION_MODEL.md` for detail.

---

## 4. Publication lifecycle and status values

### Normalized lifecycle

| Normalized status | Meaning |
|---|---|
| `published` | Complete active record visible in the client application |
| `research` | Incomplete work-in-progress record, not published |
| `research_deleted` | Candidate was never completed/published |
| `deleted` | Previously published record later removed |

### Raw BWI values

| Raw value | Current interpretation | Evidence status |
|---|---|---|
| `DIRE` | Active directory record; published | Confirmed |
| `research` | Incomplete/unpublished work in progress | Confirmed operationally; raw stored value still to verify |
| `DEL` | Previously published, later deleted | Confirmed |
| `RDL` or `RDEL` | Research delete; never published | **Unresolved spelling** |

### Implementation rule

Always preserve:

```ts
rawBwiStatus: string
```

and map it separately to a normalized lifecycle enum. Do not destroy the raw code.

> **Implementation status (Task 3):** this rule is implemented as `ExistingCompany.status` (raw, exact) +
> `ExistingCompany.lifecycleStatus` (normalized, via `normalizeBwiLifecycleStatus()` in `src/bwi-codes.ts`), always
> recomputed from `status` on insert. Both `RDL` and `RDEL` normalize to the same `research_deleted` value without
> either being treated as canonical — the "Unresolved spelling" question above is unaffected by this normalization.
> See `docs/COMPANY_LOCATION_MODEL.md` for detail.

---

## 5. Audit and verification fields

**Confirmed**

BWI visibly tracks:

- BW ID
- Base Date / creation date
- Changed By
- Changed Date
- Entered By
- Researched By
- Research Date
- Phone Validated Date
- Follow-up Date
- verification/research identity

### Verification convention

- Historical researchers used personal initials.
- Current online/web research uses shared web-check identities such as `WC1` and `WC2`.
- Actual phone research may use the researcher's personal initials.
- A record can be researched with no data changes: Research Date updates while Changed Date does not.

### Recommended normalized states

```text
source_only_unverified
web_verified_no_change
web_verified_changed
phone_verified_no_change
phone_verified_changed
```

These are proposed internal values, not confirmed BWI codes.

---

## 6. Company and location fields

### 6.1 Company identity fields

| Field | Meaning | Current status |
|---|---|---|
| Company name / DBA | Displayed company name | Confirmed |
| Alphasort | Search/sort name | Confirmed required on blank new record |
| Website | Official company website | Confirmed client-visible |
| Domain | Normalized website/email domain | Internal normalized field |
| Email format | Company-level email pattern | Confirmed; optional for publication |
| SIC code | Primary Standard Industrial Classification | Confirmed client-critical |
| SIC description | Human-readable industry description | Confirmed |
| NAICS | Additional industry classification | Confirmed visible; required status unresolved |
| Start year | Year company began | Confirmed |
| Ticker symbol | Public-company symbol | Confirmed when applicable |
| Parent / affiliate relationship | Corporate relationship | Confirmed; optional for publication |
| International / foreign parent | International-company context | Confirmed visible |
| Team Page URL | Leadership/contact source | Confirmed internal operational field |
| LinkedIn company URL | Company research source | Confirmed internal operational field |

### 6.2 Location fields

| Field | Meaning | Current status |
|---|---|---|
| Physical address | Street/suite/city/state/ZIP | Confirmed |
| Mailing address | May differ from physical address | Confirmed |
| Market | Atlanta/Georgia, Charlotte, or DFW context | Confirmed; technical requirement unresolved |
| County | County for location | Confirmed; technical requirement unresolved |
| Building name / property | Named property/building | Confirmed client-visible |
| Building type | Office, industrial, retail, miscellaneous, etc. | Confirmed |
| Lease/Own | Occupancy relationship | Confirmed client-visible |
| Lease expiration | Sales trigger | Confirmed optional for publication |
| Square footage | Estimated occupied space | Confirmed optional for publication |
| Rumored move | Planned move within approximately one year | Confirmed client filter |
| Local phone | Main phone for the location | Confirmed |
| Phone 2 | Secondary phone | Confirmed visible |
| Toll-free phone | Toll-free number | Confirmed visible |
| Site type | S/H/B/R | Confirmed |
| Employee size at site | Employee band for this location | Confirmed on every record |
| Exact employee count | Exact known site count where available | Confirmed optional/extra |
| Company-wide employee size | Total company band | Conditional for Single/HQ |
| Total sites | Number of company locations | Conditional for Single/HQ |
| Estimated revenue | Revenue band | Conditional for Single/HQ |
| Latitude/longitude | Supports mapping/proximity | Confirmed stored; population mechanism unresolved |

---

## 7. Contacts

**Confirmed**

At least one meaningful contact is required before a company location can be published.

### Contact fields

The client application and walkthrough support:

- name
- business title
- functional title/category
- email / email availability
- phone/direct line where available
- LinkedIn URL
- contact lifecycle / research status

### Contact hierarchy and client value

Researchers try to identify:

- top executive / owner / president / CEO
- finance and accounting leader
- operations leader
- human resources leader
- sales and marketing leader

### Publication rule

```text
minimum meaningful contacts >= 1
```

The precise minimum contact-field requirements are still unresolved. For example, it is not yet confirmed whether a name alone is sufficient or whether a business/functional title is mandatory.

### Quality distinction

One contact may satisfy the minimum publication gate, but contact depth is a separate measure of record value.

Recommended future metric:

```text
contact_coverage_score
```

---

## 8. Publication-readiness rules

### 8.1 Status values for our system

Use:

```text
blocked
provisionally_ready
confirmed_ready
```

- `blocked`: fails at least one confirmed rule.
- `provisionally_ready`: passes confirmed rules, but unresolved rules or exceptions remain.
- `confirmed_ready`: passes all confirmed rules and no unresolved publication conditions remain.

### 8.2 Confirmed base requirements

The blank BWI **New Company Profile** marks required fields in green. Current confirmed base blockers are:

- company name
- alphasort
- physical-address requirement or approved exception
- mailing-address requirement or approved exception
- local-phone requirement or approved exception
- building type
- site type
- employee-size band at this site
- start year
- SIC code / description
- at least one meaningful contact

### 8.3 Conditional corporate-office requirements

For `single_site` and `headquarters` records:

- company-wide employee size
- total sites
- estimated revenue band

Company-wide employee size was explicitly demonstrated as required for Headquarters. Revenue and total sites are confirmed corporate-office fields and should remain conditional until tested directly for each site type.

### 8.4 Confirmed optional fields

The following may be absent while a record is still considered complete:

- square footage
- lease expiration
- email format
- parent-company information

### 8.5 Unresolved publication rules

- exact meaning of yellow fields such as Market and County
- whether NAICS is required in any context
- exact minimum content for a meaningful contact
- full behavior of virtual-company address rules
- whether all white fields are optional or some become conditionally required
- exact corporate-office requirements for Single Site versus Headquarters

---

## 9. Phone-state rules

Do not model phone as only `string | null`.

### Confirmed distinct states

```text
phone_found
phone_not_published
phone_disconnected
location_closed
physical_location_confirmed_no_local_phone
virtual_company_with_phone
virtual_company_no_phone
```

### `000-000-0000` exception

**Confirmed**

If a physical location is confirmed to exist but a local phone is not published/findable, BWI may publish the record using:

```text
000-000-0000
```

This must be represented as an explicit exception state with evidence. It must not be silently inserted as fake data.

### Important rule

A disconnected phone does not prove the location is closed.

---

## 10. Address-state rules

Do not model address as only present/missing.

Recommended normalized states:

```text
physical_address_confirmed
mailing_address_confirmed
mailing_only
virtual_company
address_not_listed_exception
possible_move
moved_location
address_unverified
```

### Known exception

BWI may use `Not Listed` for the physical address only under specific conditions involving a known physical ZIP and a valid mailing address.

The exact user-interface validation and publishing behavior remain unresolved.

---

## 11. Employee and revenue bands

**Confirmed**

BWI uses legacy categorical codes and human-readable ranges rather than requiring exact values.

The domain model should preserve:

```ts
interface EmployeeSizeValue {
  estimate?: number;
  minimum?: number;
  maximum?: number;
  bandLabel?: string;
  rawCode?: string;
}

interface RevenueValue {
  estimate?: number;
  minimum?: number;
  maximum?: number;
  bandLabel?: string;
  rawCode?: string;
}
```

### Rules

- Every location has employee size at the site.
- Company-wide employee size, total sites, and estimated revenue apply to corporate offices.
- Exact employee counts may be available but are not present on every record.
- Never discard raw BWI codes during normalization.

### Unresolved

The complete BWI code dictionary for employee and revenue bands has not yet been captured.

> **Implementation status (Task 3):** `EmployeeSizeValue`/`RevenueValue` (`src/types.ts`) already match the interface
> above exactly and preserve `rawCode` through database round-trips. Per the "Unresolved" note above, `src/bwi-codes.ts`
> deliberately has no `normalizeBwiEmployeeBand`/`normalizeBwiRevenueBand` function — no mapping table is fabricated
> without the evidence to back it.

---

## 12. Entity resolution

### 12.1 Two separate problems

**Ingestion deduplication**

> Have we already processed this exact source item?

Key: `sourceId + sourceRecordId`, or deterministic source fingerprint.

**Business entity resolution**

> Does this observation represent an existing BWI company/location?

These must remain separate.

### 12.2 Required comparison layers

#### Company similarity

- normalized company/DBA name
- website/domain
- SIC/industry
- parent/affiliate relationship
- start year

#### Location similarity

- physical address
- city/state/ZIP
- local phone
- market/county
- site type

### 12.3 Matching universe

Entity resolution must consider all relevant BWI lifecycle statuses:

- active/published
- research/incomplete
- research delete
- full delete

> **Implementation status (Task 4):** implemented. `resolveCandidateAgainstExisting()`
> (`src/entity-resolution-policy.ts`) matches against existing records regardless of `lifecycleStatus`; a strong
> same-location match against a deleted/research-deleted record still surfaces (never excluded), flagged with
> `requiresHumanReview: true` and an explicit lifecycle-conflict reason. No lifecycle status is ever changed by this
> code, and no record is auto-resurrected.

### 12.4 Target outcome taxonomy

```text
same_existing_location
possible_same_location_changed_details
new_branch_of_existing_company
new_headquarters_of_existing_company
possible_headquarters_move
possible_name_change
likely_new_company
ambiguous_manual_review
```

The current code may retain simpler classifications until Task 4, but its evidence structure must support these richer outcomes.

> **Implementation status (Task 4):** implemented as `EntityResolutionOutcome` (`src/types.ts`), produced by
> `resolveCandidateAgainstExisting()` (`src/entity-resolution-policy.ts`), built on top of the unchanged low-level
> `MatchResult` evidence from §12.2/§12.3 above. Deliberately simplified to 7 values: `possible_same_location_changed_details`
> and `possible_headquarters_move` are merged into one `possible_changed_location`, since distinguishing them reliably
> needs evidence (e.g. confirmed move dates) this project doesn't have yet. See
> `docs/COMPANY_LOCATION_MODEL.md` for full outcome definitions, named thresholds, and the conservative
> ambiguous-fallback policy.

### 12.5 Field inheritance

When a new branch/location is linked to an existing company, safe company-level fields may be proposed for inheritance:

- website
- email format
- SIC
- start year
- parent/HQ relationship

Do not automatically inherit without location-specific evidence:

- local phone
- physical/mailing address
- site employee size
- building/lease information
- local contacts

---

## 13. Research completeness

Research completeness answers:

> How much useful information do we currently know?

It does **not** answer:

- whether the record is publishable
- whether a reviewer should approve it
- whether it is a duplicate

### Output

```ts
{
  score: number;
  presentFields: string[];
  missingFields: string[];
}
```

Use namespaced identifiers:

```text
company.website
company.sicCode
company.startYear
location.phone
location.physicalAddress
location.employeeSizeSite
contacts
```

---

## 14. Review priority

Review priority answers:

> Which candidate should a human review first?

It must remain independent from approval and publication readiness.

### Confirmed business priorities

- generally prioritize companies with 4+ employees
- core client target: Single Site and Headquarters records with 10–99 employees
- favor likely-new observations
- favor candidates with enough evidence to review efficiently

A high-priority record may still be blocked.

---

## 15. Field-level evidence

Every proposed researched value should eventually support:

```ts
interface FieldEvidence<T> {
  value: T;
  confidence: number;
  sourceUrl?: string;
  sourceType: string;
  capturedAt: string;
  evidenceText?: string;
  rawValue?: unknown;
}
```

### Current research source types

- company website
- team/leadership page
- LinkedIn company/person page
- Perplexity-assisted research
- Hunter email verification
- Google search
- Secretary of State filings
- business journals
- chambers of commerce
- economic-development organizations
- county business-license datasets
- client Research-on-Demand request

### Team-page rule

A team-page URL is more than a completeness field. It is a future **refreshability signal** because it may let researchers update contacts without phoning.

---

## 16. Client-facing data utility

The client application uses BW data for prospecting, list building, calling, emailing, mapping, and activity tracking.

### Company/location filters visible in the list builder

- employee size
- SIC / industry
- public versus private
- estimated revenue
- site type
- start year
- parent country / relationship
- total sites
- website availability
- county
- metro area
- ZIP/city/address
- building name
- radius / proximity
- street name
- building ownership/tenancy
- building type
- lease expiration
- rumored move
- square footage

### Contact filters

- business title
- functional/personal title
- email availability
- unsubscribe status

### Freshness filters

- newly added firms
- newly added contacts

### Important distinction

Client-specific custom fields—CRM, Pipedrive, prospect rating, status, additional information—are subscriber-owned workflow data, not universal research fields. Project 1 should not attempt to discover or populate them.

---

## 17. Research on Demand taxonomy

**Confirmed from client UI/workflow**

### Company requests

- company not found
- company closed
- company moved
- company name changed
- phone disconnected
- other company request

### Contact requests

- contact no longer at company
- possible new contact
- contact email invalid
- other contact request

### Service levels

- no reply needed
- status update after verification
- urgent / response within 24 hours

These requests currently flow into Mojo and are managed by Emily and Jen.

This is future Phase 2 scope, not Project 1's first proactive DFW intake build.

---

## 18. Source-ingestion rules

A source adapter converts an external observation into:

```text
Provisional CompanyIdentity
+
LocationCandidate
+
SourceProvenance
```

### Provenance requirements

- source ID
- source name
- source record ID
- source URL when available
- page/row/context when relevant
- captured/ingested time
- deterministic fingerprint
- raw source payload or reference

### Source adapter behavior

- company name is the minimum usable identity signal
- malformed records must be skipped safely
- one bad row must not crash a run
- source reruns must be idempotent
- different sources may retain separate observations about the same real-world company
- ingestion must not perform company mastering

---

## 19. Human review workflow

The pilot review packet should show:

- original source observation
- provisional company and location data
- closest BWI matches across all statuses
- company-similarity evidence
- location-similarity evidence
- recommended classification
- proposed inherited company-level fields
- field-level evidence URLs
- research-completeness score
- publication status and named blockers
- unresolved requirements
- priority

### Target reviewer actions

```text
approve_new_company
approve_new_branch
link_existing_location
mark_duplicate
needs_more_research
reject_source_observation
```

### Initial write policy

For the pilot, Delphi remains the final human write surface. No direct production database writeback until the technical architecture and supported publish path are verified.

---

## 20. Pilot success metrics

### Operational metrics

- raw source observations
- valid observations
- candidates surfaced
- true new companies
- new branches
- duplicates filtered
- records approved
- records manually entered/published
- human review minutes
- human research minutes
- records completed per hour
- missing-field patterns

### Entity-resolution metrics

- same-location precision/recall
- new-branch accuracy
- false-duplicate rate
- false-new rate
- manual-review rate

### Economic metrics

- automation cost per candidate
- automation cost per approved record
- human minutes per approved record
- annualized research capacity
- estimated labor hours saved

Manual research has historically averaged approximately 7–8 minutes for ordinary records, with complex acquisitions and multi-market changes taking substantially longer.

---

## 21. Current known external-source priorities

### Historical intake sources

- county business-license datasets
- local business journals
- chambers of commerce
- economic-development organizations
- client Research-on-Demand requests

### Current operational source

Emily and Jen are manually working a DFW chamber/economic-development report describing companies that moved headquarters or expanded in DFW.

This should be the first real Project 1 source adapter once the original digital source and annotations are obtained.

---

## 22. Technical boundaries and unresolved architecture

The following are explicitly unresolved:

- database(s) behind Delphi
- whether Delphi writes to source-of-truth or staging
- exact stored status values
- contacts/relationships table design
- how `DIRE` publishes into the client app
- Azure SQL / ADF / nightly-sync role
- triggers, stored procedures, services, or batch jobs
- whether Retool can be revived as review UI
- whether Mojo exposes an API
- supported export/import paths
- geocoding/lat-long service
- safe production-write path

Project 1 must keep integration behind an adapter and avoid direct writes until Rif/Randall confirm these details.

---

## 23. Open domain questions

1. Is the research-delete code stored as `RDL` or `RDEL`?
2. Is `research` a literal stored status?
3. What do yellow fields mean in Delphi?
4. What contact fields constitute a meaningful required contact?
5. Are Market and County required, defaulted, or derived?
6. What are the complete employee-band and revenue-band code dictionaries?
7. Are revenue and total sites strictly required for both Single Site and Headquarters?
8. What are the exact virtual-company publishing rules?
9. What exact conditions permit physical address = `Not Listed`?
10. Does address validation automatically set county and latitude/longitude?
11. Are NAICS and International fields ever required?
12. Can query exports include stable BW IDs and all lifecycle statuses?
13. Which fields does Delphi's Duplicate action copy in the current version?
14. Which contacts are location-specific versus company-wide in the underlying data?

---

## 24. Source evidence used

This document consolidates:

- Emily's **AI Research / Key Data Fields** document
- July 20 Business Wise discovery walkthrough
- full and trimmed Otter transcripts
- Delphi/BWI video and frame-by-frame visual dissection
- blank New Company Profile screenshot
- client company-profile screenshots
- client list-builder/filter screenshots
- client Research-on-Demand screenshots
- Business Wise discovery notes

Where evidence conflicts, the conflict is preserved as unresolved rather than silently normalized.

---

## 25. Change-control rule

When a new fact is confirmed:

1. update this document
2. label the evidence status
3. update the domain type or rule evaluator if needed
4. add or update tests
5. avoid encoding a rule based solely on a transcript typo or visual assumption

This document should remain the authoritative business-domain reference for Project 1.
