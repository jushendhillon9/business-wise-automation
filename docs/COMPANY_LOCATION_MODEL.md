# Company identity + location candidate model

**Authoritative domain reference:** [`docs/BWI_DOMAIN_RULES.md`](./BWI_DOMAIN_RULES.md) is the consolidated source of
truth for Business Wise domain facts (evidence-labeled Confirmed/Conditional/Inferred/Unresolved). This document
explains the `CompanyIdentity`/`LocationCandidate` split those rules motivated, and tracks where the current
implementation is intentionally a subset of what that document describes — see
["Known gaps vs. BWI_DOMAIN_RULES.md"](#known-gaps-vs-bwi_domain_rulesmd) below.

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
  siteType, rawSiteTypeCode, buildingName, buildingType, leaseOrOwn,
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
`src/types.ts`. The `EmployeeSizeValue`/`RevenueValue` shapes match `docs/BWI_DOMAIN_RULES.md` §11 exactly.

## Normalizing BWI legacy codes without losing raw values

Business Wise inherited shorthand codes from the original printed-directory/Delphi systems (site type `S/H/B/R/U`,
lifecycle status `DIRE/DEL/RDL/RDEL/research`). Internal logic wants clean, typed values to reason about; future
integration and auditing need the exact original code, losslessly. The project stores **both**, as explicit typed
fields — not just inside `rawSourceData`/`rawJson` catch-alls — for anything domain logic actually reads:

- `LocationCandidate.siteType` (normalized: `SiteType`) + `LocationCandidate.rawSiteTypeCode` (exact raw string, e.g.
  `"H"`, `" h "`)
- `ExistingCompany.status` (exact raw string, e.g. `"DIRE"`, `"RDL"`) + `ExistingCompany.lifecycleStatus` (normalized:
  `BwiLifecycleStatus`)

Both normalizers live in one centralized, pure module — **`src/bwi-codes.ts`** — rather than being spread as ad hoc
string comparisons through the codebase:

- `normalizeBwiSiteType(raw)` → `{ normalized, rawCode, recognized }`. Tolerant of case, surrounding whitespace, and
  already-normalized input (e.g. `"headquarters"`). `"U"` is BWI's own explicit "unknown site type" code and
  normalizes to `"unknown"` with `recognized: true`; a code that isn't `S/H/B/R/U` at all *also* normalizes to
  `"unknown"`, but with `recognized: false` — the same safe fallback value, with the distinction preserved via the
  flag rather than silently claiming a code we don't understand.
- `normalizeBwiLifecycleStatus(raw)` → `{ normalized, rawCode, recognized }`. Both `"RDL"` and `"RDEL"` normalize to
  the same `research_deleted` value (docs/BWI_DOMAIN_RULES.md §4 leaves the actual stored spelling unresolved), but
  neither is treated as canonical — the exact raw string a caller passed in is always preserved on `rawCode` /
  `ExistingCompany.status`, never collapsed or overwritten.

Both functions are pure, deterministic, and never throw: blank/`undefined`/genuinely-unrecognized input degrades to
`{ normalized: "unknown", recognized: false }` rather than crashing ingestion.

`src/sources/dfw-json-adapter.ts` and `src/sources/dfw-csv-adapter.ts` call `normalizeBwiSiteType()` when a source
gives a raw site-type code (`siteTypeCode` / `site_type_code`); the ingestion engine itself stays BWI-code-agnostic —
that translation is an adapter's job, per the source-adapter boundary described above. `src/db.ts`'s
`insertExistingCompany()` always derives `lifecycle_status` from `status` via `normalizeBwiLifecycleStatus()`, so the
two columns can never drift apart.

**What this deliberately does not include:** employee-size and revenue band code tables. `EmployeeSizeValue` /
`RevenueValue` (`{ estimate, minimum, maximum, bandLabel, rawCode }`) already have a `rawCode` field and a source
adapter can populate it directly, but `docs/BWI_DOMAIN_RULES.md` §11 states plainly that "the complete BWI code
dictionary for employee and revenue bands has not yet been captured" — so `src/bwi-codes.ts` has no
`normalizeBwiEmployeeBand`/`normalizeBwiRevenueBand` function, and none of the current fixtures fabricate one. A
raw employee/revenue code is preserved verbatim if a source provides it; it is never used to *infer* a
minimum/maximum/estimate that isn't independently given.

**Naming note:** `docs/BWI_DOMAIN_RULES.md` §2 refers to the entity-resolution comparison target as
`LocationCandidate / ExistingLocation`. This codebase's existing-record type is named `ExistingCompany`
(`src/types.ts`) — despite the name, it already represents one existing BWI *location* row (it carries
address/city/state/phone, not a company-wide identity), so it is conceptually what the domain-rules document calls
`ExistingLocation`. The name predates this document and has not been renamed as part of this documentation pass, to
avoid unnecessary churn to `entity-resolution.ts`, `db.ts`, and their tests. A rename to `ExistingLocation` is a
reasonable candidate for a future, code-focused task.

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

## Similarity classification vs. business-resolution outcome

Two distinct concepts sit side by side in this codebase, and neither replaces the other:

1. **Similarity / match-confidence classification** — `findBestMatch()` / `scoreCandidateAgainstExisting()`
   (`src/entity-resolution.ts`). Compares one `LocationCandidate` against each known `ExistingCompany` and returns a
   `MatchResult`: an overall `score`, one of `likely_new` / `possible_duplicate` / `likely_duplicate`, and evidence
   split into `companySimilarity` (name score, domain match, SIC match — facts that should hold regardless of which
   location you're looking at) and `locationSimilarity` (address score, phone match, city/state match — facts
   specific to this physical site). **This formula, its weights, and its thresholds are unchanged since the
   company/location split** — Task 4 does not recalibrate them.
2. **Business-resolution outcome** — `resolveCandidateAgainstExisting()` (`src/entity-resolution-policy.ts`). Reads
   the *same* `MatchResult` evidence (via `rankCandidateMatches()`, the deterministic ranking layer) and answers the
   operational question a Business Wise researcher actually needs answered: is this the same existing location, a
   new branch, a new headquarters, a possible name change, a possible move, a genuinely new company, or too
   ambiguous to call automatically?

The three architectural layers, matching `src/entity-resolution.ts` / `src/entity-resolution-policy.ts`:

```
A. scoreCandidateAgainstExisting(candidate, existing)   -- low-level similarity for one existing record (unchanged)
B. rankCandidateMatches(candidate, existingCompanies)    -- ranks all of them, deterministically, best-to-worst
C. resolveCandidateAgainstExisting(candidate, existingCompanies) -- interprets the ranked evidence into a business outcome
```

### The seven outcomes (`EntityResolutionOutcome`, `src/types.ts`)

This is a deliberately conservative, simplified version of the aspirational taxonomy in
`docs/BWI_DOMAIN_RULES.md` §12.4 (that section's `possible_same_location_changed_details` and
`possible_headquarters_move` are merged into one `possible_changed_location` here).

| Outcome | Meaning | Requires human review? |
|---|---|---|
| `same_existing_location` | Strong company **and** strong location evidence. A company-name match alone can never produce this — location-specific evidence (address, or phone+geography) is required. | Only if the matched record's lifecycle is deleted/research-deleted (see below). |
| `new_branch_of_existing_company` | Strong company identity, materially different location, candidate `siteType: "branch"`. | No — but still flows through the normal review queue like everything else. |
| `new_headquarters_of_existing_company` | Strong company identity, materially different location, candidate `siteType: "headquarters"`. | **Always** — the policy never claims the former HQ closed or moved; that's a human call. |
| `possible_changed_location` | Strong company identity, materially different location, and site type doesn't resolve confidently to branch/HQ. Deliberately non-definitive. | Always. |
| `possible_name_change` | Strong location evidence, materially different name, but a stable identity signal (domain or phone match) supports continuity. An exact address alone is never sufficient — unrelated businesses can occupy the same property over time. | Always. |
| `likely_new_company` | No existing record has credible company or location evidence. | No. |
| `ambiguous_manual_review` | Meaningful evidence exists but interpretations conflict — the conservative fallback. Never chosen just to avoid ambiguity, and never skipped in favor of guessing. | Always. |

### Named thresholds (`src/entity-resolution-policy.ts`)

All cutoffs reuse the existing 0–1 similarity scale from `scoreCandidateAgainstExisting()` — this layer interprets
that scale, it doesn't add a new one:

- `STRONG_COMPANY_NAME_SCORE` (0.85), `MODERATE_COMPANY_NAME_SCORE` (0.7), `WEAK_COMPANY_NAME_SCORE` (0.5) —
  interpret `companySimilarity.nameScore`.
- `STRONG_ADDRESS_SCORE` (0.85), `MODERATE_ADDRESS_SCORE` (0.6) — interpret `locationSimilarity.addressScore`.
- `MEANINGFUL_MATCH_SCORE` (0.3) — below this on the *overall* `MatchResult.score`, there is no credible signal at
  all (`likely_new_company`). This is intentionally a different question from the low-level 0.68/0.9 classification
  thresholds, which measure duplicate strength, not business interpretation.
- `AMBIGUOUS_SCORE_MARGIN` (0.05) — if the top two ranked matches' overall scores differ by less than this *and*
  point at two different existing records, the pick between them is treated as unsafe (`ambiguous_manual_review`),
  regardless of what either one alone would otherwise suggest.

"Strong company identity" = `nameScore >= STRONG_COMPANY_NAME_SCORE`, or (`domainMatch` or `sicMatch`) with
`nameScore >= MODERATE_COMPANY_NAME_SCORE`. "Strong location evidence" = `addressScore >= STRONG_ADDRESS_SCORE`, or
an exact phone match combined with city/state match, or a moderately strong address score combined with city/state
match. Neither predicate is satisfied by name similarity alone.

### Multiple-match ranking

`rankCandidateMatches()` scores a candidate against *every* known existing record and returns all of them, ranked —
never just the single best one thrown away with the rest discarded. Ordering is fully deterministic, in this
priority: 1) higher overall score, 2) stronger location evidence (address score), 3) stronger company-name score,
4) stable lexical ordering by existing-record id. Database read order (SQLite gives no ordering guarantee without an
explicit `ORDER BY`) never decides the outcome. `EntityResolutionDecision.alternativeMatches` carries up to the next
2 best matches (top 3 total, including `bestMatch`) so a reviewer can see what else was considered.

### Lifecycle handling

Entity resolution keeps comparing against BWI records in **every** lifecycle status — published, research, deleted,
research_deleted, unknown. Deleted and research-deleted rows are never excluded from matching, and a strong
same-location match against one can still legitimately produce `same_existing_location` — but the decision then
carries `requiresHumanReview: true` and a `conflicts` entry (`existing_location_is_deleted` or
`existing_location_is_research_deleted`) explaining why. The policy never auto-resurrects a deleted record, never
silently reclassifies a deleted-row match as an active location, and never changes any lifecycle status itself — no
writeback of any kind happens here. Both `RDL` and `RDEL` raw spellings normalize to the same `research_deleted`
value (`src/bwi-codes.ts`), so which spelling BW actually stores doesn't change this policy's behavior at all.

### Explainability

Every decision carries `reasons: EntityResolutionReasonCode[]` and `conflicts: EntityResolutionConflictCode[]` —
stable, typed identifiers (e.g. `exact_domain_match`, `candidate_site_type_branch`,
`multiple_close_existing_location_matches`, `existing_location_is_deleted`), not prose. `bun run queue`'s terminal
table stays scannable by showing only the headline outcome; the full reason/conflict/alternative-match detail is
persisted in `review_queue`'s JSON columns (`resolution_reasons_json`, `resolution_conflicts_json`,
`resolution_alternative_matches_json`) for anyone who needs to inspect a specific decision.

### `decisionConfidence` — a heuristic, not a probability

`EntityResolutionDecision.decisionConfidence` is optional and, when present, is simply the underlying
`MatchResult.score`, capped at 0.6 whenever `requiresHumanReview` is true. It is a deterministic heuristic derived
directly from the existing similarity score — explicitly **not** a statistically calibrated probability, and no
claim is made that it is one.

### Known limitations and what a real evaluation would need

These thresholds and rules are reasoned defaults, not thresholds tuned against real outcomes. Before trusting this
layer's outcomes for anything beyond surfacing a prioritized human review queue, the project needs a
**labeled evaluation dataset** — real (or realistic) candidate/existing-record pairs with a researcher's actual
same-location/branch/HQ/name-change/new-company judgment attached — to measure precision/recall per outcome and
retune the named thresholds against it. `docs/BWI_DOMAIN_RULES.md` §20 lists the entity-resolution metrics (same-
location precision/recall, new-branch accuracy, false-duplicate rate, false-new rate, manual-review rate) this would
eventually feed. Building that dataset is explicitly out of scope for this task (see non-goals).

## Current end-to-end local workflow

```bash
bun install
bun run reset      # init db, seed BW companies, ingest both sample sources, run scoring
bun run queue
```

`bun run queue` still shows one row per `LocationCandidate`, now with `resolutionOutcome` as the prominent column and
the low-level `classification` kept alongside it as supporting context. The default fixture data doesn't match any
seeded BW record, so every row currently reads `likely_new_company` — see `src/entity-resolution-policy.test.ts` for
focused fixtures exercising every other outcome, deliberately kept out of the default demo per this project's
"prefer focused test fixtures over polluting the queue demo" guidance. See the README for the full command list and
the distinction between entity resolution, research completeness, publication readiness, and review priority.

## Known gaps vs. BWI_DOMAIN_RULES.md

`docs/BWI_DOMAIN_RULES.md` is a broader, more detailed domain reference than what Project 1 currently implements —
by design. Per its own §25 change-control rule, a newly confirmed fact should update that document first, then the
domain type or rule evaluator, then tests. This section is the reverse index: where the implementation is
intentionally a subset of (or a simpler encoding of) what that document describes, tracked here rather than silently
implemented or silently ignored.

### Contradiction worth flagging: publication-readiness confirmed-required set

`BWI_DOMAIN_RULES.md` §8.2 lists the blank BWI **New Company Profile**'s confirmed base blockers (evidence-labeled
Confirmed, from a screenshot showing required fields in green): company name, alphasort, physical address (or
approved exception), mailing address (or approved exception), local phone (or approved exception), building type,
site type, employee-size band at this site, start year, SIC code/description, and at least one meaningful contact.

`src/publication-readiness.ts` currently only treats **two** of those as `confirmed_required`
(`min_one_contact`, `company_name_present`). Local phone, physical address, SIC code, website, and site type are
modeled but marked `unresolved` (non-blocking) — see the README's "Publication readiness rules currently
implemented" section for why (the bold/italic formatting behind the original required-field list wasn't reliably
preserved, so the code stayed conservative). §8.2 is now more specific evidence than what motivated that conservative
default. Promoting these rules from `unresolved` to `confirmed_required` (and adding alphasort, building type, and
start year, none of which are checked today) is a deliberate follow-up code change, not done as part of this
documentation pass per this task's constraints — it belongs in a later numbered task.

### Fields described in BWI_DOMAIN_RULES.md but not yet modeled

- **Company identity (§6.1):** alphasort/sort name, SIC description, NAICS code.
- **Location (§6.2):** phone 2, lease expiration, square footage, rumored move, latitude/longitude.
- **Contacts (§7):** functional title/category (as distinct from `title`), contact LinkedIn URL, contact
  lifecycle/research status, and the recommended `contact_coverage_score` depth metric.
- **Audit/verification (§5):** BW ID, base date, changed/entered/researched-by, research date, phone-validated date,
  follow-up date, and the researcher-identity/verification-state fields entirely.
- **Field-level evidence (§15):** the `FieldEvidence<T>` shape (value/confidence/sourceUrl/sourceType/capturedAt) is
  not implemented — `LocationCandidate.evidence` today is a flat `string[]`, not per-field evidence records.

### Richer state modeling described but not yet implemented

- **Phone (§9)** and **address (§10)** are each recommended to be modeled as a small state enum (e.g.
  `phone_not_published` vs `phone_disconnected` vs `location_closed`), not `string | undefined`. The code already
  special-cases the `000-000-0000` placeholder (`isAcceptablePhoneValue` in `src/publication-readiness.ts`) but does
  not otherwise distinguish these states.
- **Publication status (§8.1)** recommends a tri-state `blocked | provisionally_ready | confirmed_ready` status. The
  code encodes the same information as a boolean `ready` plus `blockingReasons`/`unresolvedRequirements` arrays,
  which is derivable into the tri-state (`blocked` when `!ready`; `confirmed_ready` when `ready` and
  `unresolvedRequirements` is empty; `provisionally_ready` otherwise) but does not expose it as a named value today.
- ~~**BWI status lifecycle (§4)** recommends preserving a raw `rawBwiStatus: string` mapped separately to a
  normalized lifecycle enum.~~ **Implemented:** `ExistingCompany.status` (raw) + `ExistingCompany.lifecycleStatus`
  (normalized via `normalizeBwiLifecycleStatus()`) — see "Normalizing BWI legacy codes without losing raw values"
  above. The *which spelling is canonical* question (§4, §23.1) remains genuinely unresolved and is not answered by
  this normalization — both `RDL` and `RDEL` are still preserved as distinct raw values.
- **Conditional corporate-office requirements (§8.3):** company-wide employee size, total sites, and estimated
  revenue are described as required for `single_site`/`headquarters` records. These fields exist on
  `LocationCandidate` but are not yet checked by `evaluatePublicationReadiness()` at all (not even as `unresolved`).

### Entity-resolution comparison layers described but not yet compared

`BWI_DOMAIN_RULES.md` §12.2 lists parent/affiliate relationship and start year as company-similarity signals, and
market/county and ZIP as location-similarity signals. `CompanySimilarity`/`LocationSimilarity`
(`src/entity-resolution.ts`) currently cover name/domain/SIC and address/phone/city-state respectively; relationship,
start year, market, county, and ZIP-specific comparison are not yet part of the scoring.

None of the above are implemented as part of this documentation pass — they're recorded here so the next person (or
task) doesn't have to re-derive the diff between the domain document and the code from scratch.

### Entity-resolution business-outcome taxonomy: implemented, deliberately simplified

`BWI_DOMAIN_RULES.md` §12.4's target outcome taxonomy has 8 values, including `possible_same_location_changed_details`
and `possible_headquarters_move` as two separate outcomes. `EntityResolutionOutcome` (`src/types.ts`) implements 7,
merging those two into one `possible_changed_location` — both represent "the evidence plausibly indicates the
location changed, but we can't confidently say how," and splitting them would require distinguishing "this specific
existing location moved" from "a new HQ replaced an old one" with evidence this project doesn't yet have reliably
(e.g. confirmed move dates). This is a deliberate simplification, not an oversight — see "Similarity classification
vs. business-resolution outcome" above for the full outcome definitions and named thresholds.

Also unimplemented from §12.5 (Field inheritance): when a new branch/HQ is linked to an existing company, safe
company-level fields (website, email format, SIC, start year, parent/HQ relationship) could be proposed for
inheritance from the existing record. `EntityResolutionDecision` surfaces `matchedExistingCompanyId` /
`relatedExistingCompanyIds` for `new_branch_of_existing_company` and `new_headquarters_of_existing_company`, which is
enough context for a future task to build that proposal — but no inheritance logic exists yet.
