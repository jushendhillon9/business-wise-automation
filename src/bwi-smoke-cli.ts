/**
 * `bun run bwi:smoke -- --live [--limit=N] [--after-id=<id>] [--persist] [--unredacted]`
 *
 * Manual, explicit live-database smoke test. Requires `--live` (or
 * `--source=bwi-live`) — with neither flag, this prints usage and exits
 * without ever loading the live adapter or touching environment
 * credentials. Never invoked by `bun test` or `bun run reset`.
 *
 * Defaults: read-only, no persistence (results are not written to the local
 * sandbox unless `--persist` is passed explicitly), capped at 25 records
 * regardless of `--limit`, deterministic order (id ascending, matching the
 * live adapter's fixed ORDER BY), and redacted output — only non-sensitive
 * summary fields are printed. No contacts are fetched or printed (the
 * canonical existing-location record this reads has no contact fields at
 * all — see src/types.ts's ExistingCompany).
 */
const HARD_MAX_LIMIT = 25;

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key!, rest.join("=") || "true"] as const;
    })
);

const liveRequested = args.has("live") || args.get("source") === "bwi-live";
if (!liveRequested) {
  console.error("Usage: bun run bwi:smoke -- --live [--limit=N] [--after-id=<id>] [--persist] [--unredacted]");
  console.error("This command requires an explicit --live flag and does nothing without it.");
  console.error("It connects to a real, configured BWI database — review docs/BWI_READ_ONLY_IMPORT.md before running it.");
  process.exit(1);
}

// Only imported once --live is confirmed, so a plain `bun run bwi:smoke` with
// no flags never even loads the mssql driver or reads env credentials.
const { createBwiLiveSource } = await import("./sources/bwi/live-adapter.ts");
const { loadBwiLiveDbConfigFromEnv } = await import("./sources/bwi/live-config.ts");
const { createSchema, openDb } = await import("./db.ts");
const { runBwiImport } = await import("./bwi-import.ts");

const requestedLimit = args.has("limit") ? Number(args.get("limit")) : HARD_MAX_LIMIT;
const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : HARD_MAX_LIMIT, HARD_MAX_LIMIT));
const persist = args.has("persist");
const unredacted = args.has("unredacted");

let config;
try {
  config = loadBwiLiveDbConfigFromEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`Connecting to the configured BWI live database (server/database not printed)...`);
console.log(`limit=${limit} persist=${persist} order=id ASC`);

const source = createBwiLiveSource(config);

if (!persist) {
  // Read-only smoke path: fetch directly, never touch the local sandbox.
  const results = await source.fetchExistingLocations({ limit, afterId: args.get("after-id") });
  const accepted = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  const rejected = results.filter((r) => !r.ok);

  console.log(`Fetched ${results.length} row(s): ${accepted.length} accepted, ${rejected.length} rejected.`);

  const rows = accepted.map(({ existing }) =>
    unredacted
      ? {
          id: existing.id,
          companyName: existing.companyName,
          city: existing.city ?? "-",
          state: existing.state ?? "-",
          siteType: existing.siteType ?? "-",
          status: existing.status ?? "-",
          hasPhone: Boolean(existing.phone),
          hasWebsite: Boolean(existing.website)
        }
      : {
          id: existing.id,
          companyNamePresent: Boolean(existing.companyName),
          city: existing.city ?? "-",
          state: existing.state ?? "-",
          siteType: existing.siteType ?? "-",
          status: existing.status ?? "-",
          hasPhone: Boolean(existing.phone),
          hasWebsite: Boolean(existing.website)
        }
  );
  console.table(rows);

  if (rejected.length > 0) {
    console.log("Rejected rows (reason only, no raw values):");
    for (const r of rejected) if (!r.ok) console.log(`  - ${r.reason}`);
  }
} else {
  const db = openDb();
  createSchema(db);
  const summary = await runBwiImport(db, source, { limit, afterId: args.get("after-id") });
  db.close();

  console.log(`Persisted live smoke import: inserted=${summary.rowsInserted} updated=${summary.rowsUpdated} unchanged=${summary.rowsUnchanged} rejected=${summary.rowsRejected}`);
}
