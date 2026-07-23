# Business Wise — Project 1 Starter

A safe, local vertical slice for the proposed DFW automated new-company intake pilot.

> **Authoritative domain reference:** [`docs/BWI_DOMAIN_RULES.md`](docs/BWI_DOMAIN_RULES.md) consolidates everything
> currently known about how Business Wise represents, researches, completes, publishes, and exposes company data —
> evidence-labeled Confirmed/Conditional/Inferred/Unresolved. When this README and that document disagree, the
> domain-rules document wins; this README (and `docs/COMPANY_LOCATION_MODEL.md`) describe what the code currently
> implements, which is intentionally a subset of it. See `docs/COMPANY_LOCATION_MODEL.md`'s "Known gaps vs.
> BWI_DOMAIN_RULES.md" section for the specific, tracked differences. See
> [`docs/BWI_PRODUCTION_DB_DISCOVERY.md`](docs/BWI_PRODUCTION_DB_DISCOVERY.md) for the July 2026 production-database
> discovery record informing the write boundaries described below.

## What this proves first

`source observation -> company identity + location candidate -> entity-resolution score -> prioritized human review queue`

It deliberately does **not** write to Business Wise production systems. The real BWI / SQL / Azure / ADF integration stays behind `BusinessWiseAdapter` until technical discovery with Rif and Randall is complete.

## Why this is the right first slice

The current Business Wise workflow has known intake sources, manual duplicate review, required publish fields, manual SIC work, and a human publication gate. This starter isolates the reusable intelligence layer from the unknown production architecture.

## Company identity vs. location candidate

Business Wise is location-centric: the same real company can have a headquarters, branches, and a regional HQ, each
its own BWI row, sharing company-level facts (website, SIC, start year, relationship) while differing on
location-level facts (address, phone, site type, employee count, contacts). The domain model reflects that split:

- **`CompanyIdentity`** (`src/types.ts`) — company-level facts: `legalName`, `dbaName`, `website`, `emailFormat`,
  `sicCode`, `startYear`, `relationship`, `international`, `teamPageUrl`, `linkedinUrl`.
- **`LocationCandidate`** (`src/types.ts`) — one observed location, embedding its `company: CompanyIdentity` plus
  location-level facts: `physicalAddress`/`mailingAddress` (typed `Address`), `phone`/`tollFreePhone`, `market`,
  `county`, `siteType`, `buildingName`/`buildingType`/`leaseOrOwn`, `employeeSizeSite`/`employeeSizeCompanyWide`
  (banded `EmployeeSizeValue`), `employeeCountExact`, `totalSites`, `estimatedAnnualRevenue` (banded `RevenueValue`),
  `contacts`, plus source provenance and `capturedAt`.

**Ingestion never merges company identities.** Every valid source item gets its own fresh, provisional
`CompanyIdentity` — one identity, one location, always. Two different sources observing the same real company (a
chamber report finds "Acme Logistics", a business journal finds "Acme Logistics Inc." the next day) simply produce
two provisional identities and two location candidates; deciding whether they're the same real-world company is
entity resolution's job, done later, not ingestion's. See **`docs/COMPANY_LOCATION_MODEL.md`** for the full
rationale and a diagram.

## Similarity classification vs. business-resolution outcome

Entity resolution has two layers, and neither replaces the other:

- **Similarity classification** (`src/entity-resolution.ts`) — the original, unchanged low-level layer:
  `scoreCandidateAgainstExisting()` computes an overall `score` and one of `likely_new`/`possible_duplicate`/
  `likely_duplicate` for a candidate against one existing record, with `companySimilarity`/`locationSimilarity`
  evidence. `rankCandidateMatches()` scores against *every* existing record and returns them all, deterministically
  ranked (never trusting database read order for ties).
- **Business-resolution outcome** (`src/entity-resolution-policy.ts`) — `resolveCandidateAgainstExisting()` reads
  that same ranked evidence and answers the operational question a researcher actually needs: `same_existing_location`,
  `new_branch_of_existing_company`, `new_headquarters_of_existing_company`, `possible_changed_location`,
  `possible_name_change`, `likely_new_company`, or the conservative fallback `ambiguous_manual_review`. It never
  forces a confident branch/move/HQ/name-change call when the evidence doesn't clearly support it, and it considers
  existing records across every lifecycle status (published/research/deleted/research_deleted) — a strong match
  against a deleted record still surfaces, flagged with `requiresHumanReview: true` and a lifecycle-conflict reason,
  never silently excluded or auto-resurrected.

**The similarity score formula, weights, and thresholds are unchanged** — this outcome layer only interprets the
existing evidence; `bun run queue`'s `matchScore`/`classification` values are identical to before this layer existed.
See **`docs/COMPANY_LOCATION_MODEL.md`** → "Similarity classification vs. business-resolution outcome" for full
outcome definitions, named thresholds, multi-match ranking rules, and known calibration limitations.

## Normalized values vs. raw BWI codes

Business Wise inherited shorthand codes from the original printed-directory/Delphi systems — site type (`S/H/B/R/U`)
and lifecycle status (`DIRE`/`DEL`/`RDL`/`RDEL`/`research`). Internal logic wants clean typed values; future
integration, debugging, and auditing need the exact original code preserved losslessly. The project stores **both**,
as explicit typed fields:

- `LocationCandidate.siteType` (normalized) + `LocationCandidate.rawSiteTypeCode` (exact raw string as given)
- `ExistingCompany.status` (exact raw string, never normalized away) + `ExistingCompany.lifecycleStatus` (normalized)

All BWI code translation is centralized in **`src/bwi-codes.ts`** (`normalizeBwiSiteType()`,
`normalizeBwiLifecycleStatus()`) rather than scattered as ad hoc string comparisons. Both functions are pure,
tolerant of case/whitespace/already-normalized input, and never throw — an unrecognized code normalizes to a safe
`"unknown"` value with `recognized: false` rather than crashing ingestion or silently pretending to be a known code.
Both `"RDL"` and `"RDEL"` normalize to the same `research_deleted` value without either spelling being treated as
canonical — see `docs/COMPANY_LOCATION_MODEL.md` → "Normalizing BWI legacy codes without losing raw values" for the
full design, and the "Known BWI status discrepancy" section below for why neither spelling is chosen.

Employee-size and revenue bands (`EmployeeSizeValue`/`RevenueValue`) already carry a `rawCode` field and can preserve
one if a source provides it, but there is deliberately **no** `normalizeBwiEmployeeBand`/`normalizeBwiRevenueBand`
function — `docs/BWI_DOMAIN_RULES.md` §11 states the complete BWI code dictionary for those bands "has not yet been
captured," so no mapping table is fabricated.

## Four separate concepts

Every candidate is evaluated along four axes that are deliberately kept independent. None of them implies the others,
and **none of them is approval** — a human still reviews and approves or rejects every record.

1. **Entity resolution** (`src/entity-resolution.ts` + `src/entity-resolution-policy.ts`) — "Does this candidate
   already exist in Business Wise?" The low-level layer produces a classification (`likely_new` /
   `possible_duplicate` / `likely_duplicate`), an overall match score, and separate `companySimilarity`
   (name/domain/SIC) and `locationSimilarity` (address/phone/city-state) evidence against `existing_companies`; the
   business-resolution layer built on top of it answers the richer operational question (same location? new branch?
   possible name change? ambiguous?) — see "Similarity classification vs. business-resolution outcome" above.
2. **Research completeness** (`src/scoring.ts`, `researchCompleteness()`) — "How much useful information have we
   gathered about this candidate?" A purely descriptive score (plus namespaced `presentFields`/`missingFields`, e.g.
   `company.website` vs `location.phone`) over the fields we currently model. A high completeness score does not
   mean the record is eligible to publish.
3. **Publication readiness** (`src/publication-readiness.ts`, `evaluatePublicationReadiness()`) — "Does this
   candidate satisfy Business Wise's actual required-field rules?" This is a rule-based pass/fail gate, not a
   percentage. It returns `ready`, `blockingReasons` (unmet rules we're confident are real requirements), and
   `unresolvedRequirements` (known BW fields whose required/optional status we haven't confirmed — see below).
4. **Review priority** (`src/scoring.ts`, `reviewPriority()`) — "Which candidate should a human look at first?" Built
   from entity resolution and research completeness only. It is intentionally independent of publication readiness:
   a high-priority record (e.g. a well-researched likely-new company in BW's core segment) can still be
   not-publication-ready, and a publication-ready record isn't automatically high priority.

### Publication readiness rules currently implemented

Emily's "AI Research" document marks required fields in bold and optional fields in italics, but the parsed text we
originally had did not reliably preserve that formatting. Rather than guess a full required-field list from
unreliable formatting, `evaluatePublicationReadiness()` only treats a rule as blocking (`confirmed_required`) when
we were confident it was actually required:

- **`min_one_contact`** — at least one contact with a name or email is required to publish. (Explicit in
  `docs/BWI_DOMAIN_RULES.md` §7.)
- **`company_name_present`** — defensive check; ingestion should already guarantee this.

Everything else the domain reference lists as a BW key field — local phone (with the "000-000-0000 means confirmed
but non-published" exception), physical address (with the "Not Listed allowed only with known ZIP + valid mailing
address" exception), SIC code, website, Site Type — is modeled and reported as `status: "unresolved"`:
it shows up in `unresolvedRequirements` when missing, but **never blocks `ready`**.

> **Known contradiction, not yet resolved in code:** `docs/BWI_DOMAIN_RULES.md` §8.2 now lists the blank BWI "New
> Company Profile"'s confirmed base blockers with **Confirmed** evidence status (from a screenshot showing required
> fields in green) — company name, alphasort, physical address (or exception), mailing address (or exception), local
> phone (or exception), building type, site type, employee-size band, start year, SIC code/description, and at least
> one contact. That is a materially larger confirmed-required set than the two rules implemented today. Per this
> project's change-control rule (`docs/BWI_DOMAIN_RULES.md` §25), promoting the rest of §8.2 from `unresolved` to
> `confirmed_required` — and adding the unmodeled fields (alphasort, start year check, building type check) — is a
> deliberate code change for a later numbered task, not done automatically just because the reference document says
> so. See `docs/COMPANY_LOCATION_MODEL.md` → "Known gaps vs. BWI_DOMAIN_RULES.md" for the full breakdown.

### Known BWI status discrepancy — unresolved

`docs/BWI_DOMAIN_RULES.md` §4 defines three status acronyms: **DIRE** (active/complete record published to the
client app), **DEL** (previously published, now deleted), and **RDL or RDEL** (research delete; never published —
"Unresolved spelling" per that document, and open domain question §23.1). The earlier discovery notes already in
this repo used **`RDL`** and a plain **`research`** status for the same-ish concepts (also open question §23.2).
`ExistingCompany.status` (`src/types.ts`) keeps all five raw-looking values (`DIRE | DEL | RDEL | RDL | research`)
rather than silently normalizing one to the other — this is flagged as unresolved domain configuration until
Emily/Rif/Randall confirm which strings BW's system actually persists. `docs/BWI_DOMAIN_RULES.md` §4 additionally
recommends preserving a raw `rawBwiStatus: string` mapped separately to a normalized lifecycle enum
(`published`/`research`/`research_deleted`/`deleted`) — this **is** implemented: `ExistingCompany.lifecycleStatus`,
computed from `status` by `normalizeBwiLifecycleStatus()` (`src/bwi-codes.ts`), maps both `RDL` and `RDEL` to the
same `research_deleted` value. That normalization answers "what does this status mean internally," not "which raw
spelling is correct" — the raw string is still preserved verbatim on `status`, and neither `RDL` nor `RDEL` is
treated as canonical for future writeback. See "Normalized values vs. raw BWI codes" above.

## Source ingestion layer

New-company intake used to come from a research staff reading chamber reports, business journals, and county license
data by hand. That staff no longer exists, so intake is now a pipeline:

```
external source -> SourceAdapter -> RawSourceRecord[] -> mapping/validation -> CompanyIdentity + LocationCandidate -> existing pipeline
```

A `SourceAdapter` (`src/sources/types.ts`) is the only thing that knows about one external source's shape:

```ts
interface SourceAdapter {
  sourceId: string;
  sourceName: string;
  fetch(): Promise<RawSourceRecord[]>;
  toCandidate(record: RawSourceRecord): MappingResult; // { ok: true, candidate: LocationCandidateDraft } | { ok: false, reason }
}
```

A `LocationCandidateDraft` is a `LocationCandidate` with a nested `company: CompanyIdentityDraft` — the adapter maps
each raw row into both the company-level and location-level fields at once; the engine fills in the generated ids and
provenance. The core ingestion engine (`src/ingestion.ts`) is source-agnostic: it calls `fetch()`, maps/validates each
raw record, deduplicates against what's already been ingested, builds one fresh `CompanyIdentity` + one
`LocationCandidate` per new item, persists both, and records a `source_runs` row with counts. It never touches entity
resolution or scoring — those still run later, in `run.ts`, over whatever candidates are sitting in the database. See
**`docs/COMPANY_LOCATION_MODEL.md`** for why ingestion always creates a fresh provisional identity rather than trying
to merge companies across sources.

### Ingestion deduplication vs. entity resolution

These are two different questions and this codebase keeps them separate:

- **Ingestion deduplication** ("have we already processed this exact source item?") lives in `src/ingestion.ts` /
  `src/sources/fingerprint.ts` and the `source_records` table. It's keyed on `sourceId + sourceRecordId` when the
  source provides a stable id, or on a deterministic hash of stable fields (name/city/state/address/URL) when it
  doesn't. Running the same source twice will not create duplicate location candidates.
- **Entity resolution** ("does this company/location already exist in Business Wise?") is `entity-resolution.ts`
  comparing a `LocationCandidate` against `existing_companies`, with company-level and location-level evidence kept
  separate (`companySimilarity` / `locationSimilarity`).

Because of this split, two different sources can both legitimately produce an observation for the same real-world
company (e.g. a chamber report finds "Acme Logistics" and a business journal finds "Acme Logistics Inc." the next
day). Ingestion keeps both as separate provisional company identities and location candidates — resolving whether
they're the same company, or the same existing BW record, is entity resolution's job, not ingestion's.

### Provenance

Every location candidate now carries where it came from, in `candidate.source`: `sourceId`, `sourceName`,
`sourceUrl`, `sourceRecordId`, `fingerprint` (the idempotency key), and `ingestedAt`. `capturedAt` (when the source
says the record was discovered/published) and `rawSourceData` (the original raw record, for audit/debugging) sit on
the candidate itself.

### Sample sources

Two local fixture adapters prove the architecture until a real DFW feed is available:

| sourceId  | Adapter                    | Fixture                                        |
|-----------|-----------------------------|-------------------------------------------------|
| `dfw-json`| `src/sources/dfw-json-adapter.ts` | `data/sources/dfw-json-sample.json` |
| `dfw-csv` | `src/sources/dfw-csv-adapter.ts`  | `data/sources/dfw-county-licenses-sample.csv` |

Each fixture intentionally includes: a fully-populated record with a contact (publication-ready), a record with only
name+city, a record missing phone, a record missing employee count, a record with a source URL, an exact duplicate
row within the same file, and a malformed row (no company name) that gets skipped without crashing the run. Only two
of the nine ingested candidates have a contact; the rest demonstrate `publicationReady: false` even when reasonably
complete. Three records also carry a raw BWI site-type code to exercise `normalizeBwiSiteType()` end to end: Pioneer
Steel Fabricators (`"H"` → `headquarters`), Blue Cactus Roasters (`"s"` → `single_site`), Harbor Point Consulting
(`"b"` → `branch`), and Trinity Grove Bakery Co carries an unrecognized code (`"Q"` → `unknown`,
`recognized: false`) to prove an unmapped code doesn't crash ingestion. All four are records with no employee count,
chosen deliberately so `bun run queue`'s scores/priorities stay identical to before this normalization was added —
only the `siteType` column changes.

### Adding a new SourceAdapter

1. Create `src/sources/<name>-adapter.ts` exporting a factory that returns a `SourceAdapter`.
2. Implement `fetch()` to pull raw records (file read, API call, etc.) and return `RawSourceRecord[]` — each one is
   just `{ recordId?, data }`, so put whatever shape the source uses in `data`.
3. Implement `toCandidate()` to validate and map one `RawSourceRecord` into a `LocationCandidateDraft`: a
   `LocationCandidate` minus the fields the engine fills in (`id`, `company.id`, `source`), with `company` as a
   `CompanyIdentityDraft` (company-level fields the source gave you) and everything else as location-level fields.
   `contacts` and `evidence` are required arrays — pass `[]` if the source has none. Return `{ ok: false, reason }`
   for anything unusable — a bad row must never throw and crash the whole run. Keep source-specific field names and
   quirks inside the adapter; the ingestion engine has no idea which columns belong to which source.
4. Register it in `src/sources/registry.ts`.

## Run locally

Requires Bun.

```bash
bun install
bun run reset      # init db, seed BW companies, ingest both sample sources, run scoring
bun run queue
```

Or step by step:

```bash
bun run init
bun run seed
bun run ingest --source=dfw-json
bun run ingest --source=dfw-csv
bun run run        # entity resolution + scoring over everything ingested so far
bun run queue
```

Run `bun run ingest --source=dfw-json` a second time and you'll see `New candidates: 0` — already-ingested source
records are recognized and skipped, not re-inserted.

Run the test suite with:

```bash
bun test
```

Expected behavior with the sample data (`bun run reset && bun run queue`):

- All 9 ingested candidates classify as `likely_new` (and resolve to `likely_new_company`) against the seeded
  `existing_companies` — none of the DFW/CSV fixture companies are meant to match the seeded BW records, so the
  richer outcome layer correctly agrees there's nothing to match against. See
  `src/entity-resolution-policy.test.ts` for focused fixtures exercising `same_existing_location`,
  `new_branch_of_existing_company`, `possible_name_change`, `ambiguous_manual_review`, and the rest — deliberately
  not mixed into this demo data, per the "prefer focused test fixtures over polluting the queue demo" guidance.
- Only **Westline Freight Solutions** and **Ridgeline Precision Machining** — the two fixture records with a
  contact — show `publicationReady: yes`. Every other candidate is blocked on `min_one_contact`, regardless of how
  complete or high-priority it is.
- **Cedar Ridge Analytics** is a good example of the four-concepts split: it has relatively high research
  completeness and review priority (it falls in the 10–99 employee core segment) while still `publicationReady:
  no` — priority and completeness never imply approval.

`data/candidates.sample.json` is the original, pre-ingestion-layer, pre-company/location-split fixture and is no
longer read by any script; it's kept only for reference and does not reflect the current domain model. New sample
data belongs under `data/sources/` behind a `SourceAdapter`.

See **`docs/COMPANY_LOCATION_MODEL.md`** for the company-identity/location-candidate domain model in depth.

## Next engineering steps

`docs/BWI_DOMAIN_RULES.md` §23 ("Open domain questions") is the authoritative backlog of what needs confirming from
Emily/Jen/Rif/Randall before more rules can move from `unresolved` to implemented. The steps below are the
code-focused follow-ups building on that:

1. Plug in a real DFW source (chamber report export, business journal feed, or county license dataset) behind a new `SourceAdapter`.
2. Promote the broader confirmed-required set in `docs/BWI_DOMAIN_RULES.md` §8.2 (physical address, local phone, SIC, site type, building type, alphasort, start year) from `unresolved`/unmodeled to `confirmed_required` in `src/publication-readiness.ts`, once the team decides the evidence in §8.2 is sufficient to act on — see `docs/COMPANY_LOCATION_MODEL.md`'s gaps section for the current state.
3. Resolve which BWI status string is actually persisted (`DIRE`/`DEL`/`RDEL` vs. `RDL`/`research`,
   `docs/BWI_DOMAIN_RULES.md` §23.1–2), and either collapse `ExistingCompanyStatus` accordingly or pick a canonical
   writeback spelling for `research_deleted` in `src/business-wise-adapter.ts`. (The raw/normalized split itself —
   `status` + `lifecycleStatus` — is already implemented; what's left is the underlying spelling question.)
4. Add field-level evidence provenance (`FieldEvidence<T>` per `docs/BWI_DOMAIN_RULES.md` §15) so every proposed value can be inspected by Emily/Jen.
5. Add enrichment adapters for website, LinkedIn/team pages, phone/email validation, and SIC proposal.
6. Build a **labeled evaluation dataset** (real or realistic candidate/existing-record pairs with a researcher's actual same-location/branch/HQ/name-change/new-company judgment) and use it to measure precision/recall per `EntityResolutionOutcome` and retune the named thresholds in `src/entity-resolution-policy.ts` (`STRONG_COMPANY_NAME_SCORE`, `STRONG_ADDRESS_SCORE`, `AMBIGUOUS_SCORE_MARGIN`, etc.) — those thresholds are reasoned defaults today, not calibrated ones.
7. Split `possible_changed_location` back into `docs/BWI_DOMAIN_RULES.md` §12.4's separate `possible_same_location_changed_details` / `possible_headquarters_move` outcomes once there's reliable evidence (e.g. confirmed move dates) to distinguish them — see `docs/COMPANY_LOCATION_MODEL.md`'s gaps section for why they're merged today.
8. Implement the §12.5 field-inheritance proposal (safe company-level fields like website/SIC/start year proposed for inheritance when linking a `new_branch_of_existing_company`/`new_headquarters_of_existing_company` to its matched identity) — `EntityResolutionDecision` already surfaces the matched/related existing-company ids needed for this.
9. Build a simple review UI only after the candidate schema and review decisions stabilize — a natural place to surface `EntityResolutionDecision.reasons`/`conflicts`/`alternativeMatches` for a reviewer.
10. Implement the production `BusinessWiseAdapter` after Rif/Randall confirm architecture and write boundaries.
11. Once BWI's real employee-size/revenue band code dictionary is captured (`docs/BWI_DOMAIN_RULES.md` §11, unresolved), add `normalizeBwiEmployeeBand`/`normalizeBwiRevenueBand` to `src/bwi-codes.ts` — deliberately not invented in this task.

## Non-goals for this starter

- No autonomous publishing.
- No writes to BWI or the client database.
- No assumption that Delphi, Azure SQL, or ADF is the authoritative write path.
- No claim that the current matching thresholds are production-ready; they are starting hypotheses to measure against human review.
- No automated company-identity mastering/merging — ingestion always creates a fresh provisional `CompanyIdentity`
  per observation; consolidating provisional identities into one real company is deliberately left to a future,
  more deliberate entity-resolution step (see `docs/COMPANY_LOCATION_MODEL.md`).
