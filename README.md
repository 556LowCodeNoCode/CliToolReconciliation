# NewRecon — `tabrecon`

> `tabrecon` is a generic, agent-operable CLI that prepares two tabular files for reconciliation and reconciles them — leaving business rules and report shape to the LLM/agent layer above.

- **Loads** any tabular file (CSV / TXT / XLSX / fixed-width) into SQLite — auto-detects encoding, delimiter, header, and column types; canonicalizes amounts as exact decimals; dedups by SHA-256; refuses to guess.
- **Remembers** files across runs via structural fingerprints — recognizes returning files, flags schema drift (hard abort / soft warn).
- **Discovers** the data's own hierarchies (aggregation chains + 1:1 attributes) and uses them to propose reconciliation levels.
- **Suggests** join keys with uniqueness / overlap statistics; persists the mapping decisions once so repeat runs are zero-decision.
- **Reconciles** in exact decimal arithmetic — `MATCH` / `DIFFER` / `ONLY_A` / `ONLY_B`, with hierarchical drill-down to source rows.
- **Persists** every finding to SQLite — the LLM/agent layer queries it to apply business semantics and shape whatever report the team needs.

The project synthesizes [`556LowCodeNoCode/acc-recon`](https://github.com/556LowCodeNoCode/acc-recon) (the agent-operable TypeScript CLI + SQLite + exact-decimal + never-guess foundation) with [`556LowCodeNoCode/reconciliation-agent`](https://github.com/556LowCodeNoCode/reconciliation-agent) (multi-format ingest, fingerprint memory, drift detection, hierarchical drill-down) and adds two ideas neither had:

- **No built-in business rules and no built-in report format.** The CLI guarantees the structural part (ingest, recognition, hierarchy detection, reconciliation) is correct and identical every run. Business semantics — exclusions, FX, tolerances above the default, materiality floors, what counts as a "known one-sided" finding — are applied by the LLM/agent talking to the business team, in SQL on top of the persisted `RunFinding` / `Dataset<N>` / `ColumnHierarchy` tables.
- **Column-hierarchy detection from the data itself.** Each ingested file is analyzed for pairwise functional dependencies, labeled `aggregation` (rollup chain: top → drill-down) or `descriptive` (1:1 attribute lookup). The aggregation chains drive the `suggest` command's proposed level ordering, so the LLM/operator doesn't have to guess the recon grain.

---

## For the next maintainer — TL;DR

You can run the test suite, ingest two files, and produce findings in under 60 seconds. The full surface is exactly nine commands; everything else lives in SQLite.

```bash
# 1. install dependencies (single runtime dep: fflate)
cd tools/tabrecon && npm install

# 2. register `tabrecon` as a system-wide command (one-time, per machine)
npm link                            # creates `tabrecon` on PATH via Node's bin

# 3. run the suite (Node ≥ 22.18 required, type stripping is native)
cd ../.. && npm test                # 34 tests, ~1 second

# 4. smoke test on any two files — one command, no decisions needed
cd /path/to/your/files

# The end-user mode: tabrecon ingests both, detects column types and
# hierarchies, picks the highest-confidence join keys and decimal compare
# columns from the structural candidates it computes, persists them as the
# pair's memory, and reconciles. Output explains every auto-pick.
tabrecon run --auto --file-a A.xlsx --file-b B.xlsx

# Next month, same schemas — even --auto is unnecessary; mappings are
# remembered, so this runs zero-decision:
tabrecon run --file-a A-may.xlsx --file-b B-may.xlsx

# Query findings — the LLM/agent layer shapes any report from these tables
sqlite3 recon.db "SELECT bucket, key_json, delta_micros FROM RunFinding WHERE level = 0;"
```

> **Agent mode (default, when `--auto` is not passed):** if the pair has no
> mappings yet, `run` exits 0 with a `decisions_needed` JSON containing
> ranked key/compare candidates and hierarchy-driven level proposals — the
> agent reviews, records mappings with `tabrecon map`, and re-runs. Pairs
> with mappings already on record always run zero-decision regardless of
> `--auto`.

> Without step 2 you'd run the CLI as `node /path/to/tools/tabrecon/src/cli.ts …` — `npm link` just wires it onto `$PATH` so `tabrecon` works from anywhere. Reverse with `npm unlink -g tabrecon` from the tool folder.

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
