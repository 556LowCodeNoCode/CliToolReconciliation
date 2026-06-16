import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../tools/tabrecon/src/cli.ts", import.meta.url));

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tabrecon-e2e-"));
  writeFileSync(
    join(dir, "april-a.csv"),
    "Account,Product,Amount\n2001,P1,100.50\n2001,P2,200.00\n2002,P1,50.00\n2003,P9,75.25\n",
  );
  writeFileSync(
    join(dir, "april-b.csv"),
    "GL Account,Product Code,Sum Amount\n20-01,P1,100.50\n20-01,P2,210.00\n20-02,P1,50.00\n20-04,P3,99.99\n",
  );
  writeFileSync(
    join(dir, "may-a.csv"),
    "Account,Product,Amount\n2001,P1,100.50\n2001,P2,200.00\n2002,P1,51.00\n",
  );
  writeFileSync(
    join(dir, "may-b.csv"),
    "GL Account,Product Code,Sum Amount\n20-01,P1,100.50\n20-01,P2,200.00\n20-02,P1,51.00\n",
  );
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--no-warnings" },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { status: err.status ?? -1, stdout: String(err.stdout), stderr: String(err.stderr) };
  }
}

const DB = "e2e.db";

test("exit codes and single-line error contract", () => {
  const usage = cli(["definitely-not-a-command"]);
  assert.equal(usage.status, 2);
  const missing = cli(["ingest", "--db", DB]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr.trim(), /^error\(ConfigError\): /);
  const nf = cli(["reconcile", "--pair", "nope", "--db", DB]);
  assert.equal(nf.status, 1);
  assert.match(nf.stderr.trim(), /^error\(NotFoundError\): /);
});

test("step 1 — unknown pair → decisions_needed (exit 0, structured suggestions + levels)", () => {
  const r = cli(["run", "--file-a", "april-a.csv", "--file-b", "april-b.csv", "--db", DB, "--json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "decisions_needed");
  assert.ok(out.suggest.keyCandidates.length > 0);
  assert.ok(
    out.suggest.keyCandidates.some(
      (k: { colA: string; colB: string }) => k.colA === "account" && k.colB === "gl account",
    ),
  );
  assert.equal(out.pairName, "april-a vs april-b");
  // proposed levels are present — they may be empty for tiny fixtures, but the field exists
  assert.ok(Array.isArray(out.suggest.proposedLevels));
});

test("step 2 — map decisions, run completes; findings persisted in SQLite (no markdown report file)", () => {
  const m = cli([
    "map", "--pair", "april-a vs april-b", "--db", DB,
    "--key", "account=gl account",
    "--key", "product=product code:1",
    "--compare", "amount=sum amount",
    "--display", "product=product code",
  ]);
  assert.equal(m.status, 0);

  const r = cli([
    "run", "--file-a", "april-a.csv", "--file-b", "april-b.csv", "--db", DB, "--json",
  ]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "completed");
  assert.equal(out.reconcile.totalFindings, 3);
  assert.equal(out.reconcile.tolerance.absolute, "0.01");

  // findings are queryable in SQLite — verify the three planted findings exist at level 0
  const db = new DatabaseSync(join(dir, DB));
  try {
    const findings = db
      .prepare(
        `SELECT bucket, key_json, delta_micros FROM RunFinding
         WHERE run_id = (SELECT id FROM Run WHERE run_uuid = ?) AND level = 0 AND parent_finding_id IS NULL`,
      )
      .all(out.reconcile.runUuid) as { bucket: string; key_json: string; delta_micros: string }[];
    assert.equal(findings.length, 3);
    const buckets = findings.map((f) => f.bucket).sort();
    assert.deepEqual(buckets, ["DIFFER", "ONLY_A", "ONLY_B"]);
    const differ = findings.find((f) => f.bucket === "DIFFER")!;
    assert.match(differ.key_json, /"account":"2001"/);
    assert.equal(differ.delta_micros, "-10");
    // drill-down: level-1 child decomposes onto product=P2
    const children = db
      .prepare(
        `SELECT key_json, delta_micros FROM RunFinding
         WHERE run_id = (SELECT id FROM Run WHERE run_uuid = ?) AND level = 1 AND parent_finding_id IS NOT NULL`,
      )
      .all(out.reconcile.runUuid) as { key_json: string; delta_micros: string }[];
    assert.equal(children.length, 1);
    assert.match(children[0]!.key_json, /"product":"P2"/);
  } finally {
    db.close();
  }
});

test("step 3 — next month's files run with zero decisions (memory)", () => {
  const r = cli(["run", "--file-a", "may-a.csv", "--file-b", "may-b.csv", "--db", DB, "--json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "completed", JSON.stringify(out.reasons ?? out, null, 2).slice(0, 400));
  assert.equal(out.ingestA.routing, "attached_existing");
  assert.equal(out.ingestB.routing, "attached_existing");
  assert.equal(out.pairName, "april-a vs april-b");
  assert.equal(out.reconcile.totalFindings, 0);
});

test("--fail-on-findings gates with exit 1", () => {
  const r = cli([
    "reconcile", "--pair", "april-a vs april-b", "--db", DB,
    "--file-a", "1", "--file-b", "2", "--fail-on-findings",
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /TOTAL: 3 finding\(s\)/);
});

test("document regenerates the schema doc from the live DB", () => {
  const r = cli(["document", "--db", DB, "--schema-out", "schema.md"]);
  assert.equal(r.status, 0);
  const doc = readFileSync(join(dir, "schema.md"), "utf8");
  assert.match(doc, /## LoadedFile/);
  assert.match(doc, /## RunFinding/);
  assert.match(doc, /## Dataset1/);
  assert.match(doc, /## ColumnHierarchy/);
  assert.match(doc, /Storage conventions/);
  // The cut tables must not appear
  assert.doesNotMatch(doc, /## BusinessRule/);
  assert.doesNotMatch(doc, /## RuleRunImpact/);
});

test("rule / report commands are gone", () => {
  // Both unknown commands exit with the usage-error contract.
  const rule = cli(["rule", "--pair", "anything", "--db", DB]);
  assert.equal(rule.status, 2);
  assert.match(rule.stderr, /error\(UsageError\): Unknown command "rule"/);
  const report = cli(["report", "--run", "latest", "--db", DB]);
  assert.equal(report.status, 2);
  assert.match(report.stderr, /error\(UsageError\): Unknown command "report"/);
});

test("hierarchy command surfaces aggregation chains for an ingested file", () => {
  // Fixture with a real aggregation chain: country → city → district.
  // Each district sits in exactly one city (FD district→city), each city sits
  // in exactly one country (FD city→country) — the aggregation chain
  // therefore goes country → city → district.
  writeFileSync(
    join(dir, "geo.csv"),
    [
      "Country,City,District,Pop",
      "GR,Athens,A1,100",
      "GR,Athens,A2,200",
      "GR,Patra,P1,300",
      "DE,Berlin,B1,400",
      "DE,Berlin,B2,500",
      "DE,Munich,M1,600",
    ].join("\n") + "\n",
  );
  const ing = cli(["ingest", "--file", "geo.csv", "--db", DB, "--json"]);
  assert.equal(ing.status, 0);
  const out = JSON.parse(ing.stdout);
  const fileId = out.loadedFileId;
  const fds = out.hierarchy as { parent: string; child: string; kind: string }[];
  assert.ok(fds.length > 0, "expected at least one functional dependency");
  assert.ok(
    fds.some((f) => f.parent === "country" && f.child === "city" && f.kind === "aggregation"),
    `country→city aggregation not found in: ${JSON.stringify(fds)}`,
  );
  assert.ok(
    fds.some((f) => f.parent === "city" && f.child === "district" && f.kind === "aggregation"),
    `city→district aggregation not found in: ${JSON.stringify(fds)}`,
  );
  const h = cli(["hierarchy", "--file-id", String(fileId), "--db", DB, "--json"]);
  assert.equal(h.status, 0);
  const payload = JSON.parse(h.stdout);
  const flat = payload.aggregationChains.map((c: string[]) => c.join(">"));
  assert.ok(
    flat.some((c: string) => c === "country>city>district"),
    `chain country>city>district not found in: ${flat.join(", ")}`,
  );
});
