# Business Wise — Project 1 Starter

A safe, local vertical slice for the proposed DFW automated new-company intake pilot.

> **Authoritative domain reference:** [`docs/BWI_DOMAIN_RULES.md`](docs/BWI_DOMAIN_RULES.md) consolidates everything
> currently known about how Business Wise represents, researches, completes, publishes, and exposes company data —
> evidence-labeled Confirmed/Conditional/Inferred/Unresolved. When this README and that document disagree, the
> domain-rules document wins; this README (and `docs/COMPANY_LOCATION_MODEL.md`) describe what the code currently
> implements, which is intentionally a subset of it. See `docs/COMPANY_LOCATION_MODEL.md`'s "Known gaps vs.
> BWI_DOMAIN_RULES.md" section for the specific, tracked differences.

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
rationale, a diagram, and how entity resolution's company/location evidence split will later support richer outcomes
like "new branch of an existing company" or "headquarters move."

## Four separate concepts

Every candidate is evaluated along four axes that are deliberately kept independent. None of them implies the others,
and **none of them is approval** — a human still reviews and approves or rejects every record.

1. **Entity resolution** (`src/entity-resolution.ts`) — "Does this candidate already exist in Business Wise?" Produces
   a classification (`likely_new` / `possible_duplicate` / `likely_duplicate`), an overall match score, and separate
   `companySimilarity` (name/domain/SIC) and `locationSimilarity` (address/phone/city-state) evidence against
   `existing_companies`.
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
(`published`/`research`/`research_deleted`/`deleted`); the code does not yet implement that normalized/raw split —
tracked in `docs/COMPANY_LOCATION_MODEL.md`'s gaps section.

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
complete.

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

- All 9 ingested candidates classify as `likely_new` against the seeded `existing_companies` (none of the DFW/CSV
  fixture companies are meant to match the seeded BW records).
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
3. Resolve which BWI status strings (`DIRE`/`DEL`/`RDEL` vs. `RDL`/`research`) are actually persisted (`docs/BWI_DOMAIN_RULES.md` §23.1–2), and either collapse `ExistingCompanyStatus` accordingly or implement the recommended raw/normalized lifecycle split from §4.
4. Add field-level evidence provenance (`FieldEvidence<T>` per `docs/BWI_DOMAIN_RULES.md` §15) so every proposed value can be inspected by Emily/Jen.
5. Add enrichment adapters for website, LinkedIn/team pages, phone/email validation, and SIC proposal.
6. Evaluate entity-resolution thresholds against Emily's manual judgments on a labeled sample.
7. Use the `companySimilarity`/`locationSimilarity` split in `MatchResult` to derive the richer outcome taxonomy in `docs/BWI_DOMAIN_RULES.md` §12.4 (same existing location, new branch of an existing company, headquarters move, ...) once there's a labeled sample to validate against.
8. Build a simple review UI only after the candidate schema and review decisions stabilize.
9. Implement the production `BusinessWiseAdapter` after Rif/Randall confirm architecture and write boundaries.

## Non-goals for this starter

- No autonomous publishing.
- No writes to BWI or the client database.
- No assumption that Delphi, Azure SQL, or ADF is the authoritative write path.
- No claim that the current matching thresholds are production-ready; they are starting hypotheses to measure against human review.
- No automated company-identity mastering/merging — ingestion always creates a fresh provisional `CompanyIdentity`
  per observation; consolidating provisional identities into one real company is deliberately left to a future,
  more deliberate entity-resolution step (see `docs/COMPANY_LOCATION_MODEL.md`).
