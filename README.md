# Business Wise — Project 1 Starter

A safe, local vertical slice for the proposed DFW automated new-company intake pilot.

## What this proves first

`source candidate -> normalized record -> entity-resolution score -> prioritized human review queue`

It deliberately does **not** write to Business Wise production systems. The real BWI / SQL / Azure / ADF integration stays behind `BusinessWiseAdapter` until technical discovery with Rif and Randall is complete.

## Why this is the right first slice

The current Business Wise workflow has known intake sources, manual duplicate review, required publish fields, manual SIC work, and a human publication gate. This starter isolates the reusable intelligence layer from the unknown production architecture.

## Run locally

Requires Bun.

```bash
bun install
bun run reset
bun run queue
```

Expected behavior with the sample data:

- `Acme Logistics, Inc.` should score as a likely duplicate because of the exact phone plus strong name/address similarity.
- `Northstar Advisory` should score as a likely duplicate because of the domain plus strong name/address similarity.
- `Lone Star Robotics LLC` should surface as likely new and high priority because it is reasonably complete and falls inside the 10–99 employee core segment.

## Next engineering steps

1. Replace `data/candidates.sample.json` with one real DFW source export.
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
