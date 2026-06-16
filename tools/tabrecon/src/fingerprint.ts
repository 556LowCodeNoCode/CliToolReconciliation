/**
 * File fingerprint ("digital stamp") and profile-recognition scoring.
 *
 * Structural similarity blend (no embedding model — semantic judgment is the
 * in-session LLM's job; these weights are repo A's blend with the embedding
 * component redistributed):
 *   0.40 column-name Jaccard
 *   0.20 type-bag agreement
 *   0.20 value-sketch overlap          (renormalized away when absent)
 *   0.10 null-rate L1 similarity
 *   0.10 row-count band proximity
 * Routing: ≥ 0.95 auto-attach, ≥ 0.70 suggest, < 0.70 new profile.
 */
import { createHmac, createHash } from "node:crypto";

export const AUTO_ATTACH_THRESHOLD = 0.95;
export const SUGGEST_THRESHOLD = 0.7;

export interface FingerprintData {
  encoding: string;
  columnSetHash: string;
  /** nameNorm → inferred type */
  columnTypes: Record<string, string>;
  typeBag: Record<string, number>;
  nullRate: Record<string, number>;
  cardinalityBand: Record<string, number>;
  rowCountBand: number;
  /** nameNorm → top-K HMAC'd value hashes; null when no column qualified */
  valueSketch: Record<string, string[]> | null;
}

export interface ColumnStats {
  nameNorm: string;
  type: string;
  nullCount: number;
  distinctCount: number;
  topValues: string[];
}

export function computeFingerprint(
  encoding: string,
  columns: readonly ColumnStats[],
  rowCount: number,
  hmacSaltHex: string,
): FingerprintData {
  const names = columns.map((c) => c.nameNorm).sort();
  const columnSetHash = createHash("sha256").update(names.join("\n"), "utf8").digest("hex");

  const columnTypes: Record<string, number | string> = {};
  const typeBag: Record<string, number> = {};
  const nullRate: Record<string, number> = {};
  const cardinalityBand: Record<string, number> = {};
  const sketch: Record<string, string[]> = {};
  for (const c of columns) {
    columnTypes[c.nameNorm] = c.type;
    typeBag[c.type] = (typeBag[c.type] ?? 0) + 1;
    nullRate[c.nameNorm] = Math.round((c.nullCount / Math.max(rowCount, 1)) * 1000) / 1000;
    cardinalityBand[c.nameNorm] = Math.floor(Math.log2(c.distinctCount + 1));
    // Sketch only code-like columns: decimal (amount) values churn between
    // periods and would drag the similarity of genuinely returning files down.
    if (c.topValues.length > 0 && c.type !== "decimal") {
      sketch[c.nameNorm] = c.topValues.map((v) =>
        createHmac("sha256", hmacSaltHex)
          .update(v.normalize("NFKC").toLowerCase(), "utf8")
          .digest("hex")
          .slice(0, 16),
      );
    }
  }
  return {
    encoding,
    columnSetHash,
    columnTypes: columnTypes as Record<string, string>,
    typeBag,
    nullRate,
    cardinalityBand,
    rowCountBand: Math.floor(Math.log2(rowCount + 1)),
    valueSketch: Object.keys(sketch).length > 0 ? sketch : null,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface SimilarityBreakdown {
  score: number;
  nameJaccard: number;
  typeBagAgreement: number;
  sketchOverlap: number | null;
  nullRateSimilarity: number;
  rowBandProximity: number;
}

export function similarity(a: FingerprintData, b: FingerprintData): SimilarityBreakdown {
  const namesA = new Set(Object.keys(a.columnTypes));
  const namesB = new Set(Object.keys(b.columnTypes));
  const nameJaccard = jaccard(namesA, namesB);

  const types = new Set([...Object.keys(a.typeBag), ...Object.keys(b.typeBag)]);
  let l1 = 0;
  let total = 0;
  for (const t of types) {
    const ca = a.typeBag[t] ?? 0;
    const cb = b.typeBag[t] ?? 0;
    l1 += Math.abs(ca - cb);
    total += ca + cb;
  }
  const typeBagAgreement = total === 0 ? 1 : 1 - l1 / total;

  const shared = [...namesA].filter((n) => namesB.has(n));
  let nullRateSimilarity = 0;
  if (shared.length > 0) {
    let sum = 0;
    for (const n of shared) sum += Math.abs((a.nullRate[n] ?? 0) - (b.nullRate[n] ?? 0));
    nullRateSimilarity = 1 - sum / shared.length;
  }

  // Containment, not Jaccard: a period file holding a subset of the known
  // top values (fewer accounts this month) must still score as a full overlap.
  let sketchOverlap: number | null = null;
  if (a.valueSketch && b.valueSketch) {
    const cols = shared.filter((n) => a.valueSketch![n] && b.valueSketch![n]);
    if (cols.length > 0) {
      let sum = 0;
      for (const n of cols) {
        const sa = new Set(a.valueSketch![n]!);
        const sb = new Set(b.valueSketch![n]!);
        let inter = 0;
        for (const x of sa) if (sb.has(x)) inter++;
        sum += inter / Math.min(sa.size, sb.size);
      }
      sketchOverlap = sum / cols.length;
    }
  }

  const rowBandProximity = 1 / (1 + Math.abs(a.rowCountBand - b.rowCountBand));

  const parts: [number, number][] = [
    [0.4, nameJaccard],
    [0.2, typeBagAgreement],
    [0.1, nullRateSimilarity],
    [0.1, rowBandProximity],
  ];
  if (sketchOverlap !== null) parts.push([0.2, sketchOverlap]);
  const weightSum = parts.reduce((s, [w]) => s + w, 0);
  const score = parts.reduce((s, [w, v]) => s + w * v, 0) / weightSum;

  return { score, nameJaccard, typeBagAgreement, sketchOverlap, nullRateSimilarity, rowBandProximity };
}

export function fingerprintToJsonFields(fp: FingerprintData): {
  column_set_hash: string;
  column_names_json: string;
  type_bag_json: string;
  null_rate_json: string;
  cardinality_band_json: string;
  row_count_band: number;
  value_sketch_json: string | null;
  encoding: string;
} {
  const sortObj = <V>(o: Record<string, V>): Record<string, V> =>
    Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  return {
    column_set_hash: fp.columnSetHash,
    column_names_json: JSON.stringify(sortObj(fp.columnTypes)),
    type_bag_json: JSON.stringify(sortObj(fp.typeBag)),
    null_rate_json: JSON.stringify(sortObj(fp.nullRate)),
    cardinality_band_json: JSON.stringify(sortObj(fp.cardinalityBand)),
    row_count_band: fp.rowCountBand,
    value_sketch_json: fp.valueSketch ? JSON.stringify(sortObj(fp.valueSketch)) : null,
    encoding: fp.encoding,
  };
}

export function fingerprintFromRow(row: {
  encoding: string;
  column_set_hash: string;
  column_names_json: string;
  type_bag_json: string;
  null_rate_json: string;
  cardinality_band_json: string;
  row_count_band: number | bigint;
  value_sketch_json: string | null;
}): FingerprintData {
  return {
    encoding: row.encoding,
    columnSetHash: row.column_set_hash,
    columnTypes: JSON.parse(row.column_names_json),
    typeBag: JSON.parse(row.type_bag_json),
    nullRate: JSON.parse(row.null_rate_json),
    cardinalityBand: JSON.parse(row.cardinality_band_json),
    rowCountBand: Number(row.row_count_band),
    valueSketch: row.value_sketch_json === null ? null : JSON.parse(row.value_sketch_json),
  };
}
