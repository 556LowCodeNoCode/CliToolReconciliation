import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openDatabase, nowIso } from "../tools/tabrecon/src/db.ts";
import { ingestFile } from "../tools/tabrecon/src/ingest/ingest.ts";
import { encodeCp1253 } from "../tools/tabrecon/src/ingest/cp1253.ts";
import { classifyDrift } from "../tools/tabrecon/src/drift.ts";
import type { FingerprintData } from "../tools/tabrecon/src/fingerprint.ts";

const req = createRequire(new URL("../tools/tabrecon/package.json", import.meta.url));
const { zipSync, strToU8 } = req("fflate") as typeof import("fflate");

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tabrecon-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function csvFile(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function xlsxFile(name: string, rows: string[][]): string {
  const cell = (r: number, c: number, v: string) => {
    const col = String.fromCharCode(65 + c);
    return `<c r="${col}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`;
  };
  const sheet =
    `<?xml version="1.0"?><worksheet><sheetData>` +
    rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(r, c, v)).join("")}</row>`).join("") +
    `</sheetData></worksheet>`;
  const zip = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) });
  const p = join(dir, name);
  writeFileSync(p, zip);
  return p;
}

test("AC1: delimited UTF-8 CSV ingests with type inference; dedup is a no-op", () => {
  const db = openDatabase(join(dir, "ac1a.db"));
  const f = csvFile("sales.csv", "Account,Code,Amount,When\n2001,031,1234.50,2025-04-30\n2002,12,-7.25,2025-04-30\n");
  const out = ingestFile(db, { filePath: f });
  assert.equal(out.status, "loaded");
  assert.equal(out.rowCount, 2);
  assert.equal(out.encoding, "utf-8");
  const types = Object.fromEntries(out.columns.map((c) => [c.name, c.type]));
  assert.equal(types["Account"], "integer");
  assert.equal(types["Code"], "text"); // leading zero ⇒ code, not number
  assert.equal(types["Amount"], "decimal");
  assert.equal(types["When"], "date");
  // canonical storage
  const row = db.prepare(`SELECT * FROM "${out.datasetTable}" WHERE src_row = 2`).get() as Record<string, string>;
  assert.equal(row["amount"], "-7.25");
  assert.equal(row["when"], "2025-04-30");
  // dedup under a different name
  const f2 = csvFile("sales-renamed.csv", "Account,Code,Amount,When\n2001,031,1234.50,2025-04-30\n2002,12,-7.25,2025-04-30\n");
  const out2 = ingestFile(db, { filePath: f2 });
  assert.equal(out2.status, "already_loaded");
  db.close();
});

test("AC1: CP1253 Greek fixed-width report ingests via parse spec; greek numbers exact", () => {
  const db = openDatabase(join(dir, "ac1b.db"));
  const report =
    "ΙΣΟΖΥΓΙΟ ΛΟΓΑΡΙΑΣΜΩΝ ΣΕΛΙΔΑ 1\n" +
    "--------------------------\n" +
    "2001      1.234.567,89-\n" +
    "2002         10.000,50 \n";
  const p = join(dir, "ΙΣΟΖΥΓΙΟ.txt");
  writeFileSync(p, encodeCp1253(report));
  const out = ingestFile(db, {
    filePath: p,
    spec: {
      type: "fixed",
      skipLineRegexes: ["ΣΕΛΙΔΑ", "^-+$"],
      columns: [
        { name: "Λογαριασμός", start: 0, end: 10 },
        { name: "Υπόλοιπο", start: 10, end: 24, type: "decimal", numberFormat: "greek" },
      ],
    },
  });
  assert.equal(out.encoding, "cp1253");
  assert.equal(out.format, "fixed");
  assert.equal(out.rowCount, 2);
  const rows = db.prepare(`SELECT * FROM "${out.datasetTable}" ORDER BY src_row`).all() as Record<string, string>[];
  assert.equal(rows[0]![out.columns[1]!.sqlName], "-1234567.89");
  assert.equal(rows[1]![out.columns[1]!.sqlName], "10000.5");
  // the spec is remembered on the new profile
  const spec = db.prepare("SELECT parse_spec_json FROM Profile WHERE id = ?").get(out.profileId) as {
    parse_spec_json: string | null;
  };
  assert.ok(spec.parse_spec_json !== null);
  db.close();
});

test("AC1: xlsx ingests through the minimal OOXML reader", () => {
  const db = openDatabase(join(dir, "ac1c.db"));
  const f = xlsxFile("extract.xlsx", [
    ["Product", "Total"],
    ["P1", "100.50"],
    ["P2", "200"],
  ]);
  const out = ingestFile(db, { filePath: f });
  assert.equal(out.format, "xlsx");
  assert.equal(out.rowCount, 2);
  assert.equal(out.columns[1]!.type, "decimal");
  db.close();
});

test("AC2: renamed same-schema file auto-attaches; different file gets a new profile; near-miss suggests", () => {
  const db = openDatabase(join(dir, "ac2.db"));
  const mkCsv = (name: string, rows: string[]) =>
    csvFile(name, "Account,Product,Amount\n" + rows.join("\n") + "\n");
  const base = mkCsv("april.csv", ["2001,P1,100.50", "2002,P2,200.00", "2003,P3,300.00"]);
  const first = ingestFile(db, { filePath: base });
  assert.equal(first.routing, "created_new_profile");

  // same schema, mostly same values, different content & name → auto-attach
  const may = mkCsv("may-export-totally-different-name.csv", ["2001,P1,100.50", "2002,P2,205.00", "2003,P3,300.00"]);
  const second = ingestFile(db, { filePath: may });
  assert.equal(second.routing, "attached_existing");
  assert.equal(second.profileName, first.profileName);
  assert.ok(second.score !== null && second.score >= 0.95);

  // structurally different file → new profile
  const other = csvFile("other.csv", "Customer,City,Phone\nX,Athens,210\nY,Patra,261\n");
  const third = ingestFile(db, { filePath: other });
  assert.equal(third.routing, "created_new_profile");

  // partial overlap → suggest band (0.70–0.95), file stays unattached
  const partial = csvFile("partial.csv", "Account,Product,Quantity\n2001,P1,5\n2002,P2,6\n2003,P3,7\n");
  const fourth = ingestFile(db, { filePath: partial });
  assert.equal(fourth.routing, "unattached_suggest");
  assert.equal(fourth.profileId, null);
  assert.ok(fourth.suggestions.some((s) => s.profileName === first.profileName));
  db.close();
});

test("AC3: HARD drift aborts ingestion (nothing committed); SOFT drift warns", () => {
  const db = openDatabase(join(dir, "ac3.db"));
  const f1 = csvFile("d1.csv", "Account,Amount\n2001,10.00\n2002,20.00\n");
  const out1 = ingestFile(db, { filePath: f1, profileName: "ledger" });
  assert.equal(out1.profileName, "ledger");

  // make "amount" a mapped column via a pair mapping
  db.prepare("INSERT INTO Profile (name, created_at) VALUES ('other', ?)").run(nowIso());
  const pid = (db.prepare("SELECT id FROM Profile WHERE name = 'ledger'").get() as { id: number }).id;
  const oid = (db.prepare("SELECT id FROM Profile WHERE name = 'other'").get() as { id: number }).id;
  db.prepare("INSERT INTO ReconPair (name, profile_a_id, profile_b_id, created_at) VALUES ('p', ?, ?, ?)").run(pid, oid, nowIso());
  const rpId = (db.prepare("SELECT id FROM ReconPair WHERE name = 'p'").get() as { id: number }).id;
  db.prepare("INSERT INTO ColumnMapping (recon_pair_id, role, level, col_a, col_b) VALUES (?, 'compare', 0, 'amount', 'x')").run(rpId);

  // HARD: mapped column gone
  const beforeFiles = (db.prepare("SELECT COUNT(*) n FROM LoadedFile").get() as { n: number }).n;
  const f2 = csvFile("d2.csv", "Account,Total\n2001,10.00\n2002,20.00\n");
  assert.throws(() => ingestFile(db, { filePath: f2, profileName: "ledger" }), /DriftError|Hard schema drift/);
  const afterFiles = (db.prepare("SELECT COUNT(*) n FROM LoadedFile").get() as { n: number }).n;
  assert.equal(afterFiles, beforeFiles); // transaction rolled back / never started

  // SOFT: added column → warns, ingests
  const f3 = csvFile("d3.csv", "Account,Amount,Extra\n2001,10.00,x\n2002,21.00,y\n");
  const out3 = ingestFile(db, { filePath: f3, profileName: "ledger" });
  assert.equal(out3.status, "loaded");
  assert.ok(out3.driftWarnings.some((w) => w.startsWith("COLUMN_ADDED")));
  db.close();
});

test("drift classification: taxonomy unit checks", () => {
  const fp = (types: Record<string, string>, encoding = "utf-8"): FingerprintData => ({
    encoding,
    columnSetHash: "h",
    columnTypes: types,
    typeBag: {},
    nullRate: {},
    cardinalityBand: {},
    rowCountBand: 5,
    valueSketch: null,
  });
  const mapped = new Set(["amount"]);
  const hardMissing = classifyDrift(fp({ amount: "decimal", account: "text" }), fp({ account: "text" }), mapped);
  assert.deepEqual(hardMissing.hard, ["MAPPED_COLUMN_MISSING(amount)"]);
  const narrowed = classifyDrift(fp({ amount: "decimal" }), fp({ amount: "integer" }), mapped);
  assert.ok(narrowed.hard[0]!.startsWith("TYPE_NARROWED"));
  const widened = classifyDrift(fp({ amount: "integer" }), fp({ amount: "decimal" }), mapped);
  assert.equal(widened.hard.length, 0);
  assert.ok(widened.soft[0]!.startsWith("TYPE_WIDENED"));
  const enc = classifyDrift(fp({ a: "text" }), { ...fp({ a: "text" }), encoding: "cp1253" }, new Set());
  assert.ok(enc.hard[0]!.startsWith("ENCODING_CHANGED"));
});

test("memory: a returning fixed-width file is recognized via the stored parse spec", () => {
  const db = openDatabase(join(dir, "spec-memory.db"));
  const mkReport = (rows: string[]) =>
    "ΙΣΟΖΥΓΙΟ ΛΟΓΑΡΙΑΣΜΩΝ ΣΕΛΙΔΑ 1\n" + rows.join("\n") + "\n";
  const spec = {
    type: "fixed",
    skipLineRegexes: ["ΣΕΛΙΔΑ"],
    columns: [
      { name: "Λογαριασμός", start: 0, end: 10 },
      { name: "Υπόλοιπο", start: 10, end: 24, type: "decimal", numberFormat: "greek" },
    ],
  };
  const p1 = join(dir, "ΙΣΟΖΥΓΙΟ-april.txt");
  writeFileSync(p1, encodeCp1253(mkReport(["2001      1.000,00 ", "2002      2.000,00 "])));
  const first = ingestFile(db, { filePath: p1, spec });
  assert.equal(first.specSource, "flag");

  // next month: same layout, no spec passed — auto-parse fails, stored spec recognizes it
  const p2 = join(dir, "ΙΣΟΖΥΓΙΟ-may.txt");
  writeFileSync(p2, encodeCp1253(mkReport(["2001      1.100,00 ", "2002      2.000,00 "])));
  const second = ingestFile(db, { filePath: p2 });
  assert.equal(second.specSource, "profile_memory");
  assert.equal(second.routing, "attached_existing");
  assert.equal(second.profileName, first.profileName);
  db.close();
});

test("xlsx real-world lexicals: duplicate headers auto-dedupe; float artifacts and scientific notation normalize", () => {
  const db = openDatabase(join(dir, "xlsx-real.db"));
  const f = xlsxFile("fpsl-like.xlsx", [
    ["G/L Account", "G/L Account", "Closing Balance"],
    ["1712030022", "ΟΜΟΛΟΓΑ", "100947574.40000001"],
    ["1712030023", "ΔΑΝΕΙΑ", "7.0000000000000007E-2"],
    ["1712030024", "ΛΟΙΠΑ", "-2.5E+3"],
  ]);
  // Duplicate xlsx headers are auto-renamed: the second "G/L Account" becomes "G/L Account (2)".
  const out = ingestFile(db, { filePath: f });
  assert.equal(out.rowCount, 3);
  assert.equal(out.columns[0]!.name, "G/L Account");
  assert.equal(out.columns[1]!.name, "G/L Account (2)");
  assert.equal(out.columns[2]!.type, "decimal");
  const rows = db.prepare(`SELECT * FROM "${out.datasetTable}" ORDER BY src_row`).all() as Record<string, string>[];
  const col = out.columns[2]!.sqlName;
  assert.equal(rows[0]![col], "100947574.4"); // artifact rounded at 6th decimal
  assert.equal(rows[1]![col], "0.07"); // scientific notation expanded exactly
  assert.equal(rows[2]![col], "-2500"); // negative scientific, positive exponent
  // Truly empty headers still surface as a hard error (sentinel — auto-dedup must not mask that).
  assert.throws(
    () =>
      ingestFile(db, {
        filePath: xlsxFile("empty-header.xlsx", [["A", "", "C"], ["1", "x", "2"]]),
      }),
    /HeaderDetectionError|empty/,
  );
  db.close();
});

test("memory: a returning xlsx file is recognized after the first ingest (auto-dedupe path, no spec)", () => {
  const db = openDatabase(join(dir, "xlsx-spec-memory.db"));
  const april = xlsxFile("x-april.xlsx", [
    ["G/L Account", "G/L Account", "Closing Balance"],
    ["1001", "ΟΜΟΛΟΓΑ", "100.00"],
    ["1002", "ΔΑΝΕΙΑ", "200.00"],
  ]);
  const first = ingestFile(db, { filePath: april });
  assert.equal(first.specSource, null); // no spec needed — auto-deduped
  assert.equal(first.routing, "created_new_profile");
  const may = xlsxFile("x-may.xlsx", [
    ["G/L Account", "G/L Account", "Closing Balance"],
    ["1001", "ΟΜΟΛΟΓΑ", "110.00"],
    ["1002", "ΔΑΝΕΙΑ", "200.00"],
  ]);
  const second = ingestFile(db, { filePath: may });
  assert.equal(second.routing, "attached_existing");
  assert.equal(second.profileName, first.profileName);
  db.close();
});
