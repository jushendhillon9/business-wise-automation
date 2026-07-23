# Local, private BWI data

This directory is for **real, local-only** BWI exports and snapshots — the
kind of data that must never be committed to this repository.

Everything under `data/private/` is gitignored except this file. Put real
snapshot exports here (e.g. `data/private/bwi-locations-2026-07.csv`) and
point `bun run bwi:import -- --file=data/private/<your-file>.csv` at them.

Do not:

- commit a real BWI export anywhere in this repository
- commit credentials, connection strings, or any secret here or elsewhere
- move a real export into `data/sources/` (that directory is for synthetic,
  committed fixtures only — see `data/sources/bwi-snapshot-sample.csv`)

See [`docs/BWI_READ_ONLY_IMPORT.md`](../../docs/BWI_READ_ONLY_IMPORT.md) for
the full snapshot schema and import instructions.
