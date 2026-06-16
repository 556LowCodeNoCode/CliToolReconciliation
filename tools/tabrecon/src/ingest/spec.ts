/**
 * Parse specs make non-self-describing layouts (fixed-width report prints,
 * odd delimited files) ingestable. A spec is authored once — typically by the
 * LLM after inspecting the raw file — then persisted on the file's Profile and
 * reused automatically when a returning file is recognized.
 */
import { ParseSpecError } from "../errors.ts";
import type { NumberFormat } from "../decimal.ts";

export interface FixedColumnSpec {
  name: string;
  /** 0-based inclusive start, exclusive end character positions. */
  start: number;
  end: number;
  type?: "text" | "integer" | "decimal" | "date";
  numberFormat?: NumberFormat;
}

export interface FixedParseSpec {
  type: "fixed";
  /** Lines matching any of these regexes are skipped (page headers, footers, separators). */
  skipLineRegexes?: string[];
  /** Number of leading lines to skip unconditionally. */
  skipLeadingLines?: number;
  /** Lines shorter than this are skipped (blank / separator lines). */
  minLineLength?: number;
  columns: FixedColumnSpec[];
}

export interface DelimitedParseSpec {
  type: "delimited";
  delimiter: string;
  /** When false, the first row is data and `columns` names them. */
  hasHeader: boolean;
  columns?: string[];
  skipLeadingLines?: number;
}

export interface XlsxParseSpec {
  type: "xlsx";
  /** Positional renaming of the header — required when source headers are duplicated or missing. */
  columns?: string[];
  /** Sheet rows to skip before the header/data (title rows). */
  skipLeadingRows?: number;
  /** When false, the first (post-skip) row is data and `columns` is required. Default true. */
  hasHeader?: boolean;
}

export type ParseSpec = FixedParseSpec | DelimitedParseSpec | XlsxParseSpec;

export function validateParseSpec(raw: unknown): ParseSpec {
  if (typeof raw !== "object" || raw === null) throw new ParseSpecError("spec must be a JSON object");
  const spec = raw as Record<string, unknown>;
  if (spec["type"] === "fixed") {
    const cols = spec["columns"];
    if (!Array.isArray(cols) || cols.length < 2) {
      throw new ParseSpecError('fixed spec needs "columns": an array of at least 2 column definitions');
    }
    for (const [i, c] of cols.entries()) {
      const col = c as Record<string, unknown>;
      if (typeof col["name"] !== "string" || col["name"].trim() === "") {
        throw new ParseSpecError(`columns[${i}].name must be a non-empty string`);
      }
      if (
        typeof col["start"] !== "number" ||
        typeof col["end"] !== "number" ||
        col["start"] < 0 ||
        col["end"] <= col["start"]
      ) {
        throw new ParseSpecError(`columns[${i}] needs numeric start < end (0-based char positions)`);
      }
      if (col["type"] !== undefined && !["text", "integer", "decimal", "date"].includes(col["type"] as string)) {
        throw new ParseSpecError(`columns[${i}].type must be text|integer|decimal|date`);
      }
      if (col["numberFormat"] !== undefined && !["standard", "greek"].includes(col["numberFormat"] as string)) {
        throw new ParseSpecError(`columns[${i}].numberFormat must be standard|greek`);
      }
    }
    if (spec["skipLineRegexes"] !== undefined) {
      if (!Array.isArray(spec["skipLineRegexes"])) throw new ParseSpecError("skipLineRegexes must be an array of strings");
      for (const r of spec["skipLineRegexes"]) {
        try {
          new RegExp(r as string);
        } catch {
          throw new ParseSpecError(`skipLineRegexes entry ${JSON.stringify(r)} is not a valid regex`);
        }
      }
    }
    return spec as unknown as FixedParseSpec;
  }
  if (spec["type"] === "delimited") {
    if (typeof spec["delimiter"] !== "string" || spec["delimiter"].length !== 1) {
      throw new ParseSpecError('delimited spec needs a single-character "delimiter"');
    }
    if (typeof spec["hasHeader"] !== "boolean") {
      throw new ParseSpecError('delimited spec needs boolean "hasHeader"');
    }
    if (spec["hasHeader"] === false) {
      if (!Array.isArray(spec["columns"]) || spec["columns"].length < 2) {
        throw new ParseSpecError('delimited spec with hasHeader=false needs "columns": names array');
      }
    }
    return spec as unknown as DelimitedParseSpec;
  }
  if (spec["type"] === "xlsx") {
    if (spec["hasHeader"] !== undefined && typeof spec["hasHeader"] !== "boolean") {
      throw new ParseSpecError('xlsx spec "hasHeader" must be boolean');
    }
    if (spec["skipLeadingRows"] !== undefined) {
      if (typeof spec["skipLeadingRows"] !== "number" || spec["skipLeadingRows"] < 0) {
        throw new ParseSpecError('xlsx spec "skipLeadingRows" must be a non-negative number');
      }
    }
    if (spec["columns"] !== undefined) {
      if (
        !Array.isArray(spec["columns"]) ||
        spec["columns"].length < 2 ||
        spec["columns"].some((c) => typeof c !== "string" || c.trim() === "")
      ) {
        throw new ParseSpecError('xlsx spec "columns" must be an array of ≥ 2 non-empty names');
      }
    } else if (spec["hasHeader"] === false) {
      throw new ParseSpecError('xlsx spec with hasHeader=false needs "columns": names array');
    }
    return spec as unknown as XlsxParseSpec;
  }
  throw new ParseSpecError('spec "type" must be "fixed", "delimited" or "xlsx"');
}

/** Apply an xlsx spec to the raw sheet matrix → header + data matrix. */
export function applyXlsxSpec(fileName: string, matrix: string[][], spec: XlsxParseSpec): {
  header: string[];
  data: string[][];
} {
  const rows = matrix.slice(spec.skipLeadingRows ?? 0);
  const hasHeader = spec.hasHeader !== false;
  if (rows.length === 0) throw new ParseSpecError(`"${fileName}": no rows left after skipLeadingRows`);
  if (spec.columns) {
    const width = rows[0]!.length;
    if (spec.columns.length !== width) {
      throw new ParseSpecError(
        `"${fileName}": spec names ${spec.columns.length} columns but the sheet has ${width}`,
      );
    }
    return { header: [...spec.columns], data: hasHeader ? rows.slice(1) : rows };
  }
  return { header: rows[0]!, data: rows.slice(1) };
}

/** Apply a fixed-width spec to decoded text → header + data matrix. */
export function parseFixedWidth(text: string, spec: FixedParseSpec): string[][] {
  const skipRes = (spec.skipLineRegexes ?? []).map((r) => new RegExp(r));
  const minLen = spec.minLineLength ?? 1;
  const lines = text.split(/\r?\n/);
  const out: string[][] = [spec.columns.map((c) => c.name)];
  for (let i = spec.skipLeadingLines ?? 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length < minLen) continue;
    if (skipRes.some((re) => re.test(line))) continue;
    out.push(spec.columns.map((c) => line.slice(c.start, c.end).trim()));
  }
  return out;
}
