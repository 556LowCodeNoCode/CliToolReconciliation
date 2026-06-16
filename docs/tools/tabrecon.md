<tabrecon>

# tabrecon

## Purpose

Generic tabular reconciliation **engine + memory layer**, designed to be operated by an LLM (Claude Code today, a standalone agent or web app tomorrow). The CLI takes heterogeneous tabular files, lands them in SQLite, understands their structural hierarchy from the data itself, recognizes returning files via persisted fingerprints, persists per-pair column mappings, and runs the structural reconciliation. **Business rules and report shape live outside the CLI** — the LLM, in conversation with the business team, applies semantics and shapes reports by querying the persisted `RunFinding` / `Dataset<N>` / `ColumnHierarchy` tables directly.

## Location

- Source: `tools/tabrecon/` (TypeScript, executed natively by Node ≥ 22.18 type stripping — no build step)
- Entry point: `tools/tabrecon/src/cli.ts`
- Tests: `test_scripts/tabrecon-*.test.ts` — run `npm test` from the project root

## Runtime requirements

- Node.js ≥ 22.18 (built-in `node:sqlite`)
- Runtime dependency: `fflate@^0.8.3` only (vetted 2026-06-12)

## Installing as a system-wide command

The tool's `package.json` declares `tabrecon` as a `bin`. To register it on `$PATH` so it works from any directory, run once per machine:

```bash
cd tools/tabrecon
npm install        # only needed the first time
npm link           # creates `tabrecon` in Node's bin directory
```

After that:

```bash
which tabrecon     # → /…/node/<version>/bin/tabrecon (or /opt/homebrew/bin/ on Homebrew)
tabrecon --version # → tabrecon 0.2.0
tabrecon ingest --file /any/path/to/data.csv --db /any/path/to/store.db
```

Without `npm link` the CLI is still usable as `node /path/to/tools/tabrecon/src/cli.ts …`. To uninstall the global command later: `npm unlink -g tabrecon` from the tool folder.

## Commands

```
node tools/tabrecon/src/cli.ts <command> [flags]
```

| Command | What it does |
|---|---|
| `ingest --file <path> [--profile <n>] [--spec <json\|file>]` | Detects encoding/delimiter/header (never guesses — ambiguity raises named errors). Three parse-spec layouts: `fixed`, `delimited`, `xlsx` (positional rename for duplicated headers, `skipLeadingRows`, `hasHeader`). xlsx decimals normalized at ingestion (float artifacts rounded at the 6th decimal, scientific notation expanded exactly; text sources stay strict). SHA-256 dedup; fingerprint + profile routing (≥ 0.95 auto-attach / ≥ 0.70 suggest / new); drift gate (HARD abort, SOFT warn). **Column-hierarchy detection runs in the same transaction** — pairwise FD analysis labels each near-functional dependency as `aggregation` (top → drill-down) or `descriptive` (1:1 attribute). |
| `profile list \| show --name <n> \| attach --file-id <id> --profile <n>` | File-kind memory management. |
| `pair create --name <n> --profile-a <p> --profile-b <p> \| list` | Reconciliation pair memory. |
| `hierarchy --file-id <id>` | Show the detected aggregation chains and descriptive 1:1 attributes for one ingested file. Also queryable via the `ColumnHierarchy` table. |
| `suggest --pair <n>` | Join-key statistics (uniqueness, overlap, null rates — persisted as `JoinKeyStat`), compare-column candidates ranked by Jaro-Winkler name similarity, and **proposed level ordering** derived from both files' hierarchies (level 0 = coarsest joint grain; each subsequent level refines via an aggregation edge present on both sides). |
| `map --pair <n> --key "a=b[:level][:raw]"... --compare "a=b"... --display "a=b"... [--clear]` | Record the pair's column mappings (the pair's memory). Levels enable hierarchical drill-down. |
| `reconcile --pair <n>` | Run the structural engine: aggregate-first hierarchical comparison with configured absolute tolerance, ONLY_A / ONLY_B / MATCH / DIFFER bucketing, m2m guard. **No business rules applied.** Persists `Run`, `RunLevelStat`, `RunFinding` (with `parent_finding_id` hierarchy and `lineage_json` down to source rows). |
| `run --file-a <p> --file-b <p> [--auto] [...]` | Full pipeline: ingest A + B → if pair has mappings, reconcile → else (with `--auto`) auto-pick mappings from top-ranked structural candidates and reconcile; (without `--auto`) exit 0 with `decisions_needed`. Recognized pairs always run zero-decision. `--auto` picks: level-0 key = top-ranked join candidate (overlap ≥ 0.5, rank ≥ 0.02), optional level-1 key = next-best on different columns, compare = decimal-vs-decimal pairs preferring name similarity (Jaro-Winkler ≥ 0.6) and falling back to the largest-total decimal column on each side. xlsx files with duplicate headers (a column heading repeated for "code" + "description") have their second-and-later occurrences auto-renamed to `"<name> (2)"`. |
| `document [--schema-out <p>]` | Machine-generated DB structure documentation. |

## Why no business rules and no report

The CLI is intentionally **structural**. Once both files are ingested, fingerprinted, paired, and reconciled, every fact needed for any business view lives in SQLite:

- `Dataset<N>` — both source datasets, canonical-typed.
- `ColumnHierarchy` — aggregation chains + descriptive attributes (so the LLM knows what's a hierarchy top vs an attribute lookup).
- `ColumnMapping` — what was reconciled with what, at what level.
- `RunFinding` — every ONLY_A / ONLY_B / DIFFER with source-row lineage, hierarchical via `parent_finding_id`.

The LLM (or whichever agent fronts tabrecon) writes whatever SQL the business team needs — "exclude non-EUR rows", "tolerance €1 instead of €0.01", "report only the top 20 by absolute Δ", "group by GL account class" — and produces whatever report shape the team wants. This separation keeps the CLI provably correct and lets business semantics evolve in conversation, not in a forked tool.

## Configuration

Four-tier resolution, lowest to highest priority: shell env → `~/.tool-agents/tabrecon/.env` → `./.env` → CLI flags. NO silent fallbacks — missing required settings raise `ConfigError` naming the setting, env var, and flag.

| Setting | Env var | CLI flag | Required | Documented default | Purpose |
|---|---|---|---|---|---|
| db | `TABRECON_DB` | `--db` | no | `./recon.db` | SQLite file. Persistent by default — the memory must survive runs. |
| schemaOut | `TABRECON_SCHEMA_OUT` | `--schema-out` | no | `./tabrecon-schema.md` | Schema documentation output path. |
| tolerance | `TABRECON_TOLERANCE` | `--tolerance` | no | `0.01` | Absolute tolerance for reconcile (decimal string). |
| m2mPairCap | `TABRECON_M2M_PAIR_CAP` | `--m2m-pair-cap` | no | `10000` | Max raw row pairings per finest-level key before `ManyToManyKeyError`. |
| failOnFindings | — | `--fail-on-findings` | no | off | CI gating: exit 1 when level-0 findings > 0. |
| json | — | `--json` | no | off | Machine-readable JSON result on stdout. |

## Exit codes & error contract

| Code | Meaning |
|---|---|
| 0 | Completed — findings and `decisions_needed` are data, not errors |
| 1 | Operational failure (`error(<Name>): <message>` single line on stderr) — or findings with `--fail-on-findings` |
| 2 | Usage error |

## Storage model

Singular table names. `Meta`, `Profile`, `LoadedFile`, `Fingerprint`, `DatasetColumn`, `ColumnHierarchy`, `ReconPair`, `ColumnMapping`, `JoinKeyStat`, `Run`, `RunLevelStat`, `RunFinding`, plus per-file `Dataset<N>` tables. All amounts persisted as exact decimal strings; the engine computes on ×10⁶ BigInt micro-units — no binary floats anywhere in an amount path. Run `document` for the always-current generated description.

## Example — end-user mode (one command, two file paths)

```bash
tabrecon run --auto --file-a A.xlsx --file-b B.xlsx
```

The CLI handles everything: encoding/type detection, duplicate-header
auto-dedup for xlsx, fingerprint-based file recognition, hierarchy
discovery, join-key + compare-column auto-picking from structural
candidates, persistence of the pair's memory, and the reconciliation
itself. Output explains every auto-pick so it's auditable, and emits a
warning when a fallback heuristic was used (e.g. compare picked by total
magnitude when no name match existed). Next month's files run zero-decision.

## Example — agent-operated session (with explicit control)

```bash
# 1. ingest two files. First time: discovers hierarchy chains + descriptive attributes.
tabrecon ingest --file ledger-april.csv --profile ledger
# →  hierarchy:  aggregation chain(s) (top → drill-down):
#                  account_class → account_type → account_code

tabrecon ingest --file extract-april.xlsx --profile extract

# 2. first time: decisions_needed with hierarchy-driven level proposal.
tabrecon run --file-a ledger-april.csv --file-b extract-april.xlsx --json
# → suggest.proposedLevels[0]: account_class=class (root on both sides)

# 3. record decisions once
tabrecon map --pair "ledger vs extract" \
  --key "account_class=class" --key "account_code=code:1" \
  --compare "amount=sum" --display "name=description"

# 4. reconcile: findings persist in SQLite, no markdown file written
tabrecon reconcile --pair "ledger vs extract"

# 5. the LLM / agent / web app queries RunFinding to produce whatever the
#    business team needs — apply exclusion rules in SQL, set materiality
#    floors, shape the report.

# 6. next month: same files run with zero decisions (memory).
tabrecon run --file-a ledger-may.csv --file-b extract-may.xlsx
```

## Extension points

- New source format → reader under `src/ingest/` + dispatch in `src/ingest/ingest.ts`.
- New structural similarity component → extend `computeFingerprint` / `similarity` in `src/fingerprint.ts` (weights renormalize when a component is absent).
- New hierarchy detection (e.g., approximate FDs, multi-column composite keys) → extend `src/hierarchy.ts`; persistence in `ColumnHierarchy` is forward-compatible (just add `kind` values to the CHECK constraint).

</tabrecon>
