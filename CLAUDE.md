# NewRecon

Generic LLM-driven tabular-data reconciliation. The project takes the philosophy of `acc-recon` (agent-operable TypeScript CLI + SQLite, Claude Code as the LLM brain) and generalizes it with the breadth of `reconciliation-agent` (multi-format ingestion, fingerprint memory, hierarchical drill-down).

## Tools

- **tabrecon** — Ingests heterogeneous tabular files (delimited UTF-8/CP1253, xlsx, fixed-width via persisted parse specs) into SQLite with SHA-256 dedup, recognizes returning files via structural fingerprints with drift detection, **detects the column hierarchies in the data itself** (aggregation chains top → drill-down + descriptive 1:1 attributes), persists per-pair column mappings, and runs the structural reconciliation in exact BigInt decimal arithmetic. Findings persist in `RunFinding` (hierarchical via `parent_finding_id`, lineage to source rows). **No built-in business rules; no built-in report format** — those live in the LLM-with-business-team conversation that follows. Full documentation: `docs/tools/tabrecon.md`.

## Conventions

- Tests live in `test_scripts/`; run `npm test` from the project root (Node ≥ 22.18 required).
- Database table names are singular (`Profile`, `LoadedFile`, `RunFinding`, `ColumnHierarchy`).
- No configuration fallbacks: missing required settings raise `ConfigError`; documented defaults are part of each tool's published contract.
- All amount arithmetic is exact (BigInt micro-units / canonical decimal strings) — never introduce binary floats into an amount path.
- The tool never guesses: ambiguous encodings, delimiters, headers, or number formats raise named errors that say what to provide (usually a `--spec`).
- Reports and business rules are deliberately not built into the CLI — the LLM agent shapes them on top of the persisted findings.

## Design documents

- Crew build spec + verification record: `docs/design/crew-recon-tool.md`
