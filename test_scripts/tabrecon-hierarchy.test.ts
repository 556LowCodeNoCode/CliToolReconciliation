import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../tools/tabrecon/src/db.ts";
import { ingestFile } from "../tools/tabrecon/src/ingest/ingest.ts";
import {
  aggregationChains,
  loadColumnHierarchy,
  proposeJoinLevels,
  type FunctionalDependency,
} from "../tools/tabrecon/src/hierarchy.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tabrecon-hier-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function csv(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

test("descriptive 1:1 attribute is recognized and separated from aggregation", () => {
  const db = openDatabase(join(dir, "desc.db"));
  // Three accounts with unique names — gl_account ↔ gl_account_name is 1:1,
  // not an aggregation chain.
  const f = csv(
    "ledger.csv",
    "GL Account,GL Account Name,Amount\n" +
      "2001,ΟΜΟΛΟΓΑ,100\n" +
      "2002,ΔΑΝΕΙΑ,200\n" +
      "2001,ΟΜΟΛΟΓΑ,300\n" +
      "2003,ΛΟΙΠΑ,400\n",
  );
  const out = ingestFile(db, { filePath: f });
  // Expect both directions (the cardinalities are equal, ratio 1.0 → descriptive)
  const fds = out.hierarchy;
  const pair = fds.find(
    (f) => (f.parent === "gl account" && f.child === "gl account name") ||
           (f.parent === "gl account name" && f.child === "gl account"),
  );
  assert.ok(pair, `descriptive pair not detected in: ${JSON.stringify(fds)}`);
  assert.equal(pair!.kind, "descriptive");
  assert.equal(aggregationChains(fds).length, 0);
  db.close();
});

test("aggregation FD is rejected when a child belongs to multiple parents", () => {
  const db = openDatabase(join(dir, "broken.db"));
  const f = csv(
    "broken.csv",
    "Country,City,Pop\n" +
      "GR,Athens,100\n" +
      "GR,Patra,200\n" +
      "GR,Athens,300\n" +
      "DE,Athens,400\n", // Athens in two countries → FD city→country is violated
  );
  const out = ingestFile(db, { filePath: f });
  const offending = out.hierarchy.find((f) => f.parent === "country" && f.child === "city");
  // With one violating row out of four, consistency = 0.25 — below the 0.95 floor.
  assert.equal(offending, undefined);
  db.close();
});

test("hierarchy is persisted and round-trips through loadColumnHierarchy", () => {
  const db = openDatabase(join(dir, "persist.db"));
  const f = csv(
    "geo.csv",
    "Country,City\nGR,Athens\nGR,Patra\nDE,Berlin\nDE,Munich\n",
  );
  const out = ingestFile(db, { filePath: f });
  const loaded = loadColumnHierarchy(db, out.loadedFileId);
  assert.deepEqual(
    loaded.map((f) => `${f.parent}→${f.child}:${f.kind}`).sort(),
    out.hierarchy.map((f) => `${f.parent}→${f.child}:${f.kind}`).sort(),
  );
  db.close();
});

test("proposeJoinLevels orders candidates by joint coarseness, requiring agreement on both sides", () => {
  const fdsA: FunctionalDependency[] = [
    { parent: "product_type", child: "product_code", parentDistinct: 10, childDistinct: 500, consistency: 1.0, kind: "aggregation" },
  ];
  const fdsB: FunctionalDependency[] = [
    { parent: "product", child: "product_code", parentDistinct: 10, childDistinct: 500, consistency: 1.0, kind: "aggregation" },
  ];
  const candidates = [
    { colA: "product_type", colB: "product" },
    { colA: "product_code", colB: "product_code" },
  ];
  const levels = proposeJoinLevels(fdsA, fdsB, candidates);
  assert.equal(levels.length, 2);
  assert.equal(levels[0]!.level, 0);
  assert.equal(levels[0]!.add[0]!.colA, "product_type");
  assert.equal(levels[0]!.rationaleA.kind, "root");
  assert.equal(levels[1]!.level, 1);
  assert.equal(levels[1]!.add[0]!.colA, "product_code");
  assert.equal(levels[1]!.rationaleA.kind, "aggregation");
});

test("proposeJoinLevels skips candidates that lack an aggregation edge on both sides", () => {
  // A knows product_type → product_code; B does not (no FD recorded for B).
  const fdsA: FunctionalDependency[] = [
    { parent: "product_type", child: "product_code", parentDistinct: 10, childDistinct: 500, consistency: 1.0, kind: "aggregation" },
  ];
  const fdsB: FunctionalDependency[] = [];
  const candidates = [
    { colA: "product_type", colB: "product" },
    { colA: "product_code", colB: "product_code" },
  ];
  const levels = proposeJoinLevels(fdsA, fdsB, candidates);
  assert.equal(levels.length, 1);
  assert.equal(levels[0]!.add[0]!.colA, "product_type");
});

test("real-world: FPSL-shape file exposes product_group → product_type aggregation", () => {
  const db = openDatabase(join(dir, "fpsl.db"));
  // Two product groups, each with two product types; each row is unique on (gl, currency, type).
  const f = csv(
    "fpsl.csv",
    [
      "GL Account,Object Currency,Product Group,Product Type",
      "2001,EUR,#,031",
      "2001,EUR,#,032",
      "2001,EUR,#,033",
      "2002,EUR,71,A01",
      "2002,EUR,71,A02",
      "2002,EUR,71,A03",
    ].join("\n") + "\n",
  );
  const out = ingestFile(db, { filePath: f });
  const fdAgg = out.hierarchy.find(
    (f) => f.parent === "product group" && f.child === "product type" && f.kind === "aggregation",
  );
  assert.ok(fdAgg, `product group → product type aggregation not detected: ${JSON.stringify(out.hierarchy)}`);
  // gl_account → object_currency is a degenerate 1:1 here (every gl is in EUR), so descriptive.
  db.close();
});
