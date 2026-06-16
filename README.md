# NewRecon — `tabrecon`

> Generic LLM-driven tabular-data reconciliation. A CLI that loads heterogeneous tabular files into SQLite, understands the data's structure (column types, fingerprints, hierarchies), persists per-pair memory of how the files fit together, and runs the structural reconciliation. **Business semantics and report shape live in the LLM/agent layer above the CLI**, not in the tool itself.

This project synthesizes two prior approaches into one:

| Source | What we kept |
|---|---|
| [`556LowCodeNoCode/acc-recon`](https://github.com/556LowCodeNoCode/acc-recon) | Agent-operable TypeScript CLI, SQLite as the comparison substrate, SHA-256 dedup, exact decimal arithmetic, never-guess error contract |
| [`556LowCodeNoCode/reconciliation-agent`](https://github.com/556LowCodeNoCode/reconciliation-agent) | Multi-format ingestion (delimited / xlsx / fixed-width via parse specs), fingerprint-based file recognition with drift detection, business-rule memory model, hierarchical drill-down |

The synthesis adds two ideas the references don't have:

- **No built-in business rules and no built-in report format.** The CLI guarantees the structural part (ingest, recognition, hierarchy detection, reconciliation) is correct and identical every run. Business semantics — exclusions, FX, tolerances above the default, materiality floors, what counts as a "known one-sided" finding — are applied by the LLM/agent talking to the business team, in SQL on top of the persisted `RunFinding` / `Dataset<N>` / `ColumnHierarchy` tables.
- **Column-hierarchy detection from the data itself.** Each ingested file is analyzed for pairwise functional dependencies, labeled `aggregation` (rollup chain: top → drill-down) or `descriptive` (1:1 attribute lookup). The aggregation chains drive the `suggest` command's proposed level ordering, so the LLM/operator doesn't have to guess the recon grain.

---

## For the next maintainer — TL;DR

You can run the test suite, ingest two files, and produce findings in under 60 seconds. The full surface is exactly nine commands; everything else lives in SQLite.

```bash
# 1. install (single runtime dep)
cd tools/tabrecon && npm install && cd ../..

# 2. run the suite (Node ≥ 22.18 required, type stripping is native)
npm test                         # 34 tests, ~1 second

# 3. smoke test on synthetic data
mkdir -p /tmp/try && cd /tmp/try
printf 'Account,Product,Amount\n2001,P1,100.50\n2001,P2,200.00\n2003,P9,75.25\n' > a.csv
printf 'GL Account,Product Code,Sum Amount\n20-01,P1,100.50\n20-01,P2,210.00\n20-04,P3,99.99\n' > b.csv
CLI="node $OLDPWD/tools/tabrecon/src/cli.ts"

# first run — exits 0 with "decisions_needed" + ranked key/level candidates
$CLI run --file-a a.csv --file-b b.csv --db demo.db

# record the decisions once (this is the pair's persistent memory)
$CLI map --pair "a vs b" --db demo.db \
  --key "account=gl account" --key "product=product code:1" \
  --compare "amount=sum amount" --display "product=product code"

# re-run — full pipeline, findings land in SQLite (no report file written)
$CLI run --file-a a.csv --file-b b.csv --db demo.db

# query findings — this is what the LLM does to shape any report
sqlite3 demo.db "SELECT bucket, key_json, delta_micros FROM RunFinding WHERE level = 0;"
```

The next month's files (same schemas, different rows) will run **with zero decisions** — the profile + pair memory recognizes them.

## Where to look for everything

| Need to find | Look at |
|---|---|
| What the tool does end-to-end | `docs/tools/tabrecon.md` (full reference: commands, flags, storage model, examples, extension points) |
| Why the project exists and how the design landed | `docs/design/crew-recon-tool.md` (acceptance criteria, gate outcomes for v0.1.0 and v0.2.0, build log, verification record) |
| Project conventions Claude Code should honour | `CLAUDE.md` |
| What's pending or deliberately out of scope | `Issues - Pending Items.md` |
| Source code | `tools/tabrecon/src/` (single TypeScript CLI, ~13 source files, run natively by Node) |
| Tests | `test_scripts/` (4 files, `node --test` runner) |
| The live database schema (always machine-generated) | run `node tools/tabrecon/src/cli.ts document --db <yourdb> --schema-out schema.md` |

## Architecture in one paragraph

`tabrecon ingest` lands each file in its own `Dataset<N>` table inside SQLite, with types inferred, amounts canonicalized to exact decimal strings, columns registered in `DatasetColumn`, a structural fingerprint computed and stored in `Fingerprint`, and pairwise functional dependencies stored in `ColumnHierarchy`. A `LoadedFile` row carries the SHA-256 so identical content is never ingested twice. Returning files are recognized via structural similarity (column-name Jaccard + type bag + null rates + row-count band + value sketch) and routed to a `Profile`: ≥ 0.95 auto-attach, ≥ 0.70 surface as a `decisions_needed` suggestion, otherwise create a new profile. A `ReconPair` joins two profiles; its `ColumnMapping` rows (role: key / compare / display, with `level` for hierarchical drill-down) are decided once and reused on every later run of recognized files. `tabrecon reconcile` runs the structural engine — full-outer aggregation per level with BigInt micro-unit arithmetic — and persists every finding to `RunFinding` with `parent_finding_id` for hierarchy and `lineage_json` down to source rows. The LLM (Claude Code today, a standalone agent or web app tomorrow) takes it from there: queries `RunFinding`, applies business rules in SQL, shapes whatever report the business team needs.

## Reliability

- **Tests:** `npm test` → 34/34 passing, ~1 second.
- **Type-check:** `cd tools/tabrecon && npx tsc --noEmit -p .` → clean under strict mode.
- **Audit:** `npm audit` → 0 advisories.
- **Real-data validation:** tested end-to-end against the bank FPSL/EDW xlsx extracts from `acc-recon/sample-data/` — 3,600 + 1,903 rows, 5 mappings, **0.15 s reconcile**, hierarchy detection correctly labeled `product group → product type` (FPSL) and `system → product` (EDW) aggregation chains plus the descriptive 1:1 attributes.

## Runtime requirements

- **Node.js ≥ 22.18** — uses built-in `node:sqlite` and native TypeScript type stripping; no build step.
- **One runtime dependency:** `fflate@^0.8.3` for xlsx decompression. (`typescript` and `@types/node` are devDependencies only.)
- **macOS / Linux** verified; Windows should work (no platform-specific code) but not exercised in CI.

## The 9 commands

```
tabrecon ingest      Ingest one tabular file (auto-detect or --spec for fixed/xlsx layouts)
tabrecon profile     list | show | attach — file-kind memory
tabrecon pair        create | list — reconciliation pair (profile × profile) memory
tabrecon hierarchy   Show detected aggregation chains and descriptive attributes for a file
tabrecon suggest     Join-key statistics + compare candidates + hierarchy-driven level proposals
tabrecon map         Record key / compare / display column mappings (with optional levels)
tabrecon reconcile   Run the structural engine and persist findings in RunFinding
tabrecon run         Full pipeline: ingest A + B → if mapped, reconcile; else decisions_needed
tabrecon document    Machine-generate the database structure documentation
```

Run any command with `--help` for the full per-command reference. Every command supports `--json`. Errors are `error(<Name>): <message>` single-line on stderr; exit codes are `0` (completed), `1` (operational failure), `2` (usage error).

## Configuration

Four-tier resolution, lowest to highest priority: shell env → `~/.tool-agents/tabrecon/.env` → `./.env` → CLI flags. **No silent fallbacks** — a missing required setting raises `ConfigError` naming the setting, env var, and flag. Documented defaults are part of the published contract (e.g. `--db ./recon.db`, `--tolerance 0.01`). See `docs/tools/tabrecon.md` for the table.

## Repository layout

```
NewRecon/
├── CLAUDE.md                       # project conventions for Claude Code
├── README.md                       # you are here
├── Issues - Pending Items.md       # pending + completed change log
├── package.json                    # root: just defines `npm test`
├── docs/
│   ├── design/crew-recon-tool.md   # design spec + verification record
│   └── tools/tabrecon.md           # complete tool reference
├── test_scripts/                   # node:test suite (4 files, 34 tests)
└── tools/tabrecon/
    ├── package.json                # tool: fflate runtime dep
    ├── tsconfig.json               # strict TS config (no emit, type-check only)
    └── src/
        ├── cli.ts                  # entry point, command dispatch, help
        ├── config.ts               # 4-tier resolution, no fallbacks
        ├── db.ts                   # DDL + transactions + name normalization
        ├── decimal.ts              # exact BigInt micro-unit arithmetic
        ├── document.ts             # auto-generated schema docs
        ├── drift.ts                # HARD / SOFT schema-change taxonomy
        ├── errors.ts               # named error classes
        ├── fingerprint.ts          # structural similarity + profile routing
        ├── hierarchy.ts            # FD detection + chain build + level proposal
        ├── keys.ts                 # join-key statistics + Jaro-Winkler
        ├── reconcile.ts            # aggregate-first engine, ONLY/MATCH/DIFFER buckets
        └── ingest/
            ├── ingest.ts           # orchestrator: read → dedup → parse → infer → persist
            ├── detect.ts           # encoding probe + delimiter sniff + header detection
            ├── delimited.ts        # RFC-4180 parser
            ├── xlsx.ts             # minimal fflate-based OOXML reader
            ├── cp1253.ts           # strict Windows-1253 decoder + encoder
            ├── infer.ts            # per-column type inference + value canonicalization
            └── spec.ts             # parse-spec validators (fixed / delimited / xlsx)
```

## License

No license file yet — propose adding one before any external publication. The two reference repos are under the same org; align with whatever convention they pick.
