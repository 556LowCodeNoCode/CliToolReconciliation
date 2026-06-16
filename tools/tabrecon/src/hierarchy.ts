/**
 * Column-hierarchy detection: pairwise functional-dependency discovery inside
 * a single ingested file.
 *
 * Naming convention in this module is in the **aggregation sense**, top-down:
 *   parent  = coarse (less-cardinal) column at the top of the hierarchy
 *   child   = fine   (more-cardinal) column further down (drill-down)
 *
 * The underlying functional dependency runs the OTHER way: each child value
 * deterministically rolls up to one parent value (product_code → product_type,
 * city → country). The violation check therefore groups by the child column
 * and looks for multiple parent values within one child group.
 *
 * Two flavors emerge from the same check, separated by cardinality ratio:
 *   aggregation  — parent_distinct ≪ child_distinct  (rollup chain, e.g.
 *                  product_group → product_type → product_code)
 *   descriptive  — parent_distinct ≈ child_distinct  (attribute lookup, e.g.
 *                  gl_account → gl_account_name)
 *
 * Detection is cardinality-capped to stay cheap on wide tables; near-perfect
 * dependencies (consistency ≥ DEFAULT_MIN_CONSISTENCY) are recorded so the LLM
 * can see "almost a hierarchy" candidates too.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./db.ts";
import { datasetColumns, type DatasetColumnRow } from "./keys.ts";

export interface FunctionalDependency {
  parent: string;
  child: string;
  parentDistinct: number;
  childDistinct: number;
  consistency: number;
  kind: "aggregation" | "descriptive";
}

const DEFAULT_MIN_CONSISTENCY = 0.95;
const DEFAULT_MAX_PARENT_DISTINCT = 10_000;
/** Below this ratio child_distinct / parent_distinct, the FD is treated as descriptive (1:1 attribute) not aggregation. */
const AGGREGATION_RATIO_THRESHOLD = 1.5;

export interface DetectOptions {
  minConsistency?: number;
  maxParentDistinct?: number;
}

export function detectColumnHierarchy(
  db: DatabaseSync,
  loadedFileId: number,
  table: string,
  opts: DetectOptions = {},
): FunctionalDependency[] {
  const minConsistency = opts.minConsistency ?? DEFAULT_MIN_CONSISTENCY;
  const maxParentDistinct = opts.maxParentDistinct ?? DEFAULT_MAX_PARENT_DISTINCT;
  const cols = datasetColumns(db, loadedFileId).filter(
    (c) => c.inferred_type === "text" || c.inferred_type === "integer" || c.inferred_type === "date",
  );
  const out: FunctionalDependency[] = [];
  for (const parent of cols) {
    if (parent.distinct_count < 2 || parent.distinct_count > maxParentDistinct) continue;
    for (const child of cols) {
      if (child.sql_name === parent.sql_name) continue;
      if (child.distinct_count <= 1) continue;
      // Parent must be at least as coarse as child (≤ distinct values); equal
      // cardinality means we'll catch the descriptive 1:1 case as well.
      if (child.distinct_count < parent.distinct_count) continue;
      const fd = scoreDependency(db, table, parent, child);
      if (fd === null) continue;
      if (fd.consistency < minConsistency) continue;
      out.push(fd);
    }
  }
  // Stable ordering: aggregation first, by ascending parent cardinality (broadest level first), then by name.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "aggregation" ? -1 : 1;
    if (a.parentDistinct !== b.parentDistinct) return a.parentDistinct - b.parentDistinct;
    return a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child);
  });
  return out;
}

function scoreDependency(
  db: DatabaseSync,
  table: string,
  parent: DatasetColumnRow,
  child: DatasetColumnRow,
): FunctionalDependency | null {
  // FD direction in data: each child value deterministically rolls up to one
  // parent value. Violation = a child value associated with multiple parent
  // values. We sum the rows inside those violating child groups (not just the
  // group count) so the consistency ratio reflects the share of the data that
  // truly fits the hierarchy.
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM "${table}"
       WHERE "${parent.sql_name}" IS NOT NULL AND "${child.sql_name}" IS NOT NULL`,
    )
    .get() as { n: number };
  if (totalRow.n === 0) return null;
  const violationRow = db
    .prepare(
      `SELECT COALESCE(SUM(rows_in_group), 0) AS n FROM (
         SELECT COUNT(*) AS rows_in_group
         FROM "${table}"
         WHERE "${parent.sql_name}" IS NOT NULL AND "${child.sql_name}" IS NOT NULL
         GROUP BY "${child.sql_name}"
         HAVING COUNT(DISTINCT "${parent.sql_name}") > 1
       )`,
    )
    .get() as { n: number };
  const consistency = 1 - violationRow.n / totalRow.n;
  const ratio = child.distinct_count / Math.max(parent.distinct_count, 1);
  return {
    parent: parent.name_norm,
    child: child.name_norm,
    parentDistinct: parent.distinct_count,
    childDistinct: child.distinct_count,
    consistency: Math.round(consistency * 1000) / 1000,
    kind: ratio >= AGGREGATION_RATIO_THRESHOLD ? "aggregation" : "descriptive",
  };
}

export function persistColumnHierarchy(
  db: DatabaseSync,
  loadedFileId: number,
  fds: readonly FunctionalDependency[],
): void {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO ColumnHierarchy
       (loaded_file_id, parent_name, child_name, parent_distinct, child_distinct, consistency, kind, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso();
  for (const fd of fds) {
    ins.run(loadedFileId, fd.parent, fd.child, fd.parentDistinct, fd.childDistinct, fd.consistency, fd.kind, now);
  }
}

export function loadColumnHierarchy(db: DatabaseSync, loadedFileId: number): FunctionalDependency[] {
  const rows = db
    .prepare(
      `SELECT parent_name AS parent, child_name AS child, parent_distinct AS parentDistinct,
              child_distinct AS childDistinct, consistency, kind
       FROM ColumnHierarchy WHERE loaded_file_id = ? ORDER BY id`,
    )
    .all(loadedFileId) as unknown as FunctionalDependency[];
  return rows;
}

/**
 * Build aggregation chains from the FDs (parent → … → leaf). Walks aggregation
 * edges only; returns each maximal chain so the LLM sees the rollup levels in
 * one shot ("product_group → product_type → product_code").
 */
export function aggregationChains(fds: readonly FunctionalDependency[]): string[][] {
  const aggEdges = fds.filter((f) => f.kind === "aggregation");
  if (aggEdges.length === 0) return [];
  const childrenOf = new Map<string, FunctionalDependency[]>();
  const allChildren = new Set<string>();
  for (const e of aggEdges) {
    const list = childrenOf.get(e.parent) ?? [];
    list.push(e);
    childrenOf.set(e.parent, list);
    allChildren.add(e.child);
  }
  const roots = [...new Set(aggEdges.map((e) => e.parent))].filter((c) => !allChildren.has(c));
  const chains: string[][] = [];
  const walk = (node: string, path: string[], seen: Set<string>): void => {
    const newPath = [...path, node];
    const next = (childrenOf.get(node) ?? [])
      .filter((e) => !seen.has(e.child))
      .sort((a, b) => a.childDistinct - b.childDistinct);
    if (next.length === 0) {
      chains.push(newPath);
      return;
    }
    for (const edge of next) walk(edge.child, newPath, new Set([...seen, edge.child]));
  };
  for (const r of roots) walk(r, [], new Set([r]));
  return chains;
}

export interface PairLevelProposal {
  level: number;
  /** key entries to add at this level (cumulative; level k means "key at levels 0..k"). */
  add: { colA: string; colB: string }[];
  /** rationale — both sides' hierarchies that justify this position. */
  rationaleA: { parent: string; child?: string; kind: string };
  rationaleB: { parent: string; child?: string; kind: string };
}

/**
 * From two side-A/side-B hierarchies and a set of column-name-pair candidates
 * (col_a, col_b), propose level ordering: level 0 = coarsest column pair where
 * both sides agree it's a top-of-hierarchy column; subsequent levels each
 * refine the previous via an aggregation edge present on BOTH sides.
 */
export function proposeJoinLevels(
  fdsA: readonly FunctionalDependency[],
  fdsB: readonly FunctionalDependency[],
  candidates: readonly { colA: string; colB: string }[],
): PairLevelProposal[] {
  const aggA = fdsA.filter((f) => f.kind === "aggregation");
  const aggB = fdsB.filter((f) => f.kind === "aggregation");
  const cardinalityA = (col: string): number =>
    fdsA.find((f) => f.parent === col)?.parentDistinct ??
    fdsA.find((f) => f.child === col)?.childDistinct ??
    Number.POSITIVE_INFINITY;
  const cardinalityB = (col: string): number =>
    fdsB.find((f) => f.parent === col)?.parentDistinct ??
    fdsB.find((f) => f.child === col)?.childDistinct ??
    Number.POSITIVE_INFINITY;
  const hasEdgeA = (parent: string, child: string): boolean =>
    aggA.some((e) => e.parent === parent && e.child === child);
  const hasEdgeB = (parent: string, child: string): boolean =>
    aggB.some((e) => e.parent === parent && e.child === child);

  if (candidates.length === 0) return [];

  // Sort by coarseness (joint cardinality on both sides, smallest first).
  const ranked = [...candidates].sort(
    (x, y) =>
      Math.max(cardinalityA(x.colA), cardinalityB(x.colB)) -
      Math.max(cardinalityA(y.colA), cardinalityB(y.colB)),
  );
  const proposals: PairLevelProposal[] = [];
  const taken = new Set<string>();
  let prev: { colA: string; colB: string } | null = null;
  for (const cand of ranked) {
    const sig = `${cand.colA}${cand.colB}`;
    if (taken.has(sig)) continue;
    let rationaleA: PairLevelProposal["rationaleA"] = { parent: cand.colA, kind: "root" };
    let rationaleB: PairLevelProposal["rationaleB"] = { parent: cand.colB, kind: "root" };
    if (prev !== null) {
      // Must refine the previous level on both sides via an aggregation edge.
      if (!hasEdgeA(prev.colA, cand.colA) || !hasEdgeB(prev.colB, cand.colB)) continue;
      rationaleA = { parent: prev.colA, child: cand.colA, kind: "aggregation" };
      rationaleB = { parent: prev.colB, child: cand.colB, kind: "aggregation" };
    }
    proposals.push({
      level: proposals.length,
      add: [cand],
      rationaleA,
      rationaleB,
    });
    taken.add(sig);
    prev = cand;
  }
  return proposals;
}
