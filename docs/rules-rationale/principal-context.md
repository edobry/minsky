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

| Term         | Date       | Signal                                                     |
| ------------ | ---------- | ---------------------------------------------------------- |
| `Mach-O`     | 2026-08-18 | _"what does 'strings on a Mach-O' mean?"_                  |
| `strings(1)` | 2026-08-18 | same question; both terms were in the one unglossed clause |

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
most-recently-modified transcripts:

```
user-role turns with text: 226
user_text chars total:     5434550

agent/harness-authored turns: 87 (38.5%)
  their chars:                5379404 (99.0%)
plausibly typed turns:        139 (61.5%)
  their chars:                55146 (1.0%)
```

**99.0% of the column's characters are agent-authored.** The principal's actual typed prose is
1.0% of it. Any term-frequency pass over unfiltered `user_text` is reading the corpus, not the
principal.

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

Cost/benefit as it stands: the residue is ~55k chars over 25 transcripts, so the corpus is
thin per-session but grows continuously and costs nothing to accumulate. The build is worth
doing when the hand-maintained confirmed-known list starts to rot — that is the trigger to
watch, not a date.

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
- mt#4259 — **the reciprocal half**: treat the principal as an EVIDENCE CHANNEL, not only the
  recipient of findings. Same root — the agent's model of him is one-directional: he is never a
  party with STATE the agent can reason about (mt#4248, what he knows) nor a VANTAGE POINT it
  can draw on (mt#4259, what he can see). **Coordinate, do not merge** — a knowledge model and
  a probe habit are different builds, per `decision-defaults.mdc §Task overlap` — but a design
  for either that ignores the other treats a symptom: a vocabulary model that never asks him
  what he knows is guessing, and a probe habit that asks in terms he must decode reproduces
  the problem while trying to solve it.
- mem#1086 (`5b8858f0`) — the incident record and channel analysis both tasks cite
- `user-preferences.mdc §Plain-language first` — the ADJACENT rule, deliberately a different
  class: process-internal shorthand, not outside-domain technical terms. Both failed in the
  same session, which is the evidence they are not one rule.
- `feedback_build_vs_buy_default_for_non_core` — R1 of the same pattern
- `feedback_build_path_as_research_at_action_time` — R2 of the same pattern
- This rule is R3 (meta) of the pattern
