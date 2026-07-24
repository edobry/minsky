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
`memory_search`, a railway/cloudflare/supabase client, `github get_me`); a service-scoped
skill load (`railway:use-railway`); a probe-shaped shell command (`which`, `whoami`,
`command -v`, `--version`, `auth status`); or an inline probe report in the prose
("Probed: ..."). A deferral that shows its probe results is the CORRECT shape — that is
precisely what the rule prescribes — and must never fire.

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
