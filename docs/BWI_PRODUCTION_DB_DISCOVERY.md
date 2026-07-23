# Business Wise Production Database Discovery

**Status:** Discovery record — read-only investigation findings, no architecture locked
**Date:** July 2026
**Scope:** Production Business Wise SQL Server database — schemas, object definitions, metadata, aggregate counts,
and Query Store, inspected to identify safe integration boundaries for Project 1
**Not in scope:** Application-layer behavior, Delphi source code, Retool internals, or any conclusion not supported
by what was directly inspected

**Related documents:** [`docs/BWI_DOMAIN_RULES.md`](./BWI_DOMAIN_RULES.md) (business-domain rules — company/location
facts, publication readiness, lifecycle) and [`docs/OPTION_A_DISCOVERY_DESIGN.md`](./OPTION_A_DISCOVERY_DESIGN.md)
(company-discovery pipeline design). This document is narrower and lower-level than both: it records what the
production **database** actually contains and how its object groups relate, as evidence for where Project 1's write
boundary must sit. It does not restate or duplicate `BWI_DOMAIN_RULES.md`'s field-level business rules.

---

## 1. Purpose and scope

This was an authorized, read-oriented architecture investigation of the production Business Wise SQL Server
database, conducted through SQL Server Management Studio.

The work focused on:

- schemas and object definitions (tables, views, stored procedures)
- table and column metadata
- aggregate queries (row counts, status distributions, timeline queries)
- Query Store configuration and retained query history

**No intentional production data modifications, publishing actions, schema changes, or workflow executions were
performed.** Every query used was read-only (`SELECT`, catalog/metadata views, Query Store DMVs, object-definition
lookups).

Credentials, connection strings, server names, IP addresses, and any other infrastructure secrets are deliberately
excluded from this document and were not committed anywhere in this repository.

The purpose of the investigation was narrow and specific: **identify safe architectural boundaries for Project 1** —
which production tables and procedures are safe to eventually read from or write to, and which are not, before any
integration work begins.

---

## 2. Executive summary

The production database is organized into three architecturally distinct layers, not one:

1. **Canonical internal directory** — `DirCompany`, `DirCompanyDirectory`, `DirContact`, `DirEntity`,
   `srcDirCompanyShort`. The authoritative internal company/location/contact records.
2. **Legacy research and batch subsystem** — `ResearchData`, `ResearchContacts`, `ResearchStatus`,
   `DirProjectBatch`, `DirProjectBatchItem`, and related views. An overlay/workflow system historically used to
   propose and track edits to canonical records, with a long operational history and an unresolved apply path.
3. **Separate outbound publication subsystem** — `PubPublish`, `PubTable`, `PubDirCompanyShort`, `PubDirContact`,
   and the `spCreate...Work`/`spPrepare...` procedure family. Compares canonical records against previously
   published copies and queues outbound `INSE`/`UPDA`/`DELE` work items.

**Main conclusion:** the new automation must not use the legacy research tables, `PubTable`, or direct canonical SQL
writes as its first-pilot integration surface. None of the three layers is a safe, well-understood entry point for
new automated intake today — the research subsystem has unresolved apply logic and integrity gaps, and the
publication subsystem is a downstream export mechanism, not a staging or review layer.

For the pilot, the system should produce **evidence-backed, human-reviewed research packets for manual entry
through the existing authorized workflow** — the same posture already established in `BWI_DOMAIN_RULES.md` §19's
write policy and this repo's non-goals ("No writes to BWI or the client database").

---

## 3. Confirmed architectural layers

### 3.1 Canonical internal directory

| Object | Confirmed role |
|---|---|
| `DirCompany` | Company-level identity record. |
| `DirCompanyDirectory` | Location/directory-level record — the location-centric row model described in `BWI_DOMAIN_RULES.md` §2. |
| `DirContact` | Contact records associated with a company/location. |
| `DirEntity` | Audit/entity-level metadata associated with directory records. |
| `srcDirCompanyShort` | A derived/internal short representation of company records, used elsewhere (notably by the publication subsystem, §3.3) as a comparison source. |

This division — company identity vs. location/directory data vs. contacts vs. audit/entity metadata vs. derived
internal representations — is confirmed from schema and object definitions. **Not every column's exact business
meaning is confirmed** in this layer; this document records the table-level roles that were verified, not a
column-by-column data dictionary. Field-level business semantics (required/optional, client-visible, etc.) remain
governed by `BWI_DOMAIN_RULES.md`.

### 3.2 Legacy research and batch subsystem

| Object | Confirmed role |
|---|---|
| `ResearchData` | Company-level edit overlay: `Edit...` proposed-value fields and `Del...` deletion-flag fields, associated with a company and a batch. |
| `ResearchContacts` | Proposed contact-level changes (insert/edit/delete), associated with `DirContactId` and a batch. |
| `ResearchStatus` | Activity/submission ledger — result/status state, change-count metadata, notes, user and timestamp tracking. |
| `DirProjectBatch` | A batch of research work items with a status (e.g. `RSCH`, `COMP`). |
| `DirProjectBatchItem` | Individual items within a batch, checked in/out against directory records. |
| `vw_ResearchData` | A view joining canonical values with proposed `ResearchData` edits, batch context, SIC descriptions, and notes. |
| `vw_ResearchContacts`, `vw_ResearchContacts2` | Related contact-research reporting views. |
| Related Retool-era/reporting views | Additional views apparently built for reporting or an earlier Retool-based review interface; not individually catalogued here. |

Key findings (see §5–§7 for detail):

- `ResearchData` stores company-level `Edit...` and `Del...` overlay fields — it is an edit *proposal* layer, not
  the canonical company record.
- `ResearchContacts` stores proposed contact changes in the same overlay style.
- `ResearchStatus` is an activity/submission ledger, not a data table in its own right.
- `vw_ResearchData` presents canonical values and proposed edits side by side; **the view itself does not apply
  changes** — it is a read/reporting surface only.
- **The exact application-side logic that applies approved research changes back into canonical `Dir*` tables
  remains unresolved.** No single stored procedure was found that performs this for `ResearchData` (§5, §14).

### 3.3 Outbound publication subsystem

| Object | Confirmed role |
|---|---|
| `PubPublish` | A publication job record (e.g. `FULL` or `COMP` job types). |
| `PubTable` | Queue of outbound publication work items (`INSE`/`UPDA`/`DELE`), one row per pending change to publish. |
| `PubDirCompanyShort` | Previously published snapshot of company-short data, compared against `srcDirCompanyShort`. |
| `PubDirContact` | Previously published snapshot of contact data, compared against `DirContact`. |
| `spPrepareFullPublishWork` | Creates or reuses a publication job and invokes category-specific work creators. |
| `spCreateCompanyAndContactsWork` | Compares canonical vs. published snapshots and inserts `PubTable` work items. |
| `spCompletedWorkItem`, `spCompletedPublish` | Mark work items / publish jobs complete. |
| Related `spCreate...Work` procedures | Additional category-specific comparison/work-creation procedures, not individually catalogued here. |

This subsystem:

- compares canonical internal records (`DirCompany`/`srcDirCompanyShort`/`DirContact`) against their previously
  published copies (`PubDirCompanyShort`/`PubDirContact`)
- creates `INSE`, `UPDA`, and `DELE` work items representing the delta
- queues that work in `PubTable` for downstream consumption
- operates **downstream** of canonical records — it publishes changes outward, it does not originate them
- **is not the research review or staging layer for Project 1.** It has no relationship to `ResearchData` or the
  research/batch subsystem; it is a separate outbound export pipeline (§13).

---

## 4. Objects and procedures inspected

Confidence labels: **Confirmed from definition** (object DDL/procedure body read directly), **Confirmed from
schema** (columns/types/keys read directly), **Strong inference** (consistent pattern across multiple inspected
objects/queries, not from a single definitive source), **Unresolved** (open question, not answered by inspection).

| Object | Type | Observed responsibility | Confidence | Important caveat |
|---|---|---|---|---|
| `ResearchData` | Table | Company-level edit-overlay fields (`Edit...`/`Del...`) tied to company + batch | Confirmed from schema | No apply procedure found; not proven to be later merged wholesale |
| `ResearchContacts` | Table | Proposed contact insert/edit/delete overlay tied to `DirContactId` + batch | Confirmed from schema | Same unresolved-apply caveat as `ResearchData` |
| `ResearchStatus` | Table | Activity/submission ledger — status, notes, counts, user/timestamp | Confirmed from schema | Relationship to final apply step unresolved |
| `DirCompany` | Table | Canonical company identity | Confirmed from schema | Not every column's meaning independently verified |
| `DirCompanyDirectory` | Table | Canonical location/directory record | Confirmed from schema | Same caveat |
| `DirContact` | Table | Canonical contact record | Confirmed from schema | Same caveat |
| `DirProjectBatch` | Table | Batch header — status, dates, ownership | Confirmed from schema | Full status-code dictionary unresolved |
| `DirProjectBatchItem` | Table | Per-item batch membership and check-in/out state | Confirmed from schema | Same caveat |
| `vw_ResearchData` | View | Joins canonical + proposed-edit + batch + SIC + notes for research review | Confirmed from definition | Does not select a "winning" value; presentation only |
| `sp_BWDirCheckOutProjectBatch` | Stored procedure | Sets `CheckOutDate`, moves batch status to `RSCH` | Confirmed from definition | Internal comment describes check-in behavior despite performing check-out (stale/misleading) |
| `sp_BWDirCheckInProjectBatch` | Stored procedure | Finalizes batch-item metadata, closes batches, triggers cleanup | Confirmed from definition | Does not apply `ResearchData`/`ResearchContacts` overlay to canonical tables |
| `spPrepareFullPublishWork` | Stored procedure | Creates/reuses publish job, invokes category work creators | Confirmed from definition | Downstream of canonical data, not a research/apply step |
| `spCreateCompanyAndContactsWork` | Stored procedure | Diffs canonical vs. published snapshots, inserts `PubTable` work items | Confirmed from definition | Suspected alias defect observed (§14) — not confirmed by reproduction |
| `PubPublish` | Table | Publication job record | Confirmed from schema | Job-type/state dictionary not fully catalogued |
| `PubTable` | Table | Queued outbound `INSE`/`UPDA`/`DELE` work items | Confirmed from schema | Downstream consumer of `PubTable` not identified (§16 Q13) |
| `PubDirCompanyShort` | Table | Previously published company-short snapshot | Confirmed from schema | — |
| `PubDirContact` | Table | Previously published contact snapshot | Confirmed from schema | — |

---

## 5. Research overlay findings

`ResearchData` is a company-level **edit overlay** associated with a company identifier and a batch identifier.
Representative field-name patterns observed (not an exhaustive schema dump):

- `EditName`, `EditAddress`, `EditWebsite`, `EditSIC`, `EditPhone...`, `EditSize...`, `EditLease...`, and additional
  `Edit...` relationship fields
- `DelWebsite`, `DelEmail`, `DelPhone...`, `DelSIC`, and other `Del...` deletion-intent flags

Key findings:

- `ResearchData` is an edit overlay, associated with company and batch identifiers. **It is not the canonical
  company record.**
- **No single general-purpose stored procedure was found that applies all `Edit...` fields to canonical tables.**
- It is **not proven** to be a conventional staging table that gets merged wholesale into canonical records at some
  later step — that mechanism, if it exists, was not located during this investigation.

`ResearchContacts` follows the same overlay pattern at the contact level:

- proposed contact insert/edit/delete behavior
- relationship to canonical contacts via `DirContactId`
- `Edit...` contact fields, plus a `DelContact` flag
- batch association, matching the company-level overlay's batch model

`ResearchStatus` is not a data-overlay table — it is an **activity ledger**:

- activity history entries
- result/submission state
- change-count metadata
- free-text notes
- user and timestamp tracking per activity

---

## 6. vw_ResearchData findings

The inspected view definition joins:

- `DirCompany`
- `DirCompanyDirectory`
- `srcDirCompanyShort`
- `DirProjectBatchItem`
- `ResearchData`
- `CodeDirSIC`
- aggregated `DirNote` content

The view exposes, side by side, in a single row:

- current canonical values
- proposed `Edit...` values
- delete flags
- batch context
- research notes

**Clarifications, confirmed from the view definition:**

- The view does not select a final "winning" value between canonical and proposed-edit columns — both are exposed,
  unresolved, for a human or downstream process to interpret.
- The view does not apply edits; it is a read/reporting surface.
- It supports an overlay-oriented research interface (consistent with a researcher or reviewer working proposed
  changes against current values).
- **The application logic responsible for applying approved changes into canonical records remains unresolved** —
  this view does not contain or imply that logic.

---

## 7. Batch lifecycle findings

### 7.1 Check-out — `sp_BWDirCheckOutProjectBatch`

Confirmed from the procedure definition:

- sets `CheckOutDate`
- changes batch status to `RSCH`
- does not apply any research edits

**Note:** the procedure's internal comment text refers to check-in behavior even though the code it precedes
performs check-out. This is a stale or misleading comment in the production code, not a behavioral question — it is
recorded here so a future reader isn't misled by the comment when reading the procedure body directly.

### 7.2 Check-in — `sp_BWDirCheckInProjectBatch`

Confirmed from the procedure definition, this procedure:

- updates researched-by and researched-date metadata
- updates entered-by and entered-date metadata
- sets `IsResearch` to `N`
- converts remaining `RSCH` directory statuses to `RDEL`
- stamps `CheckInDate` and `CheckInById`
- copies submitted `ResearchStatus` result/notes to the corresponding batch items
- marks a batch `COMP` when all its items are checked in
- invokes a research cleanup step on batch completion

**This procedure finalizes workflow metadata and cleanup. It does not apply the full `ResearchData` or
`ResearchContacts` overlay into canonical records.** This is the central finding motivating §17's guardrails: the
one stored procedure most plausibly expected to "complete" a research edit does not, in fact, write proposed field
values back to `DirCompany`/`DirCompanyDirectory`/`DirContact`.

---

## 8. Query Store findings

Observed Query Store configuration on the production database:

| Setting | Observed value |
|---|---|
| Actual state | `READ_WRITE` |
| Desired state | `READ_WRITE` |
| Capture mode | `AUTO` |
| Stale-query threshold | 30 days |
| Size-based cleanup | `AUTO` |
| Space used | approximately 65–66 MB |
| Maximum size | 100 MB |
| Readonly reason | zero (not in a readonly state) |

Retained Query Store traffic showed **parameterized direct writes** to canonical objects, including `DirCompany`,
`DirCompanyDirectory`, `DirContact`, `DirEntity`, and related contact/relationship records.

**Interpretation:**

- This confirms that production applications issue direct writes against canonical records.
- Query Store does not by itself identify the calling application.
- **Do not attribute these writes definitively to Retool.** Possible callers include Delphi, Retool, another
  internal application, background/batch processes, or multiple systems writing concurrently.
- Some temporary-object naming observed in the retained queries suggested an older ADO-style application, but this
  is a clue, not proof, of which application is writing.

A **targeted Query Store search found no retained `INSERT`, `UPDATE`, `DELETE`, or `MERGE` statements targeting
`ResearchData` or `ResearchContacts`.**

This must be interpreted carefully:

- It proves no such writes were visible in the retained Query Store window at the time of inspection.
- It does **not** prove those tables were never written.
- Older write activity could have aged out of Query Store due to the 30-day stale-query threshold.

---

## 9. Aggregate data findings

Observed row counts (point-in-time, as of the July 2026 investigation):

**`ResearchData`**

- 4,246 rows

**`ResearchContacts`**

- 12,252 rows
- 5,052 distinct companies represented

**`ResearchStatus`**

- 38,709 rows
- 10,333 rows with result `SUBMITTED`
- latest observed `Updated` timestamp: March 1, 2025

Null values in the inspected `ResearchData` date fields do **not** independently prove inactivity — a null date
field could reflect several different states, and no single-field inference was treated as conclusive.

---

## 10. Batch-status distribution

**`ResearchData`, by batch status:**

| Status | Batches | Rows |
|---|---:|---:|
| `COMP` | 71 | 1,493 |
| `RSCH` | 93 | 2,753 |

**`ResearchContacts`, by batch relationship:**

| Batch relationship | Batches | Rows | Distinct companies |
|---|---:|---:|---:|
| No matching batch (orphaned) | 1 missing batch relationship | 3,234 | 1,601 |
| `COMP` | 65 | 3,637 | 1,345 |
| `RSCH` | 83 | 5,381 | 2,153 |

**Significance:**

- Completed (`COMP`) batches still retaining research rows indicates either inconsistent historical cleanup or an
  alternate completion path that doesn't clear `ResearchData`/`ResearchContacts`.
- Orphaned `ResearchContacts` rows (no matching batch) indicate a data-integrity risk in the legacy subsystem.
- **Neither condition should be repaired without explicit owner approval and forensic analysis** — that work is out
  of scope for this document and for Project 1's pilot.
- Together, these findings are additional evidence (beyond §5's unresolved apply path) that these tables are **not**
  a clean surface for new automated intake.

---

## 11. Timeline and backlog findings

Observed timeline evidence:

- The newest inspected `CheckOutDate` values were **February 25, 2025**. No later check-outs were observed in the
  inspected results.
- `ResearchStatus` activity extended through **March 1, 2025**.
- Old batch items continued receiving `CheckInDate` values as recently as **July 2026** — i.e., check-ins are still
  occurring against a backlog of batches that were never newly checked out after February 2025.

Representative batch examples (not exhaustive):

| Batch | Status | Items | Unchecked | Latest check-in |
|---|---|---:|---:|---|
| 39321 | `RSCH` | 140 | 137 | July 22, 2026 |
| 39357 | `RSCH` | 135 | 134 | July 20, 2026 |
| 39369 | `RSCH` | 140 | 137 | July 9, 2026 |

Additional examples of nearly untouched batches were also observed: 200 items with 197 unchecked, 150 items with
149 unchecked, and 140 items with 139 unchecked.

**Current best interpretation:**

- New batch check-outs appear to have stopped in February 2025.
- Old backlog items continue to be checked in intermittently, up through the July 2026 investigation date.
- The subsystem is not completely dead — check-in activity continues — but it is not receiving new work.
- It reads as a **long-lived legacy backlog** being slowly drained, rather than a healthy, actively-fed modern
  intake pipeline.

The absence of newer check-outs is a **strong inference** based on the inspected data, not absolute proof that no
other check-out path exists in the system.

---

## 12. Invalid query result correction

**This section records a data-quality correction and must not be skipped by a future reader reusing these
findings.**

An earlier exploratory query joined `DirProjectBatchItem` directly to multiple `ResearchStatus` rows before
calculating unchecked totals. Because a batch item can have more than one associated `ResearchStatus` row, this join
multiplied item rows before aggregation, producing impossible counts — for example, tens of thousands of "unchecked"
records reported for batches that contain only 100–200 items total.

**Those inflated values are invalid. They must not be cited or reused anywhere in this repository or in future
analysis.**

The valid unchecked totals shown in §11 above came from a separate, corrected batch-item aggregation that does
**not** join through `ResearchStatus` before counting — i.e., it aggregates `DirProjectBatchItem` on its own terms
and only checks `ResearchStatus` state per item without multiplying rows.

---

## 13. Publication pipeline findings

**`spPrepareFullPublishWork`:**

- creates or reuses `FULL` or `COMP` publication jobs
- calls category-specific work creators, including `spCreateCompanyAndContactsWork`
- marks a job complete immediately when no `PubTable` work is generated

**`spCreateCompanyAndContactsWork`:**

- compares `srcDirCompanyShort` against `PubDirCompanyShort`
- compares `DirContact` against `PubDirContact`
- creates `INSE`, `UPDA`, and `DELE` work items representing the diff
- inserts those items into `PubTable`

**Key boundary:** this system publishes canonical changes **outward**. It does not perform the research-to-canonical
approval process described in §5–§7. `PubTable` is an outbound export queue, not a staging or review surface for
new intake — see §17 for why Project 1 must not treat it as one.

---

## 14. Suspected procedure defect

A suspected alias defect was observed in `spCreateCompanyAndContactsWork`:

- A row alias is first constrained to `DirContact` / `DELE`.
- A later condition in the same logical branch appears to require that same alias to be `DirCompany` / `INSE`.
- Those two conditions cannot both be true for the same row.
- The likely intended alias for the second condition may have been a separate, inserted-company alias rather than
  the `DirContact`/`DELE` alias.

**Status: suspected defect. Not confirmed by reproduction.** This is recorded as an observation for future
investigation, not a diagnosed bug. **Do not modify this procedure without explicit database-owner authorization,
without tests, and without a database-owner review.** No production patch is included in or implied by this
document.

---

## 15. Confirmed facts vs. inferences

### Confirmed facts

- The database separates canonical internal records (§3.1), a legacy research/batch overlay subsystem (§3.2), and a
  separate outbound publication subsystem (§3.3) — these are structurally distinct object groups, not one system.
- `ResearchData`/`ResearchContacts` are edit-proposal overlays, not canonical records, and no general-purpose
  stored procedure was found that applies their `Edit...` fields to canonical tables.
- `vw_ResearchData` presents canonical and proposed values side by side without applying or selecting a winning
  value.
- `sp_BWDirCheckOutProjectBatch` performs check-out (sets `CheckOutDate`, status to `RSCH`) despite a stale comment
  suggesting check-in behavior.
- `sp_BWDirCheckInProjectBatch` finalizes workflow metadata and batch completion but does not apply the
  `ResearchData`/`ResearchContacts` overlay to canonical tables.
- Query Store configuration is `READ_WRITE`/`AUTO` with a 30-day stale-query threshold, ~65–66 MB used of a 100 MB
  cap.
- Retained Query Store history shows parameterized direct writes to `DirCompany`, `DirCompanyDirectory`,
  `DirContact`, and `DirEntity`.
- Retained Query Store history shows **no** `INSERT`/`UPDATE`/`DELETE`/`MERGE` statements against
  `ResearchData`/`ResearchContacts` within the retained (30-day-bounded) window.
- The observed row counts and batch-status distributions in §9–§10, as of the July 2026 investigation.
- The newest observed `CheckOutDate` values were February 25, 2025; `CheckInDate` values continued through July
  2026.
- `spPrepareFullPublishWork` / `spCreateCompanyAndContactsWork` compare canonical records against previously
  published snapshots and queue `INSE`/`UPDA`/`DELE` work into `PubTable`.
- An earlier exploratory query produced invalid, inflated "unchecked item" counts by joining
  `DirProjectBatchItem` to multiple `ResearchStatus` rows before aggregating (§12) — those counts are invalid and
  must not be reused.

### Strong inferences

- New research-batch check-outs appear to have stopped after February 2025 — inferred from the absence of later
  `CheckOutDate` values in the inspected data, not proven absolutely.
- The research/batch subsystem is draining a long-lived legacy backlog rather than receiving new intake.
- Some direct canonical writes may originate from a legacy ADO-style application, based on temporary-object naming
  patterns observed in Query Store — this is a clue, not a confirmed source.
- `ResearchData`/`ResearchContacts` are unsafe as a new-intake integration surface, given the unresolved apply path,
  the orphaned/inconsistent rows in §10, and the absence of confirmed write activity against them in the retained
  Query Store window.
- Manual entry through the existing, authorized Business Wise/Delphi workflow is the safest available first-pilot
  write surface, given the unresolved state of every direct-write alternative inspected.

---

## 16. Open questions

1. Which application performs each canonical write observed in Query Store?
2. What exact logic applies approved research changes from `ResearchData`/`ResearchContacts` into canonical tables?
3. Is Retool still actively used against this database?
4. Why did new batch check-outs stop in February 2025?
5. Why are old batches still being checked in as late as July 2026?
6. Who (which user/process) performs the recent check-ins?
7. Why do completed (`COMP`) batches retain research rows instead of being cleared?
8. What happened to the batch associated with the 3,234 orphaned `ResearchContacts` rows?
9. Are the orphaned rows intentional retained history, or evidence of failed cleanup?
10. What do all `DirProjectBatch`/directory status codes mean, comprehensively?
11. What validation, if any, occurs before a direct canonical write?
12. Are external jobs, services, or scheduled processes involved in any of these writes?
13. What downstream process or system consumes `PubTable`?
14. What rollback and audit mechanisms exist for canonical writes?
15. Which fields are required for a canonical save versus for publication, at the database level?
16. What is the authoritative source for parent/HQ/affiliate relationship data?
17. Does the suspected alias defect in `spCreateCompanyAndContactsWork` (§14) produce observable errors or bad
    data in practice?
18. Should the legacy research/batch backlog be cleaned up, migrated, archived, or left untouched?

---

## 17. Project 1 engineering guardrails

**This section is binding guidance for the pilot, not a suggestion.**

For the first pilot, Project 1 must **not**:

- write directly to `DirCompany`
- write directly to `DirCompanyDirectory`
- write directly to `DirContact`
- write directly to `DirEntity`
- insert into `ResearchData`
- insert into `ResearchContacts`
- use `ResearchStatus` as the new workflow engine
- create `DirProjectBatch` records
- create `DirProjectBatchItem` records
- write to `PubTable`
- invoke any publication procedure (`spPrepareFullPublishWork`, `spCreateCompanyAndContactsWork`,
  `spCompletedWorkItem`, `spCompletedPublish`, or related `spCreate...Work` procedures)
- modify Retool
- create production migrations

Instead, the pilot's intake path is:

```
external source observation
        ↓
isolated local candidate/proposal records
        ↓
entity-resolution assessment
        ↓
field-level evidence and confidence
        ↓
readiness assessment
        ↓
human review
        ↓
approved research packet
        ↓
manual entry through the existing authorized Business Wise/Delphi workflow
```

This matches the write policy already established in `BWI_DOMAIN_RULES.md` §19 ("Delphi remains the final human
write surface... No direct production database writeback until the technical architecture and supported publish
path are verified") and this repo's stated non-goals in `README.md`.

**Direct production integration is deferred until all of the following are understood and approved:**

- authoritative source of truth for each object group
- application ownership of each write path
- permissions model
- validation rules enforced (if any) at write time
- transaction boundaries
- side effects of a canonical write (e.g. downstream publication triggers)
- synchronization behavior between subsystems
- publication behavior (what `PubTable` work is actually consumed by, and when)
- auditability of a write
- rollback behavior

---

## 18. Relationship to other repository documents

- **[`docs/BWI_DOMAIN_RULES.md`](./BWI_DOMAIN_RULES.md)** — the authoritative business-domain reference (fields,
  publication readiness, lifecycle status meanings, contacts). §22 of that document lists the production-architecture
  unknowns this discovery addresses; several of those items (database(s) behind Delphi, stored procedures/batch
  jobs, whether Retool can be revived, safe production-write path) are now informed by the findings above, though
  most remain only partially resolved (see §16).
- **[`docs/OPTION_A_DISCOVERY_DESIGN.md`](./OPTION_A_DISCOVERY_DESIGN.md)** — the company-discovery pipeline design.
  Its Part 9 prerequisite #1 ("a real BWI comparison universe... open question §23.12") and its explicit non-goal of
  any Delphi/production write path are consistent with, and reinforced by, this document's §17 guardrails.
- **`README.md`** — states the current code intentionally stops at `BusinessWiseAdapter` as an uninstantiated
  interface pending "technical discovery with Rif and Randall." This document is that discovery's first durable
  record.
- **`src/business-wise-adapter.ts`** — the adapter boundary this discovery informs. It remains unimplemented; this
  document does not change that.

---

## 19. Validation notes

This document was reviewed for internal contradictions before being added to the repository. No existing repository
documentation was modified as part of this task.

One point of terminology worth flagging for a future pass (not resolved here, per this task's documentation-only
scope): `BWI_DOMAIN_RULES.md` §22 lists "triggers, stored procedures, services, or batch jobs" as unresolved
architecture; this document resolves several of those specifically (the check-out/check-in and publication
procedures), while the deeper question of *what applies approved research edits to canonical tables* (§16 Q2)
remains genuinely open. No existing document currently states a conflicting answer to that question, so no
correction to prior documentation is required.

No credentials, IP addresses, phone numbers, usernames, or secrets are present in this document.
