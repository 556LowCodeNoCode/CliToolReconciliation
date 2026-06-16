/**
 * Auto-pick reconciliation mappings from the structural candidates the tool
 * already computes — so an end user with two files and one ask ("reconcile
 * them") never has to declare keys, compare columns, or display columns.
 *
 * Picks are deterministic and explainable:
 *   level-0 key  — top-ranked candidate from `suggestMappings.keyCandidates`
 *                  (rank = overlap × √(uniqA × uniqB)) above conservative floors.
 *   level-1 key  — next-best key on different columns from level 0, if its
 *                  overlap clears the floor (gives a finer drill-down grain).
 *   compare      — decimal-vs-decimal pair(s): prefer name similarity
 *                  (Jaro-Winkler ≥ threshold); fall back to the largest-total
 *                  decimal column on each side when names don't align.
 *
 * If no key passes the floors, returns empty mappings + a warning — the
 * caller falls back to the existing `decisions_needed` path (the agent
 * decides).
 */
import type { DatabaseSync } from "node:sqlite";
import { datasetColumns, suggestMappings, type DatasetColumnRow } from "./keys.ts";

export interface AutoMapping {
  role: "key" | "compare" | "display";
  level: number;
  colA: string;
  colB: string;
  normMode: "smart" | "raw";
  rationale: string;
}

export interface AutoMappingResult {
  mappings: AutoMapping[];
  warnings: string[];
}

const KEY_OVERLAP_FLOOR = 0.5;
const KEY_RANK_FLOOR = 0.02;
const COMPARE_NAME_SIM_FLOOR = 0.6;

interface FileRef {
  id: number;
  table: string;
}

export function autoPickMappings(
  db: DatabaseSync,
  pairId: number,
  fileA: FileRef,
  fileB: FileRef,
): AutoMappingResult {
  const suggest = suggestMappings(db, pairId, fileA, fileB);
  const mappings: AutoMapping[] = [];
  const warnings: string[] = [];

  // --- keys ---------------------------------------------------------------
  const goodKeys = suggest.keyCandidates.filter(
    (k) => k.rankScore >= KEY_RANK_FLOOR && k.overlapRatio >= KEY_OVERLAP_FLOOR,
  );
  if (goodKeys.length === 0) {
    warnings.push(
      "No high-confidence join key detected (no candidate passes overlap ≥ " +
        KEY_OVERLAP_FLOOR + " and rank ≥ " + KEY_RANK_FLOOR + "). Reconciliation cannot proceed.",
    );
    return { mappings, warnings };
  }
  const lvl0 = goodKeys[0]!;
  mappings.push({
    role: "key",
    level: 0,
    colA: lvl0.colA,
    colB: lvl0.colB,
    normMode: "smart",
    rationale: `top-ranked key (overlap ${lvl0.overlapRatio}, uniq ${lvl0.uniquenessA}/${lvl0.uniquenessB})`,
  });
  const lvl1 = goodKeys.find((k) => k.colA !== lvl0.colA && k.colB !== lvl0.colB);
  if (lvl1 !== undefined) {
    mappings.push({
      role: "key",
      level: 1,
      colA: lvl1.colA,
      colB: lvl1.colB,
      normMode: "smart",
      rationale: `cross-dimension refinement (overlap ${lvl1.overlapRatio})`,
    });
  }

  // --- compare columns ----------------------------------------------------
  const colsA = datasetColumns(db, fileA.id);
  const colsB = datasetColumns(db, fileB.id);
  const decimalsA = colsA.filter((c) => c.inferred_type === "decimal");
  const decimalsB = colsB.filter((c) => c.inferred_type === "decimal");
  if (decimalsA.length === 0 || decimalsB.length === 0) {
    warnings.push(
      `One side has no decimal columns (A: ${decimalsA.length}, B: ${decimalsB.length}) — nothing to reconcile as amounts.`,
    );
    return { mappings, warnings };
  }

  // Try name-similar decimal pairs first.
  const nameSimPairs = suggest.compareCandidates.filter(
    (c) => c.typeA === "decimal" && c.typeB === "decimal" && c.nameSimilarity >= COMPARE_NAME_SIM_FLOOR,
  );
  if (nameSimPairs.length > 0) {
    for (const c of nameSimPairs) {
      mappings.push({
        role: "compare",
        level: 0,
        colA: c.colA,
        colB: c.colB,
        normMode: "smart",
        rationale: `decimal-vs-decimal, name similarity ${c.nameSimilarity}`,
      });
    }
  } else {
    // Fallback: pick the decimal column with the largest absolute total on
    // each side — typically the "main amount" column (closing balance,
    // sum, total).
    const colTotal = (table: string, sqlName: string): number =>
      Number(
        (
          db
            .prepare(`SELECT COALESCE(SUM(ABS(CAST("${sqlName}" AS REAL))), 0) AS t FROM "${table}"`)
            .get() as { t: number }
        ).t,
      );
    const biggest = (cols: DatasetColumnRow[], table: string): DatasetColumnRow | undefined =>
      cols
        .map((c) => ({ c, total: colTotal(table, c.sql_name) }))
        .sort((x, y) => y.total - x.total)[0]?.c;
    const aBig = biggest(decimalsA, fileA.table);
    const bBig = biggest(decimalsB, fileB.table);
    if (aBig !== undefined && bBig !== undefined) {
      mappings.push({
        role: "compare",
        level: 0,
        colA: aBig.name_norm,
        colB: bBig.name_norm,
        normMode: "smart",
        rationale: "largest-total decimal column on each side (no name match found)",
      });
      warnings.push(
        `Compare picked by total magnitude — verify "${aBig.name_norm}" ↔ "${bBig.name_norm}" is the right pair. ` +
          "Override with `tabrecon map --pair <n> --clear --key ... --compare ...` if not.",
      );
    }
  }

  return { mappings, warnings };
}
