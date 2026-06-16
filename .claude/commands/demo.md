---
description: Live 5-scene demo of the tabrecon CLI for an audience watching this Claude Code session
---

You are driving a live demo of `tabrecon` for colleagues observing this Claude Code session. The goal is to show the CLI's **structural-engine + Claude-Code-as-analyst** split on real data, end-to-end, in roughly 5–7 minutes.

## Demo folder & files (defaults)

- Default folder: `/Users/suzy/ClaudeCode/Projects/DemoReconciliation`
- File A: `Προιόντα από FPSL 30.04.2025.xlsx`
- File B: `Προιόντα από EDW 30.04.2025.xlsx`

If `$ARGUMENTS` is set, treat it as either an alternate folder path (with two `.xlsx` files inside, picked alphabetically as A and B), or as a `scene-N` instruction to jump to that scene. If unclear, ask the user once and then proceed.

## Cold start (always — even if jumping scenes, briefly cd and confirm)

```bash
cd "$DEMO_FOLDER"
rm -f recon.db          # ensure first-run UX
ls -la *.xlsx
```

Confirm both files are present. If they aren't, stop and tell the demoer; otherwise continue.

## Scene 1 — The hook (~30 s)

State out loud (one short paragraph): "Two xlsx files, ~5,500 rows total, completely different schemas. The user has nothing else — no parse spec, no column mapping, no business rules. Watch."

Run:

```bash
tabrecon run --auto --file-a "Προιόντα από FPSL 30.04.2025.xlsx" --file-b "Προιόντα από EDW 30.04.2025.xlsx"
```

After the full output prints, narrate **two short sentences** highlighting what just happened. Specifically point out:

- the **duplicate-header auto-dedup** (`G/L Account (2)`, `Object Currency (2)`) — a real-world quirk handled silently
- the **hierarchy detection** — `product group → product type` (FPSL), `system → product` (EDW)
- the **auto-mapped keys + compare** with their rationale (overlap 0.502, overlap 0.978, largest-total decimal)
- the **findings count** — 385 at level 0, with 23 DIFFER at level 1

End the scene with: *"Questions on what you just saw, or shall I show how the tool figured out the structure?"* — and then **pause for the demoer's signal** before continuing. Do not roll into scene 2 automatically.

## Scene 2 — How does it know? (~1 m)

When green-lit:

```bash
tabrecon hierarchy --file-id 1
tabrecon hierarchy --file-id 2
```

Narrate the key insight: the tool found these hierarchies by pairwise functional-dependency analysis inside each file. No banking knowledge is baked into the code — the same algorithm finds `genre → subgenre` in book inventories, `country → city → district` in geographic data. Show one extra command to prove it:

```bash
sqlite3 recon.db "SELECT parent_name, child_name, kind, consistency FROM ColumnHierarchy ORDER BY loaded_file_id, parent_distinct;" | column -t -s'|'
```

Quick note: the auto-pick of `closing balance ↔ sum_amount` was *not* via name similarity (those words don't match) — the tool fell back to "largest-total decimal column on each side", which is documented and emits a warning. Honesty point.

Pause. *"Now: what happens next month, when you get fresh files?"*

## Scene 3 — The memory (~30 s)

When green-lit, demonstrate the persistent memory. Two equally good ways — pick whichever feels right:

**(a) zero-decision re-run on the same files** (fastest, makes the point with one command):

```bash
tabrecon run --file-a "Προιόντα από FPSL 30.04.2025.xlsx" --file-b "Προιόντα από EDW 30.04.2025.xlsx"
```

Note `--auto` is omitted on purpose. Highlight in the output: both files report `already loaded`, the pair's mappings are remembered, and the reconcile runs with zero decisions.

**(b) simulate a new month** by copying one file and re-running:

```bash
cp "Προιόντα από EDW 30.04.2025.xlsx" "Προιόντα από EDW 31.05.2025.xlsx"
tabrecon run --file-a "Προιόντα από FPSL 30.04.2025.xlsx" --file-b "Προιόντα από EDW 31.05.2025.xlsx"
```

Highlight: the new file's fingerprint was scored against the EDW profile, matched at ≥ 0.95, auto-attached, reused the same mappings, reconciled.

Pause. *"Now the interesting part — let's pretend the business team is in the room and wants to dig in."*

## Scene 4 — The Claude Code payoff (2–3 m) ⭐ — the key scene

Invite the audience to ask analytical questions. If they're shy, seed with one of these:

- "Which 5 GL accounts contribute most to the gap on the DIFFER findings?"
- "Show only findings where both sides have data and `|delta| > €100,000`."
- "Group the DIFFER findings by product type and total the delta."
- "Which findings are over 5 % relative to their magnitude?"

For each question:
1. Write the SQL against `RunFinding` (joining `Dataset<N>` / `ColumnMapping` only if needed).
2. Run via `sqlite3 recon.db "<query>"`.
3. Present the result as a clean markdown table.
4. One sentence of insight ("notice that GL X drives N% of the gap alone", etc.).

**The thing to land here**: the CLI did the structural work; the business reasoning is happening *in this conversation*, in SQL, against persisted findings. Different teams could ask different questions of the same database without changing the tool. This is why the CLI doesn't ship with built-in business rules or a fixed report format.

Run this scene as long as the audience is engaged. End it when they're satisfied or the demoer signals to wrap.

## Scene 5 — The handoff (~30 s)

When wrapping up:

```bash
tabrecon document --db recon.db --schema-out /tmp/recon-schema.md
head -40 /tmp/recon-schema.md
```

Show the table list. Final line: *"Every artifact is in plain SQLite. Any agent, any UI, any analyst with SQL — same source of truth, different presentations. The `recon.db` is ready for whoever picks it up next."*

Offer to leave `recon.db` in place so the audience can explore on their own.

## House rules

- Keep narration short — 1–3 sentences per scene; let the tool's stdout speak.
- **Always pause between scenes 1–4** for the demoer to signal continue.
- Scene 4 is the heart — give it real time, don't rush.
- If anyone asks a technical question mid-scene, answer it inline and resume.
- Don't restate what the previous tool output already said.
- If `$ARGUMENTS` says `scene-N`, skip ahead with one sentence of context for what would have happened in the earlier scenes.
