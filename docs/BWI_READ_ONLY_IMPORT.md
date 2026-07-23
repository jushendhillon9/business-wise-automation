# BWI Read-Only Import (Task 7)

**Status:** Implemented — read-only import path from the canonical BWI directory layer into the local sandbox.
**Related documents:** [`docs/BWI_PRODUCTION_DB_DISCOVERY.md`](./BWI_PRODUCTION_DB_DISCOVERY.md) (authoritative source
of truth for the production database's architecture and write boundary), [`docs/BWI_DOMAIN_RULES.md`](./BWI_DOMAIN_RULES.md)
(business-domain rules), [`docs/COMPANY_LOCATION_MODEL.md`](./COMPANY_LOCATION_MODEL.md) (`CompanyIdentity`/
`LocationCandidate`/`ExistingCompany` domain model this import path feeds into).

## Purpose

Entity resolution (`src/entity-resolution.ts`, `src/entity-resolution-policy.ts`) has always been able to compare an
incoming `LocationCandidate` against a set of `ExistingCompany` records — but until this task, the only
`ExistingCompany` records available were `seed.ts`'s three hand-written synthetic fixtures. Task 7 builds a safe,
read-only path to import **real** existing BWI company-location records into the local sandbox, so matching and
duplicate/new-branch analysis can run against BWI's actual directory instead of only synthetic data.

This is an **import** path, not an **integration** path: it reads from BWI, once, into the local sandbox. It never
writes back. See "No-write guarantees" below.

`docs/OPTION_A_DISCOVERY_DESIGN.md` names "a real BWI comparison universe... with stable BW IDs and all lifecycle
statuses" as a hard gate (Part 9 prerequisite #1, open question §23.12) for novelty classification to mean anything.
Task 7 builds the *mechanism* that gate needs — stable-id import supporting every lifecycle status, feeding the
existing comparison pipeline unchanged. Whether a specific real export is complete/fresh enough to actually close
that gate is an operational question for whoever runs the import, not something this code can determine on its own.

## Canonical production source boundary

Per `docs/BWI_PRODUCTION_DB_DISCOVERY.md` §2–§3, the production database has three architecturally distinct layers.
Task 7 may read **only** from the first:

- ✅ **Canonical internal directory** — `DirCompany`, `DirCompanyDirectory` (and, for context only, `DirContact`/
  `DirEntity`/`srcDirCompanyShort`, none of which this task currently reads).
- ❌ **Legacy research/batch subsystem** — `ResearchData`, `ResearchContacts`, `ResearchStatus`, `DirProjectBatch`,
  `DirProjectBatchItem`. An edit-proposal overlay, not the canonical record — never used as a source here.
- ❌ **Outbound publication subsystem** — `PubPublish`, `PubTable`, `PubDirCompanyShort`, `PubDirContact`, and the
  `spCreate...Work`/`spPrepare...` procedures. A downstream export queue, not a staging/review surface — never used
  here.

## Canonical existing-BWI-location domain type

`ExistingCompany` (`src/types.ts`) — already the type `findBestMatch()`/`resolveCandidateAgainstExisting()` compare
candidates against — was extended (not replaced) with the fields Task 7 needs: `alphasort`, `mailingAddress`,
`siteType`/`rawSiteTypeCode`, `relationship`, `market`/`county`, `employeeSizeSite`/`employeeSizeCompanyWide`,
`lastUpdatedAt`, `source` (`SourceProvenance`), and `fieldEvidence` (`FieldEvidenceCollection`). All new fields are
optional, so every pre-Task-7 fixture (`seed.ts`, existing tests) is unaffected.

`ExistingBwiLocation` is a documented type alias for `ExistingCompany` — not a second type. See the naming note in
`docs/COMPANY_LOCATION_MODEL.md` for why `ExistingCompany` already represents "one existing BWI location row" despite
its name; Task 7 leans on that instead of introducing a second, competing domain model or a second table.

**Why reusing `ExistingCompany` (and the `existing_companies` table) matters:** `run.ts` already does
`loadExistingCompanies(db)` → `findBestMatch(candidate, existingCompanies)` /
`resolveCandidateAgainstExisting(candidate, existingCompanies)`. Because BWI imports land in the same table
`seed.ts` populates, **zero changes were needed to `run.ts`, `entity-resolution.ts`, or
`entity-resolution-policy.ts`** — more imported rows are automatically compared against on the next `bun run run`.
Task 4's matching formula, weights, and thresholds are completely unchanged.

## Live adapter vs. snapshot adapter

Both implementations satisfy one shared interface:

```ts
interface BusinessWiseReadOnlySource {
  sourceType: "bwi_snapshot" | "bwi_live";
  sourceName: string;
  fetchExistingLocations(options: FetchExistingLocationsOptions): Promise<BwiImportRowResult[]>;
}

type FetchExistingLocationsOptions = {
  limit: number;         // every implementation enforces its own hard cap regardless of the caller's request
  afterId?: string;      // keyset pagination cursor (stable id > cursor), never OFFSET
  updatedSince?: string; // bounded "what changed since X" fetch
  ids?: string[];        // bounded fetch by a fixed list of stable ids
};
```

(`src/sources/bwi/types.ts`)

Both adapters parse their own wire format into one shared intermediate shape, `RawBwiDirectoryRecord` (loose,
string-keyed — the CSV parser and the SQL row mapper both produce it the same way), and hand off to **one** shared
normalization function, `mapRawBwiRecordToExistingLocation()` (`src/sources/bwi/mapping.ts`). This is what guarantees
the live and snapshot paths can never silently drift into two different domain models or duplicate BWI-code
normalization logic — `mapping.ts` is the only place that calls `normalizeBwiSiteType()`/
`normalizeBwiLifecycleStatus()` (`src/bwi-codes.ts`, unchanged since Task 3).

- **`createBwiSnapshotSource()`** (`src/sources/bwi/snapshot-adapter.ts`) — reads a local CSV file. Deterministic,
  offline, safe to rerun. This is the path automated tests, `bun run bwi:import`, and local development all use.
- **`createBwiLiveSource()`** (`src/sources/bwi/live-adapter.ts`) — a direct, structurally read-only SQL Server
  adapter over `DirCompany`/`DirCompanyDirectory`. Never called by `bun test` or `bun run reset`; only by the
  explicit manual smoke test (see below).

### Column names in the live adapter are unconfirmed — needs confirmation from Jushen

`docs/BWI_PRODUCTION_DB_DISCOVERY.md` confirmed the **table-level** roles of `DirCompany`/`DirCompanyDirectory` but
explicitly did not capture column-level detail ("not every column's exact business meaning is confirmed" — §3.1).
`src/sources/bwi/live-adapter.ts`'s `SCHEMA` constant is a best-effort placeholder column list, informed only by one
confirmed clue: §5's observed `ResearchData` `Edit...` field-name pattern (`EditName`, `EditAddress`, `EditWebsite`,
`EditSIC`, `EditPhone...`, `EditSize...`), which *suggests* — does not prove — similarly-named canonical columns.

**Every table/column name in `SCHEMA` needs confirmation from Jushen** before the live adapter is ever pointed at a
real server. It's centralized in one object specifically so correcting it is a one-place edit, not a
search-and-replace across SQL text.

## Read-only enforcement (the live adapter)

`src/sources/bwi/live-adapter.ts` is structurally incapable of writing:

- No generic `execute(sql)`/`query(sql)` method is exposed — the module's only public surface is
  `createBwiLiveSource(config).fetchExistingLocations(options)`.
- All SQL text is a small, fixed, code-owned set of `SELECT`-only constants (`FETCH_PAGE_SQL`,
  `FETCH_UPDATED_SINCE_SQL`, `buildFetchByIdsSql()`). No caller-supplied SQL text exists anywhere.
- `buildFetchByIdsSql()` validates every parameter name against a strict `^[A-Za-z0-9_]+$` allowlist before
  interpolating it, so even a caller that misused the function couldn't smuggle SQL text through it.
- No `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`EXEC`/`CREATE`/`ALTER`/`DROP`/`TRUNCATE` statement, stored-procedure
  invocation, temporary table, or schema change exists anywhere in the module.
- Every fetch parameter is bound via the driver's own parameterization (`.input(name, type, value)`), never
  string-concatenated.
- Pagination is keyset-based (`WHERE id > @afterId ORDER BY id ASC`), never `OFFSET`, since `OFFSET` stability
  against the live schema's actual (unverified) indexes can't be assumed.
- `readOnlyIntent: true` is set on the connection by default (requests routing to an Always On readable secondary
  when supported) — a defense-in-depth signal, not the primary guarantee. The fixed-`SELECT`-only surface above is
  the actual enforced boundary. Set `BWI_DB_READ_ONLY_INTENT=false` if the target server rejects the option.
- `src/sources/bwi/live-adapter.test.ts` enforces all of this with automated tests: it scans the exported SQL
  constants (and, as a broader net, the module's own source text with comments stripped) for forbidden SQL verbs,
  and asserts the module's exported surface contains no generic query/execute/exec/run function.

The **operational** guardrail — a SQL login with `SELECT`-only grants on the `Dir*` tables — is outside this repo's
control and is a DBA/ops responsibility; the code-level guardrails above are what this repository can enforce and
test.

## Credential handling

No credentials, hostnames, IP addresses, ports, usernames, or passwords are ever committed. Connection configuration
comes only from local environment variables, loaded by `src/sources/bwi/live-config.ts`:

| Variable | Required | Purpose |
|---|---|---|
| `BWI_DB_SERVER` | yes | Hostname/IP of the BWI SQL Server instance |
| `BWI_DB_NAME` | yes | Database name |
| `BWI_DB_USER` | no | SQL auth username |
| `BWI_DB_PASSWORD` | no | SQL auth password |
| `BWI_DB_PORT` | no | Defaults to SQL Server's standard port |
| `BWI_DB_ENCRYPT` | no | Defaults to `true` |
| `BWI_DB_TRUST_SERVER_CERTIFICATE` | no | Defaults to `false` |
| `BWI_DB_READ_ONLY_INTENT` | no | Defaults to `true` |

See [`.env.example`](../.env.example) (names only, no values) for the exact format. Copy it to a local `.env`
(already gitignored) and fill in real values there — never in a committed file.

`loadBwiLiveDbConfigFromEnv()` throws a single clear error naming every missing required variable **by name only**
when `BWI_DB_SERVER` or `BWI_DB_NAME` is absent. No error message, log line, or thrown exception in this codebase
ever includes the *value* of any of these variables — `src/sources/bwi/live-config.test.ts` verifies this
explicitly. Nothing in `src/bwi-smoke-cli.ts` prints the configured server/database name either, even on success.

## Snapshot schema

A local BWI snapshot is a CSV file with these columns (`src/sources/bwi/snapshot-adapter.ts`):

| Column | Required | Maps to |
|---|---|---|
| `bwi_location_id` | **yes** | `ExistingCompany.id` (the stable BWI identifier) |
| `company_name` | **yes** | `ExistingCompany.companyName` |
| `alphasort` | no | `ExistingCompany.alphasort` |
| `address` | no | `ExistingCompany.address` |
| `mailing_address` | no | `ExistingCompany.mailingAddress` |
| `city` / `state` / `postal_code` | no | `ExistingCompany.city` / `state` / `postalCode` |
| `phone` | no | `ExistingCompany.phone` |
| `website` | no | `ExistingCompany.website` |
| `sic_code` | no | `ExistingCompany.sicCode` |
| `site_type_code` | no | Raw BWI site-type code (`S`/`H`/`B`/`R`/`U`) → `siteType` (normalized) + `rawSiteTypeCode` (verbatim) |
| `status_code` | no | Raw BWI lifecycle code (`DIRE`/`DEL`/`RDL`/`RDEL`/`research`) → `lifecycleStatus` (normalized) + `status` (verbatim) |
| `market` / `county` | no | `ExistingCompany.market` / `county` |
| `parent_company` / `affiliate` | no | `ExistingCompany.relationship.parentCompany` / `affiliate` |
| `employee_size_site` / `employee_size_site_raw_code` | no | `ExistingCompany.employeeSizeSite.estimate` / `rawCode` |
| `employee_size_company_wide` / `employee_size_company_wide_raw_code` | no | `ExistingCompany.employeeSizeCompanyWide.estimate` / `rawCode` |
| `last_updated_at` | no | `ExistingCompany.lastUpdatedAt` (must parse as a valid date if present — a malformed value rejects that row) |

Only `bwi_location_id` and `company_name` are required **headers** — a file missing either column fails immediately
with a clear error, before any row is processed. Every other column may be absent from a row's value (tolerated) or
from the header entirely. Unknown raw `site_type_code`/`status_code` values are preserved verbatim (never silently
coerced into a known code) and reported in the import summary.

A synthetic example fixture lives at [`data/sources/bwi-snapshot-sample.csv`](../data/sources/bwi-snapshot-sample.csv)
— seven synthetic companies covering a full row, a minimal row, unknown raw codes, a research-deleted row, and a
parent/affiliate relationship. **No real production data.**

### Where real exports go

Real BWI exports must never be committed. They belong only in `data/private/` (gitignored except its own README —
see [`data/private/README.md`](../data/private/README.md)). `data/sources/` is for synthetic, committed fixtures
only.

## Local snapshot import

```bash
bun run bwi:import -- --file=data/sources/bwi-snapshot-sample.csv
# or, for a real local export:
bun run bwi:import -- --file=data/private/your-export.csv
```

Optional flags: `--limit=N`, `--after-id=<id>`, `--updated-since=<iso-date>`, `--exported-at=<iso-date>` (when the
snapshot file itself records an export time). Prints a summary: rows read/accepted/rejected/inserted/updated/
unchanged, unknown raw site-type/lifecycle codes seen, and up to 20 validation errors. There is **no `--live` option
on this command** — snapshot import is the only thing it can do.

## Manual live smoke test

```bash
bun run bwi:smoke -- --live [--limit=N] [--after-id=<id>] [--persist] [--unredacted]
```

Requires the explicit `--live` flag (or `--source=bwi-live`); with neither, the script prints usage and exits
without ever loading the live adapter, `mssql`, or reading any `BWI_DB_*` environment variable. Defaults:

- **read-only** — results print to the terminal, nothing is written to the local sandbox, unless `--persist` is
  passed explicitly
- **capped at 25 records**, regardless of `--limit` (a higher value is silently clamped down, never up)
- **deterministic order** — id ascending, matching the live adapter's fixed `ORDER BY`
- **redacted output** — by default, prints only non-sensitive summary fields (id presence, city/state, site type,
  status, whether a phone/website is present — not the actual phone/website value). Pass `--unredacted` to see full
  field values for a single manual check. No contacts are ever fetched or printed — `ExistingCompany` has no
  contact fields at all.

**Nobody runs this automatically.** `bun test` and `bun run reset` never invoke it. Review this document and confirm
`SCHEMA` in `live-adapter.ts` matches the real schema before running it against a real server.

## How existing BWI records differ from incoming candidates

`ExistingCompany` (what this import produces) and `LocationCandidate` (what `src/ingestion.ts`'s DFW source adapters
produce) are never conflated:

- `ExistingCompany` rows land in the `existing_companies` table — the comparison universe.
- `LocationCandidate` rows land in `location_candidates` — the incoming, provisional, not-yet-in-BWI observations.
- Entity resolution always compares the second against the first, never the other way around, and a BWI import never
  writes to `location_candidates`.

## Raw vs. normalized BWI values

Task 7 reuses, never duplicates, the Task 3 normalization functions (`normalizeBwiSiteType()`/
`normalizeBwiLifecycleStatus()`, `src/bwi-codes.ts`) — `mapRawBwiRecordToExistingLocation()`
(`src/sources/bwi/mapping.ts`) is the only place either function is called for a BWI import. Both the raw code
(`ExistingCompany.status`/`rawSiteTypeCode`) and the normalized value (`lifecycleStatus`/`siteType`) are always
preserved, matching the existing pattern documented in `docs/COMPANY_LOCATION_MODEL.md` → "Normalizing BWI legacy
codes without losing raw values." An unrecognized raw code normalizes to `"unknown"` (never silently coerced into a
known value) and is reported in the import summary's unknown-codes list.

`ExistingCompanyStatus` (`src/types.ts`) was widened from a plain 5-value closed union to also accept any string
(`| (string & {})`) — a real/snapshot BWI import may surface a raw status code beyond the five previously documented
ones, and the exact raw string must never be dropped or coerced just to fit a closed type.

## Field evidence and confidence

Imported records carry `FieldEvidence` (Task 6's model, reused unchanged — no new evidence type) for the fields the
row actually supports: `company.companyName`, `company.website`, `company.sicCode`, `location.address`,
`location.phone`, `location.siteType`, `location.status`. Each evidence record's `source.sourceType` is
`"bwi_canonical_snapshot_import"` or `"bwi_canonical_live_import"` (two new `FieldEvidenceSourceType` values, added
to the existing closed union in `src/types.ts`) — never the generic `"existing_bwi_record"` value, so a reviewer can
tell which import path produced a given value.

**Confidence is deliberately not the Task 6 placeholder.** `BWI_CANONICAL_IMPORT_CONFIDENCE = 0.7`
(`src/sources/bwi/mapping.ts`) is distinct from `SINGLE_SOURCE_OBSERVED_CONFIDENCE = 0.6` (`src/types.ts`, used for
one unverified external source row like a chamber feed). The distinction matters: **"this is the value BWI's system
currently has on file" is not the same claim as "this value is objectively current and correct."** BWI being the
canonical system of record does not by itself mean a given value is fresh or accurate — it could be years stale (see
`lastUpdatedAt`, when known). 0.7 is a documented, deliberately-not-1.0 placeholder — **needs confirmation from
Jushen**, exactly like the Task 6 placeholder.

Field-evidence confidence, per Task 6's own rule (unchanged), **never feeds entity-resolution thresholds,
`EntityResolutionDecision.decisionConfidence`, or `PublicationReadinessAssessment`**. Nothing in Task 7 changes that.

`capturedAt` on each evidence record is the snapshot's export time (`--exported-at`) or the live read's own instant
— never fabricated when a snapshot doesn't record one. `ExistingCompany.lastUpdatedAt` is a separate domain value
(the *source system's own* audit timestamp, when the source provides one) and is never conflated with
`capturedAt`/`ingestedAt`.

## Persistence and upsert behavior

BWI-imported records land in the existing `existing_companies` table (`src/db.ts`), extended with new nullable
columns for the fields above plus a `raw_json` snapshot column (mirroring `location_candidates`' existing pattern) so
every new optional field round-trips losslessly. `field_evidence_json` mirrors `location_candidates.evidence_json`'s
precedent of also giving evidence its own column.

`upsertBwiExistingLocation()` (`src/bwi-import.ts`) is keyed by the stable BWI id (`ExistingCompany.id`):

- **not previously present** → insert
- **present, content unchanged** (compared ignoring only `ingestedAt`/timestamp-of-import, which legitimately
  differs on every run) → no-op, reported as `unchanged`
- **present, content changed** → overwritten, reported as `updated`

**Nothing is ever deleted.** A bounded snapshot or page that simply doesn't mention a previously-imported id is not
evidence that record was removed from BWI — `runBwiImport()`/`upsertBwiExistingLocation()` never issue a `DELETE`.
Deciding what "no longer present in the latest bounded export" actually means is explicitly out of scope for Task 7.

Every import run is recorded in `bwi_import_runs` (mirrors `source_runs`' shape for the DFW ingestion pipeline):
source type/name, timing, and rows read/accepted/rejected/inserted/updated/unchanged, plus unknown-code and
validation-error lists.

## Entity-resolution integration

No changes to `src/entity-resolution.ts`, `src/entity-resolution-policy.ts`, `src/scoring.ts`, or
`src/publication-readiness.ts`. `run.ts`'s existing `loadExistingCompanies(db)` → `findBestMatch()`/
`resolveCandidateAgainstExisting()` flow already compares every row in `existing_companies` — imported BWI records
are indistinguishable to that pipeline from `seed.ts`'s synthetic fixtures. `src/sources/bwi/
entity-resolution-integration.test.ts` proves this end-to-end: an imported record can produce
`same_existing_location`, `new_branch_of_existing_company`, and the conservative `ambiguous_manual_review`/
`likely_new_company` fallbacks, exactly as it would for a hand-written fixture — including still surfacing a
deleted/research-deleted imported record (flagged `requiresHumanReview: true`), never silently excluding or
auto-resurrecting it.

## Redaction behavior

`bun run bwi:search` (list/search the locally-imported records) and `bun run bwi:smoke` (the manual live check) both
print bounded, tabular summaries — never a raw dump of every field, and never contacts (there are none to fetch —
`ExistingCompany` has no contact fields). The smoke test additionally masks phone/website down to a boolean
"present" flag by default; pass `--unredacted` to see full values for a manual, one-off check.

## No-write guarantees

Nothing added in Task 7:

- writes to `DirCompany`, `DirCompanyDirectory`, `DirContact`, or `DirEntity`
- inserts into `ResearchData`, `ResearchContacts`, or creates/modifies `DirProjectBatch`/`DirProjectBatchItem` rows
- invokes any publication procedure or writes to `PubTable`
- calls any stored procedure at all
- adds a production migration, schema change, or temporary table
- adds a `BusinessWiseAdapter` implementation or any other direct writeback path (`src/business-wise-adapter.ts`
  remains an uninstantiated interface, untouched by this task)

## Manual Delphi entry remains the pilot write surface

This import path only feeds entity resolution with real comparison data. It does not change the pilot's write
boundary (`docs/BWI_PRODUCTION_DB_DISCOVERY.md` §17, `docs/BWI_DOMAIN_RULES.md` §19): every candidate still flows
through field-level evidence, publication readiness, and human review, ending in **manual entry through the
existing, authorized Business Wise/Delphi workflow** — never an automated write.
