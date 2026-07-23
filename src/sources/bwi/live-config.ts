/**
 * Loads the direct BWI read-only SQL Server connection configuration from
 * environment variables only — never from a committed file, a CLI argument,
 * or a hardcoded default. See .env.example for the variable names (values
 * left blank) and docs/BWI_READ_ONLY_IMPORT.md for local setup.
 *
 * Errors identify which variable is missing by name only. Never log or
 * include the value of any of these variables anywhere, including in error
 * messages, since several of them are credentials.
 */
export type BwiLiveDbConfig = {
  server: string;
  database: string;
  user?: string;
  password?: string;
  port?: number;
  encrypt: boolean;
  trustServerCertificate: boolean;
  /** Requests routing to an Always On readable secondary when supported. Defaults true; set BWI_DB_READ_ONLY_INTENT=false if the target server rejects the option. Not itself a write guarantee — see live-adapter.ts's fixed-SELECT-only surface for the actual enforcement. */
  readOnlyIntent: boolean;
};

const REQUIRED_KEYS = ["BWI_DB_SERVER", "BWI_DB_NAME"] as const;

/**
 * Reads BWI_DB_SERVER, BWI_DB_NAME, BWI_DB_USER, BWI_DB_PASSWORD,
 * BWI_DB_PORT, BWI_DB_ENCRYPT, BWI_DB_TRUST_SERVER_CERTIFICATE from `env`
 * (defaults to `process.env`). Throws a single Error naming every missing
 * required key when BWI_DB_SERVER or BWI_DB_NAME is absent — never a
 * partial/ambiguous failure, and never a value in the message.
 */
export function loadBwiLiveDbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BwiLiveDbConfig {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required BWI live-database environment variable(s): ${missing.join(", ")}. ` +
        `Set them locally (see .env.example and docs/BWI_READ_ONLY_IMPORT.md) before running a live BWI operation. ` +
        `This error never includes variable values.`
    );
  }

  const port = env.BWI_DB_PORT ? Number(env.BWI_DB_PORT) : undefined;
  if (env.BWI_DB_PORT && !Number.isFinite(port)) {
    throw new Error(`BWI_DB_PORT is set but is not a valid number. (Value not shown.)`);
  }

  return {
    server: env.BWI_DB_SERVER!,
    database: env.BWI_DB_NAME!,
    user: env.BWI_DB_USER || undefined,
    password: env.BWI_DB_PASSWORD || undefined,
    port,
    encrypt: env.BWI_DB_ENCRYPT !== "false",
    trustServerCertificate: env.BWI_DB_TRUST_SERVER_CERTIFICATE === "true",
    readOnlyIntent: env.BWI_DB_READ_ONLY_INTENT !== "false"
  };
}
