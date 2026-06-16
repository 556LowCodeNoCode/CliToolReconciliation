/**
 * Per-column type inference over a parsed string matrix, and canonicalization
 * of every value:
 *   integer  ^-?\d+$, no leading zeros (leading zeros mean "code" → text)
 *   decimal  all values parse under one detected lexical number format;
 *            canonical form is the plain standard string ("1234.56")
 *   date     ISO yyyy-mm-dd, dd.mm.yyyy or dd/mm/yyyy (day-first, documented);
 *            canonical form is ISO
 *   text     everything else (trimmed, NFKC-normalized whitespace untouched)
 * Empty cells are NULL. A parse spec column `type` overrides inference.
 */
import {
  detectNumberFormat,
  formatMicros,
  parseDecimalToMicros,
  type NumberFormat,
} from "../decimal.ts";
import { NumberFormatError } from "../errors.ts";

export type ColumnType = "text" | "integer" | "decimal" | "date";

export interface InferredColumn {
  type: ColumnType;
  numberFormat: NumberFormat | null;
  /** canonical values aligned with the input rows; null = empty cell */
  values: (string | null)[];
  nullCount: number;
  distinctCount: number;
  /** top-K canonical values by frequency (for the fingerprint sketch) */
  topValues: string[];
}

const INTEGER_RE = /^-?(0|[1-9][0-9]{0,17})$/;
const LEADING_ZERO_RE = /^-?0[0-9]/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EU_DOT_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const EU_SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function toIsoDate(raw: string): string | null {
  if (ISO_DATE_RE.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    return validYmd(y!, m!, d!) ? raw : null;
  }
  const m = EU_DOT_DATE_RE.exec(raw) ?? EU_SLASH_DATE_RE.exec(raw);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (!validYmd(y, mo, d)) return null;
    return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  }
  return null;
}

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const TOP_K = 20;
const SKETCH_DISTINCT_CAP = 10_000;

export function inferColumn(
  rawValues: readonly string[],
  encodingHint: "greek" | "standard",
  forcedType?: ColumnType,
  forcedFormat?: NumberFormat,
  allowRounding = false,
): InferredColumn {
  const nonNull: string[] = [];
  for (const v of rawValues) if (v.trim() !== "") nonNull.push(v.trim());
  const nullCount = rawValues.length - nonNull.length;

  let type: ColumnType;
  let numberFormat: NumberFormat | null = null;

  if (forcedType) {
    type = forcedType;
    if (type === "decimal") {
      numberFormat =
        forcedFormat ?? safeDetect(nonNull, encodingHint) ?? encodingHintFormat(encodingHint);
    }
  } else if (nonNull.length === 0) {
    type = "text";
  } else if (nonNull.every((v) => toIsoDate(v) !== null)) {
    type = "date";
  } else if (nonNull.every((v) => INTEGER_RE.test(v)) && !nonNull.some((v) => LEADING_ZERO_RE.test(v))) {
    type = "integer";
  } else if (!nonNull.some((v) => LEADING_ZERO_RE.test(v))) {
    const fmt = safeDetect(nonNull, encodingHint);
    if (fmt !== null && allParseOk(nonNull, fmt, allowRounding)) {
      type = "decimal";
      numberFormat = fmt;
    } else {
      type = "text";
    }
  } else {
    type = "text";
  }

  const values: (string | null)[] = rawValues.map((raw) => {
    const v = raw.trim();
    if (v === "") return null;
    switch (type) {
      case "date": {
        const iso = toIsoDate(v);
        if (iso === null) throw new NumberFormatError(`"${v}" is not a valid date for a date-typed column`);
        return iso;
      }
      case "decimal":
        return formatMicros(parseDecimalToMicros(v, numberFormat!, allowRounding));
      case "integer":
      case "text":
        return v;
    }
  });

  const freq = new Map<string, number>();
  for (const v of values) {
    if (v === null) continue;
    freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  const distinctCount = freq.size;
  const topValues =
    distinctCount <= SKETCH_DISTINCT_CAP
      ? [...freq.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, TOP_K)
          .map((e) => e[0])
      : [];

  return { type, numberFormat, values, nullCount, distinctCount, topValues };
}

function safeDetect(samples: readonly string[], hint: "greek" | "standard"): NumberFormat | null {
  try {
    return detectNumberFormat(samples, hint);
  } catch {
    return null;
  }
}

function encodingHintFormat(hint: "greek" | "standard"): NumberFormat {
  return hint;
}

function allParseOk(samples: readonly string[], format: NumberFormat, allowRounding: boolean): boolean {
  for (const s of samples) {
    try {
      parseDecimalToMicros(s, format, allowRounding);
    } catch {
      return false;
    }
  }
  return true;
}
