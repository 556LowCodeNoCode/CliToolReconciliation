/**
 * Drift classification between a profile's last accepted fingerprint and a
 * newly computed one (repo-A taxonomy, no-ML edition).
 *   HARD — abort ingestion: encoding change, mapped column missing,
 *          type narrowed on a mapped column.
 *   SOFT — warn and continue: column added, unmapped column removed,
 *          type widened/changed on unmapped column, cardinality band shift ≥ 2
 *          on a mapped column, row-count band shift ≥ 2.
 * Type width order: integer < decimal < text. `date` only equals itself —
 * any change to or from date on a mapped column is narrowing.
 */
import type { FingerprintData } from "./fingerprint.ts";

export interface DriftReport {
  hard: string[];
  soft: string[];
}

const WIDTH: Record<string, number> = { integer: 1, decimal: 2, text: 3 };

function typeChange(prev: string, cur: string): "same" | "widened" | "narrowed" {
  if (prev === cur) return "same";
  if (prev === "date" || cur === "date") return "narrowed";
  return (WIDTH[cur] ?? 0) > (WIDTH[prev] ?? 0) ? "widened" : "narrowed";
}

export function classifyDrift(
  prev: FingerprintData,
  cur: FingerprintData,
  mappedCols: ReadonlySet<string>,
): DriftReport {
  const hard: string[] = [];
  const soft: string[] = [];

  if (prev.encoding !== cur.encoding) {
    hard.push(`ENCODING_CHANGED(${prev.encoding} → ${cur.encoding})`);
  }

  const prevCols = new Set(Object.keys(prev.columnTypes));
  const curCols = new Set(Object.keys(cur.columnTypes));

  for (const col of prevCols) {
    if (!curCols.has(col)) {
      if (mappedCols.has(col)) hard.push(`MAPPED_COLUMN_MISSING(${col})`);
      else soft.push(`UNMAPPED_COLUMN_REMOVED(${col})`);
    }
  }
  for (const col of curCols) {
    if (!prevCols.has(col)) soft.push(`COLUMN_ADDED(${col})`);
  }

  for (const col of prevCols) {
    if (!curCols.has(col)) continue;
    const change = typeChange(prev.columnTypes[col]!, cur.columnTypes[col]!);
    if (change === "same") continue;
    const desc = `${col}: ${prev.columnTypes[col]} → ${cur.columnTypes[col]}`;
    if (change === "narrowed" && mappedCols.has(col)) hard.push(`TYPE_NARROWED(${desc})`);
    else if (change === "narrowed") soft.push(`TYPE_NARROWED_UNMAPPED(${desc})`);
    else soft.push(`TYPE_WIDENED(${desc})`);
  }

  for (const col of mappedCols) {
    const a = prev.cardinalityBand[col];
    const b = cur.cardinalityBand[col];
    if (a !== undefined && b !== undefined && Math.abs(a - b) >= 2) {
      soft.push(`CARDINALITY_BAND_CHANGED(${col}: ${a} → ${b})`);
    }
  }

  if (Math.abs(prev.rowCountBand - cur.rowCountBand) >= 2) {
    soft.push(`ROW_COUNT_BAND_CHANGED(${prev.rowCountBand} → ${cur.rowCountBand})`);
  }

  return { hard, soft };
}
