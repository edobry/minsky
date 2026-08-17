# Interceptors: the ontology and vocabulary of Minsky's enforcement corpus

**Type:** architecture reference (per `documentation-taxonomy`) · **Lifecycle:** living ·
**Genus decision:** ask#7119, closed 2026-08-11 (principal) · **Source material:** mt#3754

Minsky runs roughly ninety distinct entities that sit in an agent's path and act on it: merge
gates, PreToolUse denials, Stop-event scanners, per-turn context injections, calibration
recorders, pre-commit checks, the reviewer bot. Until 2026-08-11 they had no shared name and five
partially-overlapping ones — guard, detector, observer, hook, interlock — each of which was a
synecdoche: true of one part of the corpus, false of the rest. This page is the durable record of
the name that was chosen, the model beneath it, and the vocabulary that follows from both.

Everything here is normative for new prose, new code identifiers, and new UI copy. Nothing here
renames anything already shipped; see [What this page does not
change](#what-this-page-does-not-change).

### Why this is a reference page and not an ADR

The genus decision was made by the principal in ask#7119 and is already recorded there and in
mt#3754's `## Naming decision`. An ADR restating it would put the same decision in a third place
without adding a reader, and ADRs are immutable once Accepted — the wrong container for a model
that is explicitly expected to grow as the catalog is built out over ~89 heterogeneous entities.
The decision therefore lives in [The genus decision](#6-the-genus-decision-ask7119) below, inside
the ontology it governs, so a reader lands on both at once.

---

## 1. What an interceptor is

> An **interceptor** is an entity that occupies a declared point in a trajectory, receives what is
> passing through that point, and returns a decision about the trajectory.

The trajectory is usually an agent's conversation, but not always — it can also be a commit, a
pull request, or a domain command path (see [Entity strata](#5-entity-strata)). The activity noun
is **interception**; "an interception" also names a single firing of an interceptor.

Two things this definition is doing deliberately.

**The entity is an interception, not a judgment.** Naming the corpus after any one decision —
"guard" (deny), "detector" (record) — is wrong for the rest of the corpus by construction. Five of
the eight intervention types below never block anything.

**A classifier is a PART of an interceptor, not a KIND of one.** An earlier framing proposed
`classifier` as the genus with guard/detector as species; that relation is has-a, not is-a. Two
arguments settle it:

1. A classifier's output is a **label**; an interceptor's output is an **action on the process**.
   The label→intervention half is where all the variety lives, and a classifier-genus leaves it
   unnameable.
2. Identity must be invariant under implementation change. ADR-024's ladder upgrades a detector's
   mechanism from regex to embedding to model, and it is the same entity afterward. If classifier
   were the genus, an ADR-024 rung promotion would change what the thing _is_.

So the classifier is a declared component that some interceptors contain, and its ADR-024 rung is
a property of that component — which is exactly [axis 3](#axis-3--decision-mechanism).

This has-a settlement is field-corroborated rather than invented: XACML/NIST separate the PEP
(which enforces) from the PDP (which decides) on the same rationale — PEP identity survives
swapping a regex PDP for an ML one — and Invariant Labs and LlamaFirewall arrive at the same split
independently.

### The MCP disambiguation

Minsky interceptors are host- and process-side; MCP interceptors (SEP-2624) are the protocol-wire kind; the tool-call validator/mutator subset is shaped to become them.

That sentence is deliberately unwrapped onto one line, and is written **once** in `docs/`, here.
Reference it from elsewhere rather than restating it.

**On the SEP number — do not "correct" it.** The MCP interceptors effort has **two live
identifiers, both upstream's own**, and you will encounter each of them:

- **[Issue #1763](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1763)** —
  "SEP-1763: Interceptors for Model Context Protocol", the originating proposal issue.
- **[PR #2624](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2624)** —
  "SEP-2624: Interceptors for the Model Context Protocol", open, filed from a branch literally
  named `SEP-1763`. This is the one carrying the actual SEP document (two interceptor types,
  validators and mutators; `interceptors/list` and `interceptor/invoke`).

The sentence above cites **SEP-2624 because that is what the live SEP document titles itself**.
SEP-1763 is not a stale or superseded number — it is the issue number the same effort was proposed
under, and mt#3754's earlier field-survey sections cite it for that reason. Neither number is
wrong; they name different upstream artifacts. Do not rewrite one into the other. The proposal is
still open, which is the substantive caveat the disambiguation exists for.

---

## 2. The three axes

Every interceptor is described by three coordinates. Together they replace the five disagreeing
words.

### Axis 1 — interception point

Where in the trajectory it sits. Current values are the Claude Code harness lifecycle events plus
the repo/delivery gates:

<!-- axis-1-points:start — parsed by tests/unit/interceptor-points.test.ts; every name backticked -->

`PreToolUse` · `PostToolUse` · `Stop` · `SubagentStop` · `UserPromptSubmit` · `SessionEnd` ·
`MessageDisplay` · `SessionStart` · `StopFailure` · `Notification` · `PermissionRequest` ·
`PreCompact` · `PostCompact` · `pre-commit` · `merge-time`

<!-- axis-1-points:end -->

The agent-runtime values are _literal copies_ of the harness's own event names, so this is
identity with the field, not convergence — keep them verbatim. AspectJ's "join point", Kubernetes'
admission phases and OWASP's "control point" are the same concept in other lineages, and are
useful as glosses only.

The six from `SessionStart` onward were added by mt#4129. Hooks were registered at each of them in
`.claude/settings.json` while the model had no value to represent them, so the point resolver
dropped them and the catalog carried neither the hook nor a gap — this list was one of the places
that made the omission look intentional. It is a SIXTH copy of these names: the other five are
three type unions (the hook tree cannot import from `src/`, and cockpit-web cannot import from
`.minsky/hooks/**`, so the duplication is forced), the runtime `POINTS` gate, and `VALID_POINTS`.
`tests/unit/interceptor-points.test.ts` pins all six to each other — including this one, via the
`axis-1-points` HTML comment markers around the list above. A prose list is exactly the copy that
would otherwise rot silently, which is why it is fenced and parsed rather than trusted; keep every
name backticked so the parser sees it.

Not every point has a place on the spine: `INTERCEPTION_POINT_ORDER` is deliberately a subset,
because ordering `Notification` or `PreCompact` against a turn's phases is a spine-design decision
nobody has made. An entry at such a point lands in `spinePopulation`'s `stationless` bucket, which
reports it rather than dropping it.

### Axis 2 — intervention type

What the interceptor does at that point. Eight values, each defined here:

| Type                  | Definition                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **deny**              | Halt the action. The merge gates; the PreToolUse denials.                                                                                                                                                                  |
| **allow**             | Positively green-light something otherwise blocked. The approved-Ask bridge.                                                                                                                                               |
| **inject**            | Add to what the next step sees, without editing the artifact. Per-turn time/git/prod-state context; every Stop observer's advisory. The most common non-blocking intervention in the corpus.                               |
| **mutate**            | Rewrite the payload in flight. The display linkifier's message rewrite; the agent-dispatch-record hook's prompt stamp. Distinct from inject: it edits the artifact rather than adding context beside it.                   |
| **record**            | Write evidence for a _deferred decision loop_. Every calibration log. Distinct from diagnostic logging: these records are the INPUT to `/calibration-review`.                                                              |
| **notify / escalate** | Reach a human out of band. `severity: "incident"` asks; `principal_notify`.                                                                                                                                                |
| **delegate**          | Hand the decision to another agent. In the repertoire; not yet exercised by any shipped interceptor.                                                                                                                       |
| **ask-and-pause**     | Raise a question and block on the answer. Rung-3 confirm is the nearest live instance. The field gloss is **elicitation** (MCP 2025-06-18; LangGraph `interrupt()`); never "reask", which re-prompts a model, not a human. |

Three of these — `inject`, `record`, and `notify/escalate` — have **no standard term anywhere** in
the six lineages mt#3754 surveyed (agent harnesses, guardrails frameworks, policy-enforcement,
AOP/middleware, shadow-graduation practice). `deny`/`allow`/`mutate` are exact matches for
Kubernetes' validating and mutating admission webhooks. Beware three named false friends: XACML
Obligation is not `record` (it is a mandatory action at enforcement time), XACML Advice is not
`inject` (it is scoped to the current decision cycle), and Kubernetes PSA `warn` is not
`notify/escalate` (it is in-band and same-caller-visible).

### Axis 3 — decision mechanism

_How_ it decides — i.e. what classifier, if any, it contains. ADR-024's ladder is exactly this
axis: none/constant · lexical (regex) · embedding · model. An interceptor that always fires has
the trivial constant classifier.

**Amended by mt#4038: the value set carries a fifth value, `structural`.** Authoring axis 3 for
the whole corpus made the gap unmissable. ADR-024 scopes itself, in its own Context section, to
"`UserPromptSubmit` **guidance hooks** … that detect behavioral trigger phrases in the agent's own
output" — so all four of its rungs describe matching PROSE. Most of this corpus is not that: a
migration-collision check, a status-transition validator, a required-checks merge gate and every
pre-commit step evaluate a deterministic predicate over structured state. Calling those `constant`
is false (they do not always fire); calling them `lexical` claims a prose matcher that is not
there. `structural` names the case, and neither ADR-024 nor the ladder changes — the ladder still
governs the detector family it was written for.

Measured distribution over the 86 entities carrying authored coordinates (mt#4038): **structural
56 · lexical 24 · constant 4 · embedding 2 · model 0.** So the value ADR-024 does not define
covers about two thirds of the corpus, `lexical` covers the guidance-hook detectors it does
govern, `embedding` has exactly two instances (`memory-search`, `standalone-duplicate-matcher`),
and the rung-3 `model` end of the ladder is unexercised by any shipped interceptor.

Role, dimension 2 of §5, over the same 86: **judge 72 · infrastructure 8 · feeder 6.**

---

## 3. Four amendments the axes require

mt#3754's codebase audit produced seven entities the clean three-axis model mishandles. They are
systematic rather than one-offs, so an exceptions list is the wrong tool. The frame survives with
four amendments, and **the amended model — not the clean three axes — is the model.**

### (a) A declared type is a capability SET, not a fixed conjunction

The word "composable" reads as declared-at-registration. It must read as **the set of
interventions the entity MAY produce**. The worked example this amendment was written against,
`policy-coverage-detector`, selected deny, warn, or allow per fire at runtime; the declaration
named its repertoire, not its outcome. (That entity was retired 2026-08-16, mt#4197, and no
longer appears in the catalog — the amendment it motivated stands on its own.) This matches the
field: a Kubernetes validating webhook may allow or deny per request.

Consequence for the catalog: an entity legitimately belongs to more than one computed family, and
the UI has to render that rather than force a primary.

### (b) inject / notify / record take an AUDIENCE parameter

`record-agent-dispatch` emits operator-directed audit lines to STDERR — a third channel that is
neither `notify/escalate` (which is scoped to the principal) nor `record` (evidence for
`/calibration-review`). Several interceptors use this channel undeclared.

Observed audiences: **agent · principal · operator · framework**. Parameterizing is more
parsimonious than minting new types: `notify/escalate` is `notify(principal)`; the STDERR
diagnostics are `record(operator)`.

### (c) `record` conflates three things, and the audience parameter splits them

The single word currently covers:

1. **evidence-for-review** — the calibration logs; the definition given in axis 2. → `record(review)`
2. **framework-state writes** — `record-turn-anchor` "always returns null and its only observable
   effect is a file write", consumed by _other_ interceptors. → `record(framework)`
3. **derived-metadata emission** — `auto-session-title` emits a scalar title. The registry's own
   comment flags it as the one scalar-output entity, and it does not return "a decision about the
   trajectory" at all, so §1's definition is literally false for it. → `record(framework)`, with
   the caveat noted below.

Independent corroboration that `record` is under-differentiated: Guardrails AI grades what we
collapse into deny/record as EXCEPTION / REFRAIN / FILTER / NOOP. The alternative considered and
rejected was two new types (`annotate`, `state-write`); the audience parameter from (b) does the
same work with fewer primitives.

**A known rough edge, recorded rather than papered over:** `auto-session-title` remains the entity
the genus definition fits worst. It is in the corpus because it occupies an interception point and
fires on the same machinery, not because it decides anything.

### (d) Meta-level interceptors carry a SUBJECT marker

`guard-health-escalation-detector` classifies the health of _other interceptors_, not the
trajectory; `calibration-review-cadence-detector` is a milder case of the same thing. The three
axes have no level distinction. The fix is a field, not a fourth axis for everyone:

`subject: trajectory | system`

### Two further findings that are coverage gaps, not model gaps

- **The registry sees about 37 of ~89 entities.** Merge-time and pre-commit gates occupy declared
  interception points with no `GuardRegistration` — no tuning ownership, no attention cost, no
  canary. Anything enumerating the corpus must build from the fire log's distinct-name population,
  **not** from `.minsky/hooks/registry.ts`, or it silently drops over half of it. (Counts are
  mt#3754's; the 37 and the 89 were not independently recounted there and should be re-measured
  by whatever consumes them.)
- **Filenames disagree with axis 2.** Several `*-detector.ts` files —
  `skill-staleness-detector`, `mcp-daemon-staleness-detector`, `guard-health-escalation-detector` —
  have intervention type `inject`, not `record`. Display axis-2 truth, never the filename word.

---

## 4. The computed families: guard, detector, injector

Under this model the older words stop being assigned labels and become **filters over axis 2** —
computable from an entity's declared capability set rather than stamped on it. That is what makes
the corpus renderable as one system instead of two unrelated surfaces.

| Family word  | Definition                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **guard**    | An interceptor whose intervention type includes **deny** (or **allow**).                                                                                | Keep it exactly where the field would use it. Across Guardrails AI, NeMo, LlamaFirewall, Anthropic, Lakera, Invariant and OWASP, "guard(rail)" has _not_ generalized past detect-and-block — which is why it must not be the genus, and why it is precisely right for this subset. It is also the incumbent word in the code and the fire-log key. |
| **detector** | An interceptor whose intervention type is **record**, in the calibration-first sense — a classifier shipped in audit mode with a review loop behind it. | ADR-024's own operative noun (the word "guard" appears on zero lines of ADR-024), and externally corroborated: Invariant Labs uses "detector" verbatim with an identical has-a placement; LlamaFirewall's "scanner" is a near-synonym. Retiring it would invalidate ADR-024's vocabulary.                                                          |
| **injector** | An interceptor whose intervention type is **inject**.                                                                                                   | The advisory families — the Stop observers, the per-turn context providers.                                                                                                                                                                                                                                                                        |

**`observer` is retired** as an assigned label; it survives only as an informal synonym for the
injector family. The codebase already used "the observer convention" informally for exactly this
role before the ontology existed, which is evidence the vocabulary self-organizes around roles —
and a constraint any genus had to satisfy.

**A family word is a filter, so membership is not exclusive.** By amendment (a),
`policy-coverage-detector` was both a guard and a detector. This is a property of the model, not a
classification error to resolve. (That entity was retired 2026-08-16, mt#4197; the counts below
were measured while it was still in the catalog.)

**The three words do not PARTITION the corpus (measured, mt#4038).** Computing the filters over
the authored capability sets: guard 42 · detector 27 · injector 25 — and **8 entities land in none
of them.** The three family words filter `deny`/`allow`, `record(review)`, and `inject`; nothing
filters `mutate` or `record(framework)`. The eight are exactly the pre-commit regeneration steps
(`code-formatting`, `claude-hooks-compile-regen`, `completion-manifest-regen`, the two Dockerfile
regens) and the framework-state writers (`record-turn-anchor`, `record-agent-dispatch`,
`auto-session-title`) — precisely the "feeders and infrastructure" §5 already names as the
entities that surfaced as falsifiers because they do not judge.

The class has since taken a ninth member: `interceptor-catalog-regen` joined at mt#4071
(2026-08-13), a pre-commit regeneration step that had been firing since mt#4010 but carried no
authored coordinates, so it resolved into no family for the mundane reason that nothing had
classified it. That is the visible diff this pinning exists to produce; the counts above are
mt#4038's measurement and are left as measured.

This is the corpus reporting a property of the model, not a gap to close by widening a capability
set until something matches. **A catalog must render these as explicitly outside the family
filters, never as a blank** — a blank says "we never classified this", which is a different and
false claim. Whether to mint a fourth family word is a NAMING decision and therefore
principal-reserved; the set is pinned as `OUT_OF_MODEL_NAMES` in
`.minsky/hooks/interceptor-coordinates.ts` so a future entity joining or leaving the class is a
visible diff rather than silent drift.

### The coordinates grammar

For maximal specificity, describe an interceptor by its coordinates rather than by a family word:

```
<interception point> + <intervention type(s)> + <decision mechanism>
```

Worked examples:

| Entity                             | Coordinates                                        | Family                                 |
| ---------------------------------- | -------------------------------------------------- | -------------------------------------- |
| a merge gate                       | merge-time · deny · lexical                        | a guard                                |
| `wall-of-text`                     | Stop · record(review) · lexical, audit mode        | a detector                             |
| git-state injection                | UserPromptSubmit · inject(agent) · constant        | an injector                            |
| `guard-health-escalation-detector` | Stop · inject(agent) · lexical · `subject: system` | an injector (filename notwithstanding) |

Kubernetes — the most successful precedent here — never coined a genus at all: "validating
admission webhook" is position + type + mechanism as qualifiers on a bland noun. The grammar
carries the precision; the genus noun stays thin, which is the point.

---

## 4b. The failure-class taxonomy

The three axes describe an interceptor mechanically — where it sits, what it does, how it
decides. None of them answers the question a human actually arrives with: **"what stops me
merging something unreviewed?"** That is mt#3754's sixth axis, and unlike the other five it is
**authored, not derived** — no field in any source states it and nothing can infer it.

The list is deliberately small. It is a **filter**, not a per-entity restatement: eleven classes
over ~91 entities averages ~8 entities per class, and a taxonomy approaching one class per entity
would be a renaming exercise that no one could filter by. An interceptor carries **at least one**
class and may carry several — the same non-exclusivity the computed families have.

| Class                     | The failure                                                                                                                                                                                                                                      | The question that should surface it                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **`unreviewed-merge`**    | Code reaches main without the review, checks, or evidence its policy requires.                                                                                                                                                                   | What stops me merging something unreviewed?                      |
| **`broken-main`**         | A commit leaves the tree unbuildable, unformatted, untested, or with generated outputs out of sync with their sources.                                                                                                                           | What stops me committing a tree that does not build?             |
| **`corrupt-record`**      | A durable record is written in a state later readers cannot trust: a spec missing required sections, an illegal status transition, a mutated already-applied migration, a colliding identifier.                                                  | What keeps the task graph and the migration history trustworthy? |
| **`secret-exposure`**     | A credential reaches a persisted surface — the transcript, the repo, a log.                                                                                                                                                                      | What stops a secret leaking into something permanent?            |
| **`unfounded-claim`**     | Something is asserted as fact without the evidence it needs: a code mechanism never read, a causal story never checked, a result narrated before it happened.                                                                                    | What stops me asserting something I never checked?               |
| **`wrong-workspace`**     | Work lands in the wrong tree or travels through the wrong channel: main instead of the session, raw git/gh instead of the tools, a fork writing where it declared it would not.                                                                  | What stops my edits landing in the wrong place?                  |
| **`duplicate-work`**      | Effort is spent on something another task, agent, or PR already owns.                                                                                                                                                                            | What stops me redoing work someone else is already doing?        |
| **`lost-signal`**         | Something the principal needed does not reach them — the turn dropped it (a decision not routed, an action named but not taken, an incident not escalated) or rendered it unusable (a wall of text, a silent stretch, an unclickable reference). | What makes sure I actually see what I need to see?               |
| **`stale-context`**       | The agent acts on facts that have since changed: the date, git state, production state, a stale skill or daemon, a memory never retrieved.                                                                                                       | What stops me acting on stale facts?                             |
| **`unrecorded-learning`** | A failure or a finding evaporates instead of becoming a durable fix in the substrate.                                                                                                                                                            | What makes sure we learn from a failure instead of repeating it? |
| **`blind-enforcement`**   | The interception system itself fails without anyone noticing — a guard erroring in a streak, a calibration log past its review window, a fire-log record with no known source.                                                                   | What tells me the guards themselves are still working?           |

**This page is the taxonomy's home.** Adding, removing, or re-scoping a class is an edit here
first; `.minsky/hooks/interceptor-descriptions.ts` holds the machine-readable `FailureClass` union
and the per-entity assignments, and its test suite asserts that every class in the union appears
in this table. Do not start a second vocabulary home.

### Where the per-entity assignments live

`.minsky/hooks/interceptor-descriptions.ts` (mt#4008) carries, keyed by `guardName`, a one-to-two
sentence description, its failure classes, and provenance pointers to the sources the description
distills. Three properties of that store are load-bearing and easy to erode:

1. **The population is the fire log's distinct-name set, not the registry.** Measured 2026-08-12:
   **91** distinct `guardName` values live, against **39** `GuardRegistration` entries — so
   registry-derived authoring drops **57%** of the corpus. This is §3's coverage-gap finding made
   operational. (mt#3754 recorded 37 and 89; both have since moved, which is why the store's test
   suite recomputes rather than pinning.)
2. **Coverage gaps are content.** An entity with no registry entry has no `tuningOwnership`, no
   `attentionCost` and no `canary`; those are computed into an explicit `coverageGaps` list at read
   time rather than defaulted away — and an unknown name resolves to an explicit `undescribed`
   marker rather than being dropped.
3. **Descriptions state axis-2 truth, never the filename.** The `*-detector.ts` files named in §3
   each carry a `filenameNote` recording that they inject.

The store is a **sidecar module rather than a registry field or a DB table**; the reasoning — the
thin-hooks direction, ADR-027's scope, and why a description belongs in the commit that changes
the behavior it describes — is recorded in that module's header.

---

## 5. Entity strata

Two orthogonal dimensions plus the mechanism axis. The catalog should carry all three as columns.

### Dimension 1 — which trajectory is intercepted

| Trajectory                     | Entities                                                                            | Mechanism                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Agent conversation             | ~44: the `GUARD_REGISTRY` entries plus the standalone `.claude/settings.json` hooks | Harness lifecycle events (`UserPromptSubmit`, `PreToolUse`, `Stop`, …)   |
| Repo / VCS                     | ~30 pre-commit / commit-msg / pre-push check names                                  | husky git hooks — fire for ANY committer in the checkout, agent or human |
| Delivery / PR                  | reviewer bot (review time); merge gates by subject                                  | GitHub App service; agent-side PreToolUse                                |
| Domain command paths           | `ask-form-lint` on `asks_create`                                                    | MCP command path — no hook, no git                                       |
| The interception system itself | `guard-health-escalation-detector`, `calibration-review-cadence-detector`           | Harness events mechanically, but `subject: system` per amendment (d)     |

### Dimension 2 — role on that trajectory

- **Judges** — classify, then intervene. The deny gates; the calibration-first detectors.
- **Feeders** — unconditional context providers with a trivial classifier. `inject-current-time`,
  `inject-git-state`, `inject-prod-state`, `memory-search`.
- **Infrastructure** — `record-turn-anchor` writes state other interceptors consume;
  `auto-session-title` emits metadata.

Feeders and infrastructure are exactly the entities that surfaced as falsifiers in §3: they do not
judge, and a model built only from judges mishandles them.

### Mechanism ≠ subject, and mechanism decides WHO IS BOUND

This is why mechanism is a catalog column rather than a plumbing detail. The merge gates have a
repo-level subject but are implemented as agent-side PreToolUse denials — so they bind only
harness agents. A husky hook binds any committer in the checkout. GitHub branch protection binds
everyone, including the web UI. **Choosing the mechanism chooses the enforcement coverage**, and
the existing three-layer merge-protection model is that fact made explicit.

---

## 6. The genus decision (ask#7119)

**Decided 2026-08-11 by the principal: interceptor-forward.** `interceptor` is the genus noun for
the corpus; guard / detector / injector remain computed family words for the precise or informal
register; the coordinates grammar carries maximal specificity; `interception` is the activity
noun. The catalog route is `/interceptors`, and a future catalog deeplink type follows the same
noun.

Naming is principal-reserved (`principal-context.mdc §Decisions Eugene reserves`); this page
records the call, it does not re-argue it. For the record, the three packages not chosen, one line
each — the full comparison is in mt#3754's `## Package comparison table`:

- **Families** — no umbrella noun in the UI at all; the corpus presents as three or four computed
  families. Strain: boundary entities span families.
- **Grammar only** — coin no noun; every entity is described by its coordinates. Strain: no word
  for a column header, and the vacuum tends to refill with "guard".
- **Guard colloquial + interception formal** — keep the incumbent word in code and speech. Strain:
  "guard" over-claims blocking for five of the eight types.

Two accepted costs came with the choice, and both are honored here. First, the MCP disambiguation
sentence in §1, whose footnote also settles the two-identifier question — the risk being that
"interceptor" is a still-open Draft SEP with a narrower two-type
taxonomy than our eight, and that to gRPC/NestJS-native readers it connotes wrapping both sides of
a call, which is false for our PreToolUse-only entities. Second, the storage-key policy:

### Storage keys are not migrated

The fire log holds **387,000+ records keyed by `guardName`** (plus `guard-health-log.jsonl`), read
by health tracking, the calibration sweep, threshold tuning, and the cockpit UI. That key is
**not** migrated. New code reaches interceptor vocabulary through a **read-side alias layer** over
`guardName`; the persisted field name stays as it is, permanently. Renaming it is a **Tier-2** cost
against zero behavioral gain — and the calibration sweep already carries a hand-maintained reverse
index with a recorded desync incident (mt#2889), which is what a migration would multiply.

mt#3754's adoption-cost tiers, since they are cited above and elsewhere: **Tier 0** — docs and
ontology only. **Tier 1** — code identifiers, no persisted data. **Tier 2** — persisted data
(`guardName` and its readers). **Tier 3** — shipped UI, or reversing an already-DONE decision. The
interceptor-forward choice is Tier 0–1 by construction: everything at Tier 2 and above is
explicitly out of scope, permanently, not deferred.

---

## What this page does not change

- **`hook` still names registration mechanics only** — `.claude/hooks/`, `.minsky/hooks/`,
  `.claude/settings.json` wiring — per mt#2626. mt#2626 is **not** reopened. The interceptor-forward
  choice reinforces it: the MCP Interceptors WG charter (primary source) explicitly rules
  "client-specific hook implementation details" out of scope, i.e. the emerging protocol layer
  makes the same hook/interceptor split mt#2626 made.
- **`interlock` remains the plant-UI deny noun** — the Plant Board's S2 valves, and the
  "interlock history →" drill-down link — per mt#2626, unchanged and shipped. The
  `/plant/interlock-history` ROUTE was absorbed into `/interceptors` by mt#4229 and now
  redirects; the vocabulary split survives the move intact, which is the point worth noting
  here: the page changed, the noun did not.
- **`guard` and `detector` remain correct** wherever deny/allow or calibration-first-record is
  what is meant. No rules-corpus sweep replacing them is warranted or intended.
- **No code is renamed and no storage is migrated** by this page.

## Adopted field vocabulary

Cheap, exact, and settled elsewhere — adopt rather than coin:

- **`failurePolicy: Fail | Ignore`** (Kubernetes) — names our existing but unnamed
  fail-closed / fail-open distinction exactly.
- **`mode: audit | enforce`** (Kubernetes PSA; `Count`/`Block` in AWS WAF) — the shadow-then-enforce
  graduation practice. Mode is **per-entity state, not identity**: `detector` names the
  calibration-first mechanism family, orthogonal to what mode any given entity is in.
- **elicitation** — the gloss for `ask-and-pause`.
- **validating / mutating** — glosses for `deny`/`allow` and `mutate`.

Threshold sensitivity stays orthogonal to mode, which is why ADR-031 (lifecycle) and ADR-032
(threshold tuning) are separate concerns; OWASP CRS documents its paranoia levels as orthogonal to
detection-vs-blocking mode for the same reason.

## Cross-references

- **mt#3754** — the umbrella task; `## Ontology`, `## Field-alignment synthesis`,
  `## Entity strata`, `## Package comparison table`, `## Naming decision`. Carries the full
  six-workstream survey, the per-term verdict table with adoption-cost tiers, and an
  unverified-claims ledger. Read the ledger before citing any field claim onward.
- **ask#7119** — the genus decision.
- **mt#2626** — the hook/interlock scoping this page preserves; recorded in
  `src/cockpit/CLAUDE.md §Guard/interlock vocabulary`.
- **ADR-024** — the decision-mechanism ladder (axis 3), and the source of `detector`'s meaning.
- **ADR-028** — guard/hook dispatcher consolidation; the fire log this corpus is enumerated from.
- **ADR-031 / ADR-032** — detector lifecycle and threshold tuning; deliberately separate concerns.
- **ADR-037** — principal-facing vocabulary control; coined vocabulary enters the corpus defined,
  at the authoring step, which is why every term above is defined in place.
- **`docs/architecture/agent-guidance-mechanisms.md`** — the rules → skills → subagents → hooks
  strength ordering. Interceptors are the fourth rung of that ordering, modelled properly.
- **`hook-files.mdc` / `hook-observers.mdc`** — the operational index of what is currently
  registered, by name. This page is the model; those are the roster.
