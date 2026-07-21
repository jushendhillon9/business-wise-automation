/**
 * Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas,
 * embedded newlines, and doubled-quote escaping ("" -> "). No dependency
 * needed for the fixture sizes this pipeline deals with.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      // skip; \r\n handled by the following \n
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Parses CSV text into an array of header-keyed row objects. */
export function parseCsvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const header = rows[0]!;
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      record[key.trim()] = (row[index] ?? "").trim();
    });
    return record;
  });
}
