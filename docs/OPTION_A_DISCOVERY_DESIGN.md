# Option A — New-Company Discovery: Design & Strategy Review

**Status:** Brainstorming/design exercise — no code changes, no architecture locked
**Date:** July 2026
**Audience:** Shaan, Nirv, Emily, Rif, Randall
**Evidence discipline:** Every material claim is labeled **VERIFIED FACT** (supported by a file in this repo),
**INFERENCE** (follows from verified facts), **IDEA** (proposal), or **OPEN QUESTION** (unknown; needs the BW team).

---

## PART 1 — VERIFIED CURRENT STATE

### 1.1 What actually exists today

| Statement | Evidence |
|---|---|
| Project 1 is a **local sandbox vertical slice** (Bun + SQLite + TypeScript), explicitly not connected to any BW production system. | `README.md` ("safe, local vertical slice"; "does **not** write to Business Wise production systems"), `src/db.ts` (`data/sandbox.sqlite`) |
| A **SourceAdapter abstraction already exists**: `sourceId`, `sourceName`, `fetch(): RawSourceRecord[]`, `toCandidate(): MappingResult`, registered in a registry. | `src/sources/types.ts`, `src/sources/registry.ts` |
| Two **fixture** DFW adapters exist (`dfw-json`, `dfw-csv`) reading local sample files. **No real external source is integrated yet** — not even the actual DFW chamber report. | `src/sources/dfw-json-adapter.ts`, `src/sources/dfw-csv-adapter.ts`, `data/sources/*`; `README.md` "Next engineering steps" #1: "Plug in a real DFW source" |
| **Ingestion is idempotent** per source record via fingerprints (`sourceId + sourceRecordId`, else hash of stable fields), tracked in `source_records`; reruns produce `New candidates: 0`. Bad rows are skipped, never crash a run. `source_runs` records per-run counts. | `src/sources/fingerprint.ts`, `src/ingestion.ts`, `README.md` |
| **Provenance per candidate** exists at the observation level: sourceId/name/URL/recordId/fingerprint/ingestedAt + `capturedAt` + `rawSourceData`. **Field-level evidence does not exist** — `evidence` is a flat `string[]`, not the `FieldEvidence<T>` shape §15 recommends. | `src/types.ts` (`SourceProvenance`, `LocationCandidate.evidence`), `docs/BWI_DOMAIN_RULES.md` §15, gaps list in `docs/COMPANY_LOCATION_MODEL.md` |
| The domain model splits **`CompanyIdentity` (company-level facts) from `LocationCandidate` (location-level facts)**, mirroring BW's location-centric model and Delphi's "Duplicate" workflow. Ingestion always creates one fresh provisional identity per observation — **no company mastering/merging exists**. | `src/types.ts`, `docs/COMPANY_LOCATION_MODEL.md`, `docs/BWI_DOMAIN_RULES.md` §2, §18 |
| **Entity resolution** compares one candidate against `existing_companies` using company evidence (Dice name similarity, domain match, SIC match) and location evidence (address similarity, phone match, city/state match), with fixed-weight scoring and thresholds → `likely_new` / `possible_duplicate` / `likely_duplicate`. The richer §12.4 taxonomy (new branch, HQ move, rename…) is **not implemented**; the evidence split is designed to support it later. | `src/entity-resolution.ts`, `docs/BWI_DOMAIN_RULES.md` §12.4, `docs/COMPANY_LOCATION_MODEL.md` |
| Four deliberately independent evaluations exist: entity resolution, research completeness (weighted descriptive score), publication readiness (rule gate; only `min_one_contact` + `company_name_present` confirmed-blocking today, despite §8.2's larger confirmed set — a tracked, intentional gap), and review priority (favors likely-new, S/H site types, 10–99 employees). | `src/scoring.ts`, `src/publication-readiness.ts`, `README.md` "Four separate concepts" |
| The **review queue is a console table** (`bun run queue`). A `review_status` column exists but there is **no review UI, no reviewer-decision capture, and no feedback loop**. | `src/queue.ts`, `src/db.ts` |
| The BW production boundary is an **uninstantiated interface** (`searchPotentialMatches`, `stageApprovedCandidate`). All production architecture (Delphi write path, Azure SQL/ADF, Retool revival, Mojo API, export paths, geocoding) is **explicitly unresolved**. Delphi remains the human write surface for the pilot. | `src/business-wise-adapter.ts`, `docs/BWI_DOMAIN_RULES.md` §19 (write policy), §22 |
| The seeded "existing BW universe" is **3 mock records**. No real BW export has been matched against. | `src/seed.ts` |
| **No enrichment exists.** Enrichment adapters (website, LinkedIn, phone/email validation, SIC proposal) are listed as future step #5. **No LLM/AI is used anywhere in the codebase today.** | `README.md` "Next engineering steps"; absence of any such code in `src/` |
| Historical intake sources are documented: county business-license datasets, local business journals, chambers of commerce, economic-development orgs, client Research-on-Demand. Emily and Jen are currently manually working a **DFW chamber/economic-development report about companies that moved HQ or expanded in DFW**. | `docs/BWI_DOMAIN_RULES.md` §21 |
| Manual research averages **~7–8 minutes per ordinary record**; the dedicated intake research staff **no longer exists**. Markets are DFW, Atlanta/Georgia, Charlotte. Core client segment: Single Site/HQ, 10–99 employees; generally 4+ employees. | `docs/BWI_DOMAIN_RULES.md` §20, §6.2 (Market), §14; `README.md` ("That staff no longer exists") |
| BWI lifecycle statuses (DIRE/DEL/RDL-or-RDEL/research) are modeled raw + normalized; matching must consider **all lifecycle statuses including deleted and research-deleted** records. | `src/bwi-codes.ts`, `src/types.ts`, `docs/BWI_DOMAIN_RULES.md` §4, §12.3 |
| Pilot success metrics are already defined (operational, entity-resolution, and economic), including false-new rate, human minutes per approved record, cost per approved record. | `docs/BWI_DOMAIN_RULES.md` §20 |

### 1.2 Where the Option A framing conflicts with or oversimplifies the repo

1. **"Partially implemented" overstates the funnel.** The intelligence layer (schema, matching, scoring, readiness, provenance, idempotent ingestion) is real and tested. But there is **no real source, no enrichment, no evidence gathering, no review workflow, no reviewer decisions, and matching has only run against 3 mock records**. The stated pipeline "…research/enrich… gather evidence… Emily/Jen approve" describes design intent (§15, §19), not implementation.
2. **"Compare against Business Wise records" is not yet possible at scale.** Whether BW can export its universe with stable BW IDs and all lifecycle statuses is open question §23.12. Option A's viability hinges on this **more than on any source**.
3. **The framing treats "the DFW chamber report" as an integrated pilot source.** VERIFIED FACT: it is being worked *manually* by Emily/Jen; the repo's adapters are fixtures. Obtaining the original digital source is itself an open task (§21).
4. **Discovery outcome taxonomy richer than the code.** The framing's classes (new company / new branch / existing / duplicate / rename) match §12.4's *target* taxonomy; code produces only three classes today.
5. **The framing implies review capacity exists.** Reviewer volume tolerance for Emily/Jen is nowhere quantified in the repo. (OPEN QUESTION — see Part 14.)
6. **Not in the repo at all:** Monday walkthrough transcripts, Emily's original documents, Azure architecture docs, Retool artifacts, Data Entry DB / Client DB schemas. `docs/BWI_DOMAIN_RULES.md` §24 lists them as *source evidence consolidated*; the artifacts themselves are external. Everything below leans only on the consolidation.

---

## PART 2 — DEFINING OPTION A PRECISELY

### 2.1 Concept separation

| Concept | Definition | Inside Option A? |
|---|---|---|
| **Candidate generation** | Producing raw observations from external sources → normalized `LocationCandidate`s | **Core of Option A** |
| **Company discovery** | Surfacing a company with *no* BWI row in any lifecycle status | **Core of Option A** (the headline output) |
| **New branch/location discovery** | Surfacing a new site of a company BWI already knows | **Core of Option A** — arguably equally valuable (BW is location-centric; INFERENCE from §2) |
| **Expansion signals** | Evidence a known company is growing/moving into a market (hiring, permits, announcements) | **Option A input**, used as corroboration and prioritization, not standalone records |
| **Company-change/update signals** (moves, renames, closures) | Events on existing records | **Out of scope** for Option A proper — this is the Research-on-Demand / freshness problem (§17, explicitly Phase 2). But Option A's sources will surface these as by-products; the system should *route* them, not drop them. |
| **Entity resolution** | Deciding candidate vs. BWI universe, and candidate vs. candidate | **Supporting infrastructure** (Option B), but a hard prerequisite — discovery without it is noise generation |
| **Company research / enrichment** | Filling required fields (address, phone, SIC, contacts…) | Supporting infrastructure (Option B). Option A only needs *enough* enrichment to make review efficient |
| **Database intake** | Approved record → Delphi entry | **Out of scope**; stays manual per §19 |

**INFERENCE:** Option A is therefore not "more scraping." It is: *multiple observation streams → one candidate universe → novelty determination against BWI → prioritized, evidence-backed review*. The determination step is the product; sources are commodity inputs.

### 2.2 What constitutes a "discovery"? A taxonomy

**IDEA — Discovery event taxonomy** (aligned to §12.4's outcome taxonomy and §14's priorities):

| Event type | Example signals | Is it a discovery? | BW value |
|---|---|---|---|
| **D1. New operating company in a BW market** | Chamber listing + website + address + phone | Yes — the canonical discovery | Highest, if 4+ employees, S/H site |
| **D2. First market entry by an existing out-of-market company** | HQ relocation to DFW (exactly what the current DFW report contains), first TX branch of a national firm | Yes — new BWI row(s); may be new company *and* new location | High — DFW report proves BW already values this |
| **D3. New branch of a company BWI already has** | New location page, new local license, hiring at new address | Yes — a *branch discovery*, classified `new_branch_of_existing_company` | Moderate-to-high (branches carry fewer corporate fields, §3) — value is an OPEN QUESTION |
| **D4. Newly formed legal entity (SoS registration)** | New LLC/corp filing | **Not by itself.** Most filings are shells, holding entities, side projects, or pre-operational. A filing is a *precursor signal* that becomes a discovery only when corroborated by operation evidence (address, phone, site, hiring). | Low alone; high as corroboration/freshness signal |
| **D5. Newly visible but not new** (company newly appears in a directory, launches a website, gets press) | Directory refresh, new domain | Only if BWI-novel. Often the company is old — this is a *coverage-gap discovery*, still valuable (BW's goal is a complete universe, not only newborn firms). Distinguish **new-to-world** from **new-to-BWI**; BW's economics care about new-to-BWI. | Moderate |
| **D6. Expansion/relocation signals on known companies** (HQ move, aggressive hiring, permit at new address) | Job postings spike, building permit | Not a discovery — an *update or pre-discovery signal*. Route to a future freshness pipeline; use to raise priority of any co-occurring D1–D3 candidate. | Indirect |

**Working definition (IDEA):** *A discovery is an evidenced claim that a specific physical business location, belonging to an identified company with plausible client relevance (BW markets; generally 4+ employees), has no corresponding BWI row in any lifecycle status.* One discovery = one candidate BWI row. "Company vs. branch" is a classification *on* the discovery, not a different pipeline.

---

## PART 3 — EXTERNAL SOURCE / SIGNAL LANDSCAPE

Legend for the per-class assessments: **Novelty** = share of candidates likely new-to-BWI; **ER difficulty** = entity-resolution difficulty. All assessments in this part are **INFERENCE/IDEA** unless marked; the repo verifies only §21's historical source list and §15's research source types.

### A. Authoritative / structured sources

| Source | Signal | Structure | Coverage/refresh | Noise | Novelty | ER difficulty | Provenance | Access | Cost/complexity | Funnel fit |
|---|---|---|---|---|---|---|---|---|---|---|
| **TX Secretary of State / franchise-tax registrations (Comptroller)** | New legal entities; registered agent + officer data. TX Comptroller publishes taxable-entity data as open bulk downloads. | Highly structured (CSV/bulk) | Statewide; weekly–monthly | **Very high** (shells, DBAs of individuals, holding cos, registered-agent addresses) | High new-to-world, low direct usefulness alone | Hard: legal names ≠ operating names; agent addresses ≠ operating addresses | Excellent (government record, stable IDs) | Download/API; no scraping | Low integration cost, high filtering cost | **Corroboration + freshness feed**, not primary |
| **County/city business licenses & registrations** (already a historical BW source — VERIFIED, §21) | An operating business at an address | Structured; many DFW jurisdictions publish via open-data portals (e.g. Dallas Open Data) — availability per jurisdiction is an OPEN QUESTION | Per-jurisdiction patchwork; monthly-ish | Moderate (sole proprietors, home businesses) | Good | Moderate (real addresses help a lot) | Very good | Portal download/API where offered | Medium (N jurisdictions × N formats) | **Primary candidate generator** — proven historically by BW |
| **Certificates of occupancy / commercial building permits** | A business physically moving into a space — strongest "physical operation at address" signal | Structured, address-first | City-level (Dallas, Fort Worth, Plano publish CO data); weekly | Low-moderate | Moderate (mix of new firms and known firms' new sites) | Moderate; often gives tenant name + exact address | Excellent | Open-data portals | Medium | **Primary for D2/D3 branch discovery** |
| **Chambers of commerce / EDO reports** (current source — VERIFIED, §21) | Curated relevant businesses; new members; relocation/expansion reports | Semi-structured (PDF/HTML directories) | Metro; monthly/quarterly | Low | Moderate (chambers list established firms) | Low-moderate | Good (named org) | Often no API → export or scrape; membership-directory ToS need checking | Low-medium | **Primary — already the pilot** |
| **Regulatory/licensing boards** (TDLR, health dept food permits, TABC, medical/childcare licensing) | Operating businesses in specific verticals with addresses | Structured | Statewide; regular | Low within vertical | Vertical-dependent | Low-moderate | Excellent | Mostly downloadable | Medium per vertical | Vertical booster (see G) |

### B. Commercial / business data sources

Providers like D&B, ZoomInfo, Data Axle, SafeGraph/Placekey, Coresignal, People Data Labs, etc. **VERIFIED FACT:** the repo shows no existing BW data subscriptions except research tools (Perplexity, Hunter — §15). Whether BW has other subscriptions is an OPEN QUESTION (Part 14).

- Signal: broad firmographics; "new business" feeds; contact data.
- Novelty: **the central doubt.** BW's differentiation is human-verified, local, contact-rich records; commercial aggregates are exactly what BW competes against. Buying the same aggregate everyone has yields low incremental novelty but could be a cheap *corroboration and enrichment* layer (address/phone/employee-count cross-checks) and a matching aid.
- ER difficulty: low-moderate (they ship IDs, addresses, domains).
- Cost: recurring, potentially significant; licensing usually prohibits republication — **legal review required before any provider's data influences published BW records** (OPEN QUESTION).
- Funnel fit: enrichment/corroboration, possibly a purchased "new businesses in DFW" feed to benchmark our own sources against. Not the backbone.

### C. Location / physical presence signals

- **Google Places / mapping data:** newly appearing places, addresses, phones, categories. High coverage, but ToS restricts caching/bulk use and cost scales badly; branch-vs-company ambiguity high (franchises!). Good as *per-candidate verification* (does a place exist at this address?) rather than sweep discovery.
- **Commercial real estate signals** (leases signed, tenant announcements, CoStar-type data): extremely aligned with BW's client base (note VERIFIED client filters: building name, lease expiration, square footage, rumored move — §16). Likely paid/licensed; strong long-term candidate.
- **Certificates of occupancy** (covered in A) are the cheap, legal version of this class.
- Storefront/foot-traffic datasets: skew retail; BW's core segment is unclear here (OPEN QUESTION: industry mix of BW clients' targets).

### D. Hiring / workforce signals

- Job-posting aggregates (state workforce data, scraped boards, paid feeds like Coresignal): signal that a company is operational and its locations. Rarely reveals a *new-to-world* company first; excellent for (a) confirming operation, (b) locating sites, (c) employee-size estimation, (d) detecting D2 market entry ("first Dallas postings by an out-of-state firm").
- Noise high, ER difficulty high (postings use brand names, staffing agencies pollute), ToS issues for scraping major boards.
- Funnel fit: **corroboration + prioritization signal**, phase 2+.

### E. Web / digital presence signals

- New domain registrations: enormous noise (parked domains, individuals); WHOIS privacy kills attribution. Weak primary signal.
- Company websites/location pages: **the verification backbone, not a discovery sweep.** VERIFIED: website/team-page research is already how BW works (§15). Automating "given a candidate, find and read its website/locations page" is high value and belongs to enrichment.
- Business directory diffs (Yelp/YellowPages/etc.): stale, ToS-restricted, high duplicate rate. Low priority.

### F. News / announcement signals

- Dallas Business Journal, local news, EDO press releases, funding announcements. VERIFIED: business journals are a historical BW source (§21).
- Unstructured → this is one place where **LLM extraction is genuinely warranted** (turn articles into structured candidate/event records), with per-article cost control.
- Novelty moderate; recency excellent; evidence quality excellent (citable URL); volume manageable (tens/week, not thousands).
- Funnel fit: high-precision, low-volume candidate generator + D2/D6 event detector. Good pilot complement precisely because it is *fundamentally different* from license-style rosters.

### G. Industry-specific sources

If certain SICs dominate client value (OPEN QUESTION), vertical licensing boards (A) give near-complete, authoritative rosters cheaply: health permits → restaurants; TDLR → salons/electricians; state health facility licenses → clinics; TABC → bars. Disproportionate value only if the verticals match client demand — do not build until that's answered.

### H. Non-obvious sources

- **BW's own client Research-on-Demand stream** (VERIFIED it exists, §17): "company not found" requests are literally clients telling BW what's missing — a free, perfectly relevance-weighted discovery source. Phase 2 per §21, but the highest-precision signal on this whole list.
- **BW's own deleted/RDL history**: re-checking research-deleted candidates when new external evidence appears (the repo already retains all lifecycle statuses for matching — §12.3).
- Nonprofit/990 filings, SBA loan data, UCC filings, new DBA/assumed-name county filings, LinkedIn company-page creation, local award lists ("Best Places to Work," "Fast 50"), commercial utility connections (rarely public).
- Assessment: mostly corroboration-grade; assumed-name filings are a decent D1 signal in TX (county-level, structured).

---

## PART 4 — SOURCE PRIORITIZATION

### 4.1 Scoring framework (IDEA)

Score each source 1–5 on:

1. **Net novelty** — % of candidates genuinely new-to-BWI *after* dedup against other integrated sources (incremental uniqueness, not gross yield)
2. **Relevance density** — % of candidates in BW's target profile (market, 4+ employees, operating business)
3. **Evidence quality** — can a reviewer trust/cite it? (authoritative > curated > scraped)
4. **Acquisition simplicity** — bulk download/API > export > scraping; ToS-clean; stable
5. **ER tractability** — does it ship addresses/IDs/domains that make matching cheap?
6. **Refresh economics** — update frequency × marginal new records per refresh
7. **Cost** — integration + recurring (fees, maintenance, LLM extraction)

Weighted priority ≈ `(novelty × relevance × evidence) × ER tractability / cost`, with acquisition simplicity as a gate (don't build fragile scrapers in the pilot at all). Crucially, **novelty and relevance can only be measured empirically** — hence the pilot design in Part 9 measures before committing.

### 4.2 Recommendations

**TOP 3 for the Option A pilot:**
1. **DFW chamber/EDO report** (real digital feed, replacing the fixtures) — already chosen, already manually validated by Emily/Jen, gives labeled ground truth for free.
2. **One DFW-area county/city business-license or certificate-of-occupancy open dataset** (pick the single jurisdiction with the cleanest downloadable feed) — authoritative, address-first, historically proven BW source class (§21), zero scraping.
3. **Dallas Business Journal / local business news via LLM extraction** — fundamentally different signal shape (event-driven, unstructured, high recency), small volume, tests the cross-source corroboration machinery.

**TOP 5 after the pilot (add):**
4. TX SoS/Comptroller new-entity feed — as a *corroboration/freshness layer* joined to the above, never surfaced alone.
5. Client Research-on-Demand "company not found" intake as a discovery source (needs Mojo access — OPEN QUESTION §22).

**Longer-term:** second/third license jurisdictions (replicating #2), hiring-signal feed for corroboration and employee-size estimation, one commercial dataset trialed purely as enrichment/benchmark, CRE/tenancy data (strong fit with §16 client filters), vertical licensing boards if the industry-value question lands that way, and replication of the whole stack to Atlanta and Charlotte (which is mostly *configuration* if adapters are built right — that's the real payoff of the abstraction).

Explicitly **not recommended:** new-domain monitoring, directory scraping, Google Places sweeps, buying a broad aggregator as a primary discovery source.

---

## PART 5 — MULTI-SOURCE DISCOVERY ARCHITECTURE

### 5.1 Fit with what exists

The proposed chain maps almost 1:1 onto the repo, which de-risks Option A considerably:

- SOURCE ADAPTERS → exists (`SourceAdapter`, registry)
- RAW SOURCE RECORD → exists (`RawSourceRecord`, `rawSourceData` kept immutable on the candidate; keep it so)
- PROVENANCE → exists at observation level (`SourceProvenance`); field-level (`FieldEvidence<T>`, §15) missing
- NORMALIZATION → exists (`normalize.ts`, `bwi-codes.ts`, adapter mapping)
- CANDIDATE ENTITY → exists (`CompanyIdentity` + `LocationCandidate`)
- BWI MATCHING → exists in simple form (`entity-resolution.ts`)
- NOVELTY CLASSIFICATION → partial (3-way; §12.4 taxonomy pending)
- **CROSS-SOURCE CLUSTERING → does not exist** (deliberately: "ingestion must not perform company mastering," §18)
- SIGNAL AGGREGATION / DISCOVERY CONFIDENCE → does not exist
- RESEARCH/ENRICHMENT → does not exist
- HUMAN REVIEW → console table only; decision capture missing

**INFERENCE:** the single biggest *new* architectural element Option A introduces is a **cross-source clustering step between ingestion and review** — a `DiscoveryCase` (IDEA) that groups multiple observations of the same real-world location. Everything else is extension, not invention.

### 5.2 Design positions (IDEA unless noted)

- **Common adapter interface:** yes — proven. One extension: adapters should be able to emit an optional `observationKind` (roster listing / registration / event-news / permit) so downstream logic can weight source classes without knowing source specifics. Event-like sources (news) still emit `LocationCandidate`s, possibly with sparse location data.
- **Raw records immutable:** yes (already the practice). Re-mapping after an adapter bugfix should be possible from stored raw payloads.
- **Normalized candidate schema:** current `LocationCandidate` is sufficient for the pilot; additions needed for multi-source: nothing structural — observations stay one-per-source-item. What's new sits *beside* them.
- **Cluster before or after BWI matching?** **Match each observation against BWI first, then cluster observations.** Reasons: (a) matching is per-observation and already built; (b) clustering benefits from match results (two observations both matching BW record X is itself clustering evidence); (c) a cluster whose members disagree about BWI matches is precisely the `ambiguous_manual_review` case (§12.4) and should be surfaced, not resolved silently. Clustering uses the same similarity machinery (name/domain/address/phone) candidate-vs-candidate — reuse `scoreCandidateAgainstExisting`'s evidence structure with a `LocationCandidate`-vs-`LocationCandidate` comparator.
- **DiscoveryCase (new concept):** `{ caseId, memberObservationIds[], consolidatedView, bwiMatch summary, noveltyClass, discoveryConfidence, status (open/approved_*/rejected/deferred/suppressed), decisionLog[] }`. The *case*, not the observation, is the unit of review, idempotency, and metrics. Observations are append-only; cases are stateful.
- **Company vs. location representation:** keep the existing split. A case proposing "new branch of BW company X" carries a link to X and proposed inherited company fields per §12.5 (safe: website, email format, SIC, start year, relationship; never: phone, address, site employee size, contacts).
- **Conflicting source data:** never merge destructively. The consolidated view is computed with a source-precedence policy (authoritative > curated > extracted), all values retained per-source, conflicts flagged to the reviewer ("license says Suite 200; website says Suite 210"). Field-level `FieldEvidence` (§15) is the natural container — this is the strongest argument for building §15 *before* multi-source.
- **Source-specific identifiers:** already stored (`sourceRecordId`, fingerprint); keep per-observation, list on the case.
- **Temporal history / repeated observations:** re-observation of a known fingerprint currently just increments `alreadyIngestedCount`. For discovery we want `lastSeenAt`/`timesSeen` on `source_records` (cheap) so cases can show "seen in 3 consecutive monthly license files" — a persistence signal — and so *disappearance* from a roster can eventually feed the freshness pipeline.
- **Idempotency of discovery:** two layers, both required: (1) observation-level fingerprints (exists); (2) **case-level suppression** — a decided case (approved or rejected) absorbs future matching observations silently instead of re-surfacing. This is the answer to "how do we avoid rediscovering the same business every week," and it's the most important missing piece for any recurring source.
- **Rejected candidates + new evidence:** rejection reasons must be typed (`not_a_business`, `too_small`, `out_of_market`, `duplicate_of_bwi_X`, `insufficient_evidence`). Only `insufficient_evidence` rejections re-open when a *new independent source class* observes the entity; the rest stay suppressed (with a periodic "aged rejections" audit rather than automatic resurrection).
- **Deleted BWI records:** already handled in principle — matching spans all lifecycle statuses (§12.3). A candidate matching a `DEL`/`RDL` record is not "new"; it's a distinct novelty class (**"previously deleted, reappearing"** — potentially a re-opened or resurrected business) worth its own review label. Requires the BW export to include deleted rows (open question §23.12).

---

## PART 6 — DISCOVERY CONFIDENCE / SIGNAL AGGREGATION

### 6.1 Four separate confidences (agree — keep them separate, matching the repo's "four concepts" discipline)

1. **Existence confidence** — is this a real, operating business at a real location? Driven by: source authority, independent-source count, physical evidence (CO/permit/address), website confirmation, phone, hiring, freshness, cross-source name/address agreement.
2. **Novelty confidence** — new to BWI? Driven by entity resolution (inverse of match score), completeness of the BWI comparison universe, and lifecycle-status nuances (matches-a-deleted-record ≠ novel ≠ duplicate).
3. **Relevance confidence** — worth adding? Market, employee-size estimate, site type, industry, operating-business-vs-sole-proprietor signals. This encodes §14's confirmed priorities.
4. **Classification confidence** — is the proposed company/branch/rename label right? Driven by the companySimilarity/locationSimilarity split (already designed for exactly this).

**Review priority = f(all four) — and it already exists in embryo** (`reviewPriority()` = novelty + relevance + completeness). Option A extends its inputs; it does not need a new concept, and it certainly does not need ML to start.

### 6.2 Mechanism: start with transparent additive scoring

**IDEA:** rules → weighted score → (much later, if volume justifies) learned model. Reviewer-facing scores must be explainable ("why was this surfaced?" is a required review-packet field per Part 7); the repo's existing `reasons: string[]` pattern extends naturally. An opaque model would undermine the review workflow and cannot be trained anyway until reviewer decisions are captured — **labels before models.**

Illustrative existence scoring: authoritative source with address (+0.35), each additional independent source class (+0.2/+0.1), website confirms name+location (+0.2), physical evidence (CO/permit) (+0.15), phone verified (+0.1), observed over multiple refreshes (+0.05), name/address conflict across sources (−0.15), registered-agent-style address (−0.2).

### 6.3 Worked examples (hypothetical)

**Company A** — SoS registration + live website + 14 Dallas job postings + EDO announcement: existence ≈ 0.95 (4 independent classes, incl. authoritative + self-published + third-party); novelty per ER; relevance high (hiring 14 = clearly ≥4 employees, DFW). → top of queue, with SoS date + EDO URL as citable evidence.

**Company B** — one scraped directory listing, no address: existence ≈ 0.3, relevance unknown, novelty unmeasurable (no address/domain to match on). → does **not** reach reviewers; parks in a low-confidence pool awaiting a corroborating observation. **The queue should have an evidence floor, not just an ordering** — that's the concrete mechanism that protects Emily/Jen.

**Company C** — chamber listing + license, but 0.94 name match to a BW `DEL` record at a different address: existence high, novelty *ambiguous in an interesting way* → surfaced as "possible reappearance/relocation of deleted record," explicitly requesting human judgment.

---

## PART 7 — HUMAN REVIEW EXPERIENCE

**VERIFIED baseline:** §19 already specifies the review packet (source observation, provisional data, closest BWI matches across all statuses, similarity evidence, recommended classification, proposed inherited fields, evidence URLs, completeness, publication status + blockers, priority) and six reviewer actions. Option A should *extend*, not replace:

**Additions for multi-source discovery (IDEA):**
- One **DiscoveryCase per screen**, not one observation: consolidated view + per-source values + conflicts highlighted.
- "**Why surfaced**": the score's reason list in plain language ("Found independently in Tarrant County licenses and DBJ article (link); no BWI match above 0.4; est. 20 employees").
- **One-line evidence per field** with URL (the §15 FieldEvidence payoff) — reviewers shouldn't re-research what the system already cited.
- Missing-required-fields list phrased as *what Delphi entry will need* (drives the "needs more research" decision).
- Two extra actions beyond §19's six: **`mark_rename`** (in §12.4 but not §19) and **`defer`**; plus typed rejection reasons (Part 5.2).
- **Batch affordances:** approve/reject filtered sets (e.g., all sub-4-employee sole proprietors from a license file) — reviewer minutes per decision is the metric that decides Option A's fate.

**Feedback loop (essential, cheap, currently absent):** every decision is a persisted labeled example: (candidate, best match, classification, decision, reason). Uses: threshold calibration against Emily's judgment (already README step #6), per-source acceptance-rate dashboards (Part 8), suppression, and eventually learned ranking. **Capturing decisions in the sandbox DB is arguably the single highest-leverage small build in either Option.**

Write path: unchanged — approval produces a "ready for Delphi entry" packet; Emily/Jen key it into Delphi (§19). A post-entry confirmation step (record the resulting BW ID against the case) closes the loop and enables true end-to-end metrics.

Tooling: whether Retool can be revived is unresolved (§22). The review-experience *contract* above is tool-agnostic; per README step #8, build a UI only after the case schema and decisions stabilize.

---

## PART 8 — ECONOMICS AND SUCCESS METRICS

### 8.1 Funnel metrics (extends §20's verified metric list)

Per source *s*, per period:

- `raw(s)` → `valid(s)` → `unique_obs(s)` (post-fingerprint) → `cases(s)` (post-clustering) → `above_floor(s)` (reach review) → `approved_new_company(s)`, `approved_new_branch(s)`, `linked/dup(s)`, `rejected(s)`
- **Useful discovery rate** = approved / above_floor  (reviewer signal-to-noise; the metric that protects Emily/Jen)
- **Novelty rate** = cases not matching BWI / cases
- **Incremental uniqueness** = approved discoveries observed by *s* first (or only) / approved — the anti-overlap metric that decides whether source N+1 earned its keep
- **False-new rate** = approved-then-found-duplicate / approved (matching quality; from §20)
- **Reviewer minutes per approved record**; **cost per approved record** = (amortized integration + recurring fees + compute/LLM + reviewer time) / approved
- **Benchmark:** manual research ≈ 7–8 min/record (VERIFIED §20). If (reviewer minutes + residual research minutes) per approved record isn't well below the fully-manual path *including finding the company*, the source loses.
- **Capacity**: approved records/month ÷ reviewer hours available ⇒ annualized database growth capacity, the number Shaan ultimately cares about.

### 8.2 Hypothetical source dashboard

| Source | Raw | Cases | To review | Approved | Useful rate | Incr. unique | Min/approved | $/approved | Verdict |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|
| DFW chamber | 180 | 150 | 120 | 70 | 58% | 45 | 3.5 | $6 | Keep |
| County licenses | 2,400 | 900 | 300 | 90 | 30% | 60 | 4.2 | $9 | Keep, tighten floor |
| Biz-journal LLM | 60 | 45 | 40 | 18 | 45% | 6 | 3.0 | $14 | Keep (recency + corroboration value) |
| Directory scrape | 5,000 | 3,000 | 800 | 40 | 5% | 8 | 9.0 | $55 | **Kill** |

"Is this source worth paying for/maintaining?" becomes a quarterly read of three numbers: **incremental unique approved records, cost per approved record, and useful discovery rate trend** (sources deplete — a license backfile yields a burst, then only marginal new registrations; expect and plan for decay).

---

## PART 9 — OPTION A PILOT DESIGN

### 9.0 Prerequisites from Option B (must exist first — this is the honest answer to "how strong must downstream be")

1. **A real BWI comparison universe**: an export with stable BW IDs, names, addresses, phones, websites, and *all lifecycle statuses* (open question §23.12). Without this, novelty classification is fiction and everything downstream is noise. **Hard gate.**
2. **Matching calibrated against a labeled sample** of Emily's manual judgments (README step #6) — even 100–200 labels.
3. **Reviewer decision capture** (Part 7) — else no metrics, no labels, no verdicts.
4. Minimal branch-aware classification: at least split `possible_duplicate` into "same location" vs. "same company, different location" using the existing companySimilarity/locationSimilarity split (§12.4-lite).
5. *Not* required: field-level FieldEvidence (nice-to-have; flat evidence strings suffice for 3 sources), enrichment automation beyond website lookup, any UI beyond a spreadsheet/console export, cross-source clustering in full generality (with 3 sources, candidate-vs-candidate matching using existing machinery is enough).

### 9.1 Pilot shape

**DFW chamber report (real feed) + one county/city license or CO dataset + business-journal LLM extraction** — exactly the "roster + authoritative + fundamentally different" triangle, all three within source classes BW has historically used (§21), all obtainable without scraping infrastructure.

- **Volume (estimate, to validate):** chamber ~100–300 records one-shot + monthly delta; licenses ~500–2,000/quarter for one jurisdiction after relevance filtering; news ~10–30 candidates/month. Reviewer exposure capped by the evidence floor and an agreed weekly budget (e.g., ≤ 2–3 hours/week for Emily/Jen — **number to be negotiated, OPEN QUESTION**).
- **Manual on purpose:** source file acquisition (download the license CSV monthly by hand — no schedulers yet), all Delphi entry, final SIC judgment, contact research beyond what sources give.
- **Automated:** ingestion, normalization, BWI matching, novelty classification, case assembly, scoring, queue generation, metrics.
- **Evaluation dataset:** the chamber report is gold — Emily/Jen have *already worked it manually*. Run the pipeline over the same input and compare: candidates they added vs. system's likely-new; duplicates they skipped vs. system's duplicate calls. This yields precision/recall for free and is the single best reason to start with this source.
- **Stop/go criteria (IDEA):** GO if — matching agrees with Emily's chamber judgments ≥ ~90% on duplicates (few false-new); useful discovery rate ≥ ~40% overall; reviewer minutes/approved ≤ ~4; the license source contributes material *incremental* approved records. STOP/rethink if reviewers spend most time correcting classifications, or license noise swamps the floor, or the BWI export proves unobtainable/stale.
- **What justifies expansion:** demonstrated per-source dashboard (Part 8) + a backlog of approved records exceeding Delphi-entry capacity (which would then argue for Option B intake work, informatively!).

---

## PART 10 — FAILURE MODES / RISKS

| Risk | Impact | Likelihood | Mitigation | Experimental detection |
|---|---|---|---|---|
| **Irrelevant-LLC flood** (shells, holding cos, sole props) | Reviewer overload; trust collapse | **High** if SoS-type feeds surface directly | SoS never a primary source; evidence floor; relevance scoring; typed batch-reject | Useful-discovery-rate per source in week 1 |
| **BWI universe incomplete/stale** (export missing deleted/research rows, or unobtainable) | Systematic false-news; worst failure because it *looks* like success | Medium — §23.12 unresolved | Make export the pilot's gate; measure false-new via reviewer decisions; include all lifecycle statuses (§12.3) | Chamber gold-set comparison exposes it immediately |
| **Franchises / DBAs / parent-subsidiary ambiguity** | Wrong company/branch classification; duplicates | High | Don't auto-resolve; `ambiguous_manual_review` class (§12.4); collect labels; franchise handling as an explicit later feature | Classification-override rate by reviewers |
| **Renames/relocations misread as discoveries** | Duplicate records in BW | Medium | Match on phone/domain/address independently of name (already done); "reappearance" novelty class; rename action in review | False-new rate; RoD "name changed" cross-checks later |
| **Repeated rediscovery across refreshes** | Queue clogs with decided entities | **Certain** without case-level suppression | Build suppression before any recurring source goes live (Part 5.2) | Re-surfaced-decided-case count (should be ~0) |
| **Scraping fragility / anti-bot / ToS violations** | Legal exposure; maintenance sink | High if we scrape | Pilot uses only downloads/exports/APIs; ToS review per source; no headless-browser fleet | n/a — avoided by policy |
| **API/LLM cost explosion** | Economics fail silently | Medium | LLM only on low-volume news; per-source cost tracked in $/approved; caps | Cost columns on the dashboard |
| **Reviewer overload / trust loss** | Emily/Jen disengage → pilot dies socially, not technically | Medium-high | Weekly review budget; evidence floor; batch actions; start volumes small; they co-design the packet | Reviewer minutes + qualitative check-ins |
| **Misleading confidence scores** | Reviewers rubber-stamp or distrust | Medium | Explainable reasons, never bare numbers; calibrate against labels; never auto-approve anything | Agreement rate between score bands and decisions |
| **Source decay/lag** (stale directories, license backfile depletion) | Yield collapses post-burst | High over time | Expect burst-then-trickle; incremental-uniqueness metric; retire sources unsentimentally | Trend on approved/refresh |
| **Garbage-in enrichment** (wrong website matched to candidate) | Polluted evidence worse than none | Medium | Website confirmation requires name+geography agreement; evidence carries its matching rationale | Spot-audit sample of evidence links |

---

## PART 11 — BUILD VS BUY VS HYBRID

- **BUY (or rather, *use free/public*):** source data acquisition wherever a download/API exists. Never build scraping infrastructure for the pilot; treat any scraper as a liability with a maintenance mortgage. Consider one commercial data trial strictly as an enrichment/benchmark layer, gated on licensing review.
- **BUILD:** everything from normalization inward — adapters, matching, novelty classification, case/suppression model, scoring, review packets, metrics. This is where all the differentiation lives, and (VERIFIED) roughly half of it already exists in this repo.
- **HYBRID:** enrichment — buy per-lookup services (Hunter is already in BW's workflow, §15), build the orchestration and evidence capture.

**Where the proprietary advantage actually lives (agreeing with the prompt's hypothesis, with evidence):** BW's moat is its existing human-verified, location-centric, contact-rich universe (VERIFIED: this is the product, §16) **plus** the growing set of reviewer-labeled resolution decisions **plus** cross-source novelty determination *against that universe*. Nobody else can compute "new to Business Wise." Sources are commodities; the resolution + labels + evidence-backed intake loop is the asset. Owning a scraper fleet adds no moat and much fragility.

---

## PART 12 — WHAT COULD BECOME PROPRIETARY?

Realistic (each is a direct by-product of Parts 5–8, not extra work):
1. **Labeled entity-resolution corpus** — Emily/Jen's decisions on real candidate-vs-BWI pairs, incl. branch/rename/franchise edge cases. Genuinely scarce data; directly improves the core product.
2. **Longitudinal source-observation history** — first-seen/last-seen per entity per source; over years this becomes local business-lifecycle data (openings, movements, disappearances) no aggregator has at BW's verification quality.
3. **Source performance statistics** — which signals actually precede good BW records; compounds into an ever-cheaper discovery mix.
4. **Company/branch classification patterns** for local markets.

Hype to discount: "discovery graph" as a standalone product, predictive expansion intelligence, selling the data exhaust. Possible someday; irrelevant to whether Option A pays for itself, and none of it should shape near-term architecture beyond "keep observations append-only with timestamps" (already true).

---

## PART 13 — ROADMAP (derived from the repo's actual state and README's own next-steps list)

**Stage 0 — Foundation (exists).** Sandbox slice: adapters, idempotent ingestion, provenance, split domain model, simple ER, four scores, console queue. *Success criterion already met.*

**Stage 1 — DFW proven end-to-end on real data.** Build: real chamber-report adapter (README step #1); real BWI export loaded into `existing_companies`; reviewer decision capture (even CSV-in/CSV-out); calibration vs. Emily's chamber labels (step #6); §8.2 publication-rule promotion (step #2). Depends on: BW export, digital chamber source. Learn: real matching precision, real reviewer minutes. Success: gold-set agreement ≥ target; Emily/Jen willingly work the queue. **Not yet:** clustering, more sources, UI, enrichment automation, FieldEvidence.

**Stage 2 — Second + third source, case model.** Build: license/CO adapter; news-extraction adapter; DiscoveryCase + case-level suppression; branch-aware classification (§12.4-lite via existing evidence split, step #7); per-source dashboard (Part 8). Learn: incremental uniqueness, noise profiles, cross-source conflicts. Success: pilot stop/go criteria (Part 9). **Not yet:** scheduling/monitoring, learned scoring, more jurisdictions.

**Stage 3 — Evidence & enrichment depth.** Build: FieldEvidence (§15, step #4); website-confirmation enrichment; discovery-confidence scoring with explanations; simple review UI once schema is stable (step #8, possibly Retool pending §22). Success: reviewer minutes/approved drops measurably.

**Stage 4 — Scale-out.** Build: additional jurisdictions; SoS corroboration join; RoD intake source (needs Mojo answer); scheduled refreshes + continuous monitoring; second market (Atlanta or Charlotte) as configuration. Success: sustained approved-records/month at target cost; source retirement decisions made from the dashboard.

**Stage 5 — Learning loop.** Build: threshold/ranking tuning from the accumulated label corpus; maybe a learned prioritizer *if* labels number in the thousands. Explicitly last.

---

## PART 14 — CRITICAL OPEN QUESTIONS FOR SHAAN / EMILY / NIRV (+ Rif/Randall)

**Architecture-changing:**
1. Can BW export its full universe (all markets, all lifecycle statuses, stable BW IDs, name/address/phone/website)? How fresh, how often? (§23.12 — the single gating question.)
2. Is a new *branch* worth the same reviewer effort as a new company? (Determines whether branch discovery is a first-class Option A goal or a by-product.)
3. What weekly reviewer budget can Emily/Jen actually commit? (Sets the evidence floor and volume caps for everything.)
4. Which geographies first — DFW only, or design multi-market from day one? Are Atlanta/Charlotte on a timeline?
5. Are there existing paid data subscriptions or feeds we haven't seen? Does Mojo expose Research-on-Demand data programmatically? (§22)

**Source-selection-changing:**
6. Which DFW jurisdictions' license/CO data did BW historically use, and why did that intake stop — source quality or staff loss? Which historical sources yielded the best records?
7. Are specific industries/SICs disproportionately valuable to clients? (Unlocks or kills vertical licensing sources.)
8. How much does *recency* matter to clients ("newly added firms" is a client filter, §16) — is a 3-month-old discovery materially worse than a 2-week-old one?
9. What share of historically discovered businesses actually became published, client-used records? (Calibrates the relevance model and realistic acceptance rates.)
10. Legal/ToS posture: is BW comfortable using chamber directories and commercial data under their license terms in published records?

**Process:**
11. Exact minimum "meaningful contact" and remaining §8.5 publication unknowns (blocks §8.2 promotion).
12. When Emily worked the DFW report manually, what did she reject and why? (Free labels; ask before the memory fades.)

---

## PART 15 — FINAL RECOMMENDATION

**1. What to actually build next if Shaan picks Option A:** not new sources first. In order: (a) obtain the BWI export and load it; (b) replace fixtures with the real DFW chamber adapter; (c) capture reviewer decisions; (d) calibrate matching against Emily's already-done manual work on that same report. That is Stage 1 — and it is, deliberately, mostly Option B work, because Option A's economics are downstream-limited. Then add the license source and news extraction (Stage 2) with DiscoveryCase + suppression.

**2. Explicitly NOT yet:** scraping infrastructure, schedulers/monitoring, review UI, learned models, commercial data purchases, more than one jurisdiction, SoS as a surfaced source, any Delphi/production write path, FieldEvidence generality (keep flat evidence strings through the pilot).

**3. First source categories:** chamber/EDO reports; county/city license–CO open data; local business news via LLM extraction.

**4. Minimum ER capability before adding sources:** matching against the *real* BWI universe across all lifecycle statuses, validated ≥ ~90% agreement with Emily's duplicate judgments on the chamber gold set; branch-vs-same-location split from the existing evidence structure; case-level suppression. Nothing fancier.

**5. Option A fails if:** the BWI export can't be obtained (novelty is guesswork); useful discovery rate stays below ~25–30% and Emily/Jen stop trusting the queue; cost + reviewer minutes per approved record don't beat the ~7–8-minute manual benchmark; or sources mostly rediscover what BW already has (low incremental uniqueness).

**6. Clearly successful if:** the pipeline reproduces Emily's manual DFW-report judgments, the license source adds a steady stream of *incremental* approved records at ≤ ~4 reviewer minutes each, decisions accumulate as labels, and BW's monthly new-record capacity measurably rises without new headcount.

**7. When does it stop being "scraping" and become a capability?** The moment three things co-exist: a maintained comparison universe with novelty determination, case-level memory (suppression + observation history), and a reviewer feedback loop feeding calibration. At that point sources are swappable commodities and the system's value survives any individual source dying — that is the capability.

**8. Smallest architecture preserving the larger vision:** the existing pipeline + exactly two additions — `DiscoveryCase` (grouping + status + suppression) and persisted reviewer decisions. Everything in Parts 5–6 (clustering, confidence, FieldEvidence, learning) attaches to those two without rework. No queues, services, or cloud infra; the SQLite sandbox remains sufficient for pilot volumes.

**9. Reuse vs. change (from the actual code):**
- *Reuse unchanged:* `SourceAdapter` + registry + ingestion engine + fingerprints; `CompanyIdentity`/`LocationCandidate`; `bwi-codes.ts`; publication readiness; scoring shape; provenance.
- *Extend:* `entity-resolution.ts` (candidate-vs-candidate comparator; §12.4-lite outcomes; run against real export); `review_queue` (becomes case-backed; decision columns actually written); `seed.ts` → replaced by BWI-export loader; `reviewPriority()` (add existence/relevance inputs); `source_records` (add lastSeenAt/timesSeen).
- *New:* real chamber adapter; license adapter; news-extraction adapter; `discovery_cases` + `review_decisions` tables; per-source metrics report.
- *Untouched:* `business-wise-adapter.ts` stays an interface until Rif/Randall discovery.

**10. Proposed architecture:**

```
  chamber feed      license/CO data      biz-journal articles
       │                  │                （LLM extraction）
       ▼                  ▼                       ▼
 [SourceAdapter]    [SourceAdapter]        [SourceAdapter]        ← exists (interface)
       └────────────┬─────┴───────────────────────┘
                    ▼
        Ingestion engine (idempotent, provenance, raw kept)       ← exists
                    ▼
        LocationCandidate (+ provisional CompanyIdentity)          ← exists
                    ▼
        BWI matching vs. real export, all lifecycle statuses       ← exists; needs real data + calibration
                    ▼
        Novelty classification (§12.4-lite: new / branch /
        same-location / reappearance / ambiguous)                  ← extend
                    ▼
        Cross-source clustering → DiscoveryCase                    ← NEW (small)
        (suppression of decided cases; observation history)
                    ▼
        Discovery scoring: existence · novelty · relevance ·
        classification confidence, with plain-language reasons     ← extend reviewPriority
                    ▼
        Review queue (evidence floor, batch actions)               ← extend
                    ▼
        Emily/Jen decisions  ──────► review_decisions              ← NEW (small)
             │                            │
             ▼                            └──► calibration, per-source
        Delphi entry (manual, unchanged)       dashboard, suppression, labels
```

---

*This document is a design exercise. Nothing here changes code, locks an architecture, or overrides `docs/BWI_DOMAIN_RULES.md`'s change-control rule (§25).*
