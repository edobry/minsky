# Code-Mechanism-Assertion Detector

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that detects when the prior assistant turn asserts a
named code symbol's runtime **behavior** OR a named tool/service/seam's
**capability, sourcing, or provenance** (a predicate — clamps/defaults
to/overrides/returns/throws/.../sourced from/backed by/... — within
proximity of a symbol-shaped token) without having READ that symbol this
turn (its own file or a grep of it, evidenced by the symbol appearing in
same-turn tool-use input or `tool_result` content). It is the narrow,
high-precision slice of the broader "assertion frozen as fact without
verification" family (root memory `3772c77d`) — narrowness is the precision
lever that keeps false positives low without the broader causal-premise
detector's harder judgment problem.

**Hook file:** `.minsky/hooks/code-mechanism-assertion-detector.ts` (compiled
to `.claude/hooks/code-mechanism-assertion-detector.ts`).

**Canonical case (R9, PR #1694, 2026-06-13):** claimed `executeCommand`
clamps `maxBuffer` to 1MB without reading `exec.ts` — the real default was
10MB, and the actual 850KB payload was never near either limit. The claim
was asserted, not verified.

**Capability/sourcing case (R13, mt#3050, 2026-07-22):** while authoring
mt#3043's spec, asserted "the router suggestion is sourced from the
existing `tasks_route` / `tasks_estimate` seam" without reading
`task-routing-service.ts` — the named component exposes task-GRAPH routing
(`AvailableTask`/`RouteStep`/`TaskRoute`), not model-complexity routing. The
symbol tokens (`tasks_route`, `tasks_estimate`) were already extractable
snake_case/backticked tokens; the gap was that none of the pre-mt#3050
`PREDICATE_PATTERNS` covered sourcing/provenance phrasing ("sourced from"),
only behavior verbs ("clamps", "returns"). See "Sourcing/provenance
predicates" below.

**Detection contract:**

- FIRES when the prior assistant turn contains a predicate pattern
  (`PREDICATE_PATTERNS` — behavior verbs OR sourcing/provenance verbs) within
  `SYMBOL_PROXIMITY_CHARS` (100 chars) of a symbol-shaped token (backticked
  span, camelCase, or snake_case) AND that symbol does not appear anywhere in
  the same-turn verification corpus (read-class tool-use input —
  `Read`/`Grep`/`Glob`/`*_read_file`/`*_grep_search`/`repo_search` — or any
  same-turn `tool_result` content).
- DOES NOT FIRE when the symbol was read this turn, when the predicate+symbol
  pair sits inside a fenced code block or blockquote (pasted output, not a
  fresh assertion), or when the extracted token fails the symbol-plausibility
  filter (see below).

**Symbol-plausibility filter (`isPlausibleSymbol`) — three FP-class exclusions
(mt#3002, 2026-07-21; mt#3042, 2026-07-22):**

- **File-name-shaped tokens** (`FILE_EXTENSION_RE`): a token ending in a
  doc/config extension (`.md`, `.mdc`, `.json`, `.yml`/`.yaml`, `.txt`) is
  excluded — a rule/doc-file reference (`hook-files.mdc`,
  `src/cockpit/CLAUDE.md`) cited next to a mechanism verb is the mt#2619
  echo-of-injected-rule-text class, not an unverified code-mechanism claim.
  Deliberately NOT extended to code-file extensions (`.ts`/`.js`/...): no
  calibration evidence showed a code-extension FP, and no genuine symbol in
  the regression set carries a file extension.
- **Bare hex-id tokens** (`HEX_ID_RE = /^[0-9a-f]{8,40}$/i`): a
  commit-hash-like token (e.g. `a30378971`) that reads as a "symbol" only
  because it starts with a hex letter and is backticked. Genuine
  identifiers (env vars, `snake_case`/`camelCase` function names) do not
  consist entirely of hex digits with no case-mixing or separators.
- **UPPERCASE SQL/DDL keywords** (`SQL_KEYWORDS_UPPER`, mt#3042): backticked
  `ALTER`/`DROP`/`CREATE`/... in a migration/DDL discussion extracted as
  "symbols" near the `drops?` predicate (the 2026-07-21T16:12Z calibration
  record). UPPERCASE-exact matching only — lowercase same-spelled identifiers
  (`create`, `drop` as real method names) still count, and predicates are
  untouched (`drops?` also matches genuine "X drops Y" claims). `postgres`
  joined the prose stoplist in the same change.

**Sourcing/provenance predicates (mt#3050, 2026-07-22) — widening the claim
SHAPE, not symbol extraction:**

The R13 incident exposed a coverage gap that was NOT in symbol extraction
(snake_case MCP tool ids like `tasks_route` were already extractable) but in
`PREDICATE_PATTERNS` itself: all 15 original entries are BEHAVIOR verbs ("X
clamps/returns/throws Y"). A capability/provenance claim about a named
tool/seam — "the router suggestion **is sourced from** the existing
`tasks_route` seam" — matched none of them, so the predicate half never
fired and the (already-extractable) symbol half was never consulted.

Five high-precision sourcing/provenance predicates were added:

- `sourced from`
- `comes from`
- `supplied by` / `supplies`
- `backed by`
- `reads from` / `pulls from` / `derives from`

**Deliberately excluded:** bare `provides` / `exposes`. Both are frequent in
ordinary prose ("this PR provides…", "the module exposes…"), and with
`INJECTION_ENABLED = true` a false positive here is recurring
operator-facing noise, not a silent log line. Add them only on calibration
evidence showing acceptable precision (see the mt#3050 spec's "Revised fix"
section) — the `SYMBOL_PROXIMITY_CHARS = 100` guard is the available
precision lever if that evidence emerges.

**Calibration history:** shipped mt#2486 (tier-2 of the mt#2485 stakes-tiered
reframe) with `INJECTION_ENABLED = false` — logging matches to
`.minsky/code-mechanism-assertion-calibration.jsonl` without injecting
anything, pending an FP-rate review. The 2026-07-21 calibration review (ask
`089320f7`, operator-confirmed) disposed the detector as TUNE+FLIP: FP was
~15-20%, concentrated entirely in the two classes above. mt#3002 closed both
classes and flipped `INJECTION_ENABLED = true` in the same change — the
detector graduates from calibration-only logging to live reminder injection.
The calibration log continues to be written on every match (matched or not
injected is not a distinction the log makes); it remains the audit trail for
future FP review.

A second review round (2026-07-21/22, ask `31eba1bd` / `ask#5343`,
operator-confirmed TUNE) added the SQL-keyword exclusion above (mt#3042). That
review's other proposed tune — suppressing records with
`hadSameTurnRead: true` — was found at implementation time to rest on the
documented mt#2673 field-semantics misreading (the logged claims are
definitionally unbacked; the flag is a turn-level aggregate) and was correctly
NOT implemented; a regression test now pins the claim-level exclusion
semantics instead.

mt#3050 (R13, 2026-07-22) added the five sourcing/provenance predicates above,
closing the capability-claim coverage gap the R13 incident exposed. This
change touches `PREDICATE_PATTERNS` only — symbol extraction, the
`SYMBOL_STOPLIST`, and the mt#3002/mt#3042 exclusions are unchanged.

**On match (now live):** the hook emits a `HookOutput` /
`GuardOutcome.additionalContext` naming each unbacked (symbol, predicate)
claim and directing the agent to read the symbol's source before asserting
its behavior — see `/check-premise`.

**Override:** `MINSKY_ACK_CODE_MECHANISM_ASSERTION=1` (suppresses detection
for the turn, emits an audit line).

**Fail posture:** open — transcript-parse errors, an empty turn, or a
detection exception all return `null` (silent allow), never a thrown error
back to the harness.

**Cross-references:**

- mt#2486 — this hook's origin (tier-2 of mt#2485); handoff memory `964ca2b7`
  named "calibration → injection" as the graduation gate this doc records.
- mt#2673 — truncated-substring extraction fix + turn-level backed-claim
  accounting (`hadSameTurnRead`/`backedClaimCount`), predates and is
  unaffected by the mt#3002 symbol-class exclusions.
- mt#3002 — the file-name/hex-id exclusion + injection-flip change this doc
  primarily describes.
- mt#3042 — the SQL/DDL-keyword exclusion + the ask#5343 tune-1 correction
  (regression test pinning claim-level backed-claim semantics).
- mt#3050 — R13 sourcing/provenance predicate widening (this doc's
  "Sourcing/provenance predicates" section); family log `b0b294ab` records
  R13 itself.
- `.claude/hooks/causal-premise-detector.ts` — sibling pattern (mt#2216) for
  the broader, harder-precision causal-claim family this detector's
  code-symbol slice was carved out of.
- `d9c10ef1` (memory) — RFC: detection-mechanism ladder for the
  guidance-hook family; this hook's Rung-1 regex/proximity approach is a
  concrete instance of the ladder's cheapest-sufficient-first discipline.
- mt#2652 — ADR-028 Phase 2a guard-dispatcher migration; this hook's `run()`
  is the dispatcher-compatible entry point, `main()` is the standalone CLI
  entrypoint the Claude Code harness invokes directly.
