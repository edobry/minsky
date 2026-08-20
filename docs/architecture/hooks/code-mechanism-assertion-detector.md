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

## mt#3113 (2026-07-23) — four injection-layer tuning legs

Operator-confirmed disposition from a calibration review (ask `109807e1` /
ask#5425): the detector was live-injecting at ~70-80% false positives (118+
lifetime fires as of review time). Four fixes, ALL at the INJECTION layer —
none change `detectCodeMechanismAssertion`'s core claim-detection contract
(the `claims` array, `hadSameTurnRead`, and `backedClaimCount` semantics are
byte-for-byte unchanged):

1. **Same-turn-read suppression.** 7 of 14 recent calibration records carried
   `hadSameTurnRead: true` (a DIFFERENT symbol in the same turn was backed,
   per the mt#2673 turn-level aggregate semantics) and still injected.
   `run()`/`main()` now suppress `additionalContext` whenever
   `hadSameTurnRead` is true, logging the reason `"same-turn-read"`. This is
   NOT a reversal of the earlier ask#5343 decision (documented above) to keep
   claim-level detection semantics unchanged — that decision is about what
   counts as a logged `claim`; this is a new, separate gate on top, applied
   only at the point of deciding whether to show `additionalContext`.
2. **Symbol plausibility.** Generic English/tech-term words (`since`,
   `description`, `macOS`, `CommonJS`) and bare directory references
   (`target/`) were extracted as "symbols" because `BACKTICK_SYMBOL_RE`
   accepts any backtick-quoted span with no requirement that it read as a
   genuine project identifier. Extends (not replaces) mt#3002's
   `SYMBOL_STOPLIST` with `since`/`description`/`macos`/`commonjs`
   (case-insensitive), and adds a new `BARE_DIR_REF_RE` exclusion for a
   single path segment plus exactly one trailing slash (`target/`, `dist/`,
   `build/`) — multi-segment paths (`src/exec.ts`) and code-extension
   filenames remain unaffected.
3. **Relay-context suppression.** The detector fired on claims RELAYED from
   a dispatched subagent's own report — the subagent performed the read, the
   parent turn merely quotes/paraphrases its findings. `buildRelayCorpus`
   correlates same-turn `Agent`/`Task`/`SendMessage` tool_use calls with
   their `tool_result` by `tool_use_id`; `detectRelayContext` suppresses
   (reason `"relayed-subagent-content"`) whenever ANY such report landed
   this turn — deliberately NOT gated on the claim's literal symbol text
   appearing in that report, because a claim whose symbol IS literally
   present in a same-turn tool_result (dispatch or not) is ALREADY excluded
   via the pre-existing `buildVerificationCorpus` backing mechanism before it
   ever reaches `detectRelayContext`; gating on that overlap would be
   unreachable dead code. A second, independent signal
   (`RELAY_PREAMBLE_PATTERNS`, reason `"relayed-preamble-phrase"`) catches
   the cross-turn case — the subagent completed in an EARLIER turn and this
   turn merely narrates its already-reported findings, which the same-turn
   tool_result correlation cannot see.
4. **Per-claim-set dedup.** An identical 4-symbol claim set re-fired
   (re-injected) on nearly every turn for ~10 hours in one session — the
   turn-scoped scan re-matches the same claim set every time the assistant
   repeats it. `code-mechanism-assertion-dedup-store.ts` (new file, mirrors
   `guard-health-escalation-notify-store.ts`'s mt#3072 per-session cooldown
   pattern) suppresses re-injection of an unchanged (claim-set signature,
   session) pair within a 1-hour cooldown, reason `"deduped"`.

All four suppressions compose independently via `computeSuppressionReasons`
and are recorded in the calibration record's new `suppressionReasons:
string[]` field (empty when nothing suppressed) alongside a new
`claimSetSignature: string` field — every suppressed fire still logs, so
calibration review can grade the suppressions themselves, not just the
underlying detection. Pre-existing calibration fields (`claims`,
`hadSameTurnRead`, `backedClaimCount`) are unchanged.

**On match (now live), when NOT suppressed:** the hook emits a `HookOutput` /
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
- mt#3113 — the four injection-layer suppression legs above (same-turn-read,
  symbol-plausibility extension, relay-context, per-claim-set dedup);
  disposition record ask `109807e1` (ask#5425).
- `.claude/hooks/code-mechanism-assertion-dedup-store.ts` — mt#3113 leg 4's
  cooldown store, structurally mirroring
  `guard-health-escalation-notify-store.ts` (mt#3072).
- mt#3072 — `guard-health-escalation-notify-store.ts`, the per-session
  cooldown pattern mt#3113 leg 4 mirrors.
- `.claude/hooks/causal-premise-detector.ts` — sibling pattern (mt#2216) for
  the broader, harder-precision causal-claim family this detector's
  code-symbol slice was carved out of.
- `d9c10ef1` (memory) — RFC: detection-mechanism ladder for the
  guidance-hook family; this hook's Rung-1 regex/proximity approach is a
  concrete instance of the ladder's cheapest-sufficient-first discipline.
- mt#2652 — ADR-028 Phase 2a guard-dispatcher migration; this hook's `run()`
  is the dispatcher-compatible entry point, `main()` is the standalone CLI
  entrypoint the Claude Code harness invokes directly.

## Surface expansions since mt#3113 (ported from the rule index, mt#3667)

The detector originally watched **assistant chat prose only**. Three later tasks widened what it
reads. Each is recorded here because the rule index carried this detail and nothing else did.

### mt#3489 — writing a symbol no longer backs a claim about it

A write tool's `tool_result` echoes the payload the agent just authored. That echo used to land in
the verification corpus, so a claim about just-written code was suppressed as `same-turn-read` —
indistinguishable from a claim backed by an actual read. Measured: 108 of 298 records carried that
reason, 58 by it alone.

Write-class results now route to a **separate corpus** and suppress under `write-echo-backed`
instead. Injection behavior is UNCHANGED — both still suppress. The split makes the
authorship-as-verification class countable, which is the precondition for deciding whether it
should surface at all. A `tool_result` whose originating tool cannot be identified still counts as
a read.

### mt#3571 — comments the turn ADDED are scanned (log-only)

A claim written into a code comment reads as the justification for the code beside it, and was
never examined. Comment lines a write payload **adds** now run through the same claim detection; a
comment that merely **moved** (present on both sides of a search/replace) does not, since
relocating a comment is not asserting it.

**Log-only** — this pass never reaches the injection branch. Recorded as `commentSurfaceClaims` /
`commentSurfaceClaimCount`. A record whose ONLY claims are comment-surface also carries the
`comment-surface-only` suppression reason. That label is required, not cosmetic:
`isSuppressedRecord` is `suppressionReasons.length > 0`, so an unlabeled record would be counted
as an operator-facing fire it never was, and would drive the review cadence on false input.

Expect a higher FP rate here than on the chat surface — comments are denser in symbol names and
legitimately describe mechanism. Measure before proposing to wire it.

### mt#3642 — durable artifacts are the third surface (log-only)

Everything an agent writes for the record — a PR body, a task spec or spec patch, a memory, an
ask's question — reaches the transcript as a `tool_use` **input**, not as assistant text. So the
same sentence was watched in chat (ephemeral, contradictable) and unwatched in the artifact
(durable, read later as justification).

mt#3092's false socket-contract claim was in a PR body and produced **no record at all** — that
outage was not a suppression failure, and mt#3594's problem statement was corrected on that basis.

The prose bodies of artifact-authoring tools are now a third pass, recorded as
`artifactSurfaceClaims` / `artifactSurfaceClaimCount` under the `artifact-surface-only` reason,
log-only on the same terms as the comment pass. Scoped to artifact-authoring tools, NOT all
write-class tools — an ordinary source edit stays the comment pass's job.

It reads BOTH `tool_use` shapes: a top-level line carrying `name`/`tool_name` + `input`, and a
block nested in an assistant message's `content`, matching `extractToolUseNames`. Handling only
the nested shape made top-level-recorded turns invisible (PR #2584 R1). **The comment pass still
has that gap — tracked as mt#3650.**

### mt#4106 — measured: an identity claim reaches the matcher and matches nothing

The artifact surface was asked the direct question — did it fire on two spec claims with known
ground truth? — and the answer is no, for a reason that turns out not to be about the artifact
surface at all.

On 2026-08-13 two specs asserted `readResidentBytes` in `src/mcp/orphan-exit.ts`, a symbol that has
never existed in this repo (the real reader was `getCurrentProcessResidentBytes`), and asserted that
`src/mcp/memory-capture.ts` reads the same quantity, when that module reads nothing and takes
`getResidentBytes` as an injected dependency. Both were written through `tasks_create` /
`tasks_spec_patch`, both on `ARTIFACT_TOOL_RE`. `/plan-task`'s gates (e) and (h) caught both.

**What the log says.** `.minsky/code-mechanism-assertion-calibration.jsonl` holds exactly one record
containing the string `readResidentBytes` (2026-08-13T17:15:27Z), and it carries the string only in
`judgedInput` — the chat text. No record in the log carries the symbol in `artifactSurfaceClaims` or
any other claim list. The hook was live throughout: the same session wrote records at 16:35, 16:39
and 17:15, and the artifact surface fired on 20+ turns across that day.

**What the replay says.** `scripts/replay-artifact-surface-claims.ts` runs four reconstructed bodies
through `buildArtifactProseCorpus` → `detectCodeMechanismAssertion`. Every one:
`extracted: true, matched: false, claims: []`. Every positive control — the same sentence with
`returns` or `reads from` spliced in, naming the same symbol — matches. So the corpus is fine, the
symbol extraction is fine, and the absence is real rather than a broken harness.

**The mechanism.** All 21 `PREDICATE_PATTERNS` entries are behavior verbs (`clamps`, `returns`,
`throws`, `enforces`, `ignores`, …) or mt#3050's five sourcing verbs (`sourced from`, `comes from`,
`supplies`, `backed by`, `reads/pulls/derives from`). The instances assert **identity or
equivalence** — "`X` is the single reader", "`X` is converted to it", "`X` is expressed in the same
unit against the same reading" — which name neither a behavior nor a source. `symbolsNear` only ever
runs within ±100 chars of a predicate match, so with no predicate there is no anchor and no claim.

Three consequences worth carrying:

1. **This is not an artifact-surface property.** All three surfaces call the same
   `detectCodeMechanismAssertion`, so the class is invisible in chat and in added comments too.
2. **It is a fourth blind spot, not one of the three known ones.** mt#3775 and mt#3726 are
   symbol-FREE claims and mt#4084 is a verification-corpus gap; here the symbol is present and
   extracted, and the predicate is what is missing.
3. **The enforcement-posture question does not arise on this evidence.** Promoting the artifact
   surface from log-only to injecting would have changed nothing here — a surface that produced no
   claim has nothing to enforce. Tracked as mt#4155, which places the class on ADR-024's ladder.

**Absence in this log is weak on its own.** A record is written only when at least one of the three
surfaces matches, so a turn where nothing matched leaves no row — and mt#3649's `judgedInput`
captures only the chat surface's elided text, so even an existing row does not preserve the artifact
corpus that was judged. That is why the replay above exists and why it ships as a script: the log
alone cannot distinguish "never extracted" from "extracted and matched nothing."

## mt#4157 (2026-08-16) — the 80% pass: round 6, and a decision not to widen backing

The 2026-08-14 calibration pass hand-classified all 10 injected fires in its window: **8 false, 1
real, 1 uncertain**. Two things came out of it, and the more useful one is the half that shipped no
code.

### What the 8 false positives actually were

Only ONE is a symbol-identification defect. The other seven are the verification corpus not reading
evidence that exists:

| Class                                  | Count | The backing that exists, and where                                      |
| -------------------------------------- | ----- | ----------------------------------------------------------------------- |
| Agent's own same-turn prose            | 3     | the sentence itself — "re-running gave `descendantsRequiredSigkill: 1`" |
| Tool INPUT rather than its result      | 2     | `expectedHeadSha`, a parameter of a tool the turn called                |
| The branch diff                        | 2     | the PR being reported had just shipped the mechanism                    |
| **Extraction — a URL query parameter** | **1** | nothing; no claim was made                                              |

That regrouping matters more than the count. **Seven of eight share one root cause**, so they are
one defect at three sources rather than four independent classes — recorded on mt#4084, which owns
the tool-input case and is the natural home for the widening question.

#### Where the tool-input case went, and why it was not implemented here

Recorded in-repo rather than only on the task, so a reader of this file can check the disposition
without querying the task store (PR #3031 R1).

mt#4084 already owns it, and **no rescope was required**: that task's `## Scope` names corpus
construction and says it "adds a backing SOURCE", which covers a tool's declared PARAMETER as
naturally as its NAME — only its title is narrower than its scope. `expectedHeadSha` fails for
exactly the reason a tool name does: the corpus carries `tool_result` bodies and read-class inputs,
and a parameter lives in the tool INPUT, which it does not collect.

So this task added a finding to mt#4084 naming the parameter case explicitly inside that existing
scope, together with the branch-diff and prose cases and the argument that separates them: a tool
input and a branch diff are MACHINE-RECORDED, so admitting them cannot be gamed by an agent
asserting confidently, while the agent's own prose can be — which is why the first two are safe to
widen toward and the third is not. Rescoping another task unilaterally was declined; its own
planning pass settles the widening.

### Round 6 — the URL-query-parameter exclusion

`cc_cli_limit_message` was extracted from Claude Code's own spend-limit banner, pasted into the
transcript: `raise it at claude.ai/settings/usage?from=cc_cli_limit_message`. `SNAKE_CASE_RE`
matched the query-parameter value and paired it with the nearby words "limit" and "raise".

The exclusion is **window-aware**, like mt#3540's override-boilerplate predicate and for the same
reason — it needs the surrounding slice, so it cannot live in the token-only `isPlausibleSymbol`.
A token is dropped only when EVERY occurrence in the slice sits inside a URL query span, so an agent
who also names the identifier in prose still fires.

Scoped to query parameters and NOT to "quoted third-party text", which the originating spec also
named: nothing in the text marks its author, and the fixture's banner is not quoted or fenced at
all. Path segments are likewise left alone — no record has fired on one, and a predicate written
ahead of evidence is the arms race ADR-034 is about. A test pins that scope limit so a later
widening breaks a test rather than drifting.

**ADR-034's reopen conditions were checked before the predicate was written**, which its
§Consequences requires. None fires. The one that looks triggered by the headline 80% is condition 2
("a measured FP rate above 10% on a classified corpus"), and it is not: it asks whether the
mechanism ADR-034 KEPT is failing, and the rejected allowlist would have fixed this single record
while ADMITTING the other seven — their symbols are all real. Mechanism-attributable rate: 1/10.
Condition 1 needs rounds 6 AND 7 inside 5 days; **round 6 landed 2026-08-16, so a round 7 before
2026-08-21 reopens ADR-034.**

### The agent's own prose is NOT backing — decided, no code

Three of the eight arrived with their evidence in the same sentence, which is why they look like the
detector's worst misses. Admitting prose was rejected as circular: an agent could back any claim by
asserting confidently, and suppression would land exactly on "I checked".

The narrower variant — "an observation naming a value the tool corpus ALSO contains" — needs no code
because it is already what the corpus does. The records show it working: `descendantsRequiredSigkill`
fired 2026-08-13T16:39Z with `hadSameTurnRead: false, backedClaimCount: 0`, and the SAME symbol was
suppressed at 17:15Z once a real read existed. All three class members carry
`backedClaimCount: 0` — there was no tool evidence in the turn to admit.

What remains is a WINDOW question, not a prose one: if the read happened an earlier turn in the same
session, the evidence is machine-recorded and merely out of frame. That is ask#6817's session-scope
disposition, owned by **mt#3594** and gated there on per-claim backing landing first. Full reasoning
sits in `buildVerificationCorpus`'s doc comment so the next calibration pass does not re-litigate it.

### Measured effect

Replayed with `scripts/replay-code-mechanism-calibration.ts` over all 846 records, before and after:

|        | same | changed |
| ------ | ---- | ------- |
| before | 68   | 43      |
| after  | 67   | 44      |

**Exactly one record moved**, and it is the intended one (`2026-08-13T20:33:23.738Z`,
claims `cc_cli_limit_message|limit` + `cc_cli_limit_message|raise`). Nothing stopped changing, so
there is no collateral. Injected fires in the classified window go **10 → 9** and false positives
**8 → 7**.

The FP rate barely moves, and that is the honest result rather than a disappointing one: 7 of the 8
belong to the corpus class this task does not own.

## mt#4084 (2026-08-16) — the same-turn tool CALL RECORD is backing

The corpus class mt#4157 handed on. `buildCorpora` collected read-class tool INPUT VALUES and
`tool_result` CONTENT — so a claim whose symbol is a tool the turn actually CALLED was unbacked by
construction, and so was a claim about one of that call's declared PARAMETERS. Two mechanisms, one
root:

- `collectStrings` walks `Object.values`, so a parameter NAME never entered the corpus. That is why
  `expectedHeadSha` fired three times.
- `READ_CLASS_TOOL_RE` gates input collection to `Read`/`Grep`/`Glob`-class tools, so `refs_status`,
  `tasks_get` and `session_pr_wait-for-review` contributed nothing at all.

### The admission test, and what it excludes

The criterion is not "machine-recorded" — a branch diff is machine-recorded too. It is **the agent
cannot produce it by asserting**. A tool NAME in a `tool_use` block attests the harness ran it. A
parameter KEY is further attested by the MCP boundary, which REJECTS undeclared parameters
(mt#2778), so a key present in a call that succeeded was schema-validated rather than typed.

Excluded, deliberately, each pinned by a test:

- **The agent's own prose** — settled by mt#4157 above as circular. Not reopened.
- **Parameter VALUES of non-read-class tools** — the agent CHOOSES a value, so admitting it is the
  write-echo inversion mt#3489 split out. Read-class input values stay admitted on the existing
  rationale that a path or query evidences an inspection.
- **The branch diff** — passes the authorship test, fails on cost: a `UserPromptSubmit` hook with a
  per-invocation budget, and the read is unbounded relative to the tool calls already being parsed.
  Unowned as of this task (`tasks_search` found no covering task); filed rather than absorbed.

### SC2 needed no code

Backing is a substring test (`corpusLower.includes(sym.toLowerCase())`), so `mcp__minsky__refs_status`
in the corpus already backs a claim written as `refs_status`. No prefix-stripping or alias layer was
built, and a test pins that so nobody adds one believing it was required.

### Measured — and why the obvious harness could not measure it

`scripts/replay-code-mechanism-calibration.ts` states its own bound: it replays claim EXTRACTION, not
BACKING, and runs the detector against an **empty corpus**. A corpus-only change is invisible to it —
it reports every record `same`, which reads as "no collateral" and means "the probe cannot see this"
(mem#704). `scripts/replay-code-mechanism-backing.ts` closes that without taking the retention
decision that script declined: it reconstructs each turn's tool calls from the transcript store and
joins by EXACT hash — `hashJudgedText(elideBlocksAndQuotes(assistantText))`, the same value the
capture records. **139 of 139 capture-bearing records joined, 0 unjoinable**, against 4,615 indexed
turns.

Result: **9 records changed, 11 claims newly backed.** Read individually, as the criterion requires:
three `expectedHeadSha`, one `refs_status` (the originating fire), `overrideReason` ×2, `notBefore`,
`session_pr_create` + `headSha` — all claims about a call the turn made. The two that looked like
over-suppression are not: `tasks_create|guards` sits in a turn that was explicitly reading the
implementation ("four `tasks_create` guards" — a noun, not a mechanism predicate), and
`git_search|trim` is a cross-sentence predicate mis-attribution in a turn that did call the tool.

### A test that could not fail, caught by its own control

The first draft of AT5 invented the sentence "`expectedHeadSha` is compared against the remote head."
Its predicate is not one the detector recognizes, so the test asserted the ABSENCE of a claim that
was never extracted and passed identically with the change reverted. The negative-control run
surfaced it — 3 failures where 4 were expected. The fixture is now verbatim from the record, and each
AT that asserts backing carries a paired assertion that the same input FIRES against the pre-mt#4084
corpus, so the vacuous form cannot come back.

## mt#4155 (2026-08-17) — identity claims routed to ADR-024 Rung 2

mt#4106 measured the gap; this closes it. The class is a claim asserting a symbol's IDENTITY or
EQUIVALENCE — "`X` is the single reader", "`X` is converted to it", "expressed in the same unit
against the same reading". `symbolsNear` extracts the symbol perfectly and no predicate anchors it,
so `detectCodeMechanismAssertion` returns `claims: []` on all four measured fixtures.

### Why not another predicate pattern

ADR-024 governs this decision, and the obvious fix is the one it exists to prevent.

- **Rung 1 cannot cover this class.** ADR-024's Rung 1 is a quotation/citation-aware elision
  PREFILTER targeting the PRECISION axis. Eliding quoted spans does not make an identity sentence
  match a behavior verb; there is no precision problem here to fix.
- **Adding identity verbs to `PREDICATE_PATTERNS` is neither rung.** It is the pre-ladder move
  ADR-024 §Context names as the anti-pattern: "each miss has historically been answered by adding
  another regex family (R1 -> R5) — an arms race."
- **Rung 2 is the ladder's only recall mechanism**, and its evidence gate is "a measured recall-miss
  rate", which mt#4106 supplies (4 of 4 fixtures `MISS-AT-MATCHER`, each with a passing positive
  control).

The Rung-2 precondition mt#4155's spec carried — mt#3862's finding that 85% of nominations degrade
to `timeout` — was re-measured at planning time and does NOT hold at current conditions: 6 of the
last 200 `retrospective-trigger` nomination attempts degraded (3%), with 193 of 200 producing a
non-empty `nominated_families`. The full measurement is in mt#4155's `## Planning Audit (READY)`.

### Shape

`detectCodeMechanismAssertion` stays SYNCHRONOUS and unchanged — every existing test of it passes
untouched. The Rung-2 pass is a separate, injected seam beside it:

- `IDENTITY_CLAIM_EXEMPLAR_SET` — six exemplars phrased WITHOUT a concrete symbol, so the embedding
  scores the claim's grammar rather than biasing toward turns that mention one identifier.
- `identityClaimsFromSegments(segments, verificationCorpus, writeEchoCorpus)` — pure. Applies the
  SAME backing rules as the lexical path, so a symbol read this turn is excluded at claim level and
  the two rungs cannot disagree about the same turn.
- `augmentWithIdentityNomination(base, text, corpus, writeEcho, nominator?)` — merges rather than
  replaces, because a turn can carry a behavior claim AND an identity claim. Never throws: a
  degraded or throwing nominator returns the Rung-1 result with `nominationDegradedReason` set,
  which is ADR-024's fail-to-Rung-1 invariant rather than a silent skip.
- `createIdentityClaimNominator()` — the real-wired one, mirroring `createSkillNominator`
  (mt#3772): lazy deps behind `ensureHookDomainBootstrap`, and a LATCHED failure so one wedged
  provider costs one round-trip per process rather than one per turn.

`run()` is now `async`. The dispatcher already did `await mod.run(...)`, so this is
backward-compatible; the change to callers was mechanical (`await` at 14 test call sites).

### On a hook importing domain modules directly

This hook now imports `packages/domain/src/detectors/embedding-nomination{,-factory}`. That is the
ESTABLISHED direction for this family, not a new boundary crossing: ADR-024 places the ladder "on
the shared `packages/domain/src/detectors/` framework so all guidance hooks consume one mechanism
instead of divergent regex copies", and `knowledge-acquisition-detector.ts` already imports the
same two modules the same way (mt#3772). A hook-local copy of the nomination logic is the outcome
that ADR would forbid.

What the crossing costs is real and is paid explicitly: a hook is its own entry point, inheriting
neither the reflect polyfill nor process-global configuration, which is why the nominator resolves
its deps behind `ensureHookDomainBootstrap` inside a try/catch. `custom/require-hook-domain-bootstrap`
enforces exactly that for this tree, so the layering constraint is mechanized rather than left to
review.

### Enforcement posture

Ships DISABLED. The nominator is constructed only when `MINSKY_CMA_RUNG2_NOMINATION` is set
(registered `tunable`, mirroring `MINSKY_KA_RUNG2_NOMINATION`), and
`augmentWithIdentityNomination` short-circuits on an undefined nominator — so with the flag unset
every surface returns byte-identically what it returned before.

Two reasons, not caution-in-general: `DEFAULT_SIMILARITY_THRESHOLD` (0.455) was derived from the
retrospective-trigger exemplar band and nothing has measured where identity-claim cosines live in
THIS corpus; and enabled, each turn costs a provider round-trip per surface.

Every calibration record now carries `identityDetectionRung` and
`identityNominationDegradedReason`. Without them a Rung-2 pass that never ran is indistinguishable
from one that ran and nominated nothing — which is exactly the distinction the promotion decision
turns on.

### What the tests do NOT establish

The regression fixtures exercise the PURE seam with an injected nominator, so they prove the
segment-to-claim mapping and the fail-to-Rung-1 behavior. They say nothing about whether the real
embedding actually scores these four segments above threshold — that is the live run, and it is a
separate claim with separate evidence.

## Rung 2, second cohort: symbol-FREE claims (mt#3726)

### Why this is not more exemplars in the identity family

mt#4155's class is symbol-**bearing** and predicate-free: `symbolsNear` extracts `X` from
"`X` is the single reader" perfectly, and only the predicate match fails. That is why its claims
still render as `(symbol, predicate)` pairs and its nominated segments still pass through symbol
extraction.

This cohort names no symbol at all. Measured 2026-08-19 by calling `symbolsNear` directly on one
sentence per class — every one returns `[]`, against controls (`escapeLikeLiteral returns …`,
`AgentSpawnsPipeline wires only runForSession`) that extract theirs. So the two cohorts differ in
their claim MODEL, not just their exemplar text, and the wrapper had two hard blocks against
carrying this one:

1. `augmentWithIdentityNomination` returned the Rung-1 result early when no symbol was extractable
   — correct for the identity family, fatal for a cohort whose defining property is exactly that.
2. `identityClaimsFromSegments` builds claims by extracting symbols from each nominated segment, so
   a symbol-free segment yielded zero claims even when nominated.

### The five families

| Family                      | The claim                                                                | Origin                 |
| --------------------------- | ------------------------------------------------------------------------ | ---------------------- |
| `invocation-path-positive`  | a caller exists and will run this later, unprompted                      | mt#3708 / mem#873      |
| `invocation-path-negative`  | no automatic caller exists; a human must run it                          | mem#873 R2             |
| `subsystem-property`        | a property of a subsystem, asserted from the one component that was open | mem#1087               |
| `external-system-mechanism` | how a third-party system behaves, relayed rather than read               | mt#3726 §Sibling shape |
| `log-attribution`           | an observed log line attributed to the code path under investigation     | mem#1123 R9            |

The negative sign is its own family rather than more exemplars on the positive one because mem#873
weights it HIGHER: a false "it self-heals" fails silently, while a false "you'll need to run X
manually" actively spends the principal's attention on a step the system already performs. Separate
families let calibration measure the two rates apart.

### Enforcement posture, and the one thing to know when reading its first records

Recorded, never injected — the same treatment the comment and durable-artifact surfaces get, and
for the same reason: this cohort's false-positive rate has to be measurable on its own before
anyone proposes wiring it. Concretely, a symbol-free nomination does NOT flip `matched`, because
`matched` drives the injection branch and `buildInjectionReminder`, both of which name a symbol
back to the agent.

**There is no suppression for this cohort, and that is a known over-fire source rather than an
oversight.** The existing backing rule is `verificationCorpus.includes(symbol)` — there is no
symbol here to look up. The candidate replacement is mem#1087's tractable signal (the falsifying
FILE is nameable from the claim, even though the symbol is not), which is a materially larger
mechanism than an exemplar set; mt#3594 owns the suppression-granularity question it would consume.
Read the first calibration records with that in mind rather than treating the raw fire count as a
false-positive rate.

Two switches, deliberately separate. `MINSKY_CMA_RUNG2_NOMINATION` turns the whole embedding path
on (still disabled by default, for the threshold reason above). `MINSKY_SKIP_SYMBOL_FREE_CLAIMS`
turns this cohort back off while leaving mt#4155's identity family running — so a review that finds
this cohort noisy can quiet it without reverting a family whose records are clean.

Records carry `symbolFreeClaims`, `symbolFreeClaimCount` and `symbolFreeFamilies`. The first is
`undefined` rather than `[]` when nothing nominated, which keeps a pre-mt#3726 record
distinguishable from a turn where the cohort ran and found nothing — the same distinction
`identityDetectionRung` exists for. A record whose ONLY content is a symbol-free nomination carries
the `symbol-free-cohort-only` suppression reason, because `isSuppressedRecord` treats an unlabeled
record as an operator-facing fire and would otherwise inflate the count that drives review cadence.

Both entry points gained the widened admitting condition together. mt#4155's R2 fix (PR #3128) was
that the standalone CLI path had been left on Rung 1 while the dispatcher path moved; the same
divergence would have stranded this cohort.

### What the tests do NOT establish

As with mt#4155: the unit tests inject a stub nominator, so they establish the family-routing, the
separate claim channel, the `matched` invariant and the fail-to-Rung-1 behavior. They are
structurally silent on whether the real embedding scores these sentences above threshold against
these exemplars. That is `scripts/verify-symbol-free-nomination.ts`, which reports per-family
cosine scores rather than a bare verdict — the threshold is itself unmeasured on this corpus, so
the scores are the measurement a calibration review needs in order to pick one.
