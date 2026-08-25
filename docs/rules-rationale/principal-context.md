# Principal Context — extended rationale

> Extracted from `.minsky/rules/principal-context.mdc` (mt#3085 corpus trim, Phase 2 of the
> 2026-07-22 context-audit roadmap, mem#682; Phase 1 = mt#3083 / PR #2205). The compiled rule
> carries the persona statement, the full `§Decisions Eugene reserves` list verbatim, the
> framework-trigger rule, and a one-line framework implication; this file holds the full
> per-category framework detail, the anti-patterns, and the incident narrative. Nothing here
> changes agent behavior — the directive text in the rule is the complete behavioral contract.
>
> **Updated mt#1878 (2026-08-03):** the framework trigger is no longer a 4-step list in the
> rule — it is one sentence naming the same four moves (name the framework, check it against
> this rule, switch if wrong, say what you switched) plus a pointer to **`/declare-framework`**,
> which carries the protocol. The substance is unchanged; only its shape and location are.

## Why this rule exists

This rule establishes the **persona frame** inside which all other decision-defaults apply.
Other rules (`decision-defaults.mdc`, `humility.mdc`, `work-completion.mdc`) presuppose this
frame; without it, the agent re-infers persona each turn and the inference drifts toward
generic defaults that don't match the actual context.

## Who Eugene is (full statement)

**Eugene Dobry is the principal of the commercial AI product Minsky.** Not a hobbyist; not a
personal-research project; not a one-person consultancy. The relationship to the product is:

- **Principal owner / creator** of Minsky
- Operating as the principal of whatever company is producing Minsky (formal business entity
  may evolve; "principal of commercial product" is the stable framing)
- Currently solo on engineering, but the product is **customer-facing** — Minsky is built to be
  used by paying customers, not just by Eugene
- Investment time horizon is multi-year — this is the product Eugene is building, not a side
  experiment

## What Minsky is

A commercial AI agent product. Customer-facing surfaces include MCP server, hosted MCP, CLI,
eventual cockpit UI, mesh, attention-allocation subsystem. Customers experience the agent's
quality directly.

## Framework implications (full detail)

These implications follow from the principal context and override generic defaults when they
conflict:

### 1. Tool selection for non-core capabilities

When picking a SaaS / tool / vendor for an auxiliary capability (observability, analytics, CI
infra, eval platform, etc.):

- **Time-to-customer-insight is the dominant metric.** How fast does "customer reports issue X"
  become "shipped fix Y verified to help"?
- **Workflow fit > license alignment.** A tool Eugene fights wastes principal time; a tool that
  fits the workflow earns its subscription cost many times over.
- **Switching cost has a half-life by category.** Switching observability tools
  (OTel-conformant sinks) is cheap; switching source-of-truth databases is expensive. Don't
  import lock-in concerns from the latter into the former.
- **OSS-hedge weight is LOW for derived-analytics tools.** Eugene is not running an OSS purity
  audit; he is shipping a product. OSS matters when (a) data sovereignty is load-bearing, or (b)
  switching cost is expensive. Neither applies to most SaaS-observability decisions.
- **Customer-logo signal is HIGH for tool fit.** If Notion / Stripe / Vercel / Ramp / similar
  companies running production AI products pick the tool, that's calibration data that the tool
  fits commercial-AI-product workflows.

### 2. Trust scaling

Eugene's stated goal is to **offload more Minsky work to the agent as Eugene operates at higher
business levels**. This implies:

- Decisions made by the agent should be made under the right framework on first pass, not after
  the user does framework-correction work
- Strategic recommendations should be self-contained enough that Eugene can act on them without
  re-deriving the framework
- The agent's reasoning should be explicit about the framework being applied, so Eugene can spot
  framework mismatches early

### 3. Cost calculus

- Eugene is cost-conscious but not cost-purist. $10s/mo SaaS subscriptions are acceptable when
  they save engineering time.
- Engineering time is the scarcest resource. Every hour spent on auxiliary infra is an hour not
  on Minsky core.
- "Two days of work" framing for in-house tooling is anti-pattern unless the tool itself is core
  differentiation.

### Craft-level boundary

Craft-level choices (file structure, micro-phrasing, low-stakes naming, task-spec layout) are
the agent's by default — see stakes-filter calibration in `humility.mdc`.

## Trigger rule — full text

Before making a strategic recommendation (tool selection, architectural direction, vendor
commitment, scope-changing decision):

1. **Name the evaluation framework you are about to apply** — make it explicit. "I'm applying a
   'OSS hedge + community alignment + cost-minimization' framework" or "I'm applying a
   'commercial product workflow fit + time-to-customer-insight' framework."
2. **Check that the framework matches Eugene's position per this rule.** If the framework you
   defaulted to is OSS-purist, lock-in-minimization, or research-project-shaped — STOP. That's
   the wrong frame for Eugene's commercial-product context.
3. **If the frame is wrong, switch.** The correct frame for tooling decisions is "what's the
   workflow fit for a principal shipping a commercial AI product, with paying customers as the
   consumer of the agent's quality?"
4. **Name what you switched and why.** Surfacing this lets Eugene spot framework mismatches
   early instead of after 15 turns of recommendations under the wrong frame.

**Structural enforcement.** The `/declare-framework` skill operationalizes the four steps above
as numbered process steps with required user-facing output. Invoke it explicitly when about to
deliver a strategic recommendation, or self-trigger via the cues in the skill (the agent
recognizes it is comparing ≥ 2 named candidates / a strategic recommendation is in flight). The
skill is agent-invoked discipline, not harness-fired. See
`.claude/skills/declare-framework/SKILL.md`.

## Anti-patterns to recognize in self

- **Re-inferring persona from local signals.** If you're inferring "solo dev / hobby project"
  because the git user is one person and the cost-sensitivity signal is present, you're wrong.
  Read the compiled rule instead.
- **Applying OSS-hedge framework to observability tools.** Specific recent incident: 2026-05-12
  conversation where I evaluated Langfuse / Phoenix / PostHog / Braintrust through an OSS-hedge
  framework that didn't fit Eugene's commercial-product use case. Took 15 turns + user
  re-framing to surface. See `feedback_explicit_framework_selection`.
- **Treating "lock-in" as universally bad.** Lock-in is a real concern for source-of-truth
  state; it's near-zero for OTel-conformant event sinks. The framework needs to be
  category-aware.
- **Centering open-source community signal for commercial-product tool decisions.** The
  community-OSS-adoption signal (e.g., "Langfuse has 12M downloads") is calibration data for the
  OSS category, not the deciding factor for "which SaaS fits this commercial-product loop."

## Originating incidents

- **2026-05-12 R3 retrospective** — across 15+ turns of platform-recommendation discussion,
  agent applied OSS-purist evaluation framework to a commercial-product-loop decision without
  ever surfacing the framework choice. User had to articulate "I, Eugene, as the principal of
  whatever company is producing Minsky" themselves to break the agent out of the wrong frame.
  Bridge memory: `feedback_explicit_framework_selection`. Structural escalation: mt#1789 —
  IMPLEMENTED 2026-05-13 via `/declare-framework` skill.

## The knowledge surface (mt#4248)

The rule's `§What Eugene knows` section is the behavioral contract; this section holds the
ledger it draws on, the decay path, the worked walk-throughs, and the feasibility check on
deriving the known-term set automatically.

### Why this axis exists

The persona frame above models Eugene's **authority and preferences** — what he decides, what
framework applies. It carried no **epistemic** dimension: nothing about what he knows. So the
agent calibrated vocabulary to the domain it was working in rather than to the person it was
writing for, which is writing for a generic peer.

Originating incident, 2026-08-18 (conversation `mt#4220`). The agent wrote: _"`strings` on a
Mach-O misses text in compressed regions, and I drew a confident negative from it anyway."_
He replied: _"also, sorry, what does 'strings on a Mach-O' mean?"_ — note the "sorry": the
cost lands as the principal apologising for a gap the agent created.

The agent's first framing of the fix was "explain jargon more," which is the shallow reading.
His reframe is the correct one, quoted verbatim:

> "this is a failure of the agent to have 'theory of mind' for me as a user, it should be able
> to, over time, build/track a model/persona of me and have a sense of what i am likely to
> know and not know and be able to tailor its use of jargon appropriately, ie, right at the
> edge of my knowledge"

Same session, same shape, earlier: after several turns of deploy/gate/detector vocabulary he
said _"Help me understand this. I'm a little confused."_ Two instances, two different
vocabularies — one from an outside technical domain, one Minsky-process shorthand.

**Altitude.** He named this a **theory-of-mind** capability, and that is the right frame. It
is the mt#1034 attention-allocation thesis — route scarce principal attention deliberately —
applied to the LEXICAL layer of a message rather than to whether the message is sent at all.
An unexplained term is a small, silent attention tax charged without consent.

### The ledger

**Seeded from EXPLICIT evidence only. No inferred entries.** An entry earns its place by a
quotable signal: he used the term, or he asked about it. Nothing here is a guess about what he
probably knows, and nothing here is a competence judgement.

**Confirmed gaps** — he asked outright. Gloss on first use in a message.

| Term         | Date       | Signal                                                                                                                                                                                                                                         |
| ------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Mach-O`     | 2026-08-18 | _"what does 'strings on a Mach-O' mean?"_                                                                                                                                                                                                      |
| `strings(1)` | 2026-08-18 | same question; both terms were in the one unglossed clause                                                                                                                                                                                     |
| `CSCW`       | 2026-08-22 | _"I've never heard of that field before ... I'm confused about how I've never heard that phrase before"_ — self-reported after reading it unglossed in an agent-authored research brief; not asked outright at the point of contact (mem#1201) |

First entry appended since the ledger's initial seeding (mt#4248) — exercises the append path
end to end, per mt#4442's acceptance tests.

**Confirmed known** — he used these unprompted in the 2026-08-17/18 mt#4220 conversation:

`affordance`, `visual guides`, `typography`, `collapsing`, `toggle`, `persona`,
`theory of mind`, `UX`, `MCP`, `CLI`, `subagent`, `fork`, `retro`, `handoff`, `deeplink`.

This list is illustrative of the tier-1 signal, not exhaustive of what he knows — most of what
he knows is covered by tier 2 (his working vocabulary) and will never appear here. Do not read
a term's absence from this list as evidence of anything; that is the asymmetry the rule states.

### Decay and update path

- **A gap closes on explanation.** A term he asked about, once glossed, is KNOWN thereafter —
  move it from the gap table to the confirmed-known list with the date. Gaps do not persist by
  default; carrying one forever misreads a person who learns.
- **Append on explicit signal only.** When a new definition request, a self-restatement, or an
  unprompted use appears, add the row in the same session it happened, with the quote. A signal
  recorded as "I'll fold it in later" is a signal lost.
- **Never subtract from confirmed-known.** One confused moment about a term he has used before
  is a bad sentence on the agent's part, not evidence he forgot the word.
- **The maintenance risk is real and it is one-sided.** The gap table is small and
  event-driven, so hand-maintenance is fine. The confirmed-known list is the half that rots:
  it grows without bound, every entry is low-value on its own, and nothing forces an update.
  That is exactly the half the transcript derivation below would replace — which is the
  strongest argument for building it, and the reason the feasibility check was scoped as this
  task's last criterion rather than as a nice-to-have.

### Worked walk-throughs

**The originating incident, against the shipped guidance.** `Mach-O` at time of writing: not
in the confirmed-known list; not in tier 2 (binary formats are named explicitly as an adjacent
specialist domain, outside the daily loop of building this product); therefore tier 3 —
UNKNOWN — therefore a short inline gloss. The sentence would have carried
"(Apple's macOS executable format)" inline and cost five words.

The load-bearing property: **the guidance produces that outcome without requiring the agent to
have already known he didn't know.** A rule that only works once the gap is on the ledger
would have been useless on the day it mattered, because the ledger was empty. Tier 3 is what
does the work on first contact; the ledger is a refinement on top of it.

**Counter-case, run explicitly as the tuning check.** The rule is mis-tuned if it glosses
terms he plainly knows, so this is checked rather than assumed:

| Term       | Tier                                  | Outcome      |
| ---------- | ------------------------------------- | ------------ |
| `React`    | 2 — his stack                         | **no gloss** |
| `MCP`      | 1 — confirmed known (and also tier 2) | **no gloss** |
| `subagent` | 1 — confirmed known                   | **no gloss** |

All three produce no gloss and no explanation. Note that `React` is carried by tier 2 alone —
it is NOT on the confirmed-known list — which is precisely why tier 2 has to exist. With only
the two evidence-based tiers, `React` would fall to UNKNOWN and get glossed, and the rule would
be condescending by construction on its most common vocabulary. That is the failure this check
is for.

### Feasibility: deriving the known set from `agent_transcript_turns`

**Verdict: mechanically feasible, and NOT safe to build as a naive read. The filtering is the
build, not the query.** Recorded per this task's last success criterion; the derivation itself
is out of scope and gated on this note.

What is already in place, verified by reading the source rather than assuming:

- `agent_transcript_turns` (`packages/domain/src/storage/schemas/agent-transcript-turns-schema.ts`)
  has a dedicated `user_text` column, separate from `assistant_text`, plus a generated
  `fts_text` tsvector and a 1536-dim embedding per turn.
- A `role: "user"` filter already ships on both `TranscriptFtsService.searchText()` and
  `getSession()` (`packages/domain/src/transcripts/transcript-fts-service.ts`), implemented as
  `user_text IS NOT NULL`. So "principal-authored turns only" is a one-line predicate today.

**The trap, and why the naive version would be worse than no derivation.** `user_text` is a
ROLE label, not an AUTHORSHIP label. Its extractor
(`packages/domain/src/transcripts/turn-extractor.ts`, `extractUserText`) keeps **every** `text`
block on a harness `user` line and excludes only `tool_result`. Harness `user` lines also carry
agent-authored material: generated dispatch prompts, expanded skill bodies, slash-command
expansions, injected hook context. Derive vocabulary from that column unfiltered and the agent
learns **the corpus's own vocabulary** and marks it "the principal used it" — the self-citation
error in `claim-confidence.mdc §The corpus is agent-authored`, and in the worst possible
direction: it manufactures false CONFIRMED-KNOWN entries, which suppress glosses. A wrong
"he knows it" is silent; a wrong "he doesn't" is merely wordy.

**Measured, not inferred** — `scripts/measure-principal-turn-purity.ts`, over the 25
most-recently-modified transcripts (the script's default sample size as of mt#4264 — a bare
`bun scripts/measure-principal-turn-purity.ts` reproduces this run with no `--files` flag
required):

```
user-role turns with text: 296
user_text chars total:     7730506

agent/harness-authored turns: 128 (43.2%)
  their chars:                7663305 (99.1%)
plausibly typed turns:        168 (56.8%)
  their chars:                67201 (0.9%)
```

**99.1% of the column's characters are agent-authored.** The principal's actual typed prose is
0.9% of it. Any term-frequency pass over unfiltered `user_text` is reading the corpus, not the
principal. (Re-verified mt#4264, 2026-08-18, against the fixed script — the figure moved from a
previously-cited 99.0%/1.0% to 99.1%/0.9%. That is the "25 most-recently-modified transcripts"
window shifting as new conversations accrue, not a correction to the original measurement; the
conclusion is unchanged.)

Worth recording how that number was reached, because the first attempt got it backwards: a
paired-`<tag>` scan reported **0.0%** contamination — a clean-looking result falsified by its
own denominator, since it implied 226 human turns averaging 23,500 characters each. The
dominant injected material is not tag-wrapped, so nothing was there to match. The instrument
returned the same answer a genuinely clean corpus would have (mem#704), and the tell was in the
output it did produce, not in an error.

**What a real build would therefore need**, if a later task takes it up:

1. **An authorship filter, not a role filter** — exclude turns carrying `minsky:prompt:v1` /
   `minsky:dispatch:v1` stamps, expanded skill bodies, and `<command-message>` /
   `<system-reminder>` spans. The size ceiling used in the measurement script is a blunt proxy
   that works because the distribution is strongly bimodal; a build should key on the markers
   and treat size as a backstop.
2. **A term-extraction pass over the ~1% residue**, which is small enough that this is cheap.
3. **Positive direction only.** The derivation can add confirmed-known entries. It must never
   emit a gap — absence from his prose is the UNKNOWN case, and a derived "he doesn't know this"
   would encode exactly the inference the rule forbids.

Cost/benefit as it stands: the residue is ~67k chars over 25 transcripts, so the corpus is
thin per-session but grows continuously and costs nothing to accumulate. The build is worth
doing when the hand-maintained confirmed-known list starts to rot — that is the trigger to
watch, not a date.

**Update 2026-08-19 (mt#4289): requirement 1 now exists as a column, and it does not need
markers.** `agent_transcript_turns.user_origin` records who authored each turn's `user_text`,
classified at extraction from the harness's OWN fields — `isCompactSummary`, `isMeta`,
`origin.kind`, `promptSource` — rather than from the text. So the authorship filter this section
calls for is `user_origin = 'human'` (exposed as `originKind` on `transcripts_search-text` /
`transcripts_search`), and the marker list plus its size-ceiling backstop are no longer the best
available instrument: both are heuristics over the text, and the structural fields say the same
thing without guessing.

Two things are worth carrying forward rather than discarding. **The magnitude cross-validates.**
mt#4289 measured 43.5% harness-authored across the whole production corpus by an entirely
independent method (prefix classes over `user_text`, prod-wide, 8,245 of 18,948 rows); this
section's 43.2% came from marker-matching over 25 local transcripts. Two methods, two
populations, the same number — which is the strongest evidence either has. **The 99.1%-of-chars
figure is the one that still matters**, and `user_origin` does not supersede it: the point was
never the turn count but that the residue is 0.9% of the characters, and that remains the
argument for a term-extraction pass being cheap.

The caveat on `user_origin` for THIS use: it fails open to `human` for a line carrying no
markers, which is the right default for search and the wrong one for a vocabulary derivation —
where a false CONFIRMED-KNOWN is exactly the silent error this section warns about. A build
should treat `user_origin = 'human'` as necessary and not sufficient, and keep a size backstop.

### Substrates deliberately NOT used

- **`principal_corpus`** (`packages/domain/src/principal-corpus/`, mt#1930) is the **tweet
  archive** — its command description is literally "Semantic search over the principal-corpus
  tweet archive." It feeds the `pz-voice` skill for **register** (how he writes), not for
  knowledge (what he knows), and it is drawn from a different context than the one this
  calibration serves. It is proof the "indexed corpus of the principal's own words" pattern
  works here; it is not the corpus for this. Revisit only with a stated reason.
- **Honcho** (Plastic Labs) was raised by the principal and evaluated in mt#4248's spec.
  Recommendation there: not for this scope — over-buying a general user-psychology engine for a
  one-axis need, a second state store against `decision-defaults.mdc §Datastores`, and priced
  for a many-user model this system does not have. **That evaluation is `inferred`, one
  channel** — a single web search of secondary sources, with gate (k) checks (license SPDX,
  maintenance signals, install path, canonical-URL agreement) NOT run and primary docs not read.
  v1 does not act on it. Run the checks before anyone does. Its peer model is worth a real look
  against the mesh, which is a different and larger question than jargon calibration.

### Enforcement tier: prose, stated rather than defaulted to

Per `/retrospective` Step 4's tier requirement. No detector, hook, or lint rule ships with this,
and none is deferred. Whether a given term needed a gloss for a given reader in a given sentence
is a judgement about a person, not a property of the text — no deterministic check can decide
it, and a mechanism that fired on every unglossed technical term would fire constantly and be
disabled within a day (failure mode 5 in the spec). The regression guard that DOES ship is
`tests/domain/principal-knowledge-surface.test.ts`, which asserts the guidance is present on
every surface an agent reads it from and that the ledger keeps its seeded entries — it checks
that the rule still SAYS this, never that a message obeyed it.

## The vantage point (mt#4259)

The rule's `§What Eugene can see` section is the behavioral contract. This section holds the
originating incident, the evaluation of the three candidate homes (the substance of the task,
not a formality), the worked walk-throughs including the counter-case that keeps the rule from
firing everywhere, and the enforcement-tier statement.

Quotations below are as recorded in mem#1086 (`5b8858f0`), which carries the incident and the
channel analysis.

### Why this axis exists

`§The knowledge surface` above models what he KNOWS, so vocabulary can be pitched at its edge.
This one models what he CAN SEE, so investigation can draw on it. They are two halves of one
root, stated in mem#1086: **the agent's model of the principal is one-directional.** He is the
recipient of output — never a party with STATE the agent can reason about, nor a VANTAGE POINT
it can draw on.

Originating incident, 2026-08-17/18 (mt#4220). He asked for a conversation-view behaviour "like
how Claude Code does it" — runs of consecutive agent actions folded into one line. To check
whether that behaviour existed, the agent ran `strings -n 6` over the installed Claude Code
Mach-O binary and read two published doc pages. Zero hits. It reported the behaviour absent and
**scoped the feature he had asked for out of the task on that basis**: _"Any run-folding here is
therefore an invention, not a port."_

Three things were true at once, and none of them surfaced:

- **The probe could not have succeeded.** Claude Code ships its JavaScript bundled and
  substantially compressed; `strings` prints runs of printable characters and cannot see
  compressed regions. A direct `grep -ac` over the raw binary also returns 0. The search
  returned "not found" whether or not the feature existed.
- **The subject was a VISUAL behaviour and every channel tried was TEXT** — one `WebSearch` that
  returned SEO listicles, two doc pages, and `strings`. Three channels, one kind.
- **He was looking at the feature while the search ran.** He settled the question a day later by
  posting a screenshot of his own terminal showing the exact line —
  `Thought for 47s, listed 1 directory, ran 4 shell commands`. One sentence, _"can you screenshot
  the fold you mean?"_, would have settled it in seconds.

He named the gap himself, and the wording is effectively this rule's spec: _"couldnt you have
found info about that claude code feature using methods besides scanning the binary, such as
looking online for screenshots or whatever?"_

**The cost shape is why this is worth a rule rather than a memory.** The adjacent-but-different
work that shipped in the feature's place (de-carding, mt#4220) was independently worth doing, so
nothing looked unfinished — a plausible deliverable landed, and the wrong scoping stayed
invisible until he noticed it himself.

### Why the existing rules did not fire

This is the constraint that decided where the guidance could live, so it is recorded rather than
summarised:

- **`user-preferences.mdc §Probe before deferring`** fires on deferral prose — "requires X
  access", "deferred to operator", "I can't verify until…". Its third shape (mt#3930) even says
  the probe may be a QUESTION rather than a tool call, which is exactly the mechanic needed here.
  But **no deferral prose was emitted.** The agent was not stuck; it was busy, and confidently
  wrong. Every arm of that bullet is a claim of inability and this failure contains none, so
  adding more phrases to its trigger list cannot catch it: **the failure has no phrase.**
- **`claim-confidence.mdc §Bound a negative claim`** was FOLLOWED, at the sentence level, in the
  same artifact — the spec said verbatim _"Bounded to what was checked: the installed binary's
  extractable strings and the two published docs pages; the classic-renderer source was not
  read."_ The unbounded conclusion drove the scope decision anyway, from elsewhere in the same
  document. That is mem#1086's own subject; its revised root cause is upstream of it — a single
  low-quality channel was treated as a search.
- **The `research-sandwich` skill** exists for multi-modal fan-out and was not reached for.
  Nothing signals when one channel is insufficient. See the home evaluation for why that skill
  could not have been that signal.

### Where this landed, and the three homes evaluated

The task named three candidates. The deciding question is not "which rule is topically closest"
but **which text an agent has in hand at the moment the failure occurs** — and for this incident
that is not a guess, because the transcript records which rule the agent applied at the decision
point.

| Candidate                                      | Retrieval cue                         | Verdict                                         |
| ---------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `user-preferences.mdc §Probe before deferring` | "am I actually blocked?"              | Wrong cue — the agent was not blocked           |
| `claim-confidence.mdc`                         | "what warrant does this claim carry?" | **Right home for the modality half**            |
| `research-sandwich` entry condition            | "this is a research project"          | Ruled out on the skill's own terms              |
| `principal-context.mdc` (chosen)               | "who could answer this?"              | **Right home for the principal-as-source half** |

**`user-preferences.mdc §Probe before deferring` — rejected as the primary home.** It owns the
probe mechanic, including the question-as-probe form, and it has precedent for an ACTION-keyed
arm: §Probe before SELF-IMPROVISING (mt#3154) explicitly says _"No deferral prose is emitted
here, so the tell is the ACTION, not the wording."_ So the shape is admissible there. But the
bullet's organising question is _am I unable to act?_, and the incident's agent was mid-stride
and confident. Guidance filed under a deferral bullet is retrieved when an agent feels stuck,
which is the one state this failure never enters. Secondary: that rule sits at 12,835 chars
against the 15,000 per-rule ceiling (`packages/domain/src/compile/size-budget.ts`
`DEFAULT_PER_RULE_CEILING_CHARS`), and this bullet is already its longest.

**`claim-confidence.mdc` — chosen for the modality-match half only.** The evidence for retrieval
is unusually direct: the agent wrote that rule's channel bound into the spec verbatim, so
§Bound a negative claim demonstrably WAS in hand at the decision point. It complied and stopped
one sentence short — the rule tells you how to LABEL a negative and never asks whether to go get
a better one. The modality rule is also squarely in that rule's family: it generalises §Absence
in a derived view ("the view is silent about your question") and mem#704 ("a probe that cannot
fail is not verification") from a data view to a SEARCH. What does not fit there is the
principal-as-source trigger: claim-confidence is a vocabulary for stating warrant, not a rule
about whom to ask.

**`research-sandwich` entry condition — ruled out, on the skill's own text.** Its "When to use
it" section excludes exactly this case: _"Do NOT use it for: a single-fact lookup, a one-source
question, anything a direct search-and-read answers in a few tool calls."_ "Does Claude Code
fold agent actions?" is a single-fact lookup, so even a perfectly-written entry condition there
would have told this agent not to enter. More generally, a skill is invoked deliberately;
guidance that only fires once you have decided to research well cannot catch the case where you
did not notice you were researching. The exclusion is correct and was left alone.

**`principal-context.mdc` — chosen for the trigger.** The trigger is a fact about the principal
(what he has direct access to), and this is the rule that models the principal; "who could
answer this?" resolves here. It is `alwaysApply`, so availability is equal to the other two
candidates and the choice is purely about the cue. Landing it beside `§What Eugene knows` also
makes the pair legible as ONE model rather than two rules that cite each other — mt#4248's
shipped text already forward-references this half by name. Headroom was the tiebreaker on a tie
that did not exist: 5,655 chars before this addition.

**Net: the guidance is split by nature, not by convenience** — the channel-selection trigger
where the principal is modelled, the perceive-the-kind rule where evidential warrant is
modelled, each cross-referencing the other. A reader arriving from either direction reaches
both.

### Worked walk-throughs

**The originating incident, run against the shipped guidance.** Subject: a run-folding behaviour
rendered in Claude Code's terminal UI, a tool he uses daily → conjunct 1 holds. Channels
available to the agent: the compiled binary, docs _about_ the product, third-party prose — every
one of them derived from the rendered artifact, which the agent has no way to render → conjunct
2 holds. **Verdict: he is a first-tier source; ask him, before or alongside the indirect
channels.** The guidance then bites twice more independently: the modality rule flags a TEXT
search for a VISUAL behaviour before the zero result is accepted at all, and the multi-channel
requirement rejects three text searches as one kind for a negative that is about to license a
scope decision. Any one of the three produces "ask him / search images" rather than "grep the
binary" — the criterion was that the text yields that outcome, not merely permits it.

**The counter-case, run explicitly as the tuning check.** The rule is mis-tuned if it routes
ordinary investigation to the principal, so this is checked rather than assumed:

| Investigation                                | Conjunct 1           | Conjunct 2                              | Outcome        |
| -------------------------------------------- | -------------------- | --------------------------------------- | -------------- |
| A code path in this repo                     | ✅ (he has the repo) | ❌ — you can read the file              | **do not ask** |
| Why a task's status changed                  | ✅                   | ❌ — the task record is queryable       | **do not ask** |
| Whether a deployed service is healthy        | ✅                   | ❌ — probe it                           | **do not ask** |
| A UI behaviour in a third-party app he uses  | ✅                   | ✅ — you cannot render it               | **ask**        |
| What he intended by an ambiguous instruction | ✅                   | ✅ — the intent exists only in his head | **ask**        |

The first row is the one that matters, and note that it fails on conjunct 2 alone. Conjunct 1 is
nearly always true — he has access to essentially everything in this project — so a rule stated
as "ask him when he has access" would route every question to him and be disabled within a day.
**The narrowing work is done entirely by "your channels reach it only indirectly."** Row 3 is
worth naming separately because it is the shape most likely to be rationalised into an ask: he
would probably know, and asking still costs his attention for something a probe settles.

Row 5 is the boundary case in the other direction: intent is not an artifact anyone can read, so
there is no primary source to go to and he is the only channel. That is the same conjunction,
not an exception to it.

### Enforcement tier: prose, stated rather than defaulted to

Per `/retrospective` Step 4's tier requirement. No detector, hook, or lint rule ships with this,
and none is deferred.

The trigger — "could the principal have answered this?" — is not statically decidable. It turns
on whether the agent's available channels reach the subject directly, which is a judgement about
the subject and the tooling in that moment, not a property of any text. The two adjacent
detectors do not fire here **by construction**: `operator-deferral` and `ask-routing-deferral`
both key on deferral prose or a deferral-shaped tool-call state, and this failure emits neither
— the agent never claims inability, which is the same reason §Probe before deferring could not
be the home. A detector that fired whenever an investigation concluded a negative would fire
constantly and be disabled within a day, which is the failure mode the counter-case above is
guarding against on the prose side.

The regression guard that DOES ship is `tests/domain/principal-vantage-point.test.ts`: it
asserts the guidance is present on every surface an agent reads it from, and that the
counter-case and the conjunction survive edits. It checks that the rules still SAY this, never
that an investigation obeyed it.

**The mechanizable slice deliberately not built.** mem#1086's budget proposes one: a durable
artifact containing BOTH a channel-bounded negative AND an unbounded conclusion drawn from it is
a two-sentence pattern that is detectable in a way the general case is not. That is a
claim-confidence-family detector about artifact text, not a channel-selection detector, and it
belongs to whoever picks up that budget — note mem#1086's own correction, that the existing
`negative-existence-claim` detector cannot host it (it requires a cited DONE Minsky task, and
this class of claim is about third-party products). Filed here rather than built, per the task's
`## Scope`.

## Cross-references

- `humility.mdc` — design principle on delegation boundary; this rule provides the persona
  context that the boundary is drawn around
- `decision-defaults.mdc` — policy corpus that presupposes this rule; particularly
  `§Build vs buy` and `§Multi-step direction execution` reference principal-context implicitly
- `work-completion.mdc` — work-completion discipline that presupposes commercial-product framing
- `.claude/skills/declare-framework/SKILL.md` — structural enforcement of the trigger rule
  (mt#1789)
- mt#1034 — attention-allocation subsystem (eventually the structural home for persona-aware
  decision frameworks)
- mt#1789 — structural escalation task (skill-step requiring explicit framework declaration) —
  IMPLEMENTED
- `feedback_explicit_framework_selection` — meta-rule on naming frameworks before applying them
  (bridge memory, retiring with this skill)
- mt#4248 — the knowledge-surface axis (`§The knowledge surface` above)
- mt#4259 — **the reciprocal half, now shipped**: the principal as an EVIDENCE CHANNEL, not only
  the recipient of findings (`§The vantage point` above). Same root — the agent's model of him is
  one-directional: he is never a party with STATE the agent can reason about (mt#4248, what he
  knows) nor a VANTAGE POINT it can draw on (mt#4259, what he can see). **Coordinated, not
  merged** — a knowledge model and a probe habit are different builds, per `decision-defaults.mdc
§Task overlap` — but a design for either that ignores the other treats a symptom: a vocabulary
  model that never asks him what he knows is guessing, and a probe habit that asks in terms he
  must decode reproduces the problem while trying to solve it. The two sections are deliberately
  adjacent in the rule so the model reads as one thing.
- `claim-confidence.mdc §Before accepting a zero result` — mt#4259's other half: whether a channel
  can PERCEIVE the kind of thing being sought. Split by nature, not convenience; the reasoning is
  in `§Where this landed, and the three homes evaluated`.
- mem#1086 (`5b8858f0`) — the incident record and channel analysis both tasks cite
- `user-preferences.mdc §Plain-language first` — the ADJACENT rule, deliberately a different
  class: process-internal shorthand, not outside-domain technical terms. Both failed in the
  same session, which is the evidence they are not one rule.
- `feedback_build_vs_buy_default_for_non_core` — R1 of the same pattern
- `feedback_build_path_as_research_at_action_time` — R2 of the same pattern
- This rule is R3 (meta) of the pattern
