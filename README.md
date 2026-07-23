# Business Wise — Project 1 Starter

A safe, local vertical slice for the proposed DFW automated new-company intake pilot.

> **Authoritative domain reference:** [`docs/BWI_DOMAIN_RULES.md`](docs/BWI_DOMAIN_RULES.md) consolidates everything
> currently known about how Business Wise represents, researches, completes, publishes, and exposes company data —
> evidence-labeled Confirmed/Conditional/Inferred/Unresolved. When this README and that document disagree, the
> domain-rules document wins; this README (and `docs/COMPANY_LOCATION_MODEL.md`) describe what the code currently
> implements, which is intentionally a subset of it. See `docs/COMPANY_LOCATION_MODEL.md`'s "Known gaps vs.
> BWI_DOMAIN_RULES.md" section for the specific, tracked differences. See
> [`docs/BWI_PRODUCTION_DB_DISCOVERY.md`](docs/BWI_PRODUCTION_DB_DISCOVERY.md) for the July 2026 production-database
> discovery record informing the write boundaries described below, and
> [`docs/BWI_READ_ONLY_IMPORT.md`](docs/BWI_READ_ONLY_IMPORT.md) for the Task 7 read-only import path from BWI's
> canonical directory into this sandbox.

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
   candidate satisfy Business Wise's actual required-field rules for a human-reviewed BWI research packet?" This is
   a structured, three-state assessment (`state: "blocked" | "provisionally_ready" | "confirmed_ready"`), not a
   percentage and not a plain boolean — see "Publication readiness: three states" below. Readiness never authorizes
   a direct write or publish in production; see `docs/BWI_PRODUCTION_DB_DISCOVERY.md`.
4. **Review priority** (`src/scoring.ts`, `reviewPriority()`) — "Which candidate should a human look at first?" Built
   from entity resolution and research completeness only. It is intentionally independent of publication readiness:
   a high-priority record (e.g. a well-researched likely-new company in BW's core segment) can still be blocked, and
   a `confirmed_ready` record isn't automatically high priority.

### Publication readiness: three states

`evaluatePublicationReadiness()` (`src/publication-readiness.ts`) returns a `PublicationReadinessAssessment` — the
single source of truth for readiness in this codebase; there is no separate binary readiness calculation anywhere
else:

```ts
type PublicationReadinessAssessment = {
  state: "blocked" | "provisionally_ready" | "confirmed_ready";
  blockers: PublicationReadinessIssue[];             // confirmed requirements definitely unsatisfied
  unresolvedRules: PublicationReadinessIssue[];       // material rules still needing human confirmation
  satisfiedRequirements: PublicationReadinessRequirement[];
  optionalMissingFields: string[];                    // never affects state
};
```

- **`blocked`** — at least one confirmed base requirement, or an applicable conditional requirement, is definitely
  unsatisfied (missing, invalid, or a required exception is absent).
- **`provisionally_ready`** — no definite blocker, but at least one material rule still needs human confirmation
  (today: a local phone is missing but the physical location is confirmed, so BW's 000-000-0000 non-published-phone
  exception (`docs/BWI_DOMAIN_RULES.md` §9) may apply but isn't yet confirmed). Never used as a generic fallback for
  ordinary incomplete records — definite missing required data is `blocked`.
- **`confirmed_ready`** — every applicable confirmed base and conditional requirement is satisfied and no material
  rule remains unresolved. Optional missing fields never affect this.

The confirmed base requirements (`docs/BWI_DOMAIN_RULES.md` §8.2, from the blank BWI "New Company Profile"'s
required-in-green fields) are: company name, alphasort, physical address (or ZIP + valid mailing address exception),
local phone (or the 000-000-0000 exception), building type, site type, employee size at the site, start year, SIC
code, and at least one meaningful contact. Single Site/Headquarters records additionally require (§8.3)
company-wide employee size, estimated revenue band, and total sites — Branch/Regional Headquarters records are not
blocked by those three. Square footage, lease expiration, email format, and parent-company information (§8.4) are
confirmed optional and only ever appear in `optionalMissingFields`, never `blockers`.

Every issue (`PublicationReadinessIssue`) carries a stable `ruleId`, a `scope` (`company`/`location`/`contact`), a
human-readable `explanation`, whether an approved exception could satisfy it, and the normalized/raw value
considered — both machine- and human-readable, not just a list of missing field names.

**Compatibility boolean:** `isPublicationReadyCompat(assessment)` (`src/publication-readiness.ts`) returns
`assessment.state === "confirmed_ready"`, for consumers not yet reading `state` directly (the sandbox DB's
`review_queue.publication_ready` column). It is always derived from the structured assessment, never calculated
independently, and is marked `TODO(remove)` — delete it once every consumer reads `publication_state`/`state`
directly. `provisionally_ready` is deliberately **not** publication-ready under this boolean.

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

### Field-level evidence and confidence

Beyond record-level `SourceProvenance`, individual proposed values can carry their own evidence — implementing
`docs/BWI_DOMAIN_RULES.md` §15's `FieldEvidence<T>` shape. This answers a narrower question than provenance above:
not just "where did this whole observation come from," but "where did *this specific value* come from, and how
confident are we in it."

```ts
type FieldEvidence<T> = {
  path: FieldPath;                 // { scope: "company" | "location", field } or { scope: "contact", contactId, field }
  value: T;
  normalizedValue?: T;
  rawValue?: unknown;
  confidence: number;              // 0-1, validated -- see below
  source: FieldEvidenceSource;     // sourceType, sourceId, sourceName, sourceUrl?, sourceRecordId?, sourceObservationId?
  capturedAt?: string;             // never fabricated when unknown
  evidenceText?: string;
  derivation?: "directly_observed" | "normalized" | "derived" | "inherited" | "human_confirmed";
  inheritance?: FieldEvidenceInheritance; // present only when derivation === "inherited"
};
```

All of this lives in `src/types.ts`, alongside `SourceProvenance` rather than as a second, competing source model:
`FieldEvidenceSource` reuses `SourceProvenance`'s own field names (`sourceId`/`sourceName`/`sourceUrl`/
`sourceRecordId`, via `Pick`) plus a `sourceType` category (company website, chamber of commerce, county business
license, human research decision, existing BWI record, ...) and an optional `sourceObservationId` fallback for
sources with no natural URL (an authorized BWI export, a human research decision, a local CSV row).

**Field identification.** `FieldPath` is a small discriminated union, not a free-text label — `{ scope: "company",
field: "website" }`, `{ scope: "location", field: "phone" }`, or `{ scope: "contact", contactId, field: "email" }`.
Contact evidence is linked via `Contact.id` (a new optional field, assigned by the ingesting adapter), not array
position, so it survives the contacts array being reordered or grown. `fieldPathKey()` gives a stable string key for
grouping/lookup; `evidenceForField()` and `hasFieldEvidence()` (`src/types.ts`) read a candidate's evidence without
each caller re-deriving that key.

**Confidence scale.** 0 (no confidence) through 1 (fully confirmed) — the same 0–1 convention `MatchResult.score` and
`EntityResolutionDecision.decisionConfidence` already use. `assertValidFieldEvidenceConfidence()` throws a
`RangeError` for anything outside `[0, 1]` or non-finite; `createFieldEvidence()` (the only way to construct a
`FieldEvidence`) always calls it, so an invalid confidence can never silently enter a candidate's evidence.
**Missing evidence is never treated as confidence 1.0** — a field with a value but zero evidence records is
surfaced explicitly (`missingEvidence: true` in `src/field-evidence-view.ts`), never assumed confirmed.
**Needs confirmation from Jushen:** the exact confidence values BW reviewers should expect (e.g. what a single
unverified chamber-feed row vs. a human-confirmed value should read as) are not defined anywhere in the domain docs
yet. The two DFW fixture adapters use one documented, deliberately conservative placeholder —
`SINGLE_SOURCE_OBSERVED_CONFIDENCE = 0.6` — for every value they read from a single unverified source record; this
is a starting point, not a calibrated scale.

**Multiple and conflicting evidence.** `FieldEvidence` records live in a plain array
(`LocationCandidate.fieldEvidence`), never a map keyed by field — so adding new evidence is always an append
(`addFieldEvidence()`), and a field legitimately ending up with several agreeing sources, or two sources that
disagree, is represented directly: nothing in this model ever overwrites or discards earlier evidence for the same
field. `src/field-evidence-view.ts`'s `summarizeCandidateFieldEvidence()` flags `conflicting: true` when 2+ records
for one field disagree on `value`.

**Direct vs. normalized vs. derived vs. inherited vs. human-confirmed.** `derivation` names which of these a value
is; `inheritance` (present only for `derivation: "inherited"`) preserves which existing BWI record or prior
observation a value was proposed from, why, and whether the new candidate has independent confirming evidence of its
own (`independentlyConfirmed`) — inherited values are never assumed confirmed just because they were inherited. Only
the *type* is implemented in Task 6; no inheritance-proposal logic runs anywhere in the pipeline yet (that's
`docs/COMPANY_LOCATION_MODEL.md` §12.5's still-open "Field inheritance" gap) — entity-resolution/inheritance rules
are explicitly unchanged by this task.

**Missing-evidence behavior.** Legacy candidates/fixtures predating Task 6 simply have `fieldEvidence: undefined` —
`evidenceForField()`/`hasFieldEvidence()` treat that exactly like an empty array rather than throwing or requiring a
migration. A value with no evidence is reported as unverified, never silently treated as confirmed, and never given
a fabricated source URL, confidence, or capture time.

**Where evidence is attached.** `src/sources/dfw-json-adapter.ts` and `src/sources/dfw-csv-adapter.ts` attach
`FieldEvidence` only for values the raw source row genuinely supports (never fabricated for absent fields), using
that source's own `sourceType`/`sourceId`/`sourceName`/`sourceUrl`/`sourceRecordId` — the same source identity
already on the candidate's `source: SourceProvenance`. `capturedAt` on each evidence record comes from the row's own
captured/published date when the source gives one, and is left `undefined` otherwise (never `Date.now()`, so
domain/adapter logic stays deterministic and testable with fixed timestamps).

**Persistence.** `location_candidates.field_evidence_json` (`src/db.ts`) stores `candidate.fieldEvidence` as JSON,
mirroring how `evidence_json` already stores the free-text `evidence` list — both are also captured in `raw_json`,
the full point-in-time candidate snapshot `loadLocationCandidates()` reads from. Rows inserted before this column
existed load safely with `fieldEvidence: undefined` (`DEFAULT '[]'` plus the optional TypeScript field). No
migration framework is used — this is still the disposable local sandbox; `bun run reset` recreates the schema from
scratch. Ingestion's existing fingerprint-based dedup means a source item that's already been ingested is skipped
entirely, so rerunning `bun run ingest` never re-inserts a candidate or duplicates its evidence.

**Reviewer visibility.** `bun run queue` prints its existing scannable summary table unchanged, then a new "Field
evidence detail" text block (`src/field-evidence-view.ts`) beneath it: for each candidate, one line per field with a
value, showing confidence, source type(s)/reference(s), and a `[CONFLICTING]` flag when evidence disagrees — or an
explicit `NO EVIDENCE` marker when a value exists with none recorded. Contacts are shown by name/email with the
same per-field detail, keyed to their stable `Contact.id`. This is deliberately a readable text report, not a raw
`FieldEvidence[]` dump — full detail is still available by reading `LocationCandidate.fieldEvidence` directly for
anything the summary doesn't show.

**What field evidence is not.** Field confidence is a different concept from `EntityResolutionDecision
.decisionConfidence` (match confidence — is this the same company/location?), `ResearchCompletenessResult.score`
(how much do we know?), `PublicationReadinessAssessment.state` (does it satisfy BW's required-field rules?), and
`reviewPriority` (which candidate to look at first). None of the four axes described in "Four separate concepts"
above reads `fieldEvidence` or `confidence`, and this task did not add a fifth axis or a second readiness engine —
field evidence exists purely so a reviewer can audit *why* a proposed value looks the way it does. Evidence and
confidence never authorize production entry or publication — see "Non-goals for this starter" below and
`docs/BWI_PRODUCTION_DB_DISCOVERY.md` for the write boundary; a `confirmed_ready` assessment (with or without
evidence attached) still ends in manual entry through the existing authorized BW/Delphi workflow.

### Sample sources

Two local fixture adapters prove the architecture until a real DFW feed is available:

| sourceId  | Adapter                    | Fixture                                        |
|-----------|-----------------------------|-------------------------------------------------|
| `dfw-json`| `src/sources/dfw-json-adapter.ts` | `data/sources/dfw-json-sample.json` |
| `dfw-csv` | `src/sources/dfw-csv-adapter.ts`  | `data/sources/dfw-county-licenses-sample.csv` |

Each fixture intentionally includes: a fully-populated record with a contact, a record with only name+city, a record
missing phone, a record missing employee count, a record with a source URL, an exact duplicate row within the same
file, and a malformed row (no company name) that gets skipped without crashing the run. Only two of the nine
ingested candidates have a contact. None of the fixtures set every confirmed-required field from
`docs/BWI_DOMAIN_RULES.md` §8.2 (e.g. none set `company.alphasort`), so all nine currently evaluate to
`state: "blocked"` — see "Expected behavior with the sample data" below. Three records also carry a raw BWI site-type code to exercise `normalizeBwiSiteType()` end to end: Pioneer
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

## BWI read-only import (real comparison data)

Everything above is about *incoming candidates* (`LocationCandidate`) — new-company discovery from DFW sources.
Task 7 adds the other half: importing BWI's own **existing** company-location records (`ExistingCompany`) so entity
resolution has real comparison data to match candidates against, instead of only `seed.ts`'s three synthetic
fixtures.

```bash
bun run bwi:import -- --file=data/sources/bwi-snapshot-sample.csv   # local CSV snapshot import
bun run bwi:search -- --name="Acme"                                  # search the locally-imported records
bun run bwi:smoke -- --live --limit=10                               # manual-only: read 10 rows from a real BWI DB
```

Imported records land in the same `existing_companies` table (and the same `ExistingCompany` type) `seed.ts` already
populates and `run.ts` already reads for matching — so importing more real records requires **zero changes** to
`entity-resolution.ts`/`entity-resolution-policy.ts`/`run.ts`. Two adapters (a local CSV snapshot and a direct,
structurally read-only SQL Server adapter over BWI's canonical `DirCompany`/`DirCompanyDirectory` tables) share one
normalization path, so they can never drift into two different domain models. The live adapter is never invoked by
`bun test` or `bun run reset` — only by the explicit, manually-run `bun run bwi:smoke -- --live` command, gated on
local `BWI_DB_*` environment variables (see `.env.example`) that are never committed.

Full detail — snapshot schema, credential handling, read-only enforcement, upsert/persistence semantics, and the
column-name caveat for the live adapter — lives in **[`docs/BWI_READ_ONLY_IMPORT.md`](docs/BWI_READ_ONLY_IMPORT.md)**.

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
- All 9 candidates currently evaluate to `state: "blocked"`, because none of the fixtures sets every confirmed
  base requirement (`docs/BWI_DOMAIN_RULES.md` §8.2) — e.g. none sets `company.alphasort` or `location.buildingType`.
  The fixtures were written before `evaluatePublicationReadiness()` implemented the full §8.2/§8.3 rule set and are
  a fair demonstration case for `blockers`/`unresolvedRules` reporting, not for reaching `confirmed_ready`; see
  `src/publication-readiness.test.ts` for fixtures that do reach every state.
- **Westline Freight Solutions** and **Ridgeline Precision Machining** are the only two fixture records with a
  contact, so they're the only two candidates never blocked on `min_one_contact` — every other candidate is,
  regardless of how complete or high-priority it is.
- **Cedar Ridge Analytics** is a good example of the four-concepts split: it has relatively high research
  completeness and review priority (it falls in the 10–99 employee core segment) while still `state: "blocked"` —
  priority and completeness never imply readiness, and readiness never implies approval or production write access.

`data/candidates.sample.json` is the original, pre-ingestion-layer, pre-company/location-split fixture and is no
longer read by any script; it's kept only for reference and does not reflect the current domain model. New sample
data belongs under `data/sources/` behind a `SourceAdapter`.

See **`docs/COMPANY_LOCATION_MODEL.md`** for the company-identity/location-candidate domain model in depth.

## Next engineering steps

`docs/BWI_DOMAIN_RULES.md` §23 ("Open domain questions") is the authoritative backlog of what needs confirming from
Emily/Jen/Rif/Randall before more rules can move from `unresolved` to implemented. The steps below are the
code-focused follow-ups building on that:

1. Plug in a real DFW source (chamber report export, business journal feed, or county license dataset) behind a new `SourceAdapter`.
2. ~~Promote the broader confirmed-required set in `docs/BWI_DOMAIN_RULES.md` §8.2 to `confirmed_required`.~~ **Done** — `evaluatePublicationReadiness()` now implements the full §8.2 base set and §8.3's conditional Single Site/Headquarters requirements as a three-state `PublicationReadinessAssessment` (`blocked`/`provisionally_ready`/`confirmed_ready`); see "Publication readiness: three states" above.
3. Resolve which BWI status string is actually persisted (`DIRE`/`DEL`/`RDEL` vs. `RDL`/`research`,
   `docs/BWI_DOMAIN_RULES.md` §23.1–2), and either collapse `ExistingCompanyStatus` accordingly or pick a canonical
   writeback spelling for `research_deleted` in `src/business-wise-adapter.ts`. (The raw/normalized split itself —
   `status` + `lifecycleStatus` — is already implemented; what's left is the underlying spelling question.)
4. ~~Add field-level evidence provenance (`FieldEvidence<T>` per `docs/BWI_DOMAIN_RULES.md` §15) so every proposed value can be inspected by Emily/Jen.~~ **Done (Task 6)** — see "Field-level evidence and confidence" above. Still open: the actual confidence-scale calibration (needs confirmation from Jushen), and wiring real field-level evidence into an inheritance-proposal flow (item 8 below).
5. Add enrichment adapters for website, LinkedIn/team pages, phone/email validation, and SIC proposal.
6. Build a **labeled evaluation dataset** (real or realistic candidate/existing-record pairs with a researcher's actual same-location/branch/HQ/name-change/new-company judgment) and use it to measure precision/recall per `EntityResolutionOutcome` and retune the named thresholds in `src/entity-resolution-policy.ts` (`STRONG_COMPANY_NAME_SCORE`, `STRONG_ADDRESS_SCORE`, `AMBIGUOUS_SCORE_MARGIN`, etc.) — those thresholds are reasoned defaults today, not calibrated ones.
7. Split `possible_changed_location` back into `docs/BWI_DOMAIN_RULES.md` §12.4's separate `possible_same_location_changed_details` / `possible_headquarters_move` outcomes once there's reliable evidence (e.g. confirmed move dates) to distinguish them — see `docs/COMPANY_LOCATION_MODEL.md`'s gaps section for why they're merged today.
8. Implement the §12.5 field-inheritance proposal (safe company-level fields like website/SIC/start year proposed for inheritance when linking a `new_branch_of_existing_company`/`new_headquarters_of_existing_company` to its matched identity) — `EntityResolutionDecision` already surfaces the matched/related existing-company ids needed for this.
9. Build a simple review UI only after the candidate schema and review decisions stabilize — a natural place to surface `EntityResolutionDecision.reasons`/`conflicts`/`alternativeMatches` for a reviewer.
10. Implement the production `BusinessWiseAdapter` after Rif/Randall confirm architecture and write boundaries.
11. Once BWI's real employee-size/revenue band code dictionary is captured (`docs/BWI_DOMAIN_RULES.md` §11, unresolved), add `normalizeBwiEmployeeBand`/`normalizeBwiRevenueBand` to `src/bwi-codes.ts` — deliberately not invented in this task.
12. ~~Build a real, read-only import path from BWI's canonical directory so entity resolution has a real comparison universe (`docs/OPTION_A_DISCOVERY_DESIGN.md` §23.12's hard gate) instead of only synthetic `seed.ts` fixtures.~~ **Done (Task 7)** — see "BWI read-only import" above and `docs/BWI_READ_ONLY_IMPORT.md`. Still open: confirming the exact `DirCompany`/`DirCompanyDirectory` column names in `src/sources/bwi/live-adapter.ts`'s `SCHEMA` constant (needs confirmation from Jushen — not verified against the real schema) and the canonical-import confidence calibration (`BWI_CANONICAL_IMPORT_CONFIDENCE`, also needs confirmation from Jushen).

## Non-goals for this starter

- No autonomous publishing.
- No writes to BWI or the client database.
- No assumption that Delphi, Azure SQL, or ADF is the authoritative write path.
- No claim that the current matching thresholds are production-ready; they are starting hypotheses to measure against human review.
- No automated company-identity mastering/merging — ingestion always creates a fresh provisional `CompanyIdentity`
  per observation; consolidating provisional identities into one real company is deliberately left to a future,
  more deliberate entity-resolution step (see `docs/COMPANY_LOCATION_MODEL.md`).
