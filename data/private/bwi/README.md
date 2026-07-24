# Private BWI snapshot data — drop folder

This folder is where the two real Business Wise DFW production-derived CSV snapshots go, **on your machine only**.
Nothing in this folder (other than this README) is ever committed to the repository — see the `data/private/bwi/*`
rules in `.gitignore`.

## What goes here

Drag both files from your local `BW-Private-Data` folder into this exact directory:

```
data/private/bwi/bwi_dfw_records_2026-07-23.csv
data/private/bwi/bwi_dfw_relationships_2026-07-23.csv
```

Those are the default filenames `src/bwi-snapshot/paths.ts` looks for. If your files live somewhere else (or under
different names), set these environment variables instead of moving them into the repo:

```
BWI_RECORDS_SNAPSHOT_PATH=/absolute/path/to/your/records.csv
BWI_RELATIONSHIPS_SNAPSHOT_PATH=/absolute/path/to/your/relationships.csv
```

## What this data is

Both files are exports of real, private Business Wise production data (approximately 241,194 DFW BWI location
records and 57,575 relationship edges), pulled via an authorized **SELECT-only** export. They contain real company
names, addresses, phone numbers, and other business records.

## Rules — read before touching these files

- **Never commit these files.** `.gitignore` blocks `data/private/bwi/*.csv` (and `.tsv`/`.json`/`.db`/`.sqlite`
  variants) by pattern, but do not rely on that alone — never `git add -f` anything in this folder.
- **Never upload these files, or excerpts/screenshots of their contents, to ChatGPT, Claude, GitHub (issues, PRs,
  gists), email, Slack, or a personal cloud drive (Google Drive, Dropbox, iCloud, etc.).** They contain private
  production data, not synthetic fixtures.
- **Never copy real rows into fixtures, tests, documentation, commit messages, or error/log output.** All tests and
  docs in this repository use synthetic data only — see `src/bwi-snapshot/*.test.ts` for the pattern to follow.
- Tooling that reads this data (`bun run bwi:validate`, `bun run bwi:smoke`, and `BusinessWiseSnapshotAdapter`)
  prints only aggregate information — file paths/sizes, header names, row/status/site-type/relationship-type counts,
  malformed/duplicate counts, and timing. If you extend that tooling, keep it that way: no full records, addresses,
  company names, or contacts in terminal output.
- This adapter is **read-only** by construction: it never writes back to Business Wise, never connects to
  production SQL, and implements no write/publish methods. Manual entry through Delphi remains the only production
  write path — see `docs/BWI_PRODUCTION_DB_DISCOVERY.md`.

## How to validate and load locally

From the repo root, once both files are in place (or your env vars point at them):

```bash
bun run bwi:validate   # structural validation + safe aggregate counts, exits nonzero on structural errors
bun run bwi:smoke      # builds the in-memory snapshot adapter + indexes, runs bounded synthetic lookups
```

Neither command prints real rows. See the "Real BWI Snapshot — Local Only" section in the repository root
`README.md` for full details.
