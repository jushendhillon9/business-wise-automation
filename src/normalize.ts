const COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "l.l.c",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "pllc",
  "lp"
]);

export function normalizeCompanyName(value?: string): string {
  if (!value) return "";

  const tokens = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !COMPANY_SUFFIXES.has(token));

  return tokens.join(" ").trim();
}

export function normalizePhone(value?: string): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normalizeAddress(value?: string): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\broad\b/g, "rd")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\bsuite\b/g, "ste")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDomain(value?: string): string {
  if (!value) return "";
  try {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.toLowerCase().replace(/^www\./, "").split("/")[0] ?? "";
  }
}

function bigrams(value: string): Set<string> {
  const compact = ` ${value.trim()} `;
  const result = new Set<string>();
  for (let i = 0; i < compact.length - 1; i += 1) {
    result.add(compact.slice(i, i + 2));
  }
  return result;
}

export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const left = bigrams(a);
  const right = bigrams(b);
  let overlap = 0;

  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }

  return (2 * overlap) / (left.size + right.size);
}
