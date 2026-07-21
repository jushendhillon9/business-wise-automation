import { createHash } from "node:crypto";

/**
 * Ingestion-deduplication key: "have we already processed this exact source
 * item?" Prefers the source's own record id; falls back to a deterministic
 * hash of stable fields so records without an id still dedupe reliably.
 *
 * This is intentionally unrelated to entity resolution, which asks whether a
 * candidate matches an existing Business Wise company.
 */
export function computeFingerprint(
  sourceId: string,
  sourceRecordId: string | undefined,
  stableFields: Record<string, unknown>
): string {
  if (sourceRecordId) {
    return `${sourceId}:${sourceRecordId}`;
  }

  const sortedKeys = Object.keys(stableFields).sort();
  const normalized = sortedKeys.map((key) => `${key}=${String(stableFields[key] ?? "")}`).join("|");
  const hash = createHash("sha256").update(`${sourceId}|${normalized}`).digest("hex").slice(0, 16);
  return `${sourceId}:hash-${hash}`;
}
