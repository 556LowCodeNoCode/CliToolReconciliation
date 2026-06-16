# Issues - Pending Items

## Pending

1. **Cross-dimensional drill-down levels are not auto-proposed.** `proposeJoinLevels` strictly refines via aggregation edges present on **both** sides. When two key dimensions are independent (e.g., FPSL/EDW: `product_type` and `gl_account` are independent — no hierarchy connects them), only level 0 is proposed; the LLM/operator decides whether to add a second-dimension drill-down via `--key colA=colB:1`. Acceptable design: hierarchy is a strong fact, cross-dimension drill-down is a judgment call. Revisit if users find it confusing.
2. **Drift acknowledgment is not persisted.** SOFT drifts warn and are recorded on the Fingerprint row but there is no repo-A-style ApprovedDrift TTL workflow; HARD drifts always abort.
3. **Parquet/JSON ingestion not implemented** (v1 scope decision). Add readers under `src/ingest/` if real datasets require them.
4. **`node:sqlite` is experimental in Node 22** (warning on stderr). Functionally verified. Resolves when moving to Node ≥ 24.
5. **Slash/dot dates are interpreted day-first** (`dd/mm/yyyy`, documented European convention). US-format files where all days ≤ 12 would be silently misread — fix with an explicit spec override per column if needed.

## Completed

- (2026-06-16) v0.3.0 end-user mode: added `--auto` to `tabrecon run` (auto-picks join keys + compare columns from the existing structural candidates and persists them as the pair's memory, so an end user with two files and one ask never has to declare anything). Also added auto-dedup of duplicate xlsx headers (the very common `code + description` pattern) — second-and-later occurrences are renamed to `"<name> (2)"`, no parse spec needed. Verified on the FPSL/EDW real-data set: `tabrecon run --auto --file-a A.xlsx --file-b B.xlsx` reproduces the same 385 / 23-DIFFER finding counts as the hand-mapped run. 35/35 tests green.
- (2026-06-16) v0.2.0 repositioning: removed all built-in business rules (8 kinds, `BusinessRule` and `RuleRunImpact` tables, `rule add/list/suspend` command, `RuleParamsError` / `FxRateMissingError`), removed built-in markdown report renderer (`src/report.ts`, `report` command, `--report-out` / `--drill-top` config); added column-hierarchy detection (`src/hierarchy.ts`, `ColumnHierarchy` table) running during ingest with `aggregation` / `descriptive` classification and aggregation-chain extraction; `suggest` enriched with hierarchy-driven `proposedLevels` (refinement must be backed by aggregation edges on both sides); new `hierarchy --file-id <id>` lookup command. Real bank data validated: FPSL detects `product group → product type` aggregation + descriptive 1:1 attributes; EDW detects `system → product`; 471 findings reconciled into queryable SQLite. 34/34 tests green, `tsc --noEmit` clean, `npm audit` 0 advisories.
- (2026-06-12) Real-data hardening against the acc-recon FPSL/EDW xlsx extracts: added `xlsx` parse-spec type and xlsx decimal normalization (float artifacts rounded at the 6th decimal, scientific notation `7.0E-2` expanded exactly).
- (2026-06-12) tabrecon v0.1.0 built and verified end-to-end against synthetic and real data.

## Dependency vetting log

- `fflate@0.8.3` — vetted 2026-06-12, latest stable, 0 advisories.
- `typescript@6.0.3`, `@types/node@25.9.3` (devDependencies) — vetted 2026-06-12, npm audit clean.
