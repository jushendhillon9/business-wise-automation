import { createSchema, openDb } from "./db.ts";

const db = openDb();
createSchema(db);
db.close();
console.log("Created local sandbox at data/sandbox.sqlite");
