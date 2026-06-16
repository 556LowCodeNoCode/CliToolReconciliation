/**
 * Join-key statistics and mapping suggestions for a file pair.
 * Deterministic stats (uniqueness, overlap, null rates) + name similarity
 * (Jaro-Winkler, pure TS) — the candidates the in-session LLM decides from.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.ts";

/** Smart key normalization: digit-bearing codes are joined on their digits
 *  (leading zeros stripped: "20-01040000" → "2001040000", "031" → "31");
 *  everything else is NFKC + casefold + trim. */
export function normKey(value: string, mode: "smart" | "raw"): string {
  if (mode === "raw") return value;
  const t = value.normalize("NFKC").trim();
  if (/^[0-9][0-9 .\-/]*$/.test(t)) {
    const digits = t.replaceAll(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
    if (digits !== "") return digits;
  }
  return t.toLowerCase();
}

export function jaroWinkler(s1: string, s2: string): number {
  const a = s1.toLowerCase();
  const b = s2.toLowerCase();
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(b.length - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface DatasetColumnRow {
  loaded_file_id: number;
  position: number;
  name_raw: string;
  name_norm: string;
  sql_name: string;
  inferred_type: string;
  number_format: string | null;
  null_count: number;
  distinct_count: number;
}

export function datasetColumns(db: DatabaseSync, loadedFileId: number): DatasetColumnRow[] {
  return db
    .prepare("SELECT * FROM DatasetColumn WHERE loaded_file_id = ? ORDER BY position")
    .all(loadedFileId) as unknown as DatasetColumnRow[];
}

function columnValueSet(
  db: DatabaseSync,
  table: string,
  sqlName: string,
): { values: Set<string>; nonNull: number; total: number } {
  const rows = db
    .prepare(`SELECT "${sqlName}" AS v FROM "${table}"`)
    .all() as unknown as { v: string | null }[];
  const values = new Set<string>();
  let nonNull = 0;
  for (const r of rows) {
    if (r.v === null) continue;
    nonNull++;
    values.add(normKey(r.v, "smart"));
  }
  return { values, nonNull, total: rows.length };
}

export interface KeyCandidate {
  colA: string;
  colB: string;
  nameSimilarity: number;
  uniquenessA: number;
  uniquenessB: number;
  overlapRatio: number;
  nullRateA: number;
  nullRateB: number;
  rankScore: number;
}

export interface CompareCandidate {
  colA: string;
  colB: string;
  nameSimilarity: number;
  typeA: string;
  typeB: string;
}

export interface SuggestResult {
  keyCandidates: KeyCandidate[];
  compareCandidates: CompareCandidate[];
}

const NAME_SIM_PREFILTER = 0.5;
const HIGH_UNIQUENESS = 0.9;

export function suggestMappings(
  db: DatabaseSync,
  reconPairId: number,
  fileA: { id: number; table: string },
  fileB: { id: number; table: string },
): SuggestResult {
  const colsA = datasetColumns(db, fileA.id);
  const colsB = datasetColumns(db, fileB.id);

  const setCache = new Map<string, { values: Set<string>; nonNull: number; total: number }>();
  const getSet = (table: string, sqlName: string) => {
    const key = `${table}.${sqlName}`;
    let v = setCache.get(key);
    if (!v) {
      v = columnValueSet(db, table, sqlName);
      setCache.set(key, v);
    }
    return v;
  };

  const keyCandidates: KeyCandidate[] = [];
  for (const ca of colsA) {
    if (ca.inferred_type === "decimal") continue; // amounts are compare material, not keys
    for (const cb of colsB) {
      if (cb.inferred_type === "decimal") continue;
      const nameSim = jaroWinkler(ca.name_norm, cb.name_norm);
      const sa = getSet(fileA.table, ca.sql_name);
      const sb = getSet(fileB.table, cb.sql_name);
      const uniqA = sa.nonNull === 0 ? 0 : sa.values.size / sa.nonNull;
      const uniqB = sb.nonNull === 0 ? 0 : sb.values.size / sb.nonNull;
      if (nameSim < NAME_SIM_PREFILTER && !(uniqA >= HIGH_UNIQUENESS && uniqB >= HIGH_UNIQUENESS)) {
        continue;
      }
      let inter = 0;
      for (const v of sa.values) if (sb.values.has(v)) inter++;
      const overlap = Math.min(sa.values.size, sb.values.size) === 0
        ? 0
        : inter / Math.min(sa.values.size, sb.values.size);
      const cand: KeyCandidate = {
        colA: ca.name_norm,
        colB: cb.name_norm,
        nameSimilarity: round3(nameSim),
        uniquenessA: round3(uniqA),
        uniquenessB: round3(uniqB),
        overlapRatio: round3(overlap),
        nullRateA: round3(sa.total === 0 ? 0 : (sa.total - sa.nonNull) / sa.total),
        nullRateB: round3(sb.total === 0 ? 0 : (sb.total - sb.nonNull) / sb.total),
        rankScore: round3(overlap * Math.sqrt(Math.max(uniqA * uniqB, 0))),
      };
      if (cand.overlapRatio > 0) keyCandidates.push(cand);
    }
  }
  keyCandidates.sort((x, y) => y.rankScore - x.rankScore || y.nameSimilarity - x.nameSimilarity);

  const ins = db.prepare(
    `INSERT INTO JoinKeyStat
       (recon_pair_id, loaded_file_a_id, loaded_file_b_id, col_a, col_b,
        uniqueness_a, uniqueness_b, overlap_ratio, null_rate_a, null_rate_b, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const k of keyCandidates) {
    ins.run(
      reconPairId, fileA.id, fileB.id, k.colA, k.colB,
      k.uniquenessA, k.uniquenessB, k.overlapRatio, k.nullRateA, k.nullRateB, nowIso(),
    );
  }

  const compareCandidates: CompareCandidate[] = [];
  for (const ca of colsA) {
    if (ca.inferred_type !== "decimal" && ca.inferred_type !== "integer") continue;
    for (const cb of colsB) {
      if (cb.inferred_type !== "decimal" && cb.inferred_type !== "integer") continue;
      const nameSim = jaroWinkler(ca.name_norm, cb.name_norm);
      if (nameSim < NAME_SIM_PREFILTER) continue;
      compareCandidates.push({
        colA: ca.name_norm,
        colB: cb.name_norm,
        nameSimilarity: round3(nameSim),
        typeA: ca.inferred_type,
        typeB: cb.inferred_type,
      });
    }
  }
  compareCandidates.sort((x, y) => y.nameSimilarity - x.nameSimilarity);

  return { keyCandidates: keyCandidates.slice(0, 20), compareCandidates: compareCandidates.slice(0, 20) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
