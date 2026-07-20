import { createSchema, insertExistingCompany, openDb } from "./db.ts";
import type { ExistingCompany } from "./types.ts";

const companies: ExistingCompany[] = [
  {
    id: "bw-001",
    companyName: "Acme Logistics LLC",
    address: "1200 Commerce Street",
    city: "Dallas",
    state: "TX",
    postalCode: "75201",
    phone: "214-555-0100",
    website: "https://acmelogistics.example",
    status: "DIRE"
  },
  {
    id: "bw-002",
    companyName: "Northstar Advisory Group Inc.",
    address: "500 Main Street Suite 900",
    city: "Fort Worth",
    state: "TX",
    postalCode: "76102",
    phone: "817-555-0144",
    website: "https://northstaradvisory.example",
    status: "DIRE"
  },
  {
    id: "bw-003",
    companyName: "Blue Mesa Technologies",
    address: "8000 Legacy Drive",
    city: "Plano",
    state: "TX",
    postalCode: "75024",
    phone: "972-555-0188",
    website: "https://bluemesa.example",
    status: "research"
  }
];

const db = openDb();
createSchema(db);
for (const company of companies) insertExistingCompany(db, company);
db.close();
console.log(`Seeded ${companies.length} mock Business Wise records.`);
