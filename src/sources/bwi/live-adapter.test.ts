import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as liveAdapter from "./live-adapter.ts";
import { buildFetchByIdsSql, FETCH_PAGE_SQL, FETCH_UPDATED_SINCE_SQL } from "./live-adapter.ts";

/**
 * Read-only enforcement tests. These never open a network connection or
 * import a real database driver session — they inspect the fixed SQL text
 * this module owns, and the module's own exported surface, structurally.
 * `bun test` must be able to run this file with zero network access and
 * zero configured BWI_DB_* environment variables.
 */

const FORBIDDEN_VERB_PATTERN = /\b(INSERT|UPDATE|DELETE|MERGE|EXEC(?:UTE)?|CREATE|ALTER|DROP|TRUNCATE|GRANT|DENY|sp_executesql|xp_cmdshell)\b/i;

describe("live adapter — fixed SQL text contains no forbidden verbs", () => {
  test("FETCH_PAGE_SQL is SELECT-only", () => {
    expect(FETCH_PAGE_SQL.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    expect(FETCH_PAGE_SQL).not.toMatch(FORBIDDEN_VERB_PATTERN);
  });

  test("FETCH_UPDATED_SINCE_SQL is SELECT-only", () => {
    expect(FETCH_UPDATED_SINCE_SQL.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    expect(FETCH_UPDATED_SINCE_SQL).not.toMatch(FORBIDDEN_VERB_PATTERN);
  });

  test("buildFetchByIdsSql(...) is SELECT-only for any bounded id list", () => {
    const sql = buildFetchByIdsSql(["id0", "id1", "id2"]);
    expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    expect(sql).not.toMatch(FORBIDDEN_VERB_PATTERN);
    expect(sql).toContain("@id0");
    expect(sql).toContain("@id1");
    expect(sql).toContain("@id2");
  });

  test("buildFetchByIdsSql rejects a parameter name that isn't a plain identifier, instead of emitting it into SQL text", () => {
    // buildFetchByIdsSql's contract is "placeholder names only" (e.g. id0,
    // id1 — see live-adapter.ts's own call site, which generates these from
    // array position, never from an id's value). This proves the function
    // is safe even if some future caller violated that contract and passed
    // something id-value-shaped instead.
    expect(() => buildFetchByIdsSql(["'; DROP TABLE DirCompany; --"])).toThrow();
  });
});

describe("live adapter — no generic query/execute surface", () => {
  test("the module exports no generic query/execute/exec function", () => {
    const exportNames = Object.keys(liveAdapter);
    const forbiddenNames = ["query", "execute", "exec", "run", "raw", "rawQuery"];
    for (const name of forbiddenNames) {
      expect(exportNames).not.toContain(name);
    }
  });

  test("createBwiLiveSource's returned object exposes only fetchExistingLocations plus identity fields", () => {
    const source = liveAdapter.createBwiLiveSource({
      server: "unused-in-this-test",
      database: "unused-in-this-test",
      encrypt: true,
      trustServerCertificate: false,
      readOnlyIntent: true
    });

    const keys = Object.keys(source).sort();
    expect(keys).toEqual(["fetchExistingLocations", "sourceName", "sourceType"]);
  });
});

describe("live adapter — broader source-text safety net", () => {
  test("no forbidden SQL verb appears in live-adapter.ts source text outside comments/strings describing what's forbidden", () => {
    const source = readFileSync(new URL("./live-adapter.ts", import.meta.url), "utf-8");

    // Strip /** ... */ and // ... comments (which legitimately name forbidden
    // verbs while explaining they're absent) before scanning code.
    const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");

    expect(withoutLineComments).not.toMatch(FORBIDDEN_VERB_PATTERN);
  });
});

describe("live adapter — never runs without explicit configuration", () => {
  test("automated tests do not open a live connection: no env-driven auto-connect exists at module scope", () => {
    // Importing the module must not itself attempt a connection or read env
    // vars -- creating a source is a pure function call, and fetching is
    // async/lazy. If this test file's import above didn't throw or hang,
    // that already demonstrates no eager connection attempt; this assertion
    // documents the invariant explicitly.
    expect(typeof liveAdapter.createBwiLiveSource).toBe("function");
  });
});
