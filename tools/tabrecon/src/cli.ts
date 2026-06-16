#!/usr/bin/env node
/**
 * tabrecon — generic LLM-driven tabular reconciliation CLI.
 *
 * Commands:
 *   ingest     Ingest one tabular file (delimited / xlsx / fixed-width via spec).
 *              Detects encoding/delimiter/headers, infers types, dedups by SHA-256,
 *              fingerprints, routes to a profile, and discovers column hierarchies.
 *   profile    list | show | attach — file-kind memory management.
 *   pair       create | list — reconciliation pair (profile × profile) memory.
 *   hierarchy  Show the detected aggregation chains / descriptive attributes for a file.
 *   suggest    Join-key statistics + compare candidates + proposed level ordering.
 *   map        Record key / compare / display column mappings for a pair.
 *   reconcile  Run the engine for a pair, persist findings in SQLite.
 *   run        ingest A + B → recognize → (decisions or reconcile).
 *   document   Machine-generate the database structure documentation.
 *
 * Reports and business rules are deliberately not part of the CLI. The LLM
 * (or whichever agent fronts tabrecon) queries the persisted RunFinding /
 * Dataset<N> / ColumnHierarchy tables directly to apply business semantics
 * and shape whatever report the user needs.
 *
 * Exit codes: 0 completed (findings / "decisions needed" are data),
 *             1 operational failure (single line `error(<Name>): <msg>` on stderr),
 *             2 usage error. With --fail-on-findings: 1 when findings > 0.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULTS, TOOL_NAME, resolveConfig, requireFlag, type ToolConfig } from "./config.ts";
import { nowIso, openDatabase } from "./db.ts";
import { NotFoundError, UsageError } from "./errors.ts";
import { attachFileToProfile, ingestFile, type IngestOutcome } from "./ingest/ingest.ts";
import { suggestMappings, type SuggestResult } from "./keys.ts";
import { renderSchemaDoc } from "./document.ts";
import { runReconcile, type ReconcileSummary } from "./reconcile.ts";
import { aggregationChains, loadColumnHierarchy, proposeJoinLevels, type PairLevelProposal, type FunctionalDependency } from "./hierarchy.ts";

/* ----------------------------------------------------------- arg parsing */

interface ParsedArgs {
  command: string;
  sub: string | null;
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
  help: boolean;
  version: boolean;
}

const BOOLEAN_FLAGS = new Set(["json", "fail-on-findings", "clear"]);
const MULTI_FLAGS = new Set(["key", "compare", "display"]);
const SUBCOMMANDS: Record<string, string[]> = {
  profile: ["list", "show", "attach"],
  pair: ["create", "list"],
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest0] = argv;
  let sub: string | null = null;
  let rest = rest0;
  if (SUBCOMMANDS[command] && rest0[0] !== undefined && !rest0[0].startsWith("--")) {
    sub = rest0[0]!;
    rest = rest0.slice(1);
    if (!SUBCOMMANDS[command]!.includes(sub)) {
      throw new UsageError(
        `Unknown subcommand "${command} ${sub}" — expected one of: ${SUBCOMMANDS[command]!.join(", ")}`,
      );
    }
  }
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  let help = command === "--help" || command === "-h";
  let version = command === "--version";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--version") {
      version = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = rest[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new UsageError(`Flag --${key} requires a value`);
      }
      if (MULTI_FLAGS.has(key)) {
        (multi[key] ??= []).push(next);
      } else {
        flags[key] = next;
      }
      i++;
    } else {
      throw new UsageError(`Unexpected argument "${a}" — flags start with --`);
    }
  }
  return { command, sub, flags, multi, help, version };
}

/* ----------------------------------------------------------- output */

function emit(cfg: ToolConfig, human: string[], jsonValue: unknown): void {
  if (cfg.json) {
    console.log(JSON.stringify(jsonValue, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    for (const line of human) console.log(line);
  }
}

function describeHierarchy(fds: readonly FunctionalDependency[]): string[] {
  if (fds.length === 0) return ["  hierarchy       (no near-functional dependencies detected)"];
  const chains = aggregationChains(fds);
  const lines: string[] = [];
  if (chains.length > 0) {
    lines.push("  hierarchy       aggregation chain(s) (top → drill-down):");
    for (const chain of chains) lines.push(`                    ${chain.join(" → ")}`);
  }
  const desc = fds.filter((f) => f.kind === "descriptive");
  // Descriptive 1:1 pairs are direction-symmetric — dedupe to the canonical
  // (alphabetical) ordering for human output. The persisted FD table still
  // carries both directions for SQL lookups.
  const descSeen = new Set<string>();
  const descUnique = desc.filter((d) => {
    const key = [d.parent, d.child].sort().join("↔");
    if (descSeen.has(key)) return false;
    descSeen.add(key);
    return true;
  });
  if (descUnique.length > 0) {
    lines.push("  hierarchy       descriptive 1:1 attributes:");
    for (const d of descUnique) {
      const [a, b] = [d.parent, d.child].sort();
      lines.push(`                    ${a} ↔ ${b}   (consistency ${d.consistency})`);
    }
  }
  if (lines.length === 0) {
    lines.push("  hierarchy       (no aggregation or descriptive structure recognized)");
  }
  return lines;
}

function describeIngest(o: IngestOutcome): string[] {
  const lines: string[] = [];
  if (o.status === "already_loaded") {
    lines.push(
      `  already loaded  ${o.fileName} (sha256 ${o.sha256.slice(0, 12)}… in registry, 0 rows inserted) — profile: ${o.profileName ?? "(unattached)"}`,
    );
    lines.push(...describeHierarchy(o.hierarchy));
    return lines;
  }
  lines.push(
    `  loaded          ${o.fileName} → ${o.datasetTable} (${o.rowCount} rows, ${o.format}/${o.encoding}, sha256 ${o.sha256.slice(0, 12)}…)`,
  );
  const cols = o.columns.map((c) => `${c.name}:${c.type}`).join(", ");
  lines.push(`  columns         ${cols}`);
  switch (o.routing) {
    case "attached_existing":
      lines.push(`  profile         attached to "${o.profileName}" (similarity ${o.score})${o.specSource === "profile_memory" ? " via remembered parse spec" : ""}`);
      break;
    case "attached_explicit":
      lines.push(`  profile         "${o.profileName}" (explicit --profile)`);
      break;
    case "created_new_profile":
      lines.push(`  profile         created new "${o.profileName}" (best similarity below suggest threshold)`);
      break;
    case "unattached_suggest":
      lines.push(`  profile         UNATTACHED — candidates (decide with "profile attach --file-id ${o.loadedFileId} --profile <name>"):`);
      for (const s of o.suggestions) lines.push(`                    ${s.profileName} (similarity ${s.score})`);
      break;
    default:
      break;
  }
  for (const w of o.driftWarnings) lines.push(`  drift(SOFT)     ${w}`);
  lines.push(...describeHierarchy(o.hierarchy));
  return lines;
}

interface SuggestWithLevels extends SuggestResult {
  proposedLevels: PairLevelProposal[];
}

function describeSuggest(s: SuggestWithLevels): string[] {
  const lines: string[] = ["  key candidates (uniqueness A/B, overlap, null A/B):"];
  for (const k of s.keyCandidates.slice(0, 10)) {
    lines.push(
      `    ${k.colA} = ${k.colB}   uniq ${k.uniquenessA}/${k.uniquenessB}  overlap ${k.overlapRatio}  nulls ${k.nullRateA}/${k.nullRateB}  rank ${k.rankScore}`,
    );
  }
  lines.push("  compare candidates (name similarity):");
  for (const c of s.compareCandidates.slice(0, 10)) {
    lines.push(`    ${c.colA} = ${c.colB}   sim ${c.nameSimilarity}  (${c.typeA}/${c.typeB})`);
  }
  if (s.proposedLevels.length > 0) {
    lines.push("  proposed levels (coarsest first; refines via aggregation edges present on both sides):");
    for (const p of s.proposedLevels) {
      const desc = p.add.map((a) => `${a.colA}=${a.colB}`).join(", ");
      const rA = p.rationaleA.child
        ? `A: ${p.rationaleA.parent} → ${p.rationaleA.child}`
        : `A: root ${p.rationaleA.parent}`;
      const rB = p.rationaleB.child
        ? `B: ${p.rationaleB.parent} → ${p.rationaleB.child}`
        : `B: root ${p.rationaleB.parent}`;
      lines.push(`    level ${p.level}: ${desc}   [${rA}; ${rB}]`);
    }
  }
  return lines;
}

function describeReconcile(r: ReconcileSummary): string[] {
  const lines = [
    `  reconcile       pair "${r.pairName}": ${r.fileA.name} vs ${r.fileB.name}`,
    `  run             ${r.runUuid}`,
    `  tolerance       absolute ${r.tolerance.absolute}`,
  ];
  for (const s of r.levels) {
    lines.push(
      `    level ${s.level}: ${s.only_a + s.only_b + s.differ} finding(s) / ${s.examined} examined (only_a ${s.only_a}, only_b ${s.only_b}, differ ${s.differ})`,
    );
  }
  lines.push(`  TOTAL: ${r.totalFindings} finding(s) (${r.highSeverity} high)`);
  lines.push(`  findings persisted in RunFinding for run "${r.runUuid}" — query the DB directly to shape reports.`);
  return lines;
}

/* ----------------------------------------------------------- helpers */

function pairIdByName(db: DatabaseSync, name: string): number {
  const p = db.prepare("SELECT id FROM ReconPair WHERE name = ?").get(name) as { id: number } | undefined;
  if (!p) throw new NotFoundError("ReconPair", name);
  return p.id;
}

function latestFileOfProfile(db: DatabaseSync, profileId: number): { id: number; table: string } {
  const f = db
    .prepare("SELECT id, dataset_table FROM LoadedFile WHERE profile_id = ? ORDER BY id DESC LIMIT 1")
    .get(profileId) as { id: number; dataset_table: string } | undefined;
  if (!f) throw new NotFoundError("LoadedFile", `latest of profile ${profileId}`);
  return { id: f.id, table: f.dataset_table };
}

function readSpecFlag(flags: Record<string, string | boolean>, key: string): unknown | undefined {
  const v = flags[key];
  if (typeof v !== "string") return undefined;
  const text = v.trim().startsWith("{") ? v : readFileSync(resolve(v), "utf8");
  return JSON.parse(text);
}

function parseMappingSyntax(entry: string, role: "key" | "compare" | "display"): {
  colA: string;
  colB: string;
  level: number;
  normMode: "smart" | "raw";
} {
  const eq = entry.indexOf("=");
  if (eq <= 0) throw new UsageError(`--${role} expects "colA=colB[:level][:raw]", got "${entry}"`);
  const colA = entry.slice(0, eq).trim().toLowerCase();
  let rest = entry.slice(eq + 1);
  let level = 0;
  let normMode: "smart" | "raw" = "smart";
  const m = /^(.*?)(?::(\d+))?(?::(raw|smart))?$/.exec(rest)!;
  rest = m[1]!;
  if (m[2] !== undefined) level = Number.parseInt(m[2], 10);
  if (m[3] !== undefined) normMode = m[3] as "smart" | "raw";
  const colB = rest.trim().toLowerCase();
  if (colA === "" || colB === "") throw new UsageError(`--${role} "${entry}": empty column name`);
  if (role !== "key" && level !== 0) throw new UsageError(`--${role} does not take a :level suffix`);
  return { colA, colB, level, normMode };
}

function writeOut(path: string, content: string): string {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function suggestWithLevels(
  db: DatabaseSync,
  pairId: number,
  fileA: { id: number; table: string },
  fileB: { id: number; table: string },
): SuggestWithLevels {
  const base = suggestMappings(db, pairId, fileA, fileB);
  const fdsA = loadColumnHierarchy(db, fileA.id);
  const fdsB = loadColumnHierarchy(db, fileB.id);
  const proposedLevels = proposeJoinLevels(fdsA, fdsB, base.keyCandidates);
  return { ...base, proposedLevels };
}

/* ----------------------------------------------------------- run command */

interface RunCommandResult {
  status: "completed" | "decisions_needed";
  ingestA: IngestOutcome;
  ingestB: IngestOutcome;
  pairName: string | null;
  suggest?: SuggestWithLevels;
  reconcile?: ReconcileSummary;
  reasons?: string[];
}

function doRun(db: DatabaseSync, cfg: ToolConfig, flags: Record<string, string | boolean>): RunCommandResult {
  const fileA = requireFlag(flags, "file-a", "fileA");
  const fileB = requireFlag(flags, "file-b", "fileB");
  const outA = ingestFile(db, {
    filePath: fileA,
    ...(typeof flags["profile-a"] === "string" ? { profileName: flags["profile-a"] } : {}),
    ...(readSpecFlag(flags, "spec-a") !== undefined ? { spec: readSpecFlag(flags, "spec-a") } : {}),
  });
  const outB = ingestFile(db, {
    filePath: fileB,
    ...(typeof flags["profile-b"] === "string" ? { profileName: flags["profile-b"] } : {}),
    ...(readSpecFlag(flags, "spec-b") !== undefined ? { spec: readSpecFlag(flags, "spec-b") } : {}),
  });

  const reasons: string[] = [];
  if (outA.profileId === null) reasons.push(`file A is unattached — pick a profile: ${outA.suggestions.map((s) => s.profileName).join(", ") || "(none suggested; use profile attach)"}`);
  if (outB.profileId === null) reasons.push(`file B is unattached — pick a profile (suggestions: ${outB.suggestions.map((s) => s.profileName).join(", ") || "none"})`);
  if (reasons.length > 0) {
    return { status: "decisions_needed", ingestA: outA, ingestB: outB, pairName: null, reasons };
  }

  let pairName: string;
  let pairId: number;
  if (typeof flags["pair"] === "string") {
    pairName = flags["pair"];
    const existing = db.prepare("SELECT id FROM ReconPair WHERE name = ?").get(pairName) as { id: number } | undefined;
    pairId = existing
      ? existing.id
      : Number(
          db
            .prepare("INSERT INTO ReconPair (name, profile_a_id, profile_b_id, created_at) VALUES (?, ?, ?, ?)")
            .run(pairName, outA.profileId!, outB.profileId!, nowIso()).lastInsertRowid,
        );
  } else {
    const existing = db
      .prepare("SELECT id, name FROM ReconPair WHERE profile_a_id = ? AND profile_b_id = ?")
      .get(outA.profileId!, outB.profileId!) as { id: number; name: string } | undefined;
    if (existing) {
      pairId = existing.id;
      pairName = existing.name;
    } else {
      pairName = `${outA.profileName} vs ${outB.profileName}`;
      pairId = Number(
        db
          .prepare("INSERT INTO ReconPair (name, profile_a_id, profile_b_id, created_at) VALUES (?, ?, ?, ?)")
          .run(pairName, outA.profileId!, outB.profileId!, nowIso()).lastInsertRowid,
      );
    }
  }

  const mappingCount = (
    db
      .prepare(
        "SELECT SUM(CASE WHEN role = 'key' AND level = 0 THEN 1 ELSE 0 END) AS k, SUM(CASE WHEN role = 'compare' THEN 1 ELSE 0 END) AS c FROM ColumnMapping WHERE recon_pair_id = ?",
      )
      .get(pairId) as { k: number | null; c: number | null }
  );
  if ((mappingCount.k ?? 0) === 0 || (mappingCount.c ?? 0) === 0) {
    const suggest = suggestWithLevels(
      db,
      pairId,
      { id: outA.loadedFileId, table: outA.datasetTable },
      { id: outB.loadedFileId, table: outB.datasetTable },
    );
    return {
      status: "decisions_needed",
      ingestA: outA,
      ingestB: outB,
      pairName,
      suggest,
      reasons: [
        `pair "${pairName}" has no key/compare mappings yet — decide from the candidates and record them with: ` +
          `${TOOL_NAME} map --pair "${pairName}" --key "<colA>=<colB>" --compare "<colA>=<colB>"`,
      ],
    };
  }

  const summary = runReconcile(db, {
    pairName,
    fileAId: outA.loadedFileId,
    fileBId: outB.loadedFileId,
    toleranceDefault: cfg.tolerance,
    m2mPairCap: cfg.m2mPairCap,
  });
  return {
    status: "completed",
    ingestA: outA,
    ingestB: outB,
    pairName,
    reconcile: summary,
  };
}

/* ----------------------------------------------------------- help */

function toolVersion(): string {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version: string };
  return pkg.version;
}

const GLOBAL_HELP = `${TOOL_NAME} — generic tabular reconciliation: ingest → understand structure → reconcile

SYNOPSIS
  ${TOOL_NAME} <command> [flags]        (run "${TOOL_NAME} help" or any command with --help)

COMMANDS
  ingest     --file <path> [--profile <name>] [--spec <json|@file>]
             Ingest one tabular file into the SQLite database. Detects encoding/
             delimiter/headers, infers types, dedupes by SHA-256, computes a
             structural fingerprint, routes to a profile (≥ 0.95 auto-attach /
             ≥ 0.70 suggest / new profile), classifies drift, and discovers
             column hierarchies (functional dependencies) in the data.
  profile    list | show --name <n> | attach --file-id <id> --profile <n>
  pair       create --name <n> --profile-a <p> --profile-b <p> | list
  hierarchy  --file-id <id>
             Show the detected aggregation chains (top → drill-down) and
             descriptive 1:1 attributes for one ingested file. The same data
             is queryable in the ColumnHierarchy table.
  suggest    --pair <n> [--file-a <id>] [--file-b <id>]
             Join-key statistics (uniqueness, overlap, null rates), compare
             candidates ranked by Jaro-Winkler name similarity, and a proposed
             level ordering derived from both sides' hierarchies (level 0 =
             coarsest joint grain; each subsequent level refines via an
             aggregation edge present on both sides).
  map        --pair <n> [--key "a=b[:level][:raw]"]... [--compare "a=b"]...
             [--display "a=b"]... [--clear]
             Record the pair's column mappings. Keys at level 0 are the coarse
             grain; higher levels drill down.
  reconcile  --pair <n> [--file-a <id>] [--file-b <id>] [--tolerance <d>]
             [--fail-on-findings]
             Run the structural engine (defaults to each profile's latest file)
             with the configured absolute tolerance only — no built-in business
             rules. Persists Run / RunLevelStat / RunFinding (with parent_finding_id
             hierarchy and lineage_json down to source rows) in SQLite. Apply
             business semantics by querying those tables.
  run        --file-a <path> --file-b <path> [--pair <n>] [--profile-a <n>]
             [--profile-b <n>] [--spec-a <json|@file>] [--spec-b <json|@file>]
             [--tolerance <d>] [--fail-on-findings]
             Full pipeline up to and including reconcile. Unknown files/pairs
             exit 0 with a structured "decisions needed" result; recognized
             pairs run end-to-end with zero decisions.
  document   [--schema-out <path>]     Machine-generated DB structure doc.

GLOBAL FLAGS
  --db <path>           SQLite database file. Default: ${DEFAULTS.db}
                        (persistent: the memory must survive runs).
                        Env: TABRECON_DB
  --json                Machine-readable JSON result on stdout.
  --tolerance <d>       Absolute tolerance for reconcile (decimal string).
                        Default: ${DEFAULTS.tolerance}. Env: TABRECON_TOLERANCE
  --schema-out <path>   Schema doc output. Default: ${DEFAULTS.schemaOut}. Env: TABRECON_SCHEMA_OUT
  --m2m-pair-cap <n>    Max raw row pairings per finest-level key.
                        Default: ${DEFAULTS.m2mPairCap}. Env: TABRECON_M2M_PAIR_CAP
  --fail-on-findings    Exit 1 when level-0 findings > 0 (CI gating).

CONFIGURATION RESOLUTION (lowest → highest)
  shell env → ~/.tool-agents/${TOOL_NAME}/.env → ./.env → CLI flags.
  Missing required settings raise ConfigError naming setting, env var, flag.
  No silent fallbacks; the defaults above are the published contract.

EXIT CODES
  0  completed (findings and "decisions needed" are data, not errors)
  1  operational failure (single line "error(<Name>): <message>" on stderr) —
     or findings with --fail-on-findings
  2  usage error

NOTES FOR PROGRAMMATIC / AI-AGENT USE
  - Pass --json for structured results. All amounts are exact decimal strings.
  - Reports are NOT generated by the CLI — query RunFinding (hierarchical via
    parent_finding_id, lineage in lineage_json) and shape whatever report the
    business team needs.
  - Business rules are NOT applied by the engine — exclude rows / convert FX /
    flip signs etc. by querying the Dataset<N> tables and filtering findings
    in the language the agent is most fluent in (SQL).
  - "decisions needed" results list exactly what to decide and the command
    syntax to record each decision; after recording, re-run — recognized
    pairs complete with zero decisions.`;

/* ----------------------------------------------------------- main */

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, sub, flags, multi } = parsed;

  if (parsed.version) {
    console.log(`${TOOL_NAME} ${toolVersion()}`);
    return 0;
  }
  if (command === "" || command === "help" || parsed.help) {
    console.log(GLOBAL_HELP);
    return command === "" && !parsed.help ? 2 : 0;
  }

  const cfg = resolveConfig(flags);
  const db = openDatabase(cfg.db);
  try {
    switch (command) {
      case "ingest": {
        const spec = readSpecFlag(flags, "spec");
        const out = ingestFile(db, {
          filePath: requireFlag(flags, "file", "file"),
          ...(typeof flags["profile"] === "string" ? { profileName: flags["profile"] } : {}),
          ...(spec !== undefined ? { spec } : {}),
        });
        emit(cfg, describeIngest(out), out);
        return 0;
      }
      case "profile": {
        if (sub === "list" || sub === null) {
          const rows = db
            .prepare(
              `SELECT p.id, p.name, p.parse_spec_json IS NOT NULL AS has_spec,
                      (SELECT COUNT(*) FROM LoadedFile lf WHERE lf.profile_id = p.id) AS files
               FROM Profile p ORDER BY p.id`,
            )
            .all();
          emit(cfg, (rows as { id: number; name: string; has_spec: number; files: number }[]).map(
            (r) => `  #${r.id} ${r.name} (${r.files} file(s)${r.has_spec ? ", has parse spec" : ""})`,
          ), rows);
          return 0;
        }
        if (sub === "show") {
          const name = requireFlag(flags, "name", "profile name");
          const p = db.prepare("SELECT * FROM Profile WHERE name = ?").get(name);
          if (!p) throw new NotFoundError("Profile", name);
          const fp = (p as { last_fingerprint_id: number | null }).last_fingerprint_id;
          const fingerprint = fp === null ? null : db.prepare("SELECT * FROM Fingerprint WHERE id = ?").get(fp);
          emit(cfg, [JSON.stringify({ profile: p, fingerprint }, null, 2)], { profile: p, fingerprint });
          return 0;
        }
        // attach
        const fileId = Number.parseInt(requireFlag(flags, "file-id", "file id"), 10);
        const profileName = requireFlag(flags, "profile", "profile name");
        const res = attachFileToProfile(db, fileId, profileName);
        emit(
          cfg,
          [`  attached file #${fileId} to profile "${profileName}"`, ...res.driftWarnings.map((w) => `  drift(SOFT)     ${w}`)],
          res,
        );
        return 0;
      }
      case "pair": {
        if (sub === "list" || sub === null) {
          const rows = db
            .prepare(
              `SELECT rp.id, rp.name, pa.name AS profile_a, pb.name AS profile_b,
                      (SELECT COUNT(*) FROM ColumnMapping cm WHERE cm.recon_pair_id = rp.id) AS mappings
               FROM ReconPair rp JOIN Profile pa ON pa.id = rp.profile_a_id JOIN Profile pb ON pb.id = rp.profile_b_id
               ORDER BY rp.id`,
            )
            .all();
          emit(cfg, (rows as { id: number; name: string; profile_a: string; profile_b: string; mappings: number }[]).map(
            (r) => `  #${r.id} ${r.name}: ${r.profile_a} ↔ ${r.profile_b} (${r.mappings} mapping(s))`,
          ), rows);
          return 0;
        }
        const name = requireFlag(flags, "name", "pair name");
        const pa = requireFlag(flags, "profile-a", "profileA");
        const pb = requireFlag(flags, "profile-b", "profileB");
        const profileId = (n: string): number => {
          const p = db.prepare("SELECT id FROM Profile WHERE name = ?").get(n) as { id: number } | undefined;
          if (!p) throw new NotFoundError("Profile", n);
          return p.id;
        };
        const r = db
          .prepare("INSERT INTO ReconPair (name, profile_a_id, profile_b_id, created_at) VALUES (?, ?, ?, ?)")
          .run(name, profileId(pa), profileId(pb), nowIso());
        emit(cfg, [`  created pair "${name}" (#${Number(r.lastInsertRowid)})`], { id: Number(r.lastInsertRowid), name });
        return 0;
      }
      case "hierarchy": {
        const fileId = Number.parseInt(requireFlag(flags, "file-id", "file id"), 10);
        const fds = loadColumnHierarchy(db, fileId);
        const chains = aggregationChains(fds);
        const payload = { loadedFileId: fileId, aggregationChains: chains, dependencies: fds };
        emit(cfg, describeHierarchy(fds), payload);
        return 0;
      }
      case "suggest": {
        const pairName = requireFlag(flags, "pair", "pair name");
        const pairId = pairIdByName(db, pairName);
        const pairRow = db
          .prepare("SELECT profile_a_id, profile_b_id FROM ReconPair WHERE id = ?")
          .get(pairId) as { profile_a_id: number; profile_b_id: number };
        const fa =
          typeof flags["file-a"] === "string"
            ? fileRefById(db, Number.parseInt(flags["file-a"], 10))
            : latestFileOfProfile(db, pairRow.profile_a_id);
        const fb =
          typeof flags["file-b"] === "string"
            ? fileRefById(db, Number.parseInt(flags["file-b"], 10))
            : latestFileOfProfile(db, pairRow.profile_b_id);
        const res = suggestWithLevels(db, pairId, fa, fb);
        emit(cfg, describeSuggest(res), res);
        return 0;
      }
      case "map": {
        const pairName = requireFlag(flags, "pair", "pair name");
        const pairId = pairIdByName(db, pairName);
        if (flags["clear"] === true) {
          db.prepare("DELETE FROM ColumnMapping WHERE recon_pair_id = ?").run(pairId);
        }
        const ins = db.prepare(
          "INSERT INTO ColumnMapping (recon_pair_id, role, level, col_a, col_b, norm_mode) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const recorded: unknown[] = [];
        for (const role of ["key", "compare", "display"] as const) {
          for (const entry of multi[role] ?? []) {
            const m = parseMappingSyntax(entry, role);
            ins.run(pairId, role, m.level, m.colA, m.colB, m.normMode);
            recorded.push({ role, ...m });
          }
        }
        if (recorded.length === 0 && flags["clear"] !== true) {
          throw new UsageError("map requires at least one --key/--compare/--display entry (or --clear)");
        }
        emit(cfg, [`  recorded ${recorded.length} mapping(s) for pair "${pairName}"${flags["clear"] === true ? " (after clearing)" : ""}`], recorded);
        return 0;
      }
      case "reconcile": {
        const summary = runReconcile(db, {
          pairName: requireFlag(flags, "pair", "pair name"),
          ...(typeof flags["file-a"] === "string" ? { fileAId: Number.parseInt(flags["file-a"], 10) } : {}),
          ...(typeof flags["file-b"] === "string" ? { fileBId: Number.parseInt(flags["file-b"], 10) } : {}),
          toleranceDefault: cfg.tolerance,
          m2mPairCap: cfg.m2mPairCap,
        });
        emit(cfg, describeReconcile(summary), summary);
        return cfg.failOnFindings && summary.totalFindings > 0 ? 1 : 0;
      }
      case "run": {
        const result = doRun(db, cfg, flags);
        const human: string[] = ["Phase: ingest", ...describeIngest(result.ingestA), ...describeIngest(result.ingestB)];
        if (result.status === "decisions_needed") {
          human.push("Phase: decisions needed");
          for (const r of result.reasons ?? []) human.push(`  DECIDE: ${r}`);
          if (result.suggest) human.push(...describeSuggest(result.suggest));
          emit(cfg, human, result);
          return 0;
        }
        human.push("Phase: reconcile", ...describeReconcile(result.reconcile!));
        emit(cfg, human, result);
        return cfg.failOnFindings && result.reconcile!.totalFindings > 0 ? 1 : 0;
      }
      case "document": {
        const doc = renderSchemaDoc(db);
        const out = writeOut(cfg.schemaOut, doc);
        emit(cfg, [`  schema documentation → ${out}`], { schemaFile: out });
        return 0;
      }
      default:
        console.error(GLOBAL_HELP);
        throw new UsageError(`Unknown command "${command}"`);
    }
  } finally {
    db.close();
  }
}

function fileRefById(db: DatabaseSync, id: number): { id: number; table: string } {
  const f = db
    .prepare("SELECT id, dataset_table FROM LoadedFile WHERE id = ?")
    .get(id) as { id: number; dataset_table: string } | undefined;
  if (!f) throw new NotFoundError("LoadedFile", String(id));
  return { id: f.id, table: f.dataset_table };
}

try {
  process.exitCode = main();
} catch (e) {
  const err = e as Error;
  console.error(`error(${err.name ?? "Error"}): ${err.message}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
