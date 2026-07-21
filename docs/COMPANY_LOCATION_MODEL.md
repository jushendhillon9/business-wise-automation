# Company identity + location candidate model

## Why Business Wise needs this split

Business Wise is location-centric: the same real-world company can have a headquarters, one or more branches, a
regional HQ, deleted historical locations, and unfinished research records — each a separate BWI row. The real
Delphi/BWI "Duplicate" workflow reflects this directly: when a researcher finds a new location for a company BW
already knows about, they *duplicate* the existing record and only re-key the fields that differ at the new site.

Fields copied forward (**company-level**) don't change from one location to the next:

- website, email format, SIC code
- start year
- parent/affiliate relationship, ticker symbol
- team page / LinkedIn URLs

Fields the researcher fills in fresh (**location-level**) are specific to that site:

- physical address, mailing address
- local phone, toll-free phone
- building name/type, lease or own
- site type (single site / HQ / branch / regional HQ)
- employee count at that location
- contacts based at that location

A single flat `CandidateCompany` object (the pre-refactor model) can't represent this — it has no way to say "this is
another location of a company we already have a provisional identity for." Modeling company and location facts
separately is what makes that representable later.

## The two types

```ts
CompanyIdentity {
  id, legalName, dbaName,
  website, emailFormat,
  sicCode, startYear,
  relationship, international,
  teamPageUrl, linkedinUrl
}

LocationCandidate {
  id, company: CompanyIdentity,
  physicalAddress, mailingAddress,
  phone, tollFreePhone,
  market, county,
  siteType, buildingName, buildingType, leaseOrOwn,
  employeeSizeSite, employeeSizeCompanyWide, employeeCountExact, totalSites,
  estimatedAnnualRevenue,
  contacts, description,
  source: SourceProvenance, capturedAt,
  evidence, rawSourceData
}
```

`LocationCandidate.company` embeds the full `CompanyIdentity`, not just an id — every location candidate is
self-contained and readable on its own (important for the SQLite sandbox, where `location_candidates.raw_json` is a
point-in-time snapshot). The `company_identities` table still exists separately, and `location_candidates` still
carries a `company_identity_id` foreign key, so the schema supports one identity having many locations even though
ingestion doesn't exercise that yet (see below).

`Contact`, `Address` (used for both `physicalAddress` and `mailingAddress`), and the banded `EmployeeSizeValue` /
`RevenueValue` (`{ estimate, minimum, maximum, bandLabel, rawCode }`) are shared, general-purpose types — see
`src/types.ts`.

## Why ingestion does not merge company identities

```
External source observation
        ↓
Provisional CompanyIdentity
        +
LocationCandidate
        ↓
Entity resolution against existing BWI locations
        ↓
Same location / possible duplicate / likely new
        ↓
Research + review
```

Every valid, not-yet-seen source item gets **its own fresh `CompanyIdentity`** during ingestion — one provisional
identity, one location candidate, always. Ingestion never asks "have we seen this company before, under a different
identity?" That question — company mastering — is a much harder, riskier problem (fuzzy matching across sources,
merge/split decisions, human adjudication) and is explicitly **out of scope for ingestion**. Keeping ingestion dumb
about identity means:

- it stays fast, deterministic, and easy to reason about
- a bad merge can never happen during ingestion (there's nothing to merge)
- two different sources observing the same real company (e.g. a chamber report finds "Acme Logistics" and a business
  journal finds "Acme Logistics Inc." the next day) simply produce two provisional identities and two location
  candidates — correct, since ingestion has no way to know they're the same company yet

This is a different question from **ingestion deduplication** (`src/sources/fingerprint.ts`, the `source_records`
table), which only asks "have we already processed this exact source item?" — see the README for that distinction.

## How entity resolution will later decide same-location vs. new-branch

Today, `findBestMatch()` (`src/entity-resolution.ts`) compares one `LocationCandidate` against each known
`ExistingCompany` and returns evidence split into two groups:

- **`companySimilarity`** — name score, domain match, SIC match: facts that should hold regardless of which location
  you're looking at
- **`locationSimilarity`** — address score, phone match, city/state match: facts specific to this physical site

The overall score and the three classifications (`likely_new` / `possible_duplicate` / `likely_duplicate`) are
unchanged from before this refactor — only where the evidence is read from, and the fact that it's now exposed as
two separate groups, is new.

Splitting the evidence this way is what will let future work derive richer outcomes without reworking the matching
logic again, for example:

- high `companySimilarity` + high `locationSimilarity` → probably the *same existing location*
- high `companySimilarity` + low `locationSimilarity` → probably a *new branch of an existing company*
- high `companySimilarity` + moderate `locationSimilarity` (same city, different address) + `siteType: headquarters`
  → possibly a *headquarters move*

None of those richer outcomes are implemented yet — this task only lays the groundwork (see the project's
non-goals).

## Current end-to-end local workflow

```bash
bun install
bun run reset      # init db, seed BW companies, ingest both sample sources, run scoring
bun run queue
```

`bun run queue` still shows one row per `LocationCandidate`. See the README for the full command list and the
distinction between entity resolution, research completeness, publication readiness, and review priority.
