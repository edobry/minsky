# operator-deferral-detector

Calibration-first, LOG-ONLY detection surfaces for the **operator-deferral family** —
the agent handing the principal an action it could have performed itself, without first
running the capability probe `user-preferences.mdc §Probe before deferring` requires.

**There are SIX surfaces; sections A and B below were the original two.** The full set is
enumerated under "The page says two surfaces above" — read that before assuming this page's
opening sections are the whole detector.

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

## The page says "two surfaces" above; there are now SIX

Sections A and B predate the four added later. The full set:

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

**E. Ask-justification capability-absence (mt#3999)** — an `asks_create` the router sent to
the **operator**, whose justification asserts a named capability, credential, tool or flag
does not exist, in a turn that consulted **fewer than two distinct channels**.

**F. Act-path workaround (mt#4081)** — a destructive command in a turn containing NO capability
search. The only surface here that reads no prose at all: both legs are tool-call state. Its
own section at the end of this page carries the measured surface-E miss that produced it, and
its blocking sibling is the `block-bulk-process-kill` guard.

Three things about this surface are easy to get wrong later, so they are recorded here.

**It does NOT suppress on `hasProbeEvidence`, deliberately.** On its own anchor instance the
agent HAD probed — it called `config_credentials_list`, which is on that function's probe list
— and that call is exactly what produced the false premise, returning exit-0, well-formed JSON
that silently omitted the provider. Suppressing on "did it probe at all" would blind this
surface to the only incident it exists for. What was missing was a SECOND, independent channel
(`ai_providers_list` and `ai_validate` both reported the credential present the whole time), so
the conjunct counts DISTINCT channel families instead — `config-store` and `provider-validate`
are different channels; two calls to the config store are one. Erring toward firing follows this
detector's stated asymmetry: a false positive costs a glance at a record, a false suppression
hides the failure silently.

**The routed-outcome conjunct reads the RESULT, not the input.** `asks_create` has no
`routingTarget` parameter — routing is computed downstream by `policyFirstRoute` from kind +
severity plus a policy phase — so the input side is genuinely blind to it. The result is
`RoutedAsk | SuspendedAsk | ElicitationClosedAsk` and all three carry the field, joined to the
call by mt#3918's `findToolCallsWithResults`. A **policy-covered ask is EXCLUDED** rather than
counted: it short-circuits to closed with `routingTarget: "policy"`, never reaches a human, and
so spends none of the attention this surface is about.

**Its phrase family is a THIRD one, not a widening of an existing corpus.** Measured before
shipping, by running both existing corpora against the two recorded instances: surface A's
`CAPABILITY_DEFERRAL_PATTERNS` matches NEITHER, and mt#3918's `NEGATIVE_EXISTENCE_PATTERNS`
matches neither either. The shapes are distinct — surface A is deferral of an ACTION ("requires
Railway access"), mt#3918 is absence of CALLERS ("nothing calls onProgress"), this is absence of
a CAPABILITY ("I have no OpenAI key"). A test pins the mutual non-coverage in both directions,
so a future widening of any of the three cannot silently start double-firing on one sentence.

The anchor is **n=1** and the spec says so: only the credential instance (2026-08-01, mt#3547,
ask#6754) occurred at an ask. The 90-minutes-later bun `--changed` instance was chat prose plus
a build decision, with no ask at all — it belongs to surface A's population and is retained as
evidence about the FAMILY's rate, not as a fixture. n=1 is proportionate because the increment
is a surface on an existing detector; it would not carry a fifth standalone detector.

Surface E's advisory has **its own directive**, per `guard-feedback-authoring.mdc §The directive
has to fit the shape of the fire`. The generic branch says "run the capability probe", which on
this surface is the wrong instruction and invites reading a true positive as a false one — so
surface E is excluded from that branch and names the concrete second channel for the claim's
subject instead.

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
At the symbol level: the single `PERMISSION_ESCALATION_EXCLUSIONS` array is GONE, replaced by two
exported arrays the matcher checks separately. No aggregate of the two is exported — an aggregate
nothing matches against would describe neither window, which is the whole point of the split. The
two halves:

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

The detector writes `.minsky/operator-deferral-evaluations.jsonl` covering ALL SIX surfaces,
fired or not — the miss RATE is what ADR-024's rung decisions need, and a fire-only log cannot
give it.

Records carry `evaluated: "prose-turn" | "ask-tool-call"`. **Group by that field rather than
pooling**: the two are different denominators — per completed turn versus per `AskUserQuestion`
call — so a pooled rate is not a rate of anything.

**Surface E did NOT add a third value, and that is a judgment about what the field means**
(mt#3999). `evaluated` names the GRAIN that was evaluated, and surface E's grain is the completed
turn — it runs in the same `UserPromptSubmit` pass as A/C/D. Its population is narrower (turns
that created an operator-routed ask), and a population is a filter on a denominator, not a
different one. So a qualifying turn still produces exactly ONE record, which carries an
`ask_justification: {operatorRoutedAsks, absenceClaimPresent, distinctChannels}` object. Recover
surface E's population by filtering on `operatorRoutedAsks > 0`; `distinctChannels` is the
suppressing conjunct, so it is what a miss-rate review reads.

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
- mt#3999 — surface E (ask-justification capability-absence); matcher in
  `packages/domain/src/detectors/capability-absence-escalation.ts`
- mt#3918 / `negative-existence-claim-detector.md` — the sibling absence-of-CALLERS detector,
  whose `findToolCallsWithResults` join surface E reuses; the two corpora are pinned
  mutually non-covering by test
- mem#804 — the family's bridge memory, whose budget this slice spent
- mem#582 (R5 incident, replayed as a test fixture) · mem#535 (R2/R4, owned by mt#2303)
- mem#528 — why the tool-interleaved test fixture is mandatory for any turn-scanning hook

## Surface F — act-path workaround (mt#4081)

**Trigger:** a kill (`kill` / `pkill` / `killall`) that was NOT denied and names more than one
target, in a turn that contains no capability search (`WebSearch`, `WebFetch`, or a `Skill`
load). Every leg is tool-call state; **no prose is read**.

The target and denial legs were added by mt#4111 after the surface produced five live fires in
its first four days and all five were rated false — see §The mt#4111 tune below.

### Why it is not a sixth phrase family

Surfaces A–E all key on something the agent SAID. The act path says nothing — the agent concludes
a capability is unavailable and quietly builds around it. On 2026-08-13 (mem#707 R8) surface E
evaluated exactly such a turn and scored it `fired: false`:

```
evaluated: "prose-turn"   fired: false   surfaces: []
ask_justification: { operatorRoutedAsks: 0, absenceClaimPresent: false, distinctChannels: 1 }
```

`distinctChannels: 1` was CORRECT — the turn probed one channel. The leg that failed was
`absenceClaimPresent`: the turn's two absence claims ("a no-op, so that path is out"; "I don't
know of a scripted path for it") matched no pattern in the corpus.

Widening that corpus is the response ADR-024 §Context names as the anti-pattern ("R1 → R5 — an
arms race"). So surface F keys on the two facts that need no matching at all: the destruction
happened, and no search preceded it.

### What it deliberately does not fire on

An agent that searched and then destroyed made an informed choice — the absence of the search is
what makes the shape reportable, not the destruction. A turn containing any capability-search tool
call is silent.

### Blocking sibling

`block-bulk-process-kill` (PreToolUse, denies from day one) is the enforcement half; this surface
is the measurement half, and exists so the family's miss rate on the act path stays observable the
way surface E's was here. See `docs/architecture/hooks/block-bulk-process-kill.md`.

## The mt#4111 tune — what the act path actually owns

Five live fires in four days, all five rated false, and the review that rated them named the wrong
cause for three — which is the more useful finding.

### The record did not contain its own cause

`matchedPhrase` was `leadingTokenOf(command)`: the first token of the whole command, sitting
directly beneath a comment saying _"the diversity axis is the destructive VERB, not the
command"_. For a compound command the two are different, so three of the five fires recorded
`-e`, `nohup` and `-nP` — each of them a real `kill` further down the command. `context` compounded
it: `safeTruncate(command, 240, "head")` keeps the HEAD, and the kill is in the tail, so two
records do not contain the kill at all. Replaying those two through the current parse still
reports them UNREADABLE rather than quiet, which is the honest answer and the measurement of the
defect.

The review then classified from `phrase` plus the visible head and concluded the family was
"matching argument substrings, not actions". It was not. Same class as mt#3931's finding for
`retrospective-trigger`: a stored excerpt is not the judged input, and a rating taken from it can
invert the verdict. The fix is on both axes — `phrase` is now `findKillInvocation(...).verb`, and
`context` leads with the matching SEGMENT, so a record replays to the verb it names.

### The trigger: the guard owns bulk, this surface owns the residue

A denied invocation no longer records. It is the guard working, and the act path is about what the
turn DID — a denied call did nothing. That alone removes the 2026-08-13 fire, which was an agent
deliberately exercising `block-bulk-process-kill` to confirm it denies.

That exclusion rules out narrowing to the guard's own bulk threshold, which would leave the
surface permanently silent: every command clearing three PIDs is denied. So the discriminator is
cardinality at a LOWER bar — a single-target `kill` is ordinary process management, and all four
non-denied fires were exactly that (a scratch MCP server, a backgrounded dev server, a port-holder
just located by `lsof`). What remains: two-target kills, and `pkill`/`killall` of a class the
guard's interactive list does not carry.

Provenance ("did this turn spawn what it is killing?") was the remedy proposed in review and is
NOT implemented, for the reason `block-bulk-process-kill` records for the same exclusion — the
hook input carries no record of which processes the agent spawned, and inferring it from the
process tree is a guess with a silent failure mode.

### The consequence to watch

The surface has no true positive on record, so it may now record nothing. That is the correct
outcome of the tune and it collides with ADR-024's coverage-receipt gate (≥1 live fire within 7
days). **Review threshold: if the act-path surface records zero fires in the 14 days after this
lands, the question is whether the residue is a real population — not whether to loosen the
predicate.**

## The mt#4111 tune — prose surfaces

Three suppression families, each tied to a rated false positive with its context preserved in
`.minsky/operator-deferral-calibration.jsonl`:

- **Direct instruction reference** (`STANDING_INSTRUCTION_PATTERNS`). mt#3865 already decided this
  shape — naming a standing instruction while posing the ask in the same message is the remedy
  `user-preferences.mdc §Probe before deferring` prescribes (mt#3930) — but its patterns all
  attribute the instruction to a CONFIG (`your setup says`). `"you said file"` attributes it to
  the principal directly and matched none of them. Both new forms require a DIRECTIVE complement:
  the first draft matched `you asked` bare and the replay immediately suppressed a rated real
  positive (`"…since you asked whether it was worthwhile rather than for it"`), which is what the
  negative control is for.
- **Durability as a consequence** (`PRINCIPAL_RESERVED_EXCLUSIONS`). Every durable-default pattern
  mt#3865 added needs the literal word `default` / `standing` / `durable`; `"ready for your next
restart"` states the same property as an effect.
- **Peer collision** (`PEER_COLLISION_PATTERNS`, new). `"There's a second agent on this task …
want me to reconcile the two threads first?"` is `user-preferences.mdc §Probe before claiming a
shared resource` executed verbatim — probe, find a peer, hand the resolution over. Firing here
  penalises the corpus's own answer to a double-dispatch incident. Like the standing-instruction
  family it is suppressive only BECAUSE the ask accompanies it.

A fourth fix is on the capability surface: `NEGATION_LEAD_PATTERN` gained the copular forms, after
`"mt#4124 isn't deferred to you; … I'll take it after"` — a DENIAL of a deferral paired with a
commitment to act — was read as the deferral.

### Escalation threshold on the suppression families

This is the second extension of a suppression phrase family (mt#3865 was the first). A precision
suppression is Rung-1 work under ADR-024, which is where this family stops by default. **If a
THIRD phrasing escapes `STANDING_INSTRUCTION_PATTERNS`, the disposition is to take the family up a
rung (embedding nomination against the suppression exemplars), not to add a fourth pattern.**

### Measuring a tune

`bun scripts/replay-operator-deferral-calibration.ts <path-to-log>` replays every record through
the current matcher and splits the result three ways — no context / phrase truncated out of the
stored window / rateable — so a silence caused by truncation is never counted as a suppression the
change earned. mt#4111 added the act-path arm, which replays through the kill parse rather than
the prose detectors. What it CANNOT replay: the denial leg, which is turn state the record does
not carry.

## Surface C also takes the offer shape (mt#3801)

`PERMISSION_DEFERRAL_PATTERNS` is interrogative or imperative in all eight entries — "shall I",
"want me to", "say the word". A **negated default** — a declarative next step with a trailing
`unless` — matches none of them, so this surface was silent on
_"Next step is `/plan-task mt#3799` unless you'd rather I go straight at it."_

The trigger is `findOfferShape`, imported from `ask-routing-deferral-detector` rather than
reimplemented here, because that is where its two constituents already lived. **The full narration
— the conjunction, why `hasMenuShape` cannot be promoted unguarded, the label scheme, the known
comma-`or` miss — lives on that detector's page**; this section records only what is specific to
this surface.

**What is specific here: the offer path shares the suppression chain, it does not sit beside it.**
The exclusions are the load-bearing half of Surface C — the shape of a permission-ask is identical
whether the underlying action is in-authority or genuinely reserved, and only the ACTION
discriminates. A new way to MATCH must therefore not become a new way to BYPASS. Both the literal
loop and the offer path now call `isPermissionAskSuppressed`, which is the mt#3865 two-window chain
factored out unchanged: `DESTRUCTIVE_EXCLUSIONS` against the match SENTENCE, everything else
(`PRINCIPAL_RESERVED_EXCLUSIONS`, `SETTLED_DECISION_PATTERNS`, `STANDING_INSTRUCTION_PATTERNS`,
`PEER_COLLISION_PATTERNS`) against `sentenceWithLead`. A second copy would have drifted and silenced
one path but not the other.

**`SETTLED_DECISION_PATTERNS`' scope boundary is now discharged, in the direction it predicted.**
That array's docblock recorded, before mt#3801 shipped, that it does NOT cover the offer shape and
that mt#3801 "takes the opposite position." Both halves now hold simultaneously: _"I went with the
second one unless you'd rather I switch"_ is suppressed (a completed decision of the agent's own),
while _"Next step is X unless you'd rather Y"_ fires (a proposed next step handed over). The line
between them is the one that docblock names.

**A note on the AT5 test, worth carrying.** The destructive-exclusion case
(_"I can force-push it, unless you'd rather review first."_) passed **vacuously** before this
change: nothing suppressed it, because no `unless`-shaped entry existed for the exclusions to act
on. It is now a real exclusion test, and the test file carries an explicit control asserting that
those sentences DO produce an offer shape — so they are excluded rather than merely unmatched.

**Render size is unchanged.** `buildReminder` renders `context`, not `matchedPhrase` (mt#3781), and
this change adds no surface and no directive branch. Measured 2026-08-17: `renderWorstCase()` is
2068 against a declared 2100, identical for any phrase length up to 400 chars. The sibling
`ask-routing-deferral-detector` was re-measured at the same time and its declared 600 turned out to
be understated against a reachable two-class render of 1043 — pre-existing, unrelated to this
change (mt#3801's longest label produces the smallest of the three measured renders), and filed as
mt#4234.
