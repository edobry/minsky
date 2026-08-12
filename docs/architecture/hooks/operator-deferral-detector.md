# operator-deferral-detector

Two calibration-first, LOG-ONLY detection surfaces for the **operator-deferral family** —
the agent handing the principal an action it could have performed itself, without first
running the capability probe `user-preferences.mdc §Probe before deferring` requires.

Source: `.minsky/hooks/operator-deferral-detector.ts` (generated copy:
`.claude/hooks/operator-deferral-detector.ts` — do not hand-edit).
Task: mt#2459. Calibration log: `.minsky/operator-deferral-calibration.jsonl`.
Override: `MINSKY_SKIP_OPERATOR_DEFERRAL=1` (skips both surfaces and the calibration write).

## Why this exists

The family survived two rule-tier fixes. R1 (2026-05-13, mt#1811) shipped
`CLAUDE.md §Probe before deferring` and an `/implement-task` §7 step; the family then
recurred at least four more times — R2 (2026-05-20, missing-MCP-tool silent abandon,
mt#1988 added more rule text), R3 (2026-06-02), R4 (2026-06-04), R5 (2026-06-18). The
mt#2448 audit found no visible behavioral inflection at rule tier across four weeks and
recommended a detector surface: the family fires at action-execution time, under execution
momentum, which is exactly when corpus text is not consulted.

R5 is the clearest case. Driving PR #1721 to convergence, the `minsky-reviewer` Railway
service was CRASHED and `reviewer_retrigger` errored for an auth token. The agent opened an
`AskUserQuestion` offering "you recover the reviewer service" / "provide me the MCP auth
token". The probes it skipped took under 30 seconds: `railway whoami` returned
authenticated, and one `railway redeploy` fixed it. The user's response — "why can't you
fix this yourself?" — is the signal this detector exists to produce mechanically.

## The two surfaces

### A. Capability-deferral prose (UserPromptSubmit)

Scans the just-completed turn's assistant prose for capability-deferral phrasing
("requires X access", "deferred to operator", "outside agent context", "you'll need to
provide the token") and fires **only when the same turn shows no probe evidence**.

Probe evidence is any of: a probe-shaped MCP call (`config_get`, `config_doctor`,
`memory_search`, a railway/cloudflare/supabase client, `github get_me`); a **hosted-infra**
skill load (`railway:use-railway`); a probe-shaped shell command (`which`, `whoami`,
`command -v`, `--version`, `auth status`); or an inline probe report in the prose
("Probed: ..."). A deferral that shows its probe results is the CORRECT shape — that is
precisely what the rule prescribes — and must never fire.

**Probe matching is deliberately narrow, and the asymmetry is the reason** (PR #2263 R1). A
false positive here costs one glance at a calibration record; a false _suppression_ silently
hides the exact failure this detector exists to catch. So the skill check is an explicit
prefix allowlist (`PROBE_SKILL_PREFIXES` — railway, cloudflare, supabase, github, …), NOT a
generic `namespace:` shape: namespacing is a catalog-wide convention (`Notion:search`,
`chrome-devtools-mcp:troubleshooting`), so a shape match would let any unrelated skill load
suppress a real deferral. For the same reason the shell pattern excludes `config_get` (an MCP
tool name, already covered by the tool-name path) and a bare trailing `-v` (matches ordinary
verbose/invert flags). Both directions are pinned by tests.

### B. AskUserQuestion option labels (PreToolUse)

Inspects the ask being opened. Fires when an option label offers the principal a fixable
infra/credential action and the in-flight turn contains no probe evidence. Suppressed when
the question reads as a genuine principal-reserved decision (naming, architecture, scope,
preference) — `principal-context.mdc` reserves those, so asking is correct.

This surface exists because **every other detector in the family scans assistant TEXT
only**. R5's deferral lived entirely in structured option labels, so it was invisible to
all of them. mt#1833 originally scoped an `AskUserQuestion` PreToolUse hook OUT as
"over-engineered ... re-evaluate if the skill-step + rule combination still fails"; R5 is
that failure, so the re-evaluate condition is met.

Vendor confirmation for the mechanism (Claude Code hooks reference, read 2026-07-24):
PreToolUse fires "on every tool call inside the agentic loop ... except `EndConversation`
calls", the payload carries `tool_name` + `tool_input`, and the event supports
`permissionDecision: "deny"`. So this surface COULD block the ask before it reaches the
principal. v1 declares `denyCapable: false` — the calibration log decides whether that
power is warranted.

## Scope boundary — what this detector does NOT cover

`substrate-bypass-detector.ts`'s `OPERATOR_INSTRUCTION_PATTERNS` (mt#2303, shipped, also
log-only) owns the **activation-instruction** half of the family: "after your next rebuild,
hard-refresh to see it", "you'll need to edit `cockpit.json`". Those phrasings must NOT be
added here, and this detector's phrasings must not be added there — a double-fire would
double-count one incident across two calibration logs and corrupt both false-positive
rates. `operator-deferral-detector.test.ts` pins this boundary with an explicit
non-duplication test.

The distinction that separates the two:

|               | mt#2303 (substrate-bypass)                                   | mt#2459 (this detector)                          |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Trigger       | work that FOLLOWS a change (rebuild, reinstall, config edit) | a capability the agent claims to LACK            |
| Suppression   | agent-did-it framing                                         | **probe evidence** (an axis mt#2303 has none of) |
| Input scanned | assistant text                                               | assistant text + `AskUserQuestion` `tool_input`  |

The adjacent sibling is `ask-routing-deferral-detector.ts` (mt#2471/mt#2694), which covers
a **decision** being deferred to the principal in chat prose instead of through the Ask
substrate. This detector covers an **action** being deferred. A turn can legitimately fire
both.

## The page says "two surfaces" above; there are now FOUR

Sections A and B predate the two added later. The full set:

**C. Permission-deferral prose (mt#3463)** — "I can, shall I?" rather than "I can't". It
EXCLUDES genuinely destructive or principal-reserved actions, because for those the ask is
CORRECT and firing would train the wrong behavior.

**D. Denial-anchored (mt#3533)** — an escalation or deferral resting on a permission-denied
`tool_result`, with no same-turn retry in a different **command shape** (the leading token
differs, or a compound command became simple).

Surface D is anchored on a STRUCTURED result rather than a phrase, and that is the whole
design. The prose accompanying this failure is third-person about a tool — "the API was
denied" — and the four recorded instances each worded it differently, so no phrase corpus
reaches them. ADR-024's ladder therefore governs the phrase half of the trigger and not the
denial half: a paraphrase-miss argument does not apply to parsing a `tool_result`.

Measured before shipping: 73 permission denials across 460 local transcripts, each an
`is_error: true` `tool_result` opening with one of exactly two canned strings.

**A denial whose stated reason names a security concern never fires** — mem#276's
stop-and-escalate carve-out, where stopping is the correct response. That control is
**SYNTHETIC**: zero of the 73 denials in the local corpus carried a security framing, so the
regression test is built from mem#276's recorded 2026-04-23 reason string and is labeled
synthetic in the test rather than presented as a replay.

### What the matcher does NOT treat as a deferral (mt#3865)

Three calibration windows put the FP rate at 31–43%, roughly half of it in shapes where the
trigger phrase is present but no deferral is being made. Each suppression below is tied to
specific rated records; none was written for a shape that has not fired.

| Suppression                     | Window it reads           | What it removes                                                                                         |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `NEGATION_LEAD_PATTERN`         | 40 chars before the match | A PROHIBITION carrying the phrase — "Don't paste the token into this chat"                              |
| `DESCRIPTIVE_FRAME_PATTERNS`    | match sentence + 1 lead   | A deferral ATTRIBUTED to a document or third party — reported speech, an enumerated `open question (b)` |
| `STANDING_INSTRUCTION_PATTERNS` | match sentence + 1 lead   | Naming a standing instruction AND asking in the same message — the remedy mt#3930 prescribes            |
| `SETTLED_DECISION_PATTERNS`     | match sentence + 1 lead   | An offer attached to a decision already made, on a RESOURCING reason                                    |

**The negation case is the one that matters most.** Both records were the agent refusing to
RECEIVE a secret, which the security rules require — so the advisory fired on correct behavior,
and acting on it would have degraded it. `NEGATION_LEAD_PATTERN` deliberately omits a bare
`not`: "I will not be able to provide the token" IS a capability deferral, and a bare-`not`
pattern would swallow it.

**The exclusion set is matched against two different windows, and that split is load-bearing.**
`PERMISSION_ESCALATION_EXCLUSIONS` is now the concatenation of two exported halves:

- `DESTRUCTIVE_EXCLUSIONS` stays scoped to the match SENTENCE. `/\bproduction\b/i` is a bare
  word, and sentence-scoping is what stops an incidental mention nearby from masking a real
  permission-ask about something else.
- `PRINCIPAL_RESERVED_EXCLUSIONS` reads one sentence further back, via `sentenceWithLead`.
  A reserved-category declaration is naturally written BEFORE the ask — "Both are
  standing-default changes, so I'm not making them unilaterally. Want me to pick mt#3711 back
  up?" — so the sentence-scoped check could not see the very thing making the ask correct.

That list had also gone stale against its own source: `principal-context.mdc §Decisions Eugene
reserves` gained "preferences that set a durable default" via ask#7587 on 2026-08-10, after the
list was written. Fixing the staleness WITHOUT the window widening would have left the
originating record firing — both halves were needed.

**What was deliberately NOT tuned.** The "X unless you'd rather Y" offer shape belongs to
mt#3801, which takes the opposite position on the same sentences in this same file; suppressing
it here would pre-empt that decision. And three turn-end offers to begin the next unit of work
are genuinely unratable — whether they are deferrals or the junction `/disambiguate-next`
covers depends on whether sibling tasks were walkable, which the record cannot show. A
suppression there would silence real positives.

`scripts/replay-operator-deferral-calibration.ts` replays the log through the current matcher.
Read its denominator: records with no `context` (pre-`captureSchema`) and records whose phrase
was truncated out of the 240-char window are reported SEPARATELY from suppressions, because a
record silent for those reasons is not one the tune removed.

### The evaluation stream

The detector writes `.minsky/operator-deferral-evaluations.jsonl` covering ALL FOUR surfaces,
fired or not — the miss RATE is what ADR-024's rung decisions need, and a fire-only log cannot
give it.

Records carry `evaluated: "prose-turn" | "ask-tool-call"`. **Group by that field rather than
pooling**: the two are different denominators — per completed turn versus per `AskUserQuestion`
call — so a pooled rate is not a rate of anything.

Graduation threshold for surface D specifically: a `/calibration-review` pass over >=10
classified fires, per ADR-024's ladder.

## Graduation

Calibration-first per the mt#2057 → mt#2216 → mt#2694 ladder: `INJECTION_ENABLED = false`
in v1, so a match writes a calibration record and injects nothing. Flip only after
`/calibration-review` classifies roughly 10 real fires and reports a false-positive rate.
Both surfaces write to ONE log because they are two detection surfaces on ONE failure
family — the graduation decision needs them measured together. The per-record
`matches[].category` field (`capability-deferral-prose` | `ask-option-label`) is what
distinguishes which surface fired.

Each record carries `source: "live"` — the mt#2554 coverage-receipt field that lets the
coverage gate tell a working detector from a dead one (mem#534: "a detector isn't working
because it shipped — it works only when its fire-log proves it covered its space").

## Cross-references

- mt#2459 (this task) · mt#2448 (the audit that recommended detector tier)
- mt#2303 / `substrate-bypass-detector.md` — the activation-instruction half
- mt#1819, mt#1988 — the rule-tier fixes this escalates past
- mt#1833 — the skill/rule tier that deferred the AskUserQuestion hook pending R5's evidence
- mt#3154 — generalizes probe-before-deferring to the self-improvise (act) path; complementary surface
- mem#582 (R5 incident, replayed as a test fixture) · mem#535 (R2/R4, owned by mt#2303)
- mem#528 — why the tool-interleaved test fixture is mandatory for any turn-scanning hook
