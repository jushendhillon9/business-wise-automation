/**
 * Resolves where the two real BWI DFW snapshot CSVs live on disk. Precedence
 * (highest first): explicit argument (e.g. a CLI flag) > environment
 * variable > the repo's documented default drop folder
 * (data/private/bwi/). See data/private/bwi/README.md.
 */

export const DEFAULT_RECORDS_SNAPSHOT_PATH = "data/private/bwi/bwi_dfw_records_2026-07-23.csv";
export const DEFAULT_RELATIONSHIPS_SNAPSHOT_PATH = "data/private/bwi/bwi_dfw_relationships_2026-07-23.csv";

export function resolveRecordsSnapshotPath(explicit?: string): string {
  return explicit || process.env.BWI_RECORDS_SNAPSHOT_PATH || DEFAULT_RECORDS_SNAPSHOT_PATH;
}

export function resolveRelationshipsSnapshotPath(explicit?: string): string {
  return explicit || process.env.BWI_RELATIONSHIPS_SNAPSHOT_PATH || DEFAULT_RELATIONSHIPS_SNAPSHOT_PATH;
}

/** Reads a `--<flag>=value` style CLI argument from argv, e.g. `--records=/some/path.csv`. */
export function readCliPathArg(argv: string[], flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}
