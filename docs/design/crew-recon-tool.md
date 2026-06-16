# Crew: Generic LLM-driven reconciliation tool (repo B core × repo A breadth)
Status: done — v0.3.0 end-user mode (2026-06-16)

## Gate outcomes
- **2026-06-12 — v0.1.0 build (frame):** Approved as specified. Tool name `tabrecon` (env prefix `TABRECON_*`). Built with 8 built-in business rules and a markdown report renderer.
- **2026-06-16 — v0.2.0 repositioning (scope cut):** The CLI is now a **data-preparation + structural-memory + structural-reconcile-engine** layer. All built-in business rules removed; built-in report format removed; column-hierarchy detection added so the CLI understands aggregation chains (top → drill-down) and descriptive 1:1 attributes from the data itself. The LLM (Claude Code today, standalone agent / web app tomorrow) reads the persisted `RunFinding` / `Dataset<N>` / `ColumnHierarchy` tables and shapes reports + business semantics in conversation with the business team.
- **2026-06-16 — v0.3.0 end-user mode:** An end user with two files and one ask ("reconcile them") should never have to declare anything. Added (a) auto-dedup of duplicate xlsx headers — second-and-later occurrences of an identical heading get `" (2)"`, `" (3)"` etc. appended (the very common code-plus-description pattern no longer needs a parse spec), and (b) `tabrecon run --auto` — auto-picks the highest-confidence join keys and decimal compare columns from the existing structural candidates, persists them as the pair's memory, and reconciles. Picks are explainable (rationale per pick on stdout) and conservative (heuristic fallbacks emit a warning recommending override). Verified on the FPSL/EDW real-data set: `tabrecon run --auto --file-a A.xlsx --file-b B.xlsx` reproduces the same 385 / 23-DIFFER finding counts as the prior hand-mapped run. The agent-mode path (no `--auto` → `decisions_needed` JSON) is unchanged.

## Request
> Take repo B's core (LLM-driven CLI, SQLite memory) and extend it with repo A's breadth (multi-format ingest, persisted file/pair fingerprint memory, hierarchical drill-down). The CLI should: load heterogeneous tabular files into SQLite, recognize returning files, understand the data's structural hierarchy (what's the top layer, what's drill-down), reach a "reconciliation-ready" state, and run the structural reconciliation. **No built-in business rules; no built-in report format.** Those live in the LLM-with-business-team conversation that follows.

## Acceptance criteria (v0.2.0)
AC1. **Generic ingestion, no per-dataset parsers.** `ingest` loads delimited text (UTF-8 / UTF-8-BOM / CP1253), xlsx (via fflate), and report-formatted text via LLM-authored parse specs (persisted on the profile and reused automatically on returning files). SHA-256 dedup; type inference (text / integer / decimal / date). Tests: 4 ingest paths + dedup + xlsx artifacts/scientific notation.
AC2. **File fingerprint memory** with structural similarity blend (column-name Jaccard 0.40, type-bag 0.20, value-sketch containment 0.20, null-rate 0.10, row-band 0.10). Routing thresholds: ≥ 0.95 auto-attach, ≥ 0.70 suggest, < 0.70 new profile. Decimal columns excluded from the value sketch (amounts churn between periods).
AC3. **Drift detection** on returning files: HARD drifts (encoding change, mapped column missing, type narrowed on mapped) abort; SOFT drifts (added column, type widened, cardinality / row-band shift) warn and persist.
AC4. **Pair memory** — `ColumnMapping` (role: key / compare / display, level for hierarchical drill-down), `JoinKeyStat` (uniqueness / overlap / null rates), `suggest` ranks key candidates and proposes **levels driven by both files' detected hierarchies**.
AC5. **Column-hierarchy detection during ingest.** Each ingested file gets pairwise functional-dependency analysis: every `(parent, child)` near-FD (consistency ≥ 0.95) is persisted as `ColumnHierarchy` row labeled `aggregation` (parent_distinct ≪ child_distinct — rollup chain) or `descriptive` (≈ equal — attribute lookup). Surfaced in `ingest` stdout (aggregation chains top → drill-down + descriptive pairs), in a dedicated `hierarchy --file-id <id>` lookup, and consumed by `suggest` to propose joint level ordering (each level must be a refinement via aggregation edges present on **both** sides).
AC6. **Reconciliation engine — structural only.** Aggregate-first hierarchical comparison (joins, buckets ONLY_A / ONLY_B / MATCH / DIFFER), absolute tolerance from CLI config (default €0.01), m2m guard, hierarchical drill-down to source rows with lineage. **No** built-in `tolerance_override`, `materiality_floor`, `known_one_sided`, `exclusion`, `sign_flip`, `scale_factor`, `value_map`, `fx_convert`. Findings persisted in `Run` / `RunLevelStat` / `RunFinding` (with `parent_finding_id` hierarchy and `lineage_json`), queryable by the LLM to shape reports and apply business semantics in SQL.
AC7. **Report-free CLI surface.** No markdown report file is written by tabrecon. The CLI's stdout summary (`level X: N finding(s) / M examined`) is observability, not a report. Downstream agents query `RunFinding` directly.
AC8. **Agent operability.** `--json` everywhere; error contract `error(<Name>): <message>` single-line on stderr; exit 0 / 1 / 2; 4-tier config (shell env → `~/.tool-agents/tabrecon/.env` → `./.env` → CLI flags); no silent fallbacks.
AC9. **End-to-end flow.** `run --file-a X --file-b Y` ingests both, surfaces `decisions_needed` with hierarchy-driven level proposals when no mappings exist, then on the same files-or-equivalent next-month files runs to `completed` with zero decisions. Findings persist in SQLite; the LLM queries them.
AC10. **Hygiene.** All tests pass via `node --test test_scripts/`; `tsc --noEmit` clean; `npm audit` 0 advisories.

## Out of scope (v0.2.0)
- Built-in business rules (exclusion, FX, sign-flip, etc.) — applied by the LLM/agent through SQL on top of findings.
- Built-in markdown / XLSX report renderer — the business team defines report shape; the LLM produces it from `RunFinding` queries.
- Fuzzy row matching (joins are exact on normalized keys).
- Parquet / JSON ingestion.
- SoD / approval states, run annotations, drift-approval TTL.

## Approach (v0.2.0 build)
1. **Cut:** delete `src/rules.ts`, `src/report.ts`, `BusinessRule` + `RuleRunImpact` tables, `rule` / `report` commands, `RuleParamsError` / `FxRateMissingError`, `--report-out` / `--drill-top` config. Strip `applyRowRules` call from `reconcile.ts`.
2. **Add hierarchy module:** `src/hierarchy.ts` — pairwise FD detection grouping by the more-cardinal child and checking for multiple parents (the correct direction for aggregation: child uniquely rolls up to one parent). Persist in new `ColumnHierarchy` table. Build aggregation chains from FDs. Propose join levels by intersecting both sides' aggregation edges.
3. **Wire in:** ingest runs detection in-transaction. `suggest` enriches its output with `proposedLevels`. New `hierarchy --file-id <id>` lookup command.
4. **Tests:** drop rule/report tests; rewrite e2e to query SQLite directly for findings (no report file); add `tabrecon-hierarchy.test.ts` covering descriptive vs aggregation classification, violation rejection, persistence round-trip, `proposeJoinLevels` agreement-on-both-sides semantics, and an FPSL-shape fixture.
5. **Docs:** update `docs/tools/tabrecon.md`, `CLAUDE.md`, `Issues - Pending Items.md`.

## Build log
- (2026-06-12 v0.1.0): generic ingestion + fingerprint memory + drift + 8 rule kinds + reconcile + markdown report. 35/35 tests, real-data validated against FPSL/EDW extracts.
- (2026-06-16 v0.2.0): rules + report removed; column-hierarchy detection added (during ingest, with both `aggregation` and `descriptive` classification); `suggest` extended with `proposedLevels` from both sides' aggregation edges; new `hierarchy --file-id <id>` command; CLI help rewritten. Real bank data validated end-to-end: FPSL detects `product group → product type` aggregation + descriptive 1:1 attributes (`gl_account ↔ gl_account_name`, `object_currency ↔ currency_name`); EDW detects `system → product`; suggest proposes `product type=product` as level 0; reconcile produces 385 product-level findings persisted in SQLite, queryable for any report shape the business team wants.

## Verdict (v0.2.0 — 2026-06-16)
- 34/34 tests green (`node --test test_scripts/*.test.ts`)
- `tsc --noEmit` clean (strict mode)
- `npm audit` 0 advisories
- Real FPSL/EDW xlsx flow: end-to-end without business rules; hierarchy detection labels aggregation chains and descriptive attributes correctly; reconcile persists 471 findings (level 0 + level 1) in SQLite for the LLM to query.
