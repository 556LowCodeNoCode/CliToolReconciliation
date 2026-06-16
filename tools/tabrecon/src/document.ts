/**
 * Machine-generated database-structure documentation, derived entirely from
 * the live database (repo-B pattern): every table with columns, types, FKs,
 * row counts, sample rows, plus the loaded-file registry and the storage
 * conventions an agent needs to query the data correctly.
 */
import type { DatabaseSync } from "node:sqlite";

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

export function renderSchemaDoc(db: DatabaseSync): string {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as { name: string }[]
  ).map((t) => t.name);

  const L: string[] = [];
  L.push("# tabrecon database structure");
  L.push("");
  L.push("> **Machine-generated** by `tabrecon document` — fully overwritten on each run.");
  L.push("");
  L.push(`Generated at: ${new Date().toISOString()} — ${tables.length} tables.`);
  L.push("");
  L.push("## Storage conventions");
  L.push("");
  L.push("- Dataset tables (`Dataset<N>`, one per loaded file) store every value as TEXT in canonical form:");
  L.push("  decimals as plain standard-format strings (`-1234.56`), dates as ISO `yyyy-mm-dd`, plus `src_row` (1-based data-row ordinal).");
  L.push("- `RunFinding.value_a_micros` / `value_b_micros` / `delta_micros` are exact decimal strings (engine computes on ×10⁶ BigInt micro-units; no binary floats).");
  L.push("- Column identity across the system is `DatasetColumn.name_norm` (NFKC, casefold, whitespace-collapsed).");
  L.push("- Join keys are normalized per `ColumnMapping.norm_mode`: `smart` joins digit-bearing codes on digits with leading zeros stripped; `raw` joins verbatim.");
  L.push("- `LoadedFile.sha256` is UNIQUE: identical content is never ingested twice into the same database.");
  L.push("- xlsx-sourced decimals are normalized at ingestion: binary-float lexical artifacts are rounded half-away-from-zero at the 6th decimal, and scientific notation (`7.0E-2`) is expanded exactly. Text sources are parsed strictly (no rounding).");
  L.push("");

  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as TableInfoRow[];
    const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as unknown as {
      from: string;
      table: string;
      to: string;
    }[];
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    L.push(`## ${table} (${count} rows)`);
    L.push("");
    L.push("| Column | Type | Not null | PK | FK |");
    L.push("|---|---|---|---|---|");
    for (const c of cols) {
      const fk = fks.find((f) => f.from === c.name);
      L.push(
        `| ${c.name} | ${c.type || "TEXT"} | ${c.notnull ? "yes" : ""} | ${c.pk ? "yes" : ""} | ${fk ? `${fk.table}.${fk.to}` : ""} |`,
      );
    }
    L.push("");
    if (count > 0 && count <= 100_000) {
      const samples = db.prepare(`SELECT * FROM "${table}" LIMIT 5`).all() as unknown as Record<
        string,
        unknown
      >[];
      L.push(`Sample rows (${Math.min(5, count)}):`);
      L.push("");
      const names = cols.map((c) => c.name);
      L.push(`| ${names.join(" | ")} |`);
      L.push(`|${names.map(() => "---|").join("")}`);
      for (const s of samples) {
        L.push(
          `| ${names
            .map((n) => String(s[n] ?? "").replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 40))
            .join(" | ")} |`,
        );
      }
      L.push("");
    }
  }
  return L.join("\n");
}
