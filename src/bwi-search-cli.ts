import { createSchema, loadExistingCompanies, openDb } from "./db.ts";
import { normalizeCompanyName, normalizeDomain, normalizePhone } from "./normalize.ts";

/**
 * `bun run bwi:search -- [--name=<text>] [--domain=<text>] [--phone=<text>] [--limit=N]`
 *
 * Lists/searches the locally-imported BWI existing-location records (from
 * `existing_companies` — the same table entity resolution reads). Operates
 * entirely on the local sandbox; never opens a live connection. With no
 * filters, lists the first `--limit` rows (default 50) in a deterministic
 * order.
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

const limit = args.has("limit") ? Number(args.get("limit")) : 50;
if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`--limit must be a positive number, got "${args.get("limit")}"`);
  process.exit(1);
}

const nameFilter = args.get("name") ? normalizeCompanyName(args.get("name")) : undefined;
const domainFilter = args.get("domain") ? normalizeDomain(args.get("domain")) : undefined;
const phoneFilter = args.get("phone") ? normalizePhone(args.get("phone")) : undefined;

const db = openDb();
createSchema(db);
const all = loadExistingCompanies(db);
db.close();

const matches = all.filter((company) => {
  if (nameFilter && !normalizeCompanyName(company.companyName).includes(nameFilter)) return false;
  if (domainFilter && normalizeDomain(company.website) !== domainFilter) return false;
  if (phoneFilter && normalizePhone(company.phone) !== phoneFilter) return false;
  return true;
});

const rows = matches
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id))
  .slice(0, limit)
  .map((company) => ({
    id: company.id,
    companyName: company.companyName,
    city: company.city ?? "-",
    state: company.state ?? "-",
    siteType: company.siteType ?? "-",
    status: company.status ?? "-",
    lifecycleStatus: company.lifecycleStatus ?? "-",
    source: company.source?.sourceName ?? "(seeded fixture)"
  }));

console.log(`${matches.length} matching record(s) of ${all.length} total; showing ${rows.length}.`);
console.table(rows);
