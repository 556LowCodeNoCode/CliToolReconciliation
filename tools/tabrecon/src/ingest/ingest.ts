/**
 * Ingestion orchestrator: read → dedup → parse → infer → persist → fingerprint
 * → profile routing (auto-attach / suggest / new profile) → drift gate.
 * The whole ingest is one transaction: a failure (including HARD drift)
 * commits nothing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hmacSalt, inTransaction, normColumnName, nowIso, toSqlName } from "../db.ts";
import { DriftError, UnrecognizedFormatError } from "../errors.ts";
import {
  AUTO_ATTACH_THRESHOLD,
  SUGGEST_THRESHOLD,
  computeFingerprint,
  fingerprintFromRow,
  fingerprintToJsonFields,
  similarity,
  type ColumnStats,
  type FingerprintData,
} from "../fingerprint.ts";
import { classifyDrift } from "../drift.ts";
import { detectColumnHierarchy, persistColumnHierarchy, type FunctionalDependency } from "../hierarchy.ts";
import { assertHeaderRow, detectEncodingAndDecode, sniffDelimiter } from "./detect.ts";
import { parseDelimited } from "./delimited.ts";
import { inferColumn, type ColumnType } from "./infer.ts";
import {
  applyXlsxSpec,
  parseFixedWidth,
  validateParseSpec,
  type DelimitedParseSpec,
  type FixedParseSpec,
  type ParseSpec,
  type XlsxParseSpec,
} from "./spec.ts";
import { ParseSpecError } from "../errors.ts";
import { readFirstSheet } from "./xlsx.ts";
import type { NumberFormat } from "../decimal.ts";

export type SourceFormat = "delimited" | "xlsx" | "fixed";

export interface IngestOptions {
  filePath: string;
  /** Explicit target profile name (created if absent). */
  profileName?: string;
  /** Explicit parse spec (already-parsed JSON value). */
  spec?: unknown;
}

export interface ProfileSuggestion {
  profileId: number;
  profileName: string;
  score: number;
}

export interface IngestedColumnInfo {
  name: string;
  sqlName: string;
  type: ColumnType;
  numberFormat: NumberFormat | null;
  nullCount: number;
  distinctCount: number;
}

export interface IngestOutcome {
  status: "loaded" | "already_loaded";
  loadedFileId: number;
  fileName: string;
  sha256: string;
  format: SourceFormat;
  encoding: string;
  rowCount: number;
  datasetTable: string;
  columns: IngestedColumnInfo[];
  routing:
    | "attached_existing"
    | "attached_explicit"
    | "created_new_profile"
    | "unattached_suggest"
    | "already_loaded";
  profileId: number | null;
  profileName: string | null;
  score: number | null;
  suggestions: ProfileSuggestion[];
  driftWarnings: string[];
  specSource: "flag" | "profile_memory" | null;
  hierarchy: FunctionalDependency[];
}

interface ProfileRow {
  id: number;
  name: string;
  parse_spec_json: string | null;
  last_fingerprint_id: number | null;
}

interface ParsedMatrix {
  format: SourceFormat;
  encoding: string;
  header: string[];
  data: string[][];
  forced: Map<number, { type?: ColumnType; numberFormat?: NumberFormat }>;
}

function parseWithSpec(
  fileName: string,
  text: string,
  spec: FixedParseSpec | DelimitedParseSpec,
): ParsedMatrix {
  if (spec.type === "fixed") {
    const matrix = parseFixedWidth(text, spec);
    const forced = new Map<number, { type?: ColumnType; numberFormat?: NumberFormat }>();
    spec.columns.forEach((c, i) => {
      if (c.type || c.numberFormat) {
        forced.set(i, {
          ...(c.type ? { type: c.type } : {}),
          ...(c.numberFormat ? { numberFormat: c.numberFormat } : {}),
        });
      }
    });
    return { format: "fixed", encoding: "", header: matrix[0]!, data: matrix.slice(1), forced };
  }
  const lines = text.split(/\r?\n/).slice(spec.skipLeadingLines ?? 0).join("\n");
  const matrix = parseDelimited(fileName, lines, spec.delimiter);
  if (spec.hasHeader) {
    assertHeaderRow(fileName, matrix[0] ?? []);
    return { format: "delimited", encoding: "", header: matrix[0]!, data: matrix.slice(1), forced: new Map() };
  }
  return { format: "delimited", encoding: "", header: [...spec.columns!], data: matrix, forced: new Map() };
}

function autoParse(fileName: string, text: string): ParsedMatrix {
  const delimiter = sniffDelimiter(fileName, text);
  const matrix = parseDelimited(fileName, text, delimiter);
  if (matrix.length === 0) throw new UnrecognizedFormatError(fileName, "no rows parsed");
  assertHeaderRow(fileName, matrix[0]!);
  return { format: "delimited", encoding: "", header: matrix[0]!, data: matrix.slice(1), forced: new Map() };
}

function loadProfiles(db: DatabaseSync): ProfileRow[] {
  return db
    .prepare("SELECT id, name, parse_spec_json, last_fingerprint_id FROM Profile ORDER BY id")
    .all() as unknown as ProfileRow[];
}

export function loadFingerprint(db: DatabaseSync, id: number): FingerprintData {
  const row = db.prepare("SELECT * FROM Fingerprint WHERE id = ?").get(id) as never;
  return fingerprintFromRow(row);
}

/** Columns of `profile` referenced by any pair mapping (side-aware), as name_norm. */
export function mappedColumnsOfProfile(db: DatabaseSync, profileId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT cm.col_a AS col FROM ColumnMapping cm
         JOIN ReconPair rp ON rp.id = cm.recon_pair_id WHERE rp.profile_a_id = ?
       UNION
       SELECT cm.col_b AS col FROM ColumnMapping cm
         JOIN ReconPair rp ON rp.id = cm.recon_pair_id WHERE rp.profile_b_id = ?`,
    )
    .all(profileId, profileId) as unknown as { col: string }[];
  return new Set(rows.map((r) => r.col));
}

function uniqueProfileName(db: DatabaseSync, base: string): string {
  let name = base;
  let n = 2;
  while (db.prepare("SELECT 1 FROM Profile WHERE name = ?").get(name)) name = `${base} (${n++})`;
  return name;
}

export function ingestFile(db: DatabaseSync, opts: IngestOptions): IngestOutcome {
  const abs = resolve(opts.filePath);
  const fileName = basename(abs);
  const content = readFileSync(abs);
  const sha256 = createHash("sha256").update(content).digest("hex");

  const existing = db
    .prepare(
      "SELECT id, row_count, dataset_table, profile_id, encoding, format FROM LoadedFile WHERE sha256 = ?",
    )
    .get(sha256) as
    | { id: number; row_count: number; dataset_table: string; profile_id: number | null; encoding: string; format: SourceFormat }
    | undefined;
  if (existing) {
    const pname = existing.profile_id
      ? (db.prepare("SELECT name FROM Profile WHERE id = ?").get(existing.profile_id) as { name: string }).name
      : null;
    const existingFds = db
      .prepare(
        `SELECT parent_name AS parent, child_name AS child, parent_distinct AS parentDistinct,
                child_distinct AS childDistinct, consistency, kind
         FROM ColumnHierarchy WHERE loaded_file_id = ? ORDER BY id`,
      )
      .all(existing.id) as unknown as FunctionalDependency[];
    return {
      status: "already_loaded",
      loadedFileId: existing.id,
      fileName,
      sha256,
      format: existing.format,
      encoding: existing.encoding,
      rowCount: existing.row_count,
      datasetTable: existing.dataset_table,
      columns: [],
      routing: "already_loaded",
      profileId: existing.profile_id,
      profileName: pname,
      score: null,
      suggestions: [],
      hierarchy: existingFds,
      driftWarnings: [],
      specSource: null,
    };
  }

  const salt = hmacSalt(db);
  const profiles = loadProfiles(db);

  // ---- parse ---------------------------------------------------------------
  let parsed!: ParsedMatrix;
  let specSource: IngestOutcome["specSource"] = null;
  let specUsed: ParseSpec | null = null;
  let specMatchedProfile: ProfileRow | null = null;

  const adoptMatch = (
    matches: { profile: ProfileRow; parsed: ParsedMatrix; spec: ParseSpec }[],
    autoErr: unknown,
  ): void => {
    if (matches.length === 1) {
      const m = matches[0]!;
      parsed = m.parsed;
      specUsed = m.spec;
      specSource = "profile_memory";
      specMatchedProfile = m.profile;
    } else if (matches.length > 1) {
      throw new UnrecognizedFormatError(
        fileName,
        `auto-parse failed (${(autoErr as Error).message}) and ${matches.length} stored parse specs match equally — disambiguate with --profile`,
      );
    } else {
      throw autoErr;
    }
  };

  // Memory in action: try every stored parse spec; adopt the unique one whose
  // result is near-certainly (≥ AUTO threshold) the same profile.
  const matchStoredSpecs = (
    tryParse: (spec: ParseSpec) => ParsedMatrix | null,
  ): { profile: ProfileRow; parsed: ParsedMatrix; spec: ParseSpec }[] => {
    const matches: { profile: ProfileRow; parsed: ParsedMatrix; spec: ParseSpec }[] = [];
    for (const p of profiles) {
      if (p.parse_spec_json === null || p.last_fingerprint_id === null) continue;
      let spec: ParseSpec;
      try {
        spec = validateParseSpec(JSON.parse(p.parse_spec_json));
      } catch {
        continue;
      }
      const candidate = tryParse(spec);
      if (candidate === null) continue;
      const fp = fingerprintCandidate(candidate, candidate.encoding, salt);
      if (fp === null) continue;
      const score = similarity(fp, loadFingerprint(db, p.last_fingerprint_id)).score;
      if (score >= AUTO_ATTACH_THRESHOLD) matches.push({ profile: p, parsed: candidate, spec });
    }
    return matches;
  };

  if (extname(fileName).toLowerCase() === ".xlsx") {
    const matrix = readFirstSheet(fileName, content);
    if (matrix.length === 0) throw new UnrecognizedFormatError(fileName, "empty workbook");
    const fromXlsxSpec = (spec: XlsxParseSpec): ParsedMatrix => {
      const { header, data } = applyXlsxSpec(fileName, matrix, spec);
      assertHeaderRow(fileName, header);
      return { format: "xlsx", encoding: "n/a", header, data, forced: new Map() };
    };
    if (opts.spec !== undefined) {
      specUsed = validateParseSpec(opts.spec);
      if (specUsed.type !== "xlsx") {
        throw new ParseSpecError(`an .xlsx file needs a spec of type "xlsx", got "${specUsed.type}"`);
      }
      parsed = fromXlsxSpec(specUsed);
      specSource = "flag";
    } else {
      try {
        assertHeaderRow(fileName, matrix[0]!);
        parsed = { format: "xlsx", encoding: "n/a", header: matrix[0]!, data: matrix.slice(1), forced: new Map() };
      } catch (autoErr) {
        adoptMatch(
          matchStoredSpecs((spec) => {
            if (spec.type !== "xlsx") return null;
            try {
              return fromXlsxSpec(spec);
            } catch {
              return null;
            }
          }),
          autoErr,
        );
      }
    }
  } else {
    const { encoding, text } = detectEncodingAndDecode(fileName, content);
    if (opts.spec !== undefined) {
      specUsed = validateParseSpec(opts.spec);
      if (specUsed.type === "xlsx") {
        throw new ParseSpecError('spec type "xlsx" applies to .xlsx files only');
      }
      parsed = parseWithSpec(fileName, text, specUsed);
      specSource = "flag";
    } else {
      try {
        parsed = autoParse(fileName, text);
      } catch (autoErr) {
        adoptMatch(
          matchStoredSpecs((spec) => {
            if (spec.type === "xlsx") return null;
            try {
              const candidate = parseWithSpec(fileName, text, spec);
              candidate.encoding = encoding;
              return candidate;
            } catch {
              return null;
            }
          }),
          autoErr,
        );
      }
    }
    parsed!.encoding = encoding;
  }

  // ---- infer ---------------------------------------------------------------
  const encodingHint: "greek" | "standard" = parsed.encoding === "cp1253" ? "greek" : "standard";
  const taken = new Set<string>(["src_row"]);
  const columnInfos: IngestedColumnInfo[] = [];
  const columnStats: ColumnStats[] = [];
  const canonical: (string | null)[][] = [];
  for (let c = 0; c < parsed.header.length; c++) {
    const rawName = parsed.header[c]!;
    const colValues = parsed.data.map((r) => r[c] ?? "");
    const forced = parsed.forced.get(c);
    const inf = inferColumn(colValues, encodingHint, forced?.type, forced?.numberFormat, parsed.format === "xlsx");
    const sqlName = toSqlName(rawName, taken);
    columnInfos.push({
      name: rawName,
      sqlName,
      type: inf.type,
      numberFormat: inf.numberFormat,
      nullCount: inf.nullCount,
      distinctCount: inf.distinctCount,
    });
    columnStats.push({
      nameNorm: normColumnName(rawName),
      type: inf.type,
      nullCount: inf.nullCount,
      distinctCount: inf.distinctCount,
      topValues: inf.topValues,
    });
    canonical.push(inf.values);
  }
  const rowCount = parsed.data.length;
  const fp = computeFingerprint(parsed.encoding, columnStats, rowCount, salt);

  // ---- route ---------------------------------------------------------------
  let routing: IngestOutcome["routing"];
  let targetProfile: ProfileRow | null = null;
  let newProfileName: string | null = null;
  let score: number | null = null;
  const suggestions: ProfileSuggestion[] = [];

  if (opts.profileName !== undefined) {
    routing = "attached_explicit";
    targetProfile = profiles.find((p) => p.name === opts.profileName) ?? null;
    if (targetProfile === null) newProfileName = opts.profileName;
  } else if (specMatchedProfile !== null) {
    routing = "attached_existing";
    targetProfile = specMatchedProfile;
    score = AUTO_ATTACH_THRESHOLD;
  } else {
    const scored = profiles
      .filter((p) => p.last_fingerprint_id !== null)
      .map((p) => ({ p, s: similarity(fp, loadFingerprint(db, p.last_fingerprint_id!)).score }))
      .sort((x, y) => y.s - x.s);
    const best = scored[0];
    if (best && best.s >= AUTO_ATTACH_THRESHOLD) {
      routing = "attached_existing";
      targetProfile = best.p;
      score = best.s;
    } else if (best && best.s >= SUGGEST_THRESHOLD) {
      routing = "unattached_suggest";
      score = best.s;
      for (const { p, s } of scored.slice(0, 5)) {
        if (s >= SUGGEST_THRESHOLD) {
          suggestions.push({ profileId: p.id, profileName: p.name, score: Math.round(s * 1000) / 1000 });
        }
      }
    } else {
      routing = "created_new_profile";
      newProfileName = uniqueProfileName(db, fileName.replace(/\.[^.]+$/, "").trim() || fileName);
    }
  }

  // ---- drift gate ----------------------------------------------------------
  const driftWarnings: string[] = [];
  if (targetProfile !== null && targetProfile.last_fingerprint_id !== null) {
    const prev = loadFingerprint(db, targetProfile.last_fingerprint_id);
    const report = classifyDrift(prev, fp, mappedColumnsOfProfile(db, targetProfile.id));
    if (report.hard.length > 0) throw new DriftError(targetProfile.name, report.hard);
    driftWarnings.push(...report.soft);
  }

  // ---- persist (single transaction) ----------------------------------------
  const result = inTransaction(db, () => {
    const reg = db
      .prepare(
        `INSERT INTO LoadedFile
           (file_name, absolute_path, size_bytes, sha256, format, encoding, loaded_at, row_count, dataset_table)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
      )
      .run(fileName, abs, content.length, sha256, parsed.format, parsed.encoding, nowIso());
    const fileId = Number(reg.lastInsertRowid);
    const datasetTable = `Dataset${fileId}`;

    const colDefs = columnInfos.map((c) => `"${c.sqlName}" TEXT`).join(", ");
    db.exec(`CREATE TABLE "${datasetTable}" (src_row INTEGER NOT NULL, ${colDefs})`);
    const placeholders = ["?", ...columnInfos.map(() => "?")].join(", ");
    const ins = db.prepare(`INSERT INTO "${datasetTable}" VALUES (${placeholders})`);
    for (let r = 0; r < rowCount; r++) {
      ins.run(r + 1, ...columnInfos.map((_, c) => canonical[c]![r] ?? null));
    }

    const colIns = db.prepare(
      `INSERT INTO DatasetColumn
         (loaded_file_id, position, name_raw, name_norm, sql_name, inferred_type, number_format, null_count, distinct_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    columnInfos.forEach((c, i) => {
      colIns.run(fileId, i, c.name, normColumnName(c.name), c.sqlName, c.type, c.numberFormat, c.nullCount, c.distinctCount);
    });

    let profileId: number | null = null;
    let profileName: string | null = null;
    if (newProfileName !== null) {
      const pr = db
        .prepare("INSERT INTO Profile (name, parse_spec_json, created_at) VALUES (?, ?, ?)")
        .run(newProfileName, specUsed ? JSON.stringify(specUsed) : null, nowIso());
      profileId = Number(pr.lastInsertRowid);
      profileName = newProfileName;
    } else if (targetProfile !== null) {
      profileId = targetProfile.id;
      profileName = targetProfile.name;
      if (specUsed !== null && targetProfile.parse_spec_json === null) {
        db.prepare("UPDATE Profile SET parse_spec_json = ? WHERE id = ?").run(
          JSON.stringify(specUsed),
          targetProfile.id,
        );
      }
    }

    const f = fingerprintToJsonFields(fp);
    const fpr = db
      .prepare(
        `INSERT INTO Fingerprint
           (loaded_file_id, profile_id, encoding, column_set_hash, column_names_json, type_bag_json,
            null_rate_json, cardinality_band_json, row_count_band, value_sketch_json, drift_warnings_json, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        profileId,
        f.encoding,
        f.column_set_hash,
        f.column_names_json,
        f.type_bag_json,
        f.null_rate_json,
        f.cardinality_band_json,
        f.row_count_band,
        f.value_sketch_json,
        driftWarnings.length > 0 ? JSON.stringify(driftWarnings) : null,
        nowIso(),
      );
    const fingerprintId = Number(fpr.lastInsertRowid);

    db.prepare(
      "UPDATE LoadedFile SET row_count = ?, dataset_table = ?, profile_id = ?, fingerprint_id = ? WHERE id = ?",
    ).run(rowCount, datasetTable, profileId, fingerprintId, fileId);
    if (profileId !== null) {
      db.prepare("UPDATE Profile SET last_fingerprint_id = ? WHERE id = ?").run(fingerprintId, profileId);
    }
    // Hierarchy detection runs inside the same transaction so a parse error
    // never leaves a half-described dataset behind.
    const fds = detectColumnHierarchy(db, fileId, datasetTable);
    persistColumnHierarchy(db, fileId, fds);
    return { fileId, datasetTable, profileId, profileName, fds };
  });

  return {
    status: "loaded",
    loadedFileId: result.fileId,
    fileName,
    sha256,
    format: parsed.format,
    encoding: parsed.encoding,
    rowCount,
    datasetTable: result.datasetTable,
    columns: columnInfos,
    routing,
    profileId: result.profileId,
    profileName: result.profileName,
    score: score === null ? null : Math.round(score * 1000) / 1000,
    suggestions,
    driftWarnings,
    specSource,
    hierarchy: result.fds,
  };
}

function fingerprintCandidate(
  parsed: ParsedMatrix,
  encoding: string,
  salt: string,
): FingerprintData | null {
  try {
    const stats: ColumnStats[] = [];
    for (let c = 0; c < parsed.header.length; c++) {
      const forced = parsed.forced.get(c);
      const inf = inferColumn(
        parsed.data.map((r) => r[c] ?? ""),
        encoding === "cp1253" ? "greek" : "standard",
        forced?.type,
        forced?.numberFormat,
        parsed.format === "xlsx",
      );
      stats.push({
        nameNorm: normColumnName(parsed.header[c]!),
        type: inf.type,
        nullCount: inf.nullCount,
        distinctCount: inf.distinctCount,
        topValues: inf.topValues,
      });
    }
    return computeFingerprint(encoding, stats, parsed.data.length, salt);
  } catch {
    return null;
  }
}

/** Attach an unattached loaded file to a profile (post-suggest decision). */
export function attachFileToProfile(
  db: DatabaseSync,
  loadedFileId: number,
  profileName: string,
): { profileId: number; driftWarnings: string[] } {
  const file = db
    .prepare("SELECT id, profile_id, fingerprint_id FROM LoadedFile WHERE id = ?")
    .get(loadedFileId) as { id: number; profile_id: number | null; fingerprint_id: number | null } | undefined;
  if (!file) throw new UnrecognizedFormatError(String(loadedFileId), "no LoadedFile with this id");
  const profile = db
    .prepare("SELECT id, name, last_fingerprint_id FROM Profile WHERE name = ?")
    .get(profileName) as { id: number; name: string; last_fingerprint_id: number | null } | undefined;
  if (!profile) {
    const pr = db
      .prepare("INSERT INTO Profile (name, created_at) VALUES (?, ?)")
      .run(profileName, nowIso());
    const pid = Number(pr.lastInsertRowid);
    db.prepare("UPDATE LoadedFile SET profile_id = ? WHERE id = ?").run(pid, loadedFileId);
    db.prepare("UPDATE Fingerprint SET profile_id = ? WHERE id = ?").run(pid, file.fingerprint_id);
    db.prepare("UPDATE Profile SET last_fingerprint_id = ? WHERE id = ?").run(file.fingerprint_id, pid);
    return { profileId: pid, driftWarnings: [] };
  }
  const cur = loadFingerprint(db, file.fingerprint_id!);
  const driftWarnings: string[] = [];
  if (profile.last_fingerprint_id !== null) {
    const report = classifyDrift(
      loadFingerprint(db, profile.last_fingerprint_id),
      cur,
      mappedColumnsOfProfile(db, profile.id),
    );
    if (report.hard.length > 0) throw new DriftError(profile.name, report.hard);
    driftWarnings.push(...report.soft);
  }
  return inTransaction(db, () => {
    db.prepare("UPDATE LoadedFile SET profile_id = ? WHERE id = ?").run(profile.id, loadedFileId);
    db.prepare("UPDATE Fingerprint SET profile_id = ? WHERE id = ?").run(profile.id, file.fingerprint_id);
    db.prepare("UPDATE Profile SET last_fingerprint_id = ? WHERE id = ?").run(file.fingerprint_id, profile.id);
    return { profileId: profile.id, driftWarnings };
  });
}
