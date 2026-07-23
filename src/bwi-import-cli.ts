import { createSchema, openDb } from "./db.ts";
import { runBwiImport } from "./bwi-import.ts";
import { createBwiSnapshotSource } from "./sources/bwi/snapshot-adapter.ts";

/**
 * `bun run bwi:import -- --file=<path> [--limit=N] [--after-id=<id>] [--updated-since=<iso-date>]`
 *
 * Snapshot import only. There is no `--live` option on this command on
 * purpose — a live BWI read is a manual, explicitly-flagged operation (see
 * src/bwi-smoke-cli.ts / `bun run bwi:smoke`), never something the ordinary
 * import command or `bun run reset` can reach.
 */
const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key!, rest.join("=") || "true"] as const;
    })
);

const filePath = args.get("file");
if (!filePath) {
  console.error("Usage: bun run bwi:import -- --file=<path-to-snapshot.csv> [--limit=N] [--after-id=<id>] [--updated-since=<iso-date>]");
  console.error("Real BWI exports must live under data/private/ (gitignored) — never commit one.");
  process.exit(1);
}

const limit = args.has("limit") ? Number(args.get("limit")) : 10_000;
if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`--limit must be a positive number, got "${args.get("limit")}"`);
  process.exit(1);
}

const db = openDb();
createSchema(db);

const source = createBwiSnapshotSource({
  filePath,
  ingestedAt: new Date().toISOString(),
  exportedAt: args.get("exported-at")
});

const summary = await runBwiImport(db, source, {
  limit,
  afterId: args.get("after-id"),
  updatedSince: args.get("updated-since")
});

db.close();

console.log(`BWI import (${summary.sourceType}): ${summary.sourceName}`);
console.log(`Status: ${summary.status}`);
console.log(`Rows read: ${summary.rowsRead}`);
console.log(`Rows accepted: ${summary.rowsAccepted}`);
console.log(`Rows rejected: ${summary.rowsRejected}`);
console.log(`Rows inserted: ${summary.rowsInserted}`);
console.log(`Rows updated: ${summary.rowsUpdated}`);
console.log(`Rows unchanged: ${summary.rowsUnchanged}`);

if (summary.unknownSiteTypeCodes.length > 0) {
  console.log(`Unknown raw site-type codes seen: ${summary.unknownSiteTypeCodes.join(", ")}`);
}
if (summary.unknownLifecycleCodes.length > 0) {
  console.log(`Unknown raw lifecycle/status codes seen: ${summary.unknownLifecycleCodes.join(", ")}`);
}
if (summary.validationErrors.length > 0) {
  console.log(`Validation errors (${summary.validationErrors.length}):`);
  for (const error of summary.validationErrors.slice(0, 20)) console.log(`  - ${error}`);
  if (summary.validationErrors.length > 20) console.log(`  ... and ${summary.validationErrors.length - 20} more`);
}

if (summary.status === "failed") {
  console.error(`BWI import failed: ${summary.errorMessage}`);
  process.exit(1);
}
