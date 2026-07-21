import { createDfwCsvAdapter } from "./dfw-csv-adapter.ts";
import { createDfwJsonAdapter } from "./dfw-json-adapter.ts";
import type { SourceAdapter } from "./types.ts";

const factories: Record<string, () => SourceAdapter> = {
  "dfw-json": () => createDfwJsonAdapter(),
  "dfw-csv": () => createDfwCsvAdapter()
};

export function getAdapter(sourceId: string): SourceAdapter | undefined {
  return factories[sourceId]?.();
}

export function listSourceIds(): string[] {
  return Object.keys(factories);
}
