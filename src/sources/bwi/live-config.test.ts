import { describe, expect, test } from "bun:test";
import { loadBwiLiveDbConfigFromEnv } from "./live-config.ts";

describe("loadBwiLiveDbConfigFromEnv — credential safety", () => {
  test("absent required env vars fail clearly, naming the missing keys", () => {
    expect(() => loadBwiLiveDbConfigFromEnv({})).toThrow(/BWI_DB_SERVER/);
    expect(() => loadBwiLiveDbConfigFromEnv({})).toThrow(/BWI_DB_NAME/);
  });

  test("partially-configured env (one of two required vars) still fails clearly", () => {
    expect(() => loadBwiLiveDbConfigFromEnv({ BWI_DB_SERVER: "some-server" })).toThrow(/BWI_DB_NAME/);
  });

  test("error messages never include the value of any configured secret", () => {
    const secretPassword = "sUp3rSecretPassword!123";
    let thrown: Error | undefined;
    try {
      loadBwiLiveDbConfigFromEnv({ BWI_DB_SERVER: "srv", BWI_DB_NAME: "db", BWI_DB_PASSWORD: secretPassword, BWI_DB_PORT: "not-a-number" });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(secretPassword);
  });

  test("a fully-configured env loads without throwing and never echoes values into the returned config in a loggable form by itself", () => {
    const config = loadBwiLiveDbConfigFromEnv({
      BWI_DB_SERVER: "test-server",
      BWI_DB_NAME: "test-db",
      BWI_DB_USER: "test-user",
      BWI_DB_PASSWORD: "test-password",
      BWI_DB_PORT: "1433",
      BWI_DB_ENCRYPT: "true",
      BWI_DB_TRUST_SERVER_CERTIFICATE: "false"
    });

    expect(config.server).toBe("test-server");
    expect(config.database).toBe("test-db");
    expect(config.port).toBe(1433);
    expect(config.encrypt).toBe(true);
    expect(config.trustServerCertificate).toBe(false);
    expect(config.readOnlyIntent).toBe(true);
  });

  test("BWI_DB_ENCRYPT defaults to true and BWI_DB_TRUST_SERVER_CERTIFICATE defaults to false when unset", () => {
    const config = loadBwiLiveDbConfigFromEnv({ BWI_DB_SERVER: "s", BWI_DB_NAME: "d" });
    expect(config.encrypt).toBe(true);
    expect(config.trustServerCertificate).toBe(false);
    expect(config.readOnlyIntent).toBe(true);
  });

  test("BWI_DB_READ_ONLY_INTENT=false is honored", () => {
    const config = loadBwiLiveDbConfigFromEnv({ BWI_DB_SERVER: "s", BWI_DB_NAME: "d", BWI_DB_READ_ONLY_INTENT: "false" });
    expect(config.readOnlyIntent).toBe(false);
  });
});
