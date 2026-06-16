/**
 * RFC-4180-style delimited text parser: double-quoted fields, escaped quotes
 * (""), delimiters and newlines inside quotes. Returns a dense matrix; short
 * rows are padded with "" to the header width, longer rows are an error.
 */
import { UnrecognizedFormatError } from "../errors.ts";

export function parseDelimited(fileName: string, text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) {
    throw new UnrecognizedFormatError(fileName, "unterminated quoted field at end of file");
  }
  if (field !== "" || row.length > 0) pushRow();

  const width = rows[0]?.length ?? 0;
  for (let r = 1; r < rows.length; r++) {
    const cur = rows[r]!;
    if (cur.length > width) {
      throw new UnrecognizedFormatError(
        fileName,
        `row ${r + 1} has ${cur.length} fields but the header has ${width}`,
      );
    }
    while (cur.length < width) cur.push("");
  }
  return rows.map((r) => r.map((c) => c.trim()));
}
