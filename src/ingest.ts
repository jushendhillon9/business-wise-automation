import { createSchema, openDb } from "./db.ts";
import { runIngestion } from "./ingestion.ts";
import { getAdapter, listSourceIds } from "./sources/registry.ts";

const sourceArg = process.argv.find((arg) => arg.startsWith("--source="));
const sourceId = sourceArg?.split("=")[1];

if (!sourceId) {
  console.error(`Usage: bun run ingest --source=<sourceId>`);
  console.error(`Available sources: ${listSourceIds().join(", ")}`);
  process.exit(1);
}

const adapter = getAdapter(sourceId);
if (!adapter) {
  console.error(`Unknown source "${sourceId}". Available sources: ${listSourceIds().join(", ")}`);
  process.exit(1);
}

const db = openDb();
createSchema(db);
const summary = await runIngestion(db, adapter);
db.close();

console.log(`Source: ${summary.sourceName}`);
console.log(`Raw records: ${summary.rawCount}`);
console.log(`Valid records: ${summary.validCount}`);
console.log(`New candidates: ${summary.newCandidateCount}`);
console.log(`Already ingested: ${summary.alreadyIngestedCount}`);
console.log(`Skipped: ${summary.skippedCount}`);

if (summary.skipReasons.length > 0) {
  console.log(`Skip reasons: ${summary.skipReasons.join("; ")}`);
}

if (summary.status === "failed") {
  console.error(`Ingestion run failed: ${summary.errorMessage}`);
  process.exit(1);
}
