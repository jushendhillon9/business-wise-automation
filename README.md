# Business Wise — Project 1 Starter

A safe, local vertical slice for the proposed DFW automated new-company intake pilot.

## What this proves first

`source candidate -> normalized record -> entity-resolution score -> prioritized human review queue`

It deliberately does **not** write to Business Wise production systems. The real BWI / SQL / Azure / ADF integration stays behind `BusinessWiseAdapter` until technical discovery with Rif and Randall is complete.

## Why this is the right first slice

The current Business Wise workflow has known intake sources, manual duplicate review, required publish fields, manual SIC work, and a human publication gate. This starter isolates the reusable intelligence layer from the unknown production architecture.

## Source ingestion layer

New-company intake used to come from a research staff reading chamber reports, business journals, and county license
data by hand. That staff no longer exists, so intake is now a pipeline:

```
external source -> SourceAdapter -> RawSourceRecord[] -> mapping/validation -> CandidateCompany[] -> existing pipeline
```

A `SourceAdapter` (`src/sources/types.ts`) is the only thing that knows about one external source's shape:

```ts
interface SourceAdapter {
  sourceId: string;
  sourceName: string;
  fetch(): Promise<RawSourceRecord[]>;
  toCandidate(record: RawSourceRecord): MappingResult; // { ok: true, candidate } | { ok: false, reason }
}
```

The core ingestion engine (`src/ingestion.ts`) is source-agnostic: it calls `fetch()`, maps/validates each raw record,
deduplicates against what's already been ingested, persists new `CandidateCompany` rows, and records a `source_runs`
row with counts. It never touches entity resolution or scoring — those still run later, in `run.ts`, over whatever
candidates are sitting in the database.

### Ingestion deduplication vs. entity resolution

These are two different questions and this codebase keeps them separate:

- **Ingestion deduplication** ("have we already processed this exact source item?") lives in `src/ingestion.ts` /
  `src/sources/fingerprint.ts` and the `source_records` table. It's keyed on `sourceId + sourceRecordId` when the
  source provides a stable id, or on a deterministic hash of stable fields (name/city/state/address/URL) when it
  doesn't. Running the same source twice will not create duplicate candidate rows.
- **Entity resolution** ("does this company already exist in Business Wise?") is unchanged — it's still
  `entity-resolution.ts` comparing `CandidateCompany` against `existing_companies`.

Because of this split, two different sources can both legitimately produce a candidate for the same real-world
company (e.g. a chamber report finds "Acme Logistics" and a business journal finds "Acme Logistics Inc." the next
day). Ingestion keeps both as separate candidates — resolving whether they're the same company, or the same existing
BW record, is entity resolution's job, not ingestion's.

### Provenance

Every candidate now carries where it came from: `sourceId`, `source` (human-readable source name), `sourceUrl`,
`sourceRecordId`, `capturedAt` (when the source says the record was discovered/published), `ingestedAt` (when this
pipeline ingested it), `fingerprint` (the idempotency key), and `rawSourceData` (the original raw record, for
audit/debugging).

### Sample sources

Two local fixture adapters prove the architecture until a real DFW feed is available:

| sourceId  | Adapter                    | Fixture                                        |
|-----------|-----------------------------|-------------------------------------------------|
| `dfw-json`| `src/sources/dfw-json-adapter.ts` | `data/sources/dfw-json-sample.json` |
| `dfw-csv` | `src/sources/dfw-csv-adapter.ts`  | `data/sources/dfw-county-licenses-sample.csv` |

Each fixture intentionally includes: a fully-populated record, a record with only name+city, a record missing phone,
a record missing employee count, a record with a source URL, an exact duplicate row within the same file, and a
malformed row (no company name) that gets skipped without crashing the run.

### Adding a new SourceAdapter

1. Create `src/sources/<name>-adapter.ts` exporting a factory that returns a `SourceAdapter`.
2. Implement `fetch()` to pull raw records (file read, API call, etc.) and return `RawSourceRecord[]` — each one is
   just `{ recordId?, data }`, so put whatever shape the source uses in `data`.
3. Implement `toCandidate()` to validate and map one `RawSourceRecord` into a `CandidateDraft` (a `CandidateCompany`
   minus the fields the engine fills in: `id`, `source`, `sourceId`, `ingestedAt`, `fingerprint`). Return
   `{ ok: false, reason }` for anything unusable — a bad row must never throw and crash the whole run.
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

Expected behavior with the sample data:

- `Acme Logistics, Inc.` should score as a likely duplicate because of the exact phone plus strong name/address similarity.
- `Northstar Advisory` should score as a likely duplicate because of the domain plus strong name/address similarity.
- `Lone Star Robotics LLC` should surface as likely new and high priority because it is reasonably complete and falls inside the 10–99 employee core segment.

`data/candidates.sample.json` is the original, pre-ingestion-layer fixture and is no longer read by any script; it's
kept only for reference. New sample data belongs under `data/sources/` behind a `SourceAdapter`.

## Next engineering steps

1. Plug in a real DFW source (chamber report export, business journal feed, or county license dataset) behind a new `SourceAdapter`.
2. Add field-level evidence provenance so every proposed value can be inspected by Emily/Jen.
3. Add enrichment adapters for website, LinkedIn/team pages, phone/email validation, and SIC proposal.
4. Evaluate entity-resolution thresholds against Emily's manual judgments on a labeled sample.
5. Build a simple review UI only after the candidate schema and review decisions stabilize.
6. Implement the production `BusinessWiseAdapter` after Rif/Randall confirm architecture and write boundaries.

## Non-goals for this starter

- No autonomous publishing.
- No writes to BWI or the client database.
- No assumption that Delphi, Azure SQL, or ADF is the authoritative write path.
- No claim that the current matching thresholds are production-ready; they are starting hypotheses to measure against human review.
