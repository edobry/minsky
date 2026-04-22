---
name: engineering-writing
description: Writing engineering essays, position papers, technical blog posts, and architecture memos intended for external or semi-external readers. Use when drafting or revising long-form argumentative prose — Notion position papers, public blog posts, shared design docs meant to persuade, RFCs with argumentative structure. Provides structural patterns (lead with position, justify after), section-heading heuristics (sentence case, specific, opinionated), an AI-voice-tells checklist (em dashes, tricolons, vocabulary, heading patterns), and a revision workflow. Skip for task specs (use create-task), rule files (use create-rule), code comments, or short internal-only docs.
---

# Engineering Writing

Guide for writing long-form engineering prose that reads like a person wrote it, reaches a confident position, and earns the reader's continued attention.

## When to use

- Position papers and RFCs meant for semi-external readers (Notion papers, shared design docs)
- Engineering blog posts
- Architecture memos arguing for a specific approach
- Long-form ADRs with argumentative structure

Skip for: task specs, rule files, code comments, short internal-only docs (a few paragraphs don't warrant this apparatus).

## Structure serves content, not the other way around

This is the most common way essays go wrong: the writer picks up a structure that worked for some other essay — often a sibling piece in the same corpus — and applies it section by section to different content. The content doesn't fit. Sections get forced. Claims get invented to fill slots. The resulting essay is structurally correct and rhetorically hollow.

The skill's structural advice below is an **inventory of moves**, not a required sequence. A given essay might use six moves, or ten, or three. The moves you use should be the ones your content demands.

Signs your structure is driving your content instead of the reverse:

- A section whose central claim is a stretch. If the best you can do for "three ways this goes wrong" is three paraphrases of the same concern, there aren't three ways — you're padding.
- A named taxonomy with forced distinctions. If your "four camps" collapse pairwise into each other on inspection, you have two camps, not four. Don't round up.
- A "named contribution" whose name has no load. If your scheme is called "the X model" and nothing about it is meaningfully an X, the name is imitative. Describe what it is instead.
- Forward-referenced claims that never come back. If your exordium promises "a framework, a landscape, a named pattern, and a roadmap," and three of those four are thin, you don't need four sections.
- Phases or layers padded to match an exemplar. Real phases correspond to real decision points or external gates. Invented phases correspond to slots in a template.

Check: for each section, ask "if I deleted this, what argumentative move would I lose?" If the answer is "stylistic parallelism with the other post" or "I don't know," cut it.

**Copy patterns only when your content has the same shape.** The sibling post's "GitHub is the outlier" works because GitHub literally is the outlier in the forge-signing landscape. "Four questions, not one" works because there are literally four orthogonal design dimensions. Before reusing either structural move, check: does your content have an outlier? Four orthogonal dimensions? If not, you're cargo-culting shape.

Dan Luu: "Copying someone else's style is unlikely to work for you." Start from what your content needs.

## Structural pattern: stakes before position, then justify

The right structure depends on whether you're writing **informative** prose (reader already cares) or **persuasive** prose (reader needs to be brought along).

Informative prose uses the **inverted pyramid** — conclusion first, details after. This is journalism's structure. Works when readers are searching for facts and will stop reading whenever they have enough.

Persuasive prose uses the **classical rhetoric structure** — exordium, narratio, propositio, confirmatio, peroratio. Hook, stakes, thesis, argument, conclusion. The thesis comes _after_ stakes, not before, because readers need to feel the problem before they can receive the position as reasonable rather than overreach.

Position papers are persuasion, not journalism. If your thesis is counter-intuitive ("this thing that seems minor is actually load-bearing"), leading with it makes readers dismiss it. Leading with stakes gets them to say "oh, this is a real problem" before you tell them what to do about it.

Inventory of moves engineering essays draw on. A given essay uses some subset, in an order that serves its argument:

1. **Hook / observation.** One or two paragraphs. Concrete, not abstract. May hint at the thesis without planting the flag. ("This paper is about ... a design pattern we think handles the problem.")
2. **Why it matters.** Stakes, context, what changed. This is the load-bearing section for making the reader care. Skeptical reader leaves here if you haven't earned their attention.
3. **What you think.** Your position, plainly stated, now that stakes have landed. Keep it tight (3-5 paragraphs). Invite disagreement: "if you buy this, the rest is the argument for how to act on it; if you don't, the rest is the argument for why you should."
4. **The conceptual move.** The framework or distinction that unlocks clean thinking about the problem. Often the thing that _makes_ your position defensible.
5. **Landscape and evidence.** What others do, how the camps differ, what the forge/tool/standard actually provides.
6. **Your contribution (named).** The design pattern, architectural move, or principle you're offering. Give it a name.
7. **Validation.** Threat models, security analysis, stress-testing the contribution against known failure modes.
8. **Case study.** What the framework reveals when applied to a real system — usually your own. Grounding before prescription.
9. **Prescription / roadmap.** Phased progression from messy state to principled one. Structural phases and activation gates, not timelines.
10. **Open questions and gates.** What you don't know, what would change your mind.
11. **Advice for readers in a similar place.** Short, practical, drawn from your investigation without being autobiography.
12. **Further reading.** Citations.

**Where to bury what:**

- Don't bury the position in section 8 of 12. Readers who stopped reading won't find it.
- Don't put the position in section 1 either, for a counter-intuitive thesis. Readers dismiss it without context.
- Section 3 (right after stakes) is the sweet spot for persuasive thesis placement.
- Very skimmable-first readers who want the thesis upfront can see the hint in the exordium and skip to the position if they want.

### Handling forward references in the position section

A common trap: your position section references concepts that haven't been introduced yet — "we stay Camp 3.5," "the four dimensions stay decoupled," "the capabilities model is load-bearing." If the position comes before the framework/landscape sections that introduce those concepts, readers are lost.

Two patterns that work:

- **Slim the early position** to just the claims that stand alone. Distribute the context-dependent claims into the sections that set them up. The Camp 3.5 shorthand lands at the end of the landscape section. The "decoupling as code discipline" claim lands at the end of the framework section. The "capabilities-model sovereignty" claim lands in the contribution section.
- **Forward-promise in the exordium.** "The rest of the paper elaborates these into a framework, a landscape, a named design pattern, and a roadmap." Tells the reader what's coming without demanding they understand it yet.

Use the distribution pattern when the position has claims that are meaningfully different in nature (values vs design principles vs shorthand labels). Use the forward-promise when the position is coherent but context-heavy.

## Writing for external readers

Position papers often draw on internal material: task IDs, commit SHAs, specific timelines, internal review threads, project-specific terminology. Most of this is noise to external readers and undercuts the paper. Strip it.

### What to strip

- **Internal ticket or task IDs in the main body** (mt#XXX, PROJ-123). Readers can't verify these, can't use them, and they read as advertorial for your internal tracker. Translate to descriptive summaries ("a tool-name typo in a skill file" beats "mt#1030 via the pre-tool hook"). If the IDs are genuinely useful for team execution, publish them in a separate team-facing doc and link from the paper.
- **Hard timelines in roadmap sections**, especially when your position is "progress is gate-driven, not timeline-driven." Timelines contradict the gates argument. Pick one. If phases activate on triggers rather than calendar, the timelines undermine your own case.
- **Internal file paths, branch names, repo-specific conventions** unless the paper is explicitly about them.
- **Dense internal context the reader can't verify or use.** ("mt#834 was superseded by mt#847 before mt#846 was merged.") This reads as chronology, not analysis.

### What to keep

- Named systems and tools that carry information for external readers (Dependabot, Renovate, SLSA, Fulcio).
- Concrete verbatim quotes from primary sources.
- Specific attack case studies and incidents by name when they anchor a claim.
- One or two internal examples as illustration, if they ground an abstract point. Frame them as "an example from a system we've been working on," not as the center of the argument.

### Roadmap structure: pattern vs specifics

A roadmap in a position paper serves two audiences at once:

- Your team, which wants a plan it can execute against tickets
- External readers, who want a phased-maturity pattern they can adapt

Both get served, but not with the same content. When writing for external readers, describe each phase by its **structural purpose** (foundational hygiene, attribution correctness, identity-model decision, cryptographic provenance, etc.), not by the specific tickets that implement it. Describe **gates** (what triggers the phase) rather than timelines (when it happens). If you need the team-facing version with task IDs and dates, publish it separately and link from the paper.

### Case study placement: grounding before prescription

A case study ("here's what the framework reveals when applied to a real system") usually belongs _before_ the prescriptive roadmap, not after. Readers absorb the concrete example as grounding for the abstract prescription. If the roadmap comes first, readers have no anchor for what each phase is addressing; the phases read as abstract tidying.

Default order: frame → contribution → validation → case study → prescription.

Exception: if the case study is very short or very abstract, it can work as a closing illustration. But that's the exception.

### Threat analysis: before the design pattern, not after

If your paper proposes a design pattern and also analyzes threats the pattern has to handle, put the threat analysis **before** the design pattern, not after. Threats-first motivates the design requirements. Threats-last reads as post-hoc justification.

Reader experience with threats-first: "Here's what breaks. Here's why any design has to handle X, Y, Z. Here's our design, which handles them like this." Natural evaluation.

Reader experience with threats-last: "Here's our design (abstract). Now let me convince you it's good by showing you threats it handles." The design lands without criteria; the reader is stuck trusting you until the threats arrive.

The exception: if the design pattern is truly the main event and threats are a minor validation aside, threats-last can work. But for papers where the threats are load-bearing for the design, threats come first.

### Phases and gates: integrate, don't separate

When a roadmap has phases AND each phase has an activation trigger ("gate"), resist the urge to split them into two sections (Phases then Gates). Readers end up cross-referencing. Each phase should describe what it is AND when it activates in one place.

Good:

```
### Phase 2. Bot-identity architecture decision

*What:* Choose your bot-identity model explicitly.
*Activates:* When Phase 1 produces operational data showing where gaps hurt.
```

Bad:

```
### Phase 2. Bot-identity architecture decision
Choose your bot-identity model explicitly.

### Gates
Phase 2: activates when Phase 1 produces operational data showing where gaps hurt.
Phase 3: activates when ...
```

The "bad" version forces the reader to hold each phase in memory while they scan for its gate. The "good" version delivers both facts together.

Closing note about gates-overall can remain as a short paragraph after the phases, but the per-phase activation condition belongs with each phase.

### Open questions: field-level before internal-level

A "what's still open" section serves two audiences: external readers who want to engage with the field's unresolved questions, and internal readers who want to see where you're uncertain. Lead with the field-level questions. Put the internal stance questions second. Bury the specific-to-your-situation decisions entirely if they don't teach the reader something.

Weak:

- Phase 2 model winner. Depends on our multi-tenancy plans.
- Phase 5 sequencing. Which forge first? Likely whichever a paying customer runs on.

Strong:

- How should agent-authored commits count toward a human's contribution graph? No consensus in the field.
- When will forge ecosystems recognize sigstore as Verified? No single team controls this.
- Choices we've taken that aren't permanent: GitHub App over service-account. Revisited on portability or sovereignty pressure.

Field-level questions invite reader engagement. Internal-only decisions are noise to anyone who doesn't work at your company.

### Origin / appendix: advice to future investigators, not autobiography

If you include an origin section ("how this paper came to exist"), frame it as advice for future investigators doing similar work. The external reader doesn't care about your chronology. They do care about patterns they can apply to their own system.

Good origin framing:

- "If you're doing a similar audit..."
- "The questions that surfaced the most ground were..."
- "The bugs that pointed at the architectural problem were of the form..."

Bad origin framing:

- "Pull request #646 showed..." (autobiography)
- "The investigation began when..." (autobiography)
- "We then discovered..." (chronological narrative)

A brief internal anchor ("this paper exists because one such asymmetry led back through several layers of half-explicit commitments") can ground the section. But it shouldn't be the organizing principle. The organizing principle is the advice.

## Section heading heuristics

AI-generated prose trends toward abstract, title-cased, formulaic headings. Human engineering prose trends toward sentence-case, specific, and sometimes opinionated headings.

Weak, AI-flavored:

- "The Problem"
- "Key Considerations"
- "Industry Landscape"
- "Why This Matters Now"
- "A Position"
- "Applied: Six Phases of Maturity"
- "Appendix: Origin of This Investigation"

Stronger:

- "What we think" (not "A Position")
- "What changes when agents are the committers" (not "Why This Matters Now")
- "GitHub is the outlier" (not "Forge Landscape")
- "Four questions, not one" (not "Conceptual Framework")
- "A capabilities model" (not "The Forge-Capabilities Model")
- "Three ways this goes wrong" (not "Threat Models and Security Analysis")
- "What the audit of our own code turned up" (not "A Case Study")
- "Where this started" (not "Appendix: Origin")

Rules of thumb:

- Sentence case over title case
- Specific claims over abstract nouns ("GitHub is the outlier" vs "Forge Landscape")
- Verb phrases over noun phrases where natural ("What we think" vs "Our Position")
- Let a heading tease the section's conclusion, not merely name its topic

### Named contributions need real distinctness

If you give your design pattern or framework a name ("a capabilities model," "the authority ladder," "the four-dimension audit"), the name has to describe something genuinely distinct. A good name compresses an idea the reader can then recall with one phrase. A bad name is imitative — you gave something a label because a sibling essay did, not because the thing deserves one.

Check: can you define the name in a sentence, and does the definition point to something the essay couldn't have made just as well without the name? If the definition is "three layers resolved by priority" and the name is "a layered capture model," the name is adding nothing. Call it what it is.

Named contributions from other essays in the corpus ("a capabilities model," "Camp 3.5") belong only to the essay that invented them. Don't reuse them in adjacent essays to claim kinship.

## AI-voice tells to avoid

These are the patterns readers pattern-match as AI writing. Individual instances aren't damning; clustering is the tell.

### Vocabulary

Words that flag AI drafting:

- `delve`, `leverage`, `utilize` (when `use` works)
- `crucial`, `pivotal`, `significant`, `key` (as evaluative adjectives without specifics)
- `robust`, `meticulous`, `comprehensive`
- `foster`, `bolster`, `enhance`, `garner`
- `underscore`, `showcase`
- `tapestry`, `interplay`, abstract uses of `landscape`
- `resonate`, `align`
- `enduring`, `testament`
- `paradigm`, `holistic`, `synergy`

### Phrases

Tics to cut:

- "It's worth noting that..."
- "It is important to remember..."
- "At its core..."
- "Fundamentally,..."
- "Ultimately,..."
- "In today's world..."
- "One might argue..."
- "As previously mentioned..."
- "In conclusion..."
- "This is not X, it's Y" (as a rhetorical structure, repeated)
- "Not just X, but Y" (as a rhetorical structure, repeated)

### Borrowed phrasings from sibling work

Specific idioms that earn their place in the essay that invented them become tells when they appear verbatim in a second essay by the same author. These are not generic AI-voice phrases — they're signature moves, and using them twice signals "I'm imitating a template" rather than "I'm writing."

Typical patterns that become tells when lifted verbatim from a sibling essay:

- Opening-the-counterposition idioms: "A less fashionable corollary," "If you buy it, the rest is our argument for how to act on it; if you don't, the rest is our argument for why you should."
- Forward-promise enumerations: "The rest of the paper elaborates these into a framework, a landscape, a named design pattern, and a roadmap."
- Camp-naming shorthands: "Our stance, with the camps named: Camp 3.5." (Whatever decimal-camp move the first essay invented.)
- Phase/gate macros: `### Phase N. X` with fixed-format `*What:* …` / `*Activates:* …` sub-lines.
- Second-person advice closers: "If you're doing a similar audit" / "If you're [verb]ing your own [noun]."

If a phrasing was load-bearing in the first essay, write something different that does the same rhetorical work in the second. Reusing voice-of-author patterns (contractions, sentence rhythm, directness) is fine. Reusing specific idioms is not.

### Structural tics

- **Em dash overuse.** Em dash is AI's favorite punctuation. One or two per ~2000 words is fine; a dozen is a tell. Reach for comma, period, or colon first.
- **Tricolon overuse.** "X, Y, and Z" lists repeated in every paragraph. Vary: sometimes two items, sometimes a single concrete noun.
- **Rule of three everywhere.** Three bullets per section, three adjectives stacked, three parallel clauses. Break the pattern sometimes.
- **Symmetric structures.** Every camp gets exactly the same four bullets; every phase the same four fields. Real writing has ragged edges.
- **Present-participle summary clauses.** "..., highlighting its significance" / "..., underscoring its role" / "..., emphasizing the importance of." AI glues these onto sentences to claim significance without earning it.
- **`serves as` / `marks` / `features` / `boasts`** instead of `is`. AI avoids copulas.
- **Bulleted lists where prose flows.** AI defaults to bullets; prose is often stronger.
- **Callout boxes after every section** with a "takeaway." Tutorial-flavored; doesn't belong in a position paper.
- **Title-cased headings** for everything.
- **Curly quotes mixed with straight quotes.** Check editor auto-substitution.

### Tone tics

- **No contractions.** Human writing mixes them. Use `don't`, `won't`, `it's`, `we're`.
- **Uniform sentence length.** Vary. Short sentences punch. Long sentences develop. Mix them.
- **Uniform paragraph length.** A one-sentence paragraph can carry weight.
- **Flat register start to finish.** Real writers shift between analytical, conversational, and direct. Flat neutral register is the clearest AI tell after em dashes.
- **Over-qualified statements.** "In many cases, it may be the case that..." Cut to `often`.
- **Weasel attribution.** "Observers have noted..." / "Many experts agree..." Name who, or say `we think`.

## Positive patterns to emulate

### Voice

- Use `we` or `I` when stating a position. Don't hide behind passive voice.
- Sound opinionated. A position paper that never commits is an analysis, not a position.
- Acknowledge counterpositions explicitly. "If you disagree, here's what the argument requires" reads more confident than hedging everywhere.
- Use contractions. `We don't think` beats `We do not think`.

### Sentence construction

- Default to short sentences. Break long ones with a period.
- Active voice unless there's a reason. `GitHub signs the commit` beats `The commit is signed by GitHub`.
- Concrete nouns beat abstract ones. `commit`, `token`, `installation` beat `artifact`, `identity`, `mechanism` when the concrete term works.
- Name specific systems, tools, companies, versions. Specificity earns trust.

### Evidence

- Link primary sources (docs, RFCs, commits, issue threads). Secondary sources are weaker.
- Quote verbatim when phrasing matters.
- Use concrete examples instead of abstract description. `Dependabot does X, Renovate does Y` beats `different bots approach this differently`.
- Cite attack case studies and incidents by name when they anchor a claim.

### Structure

- One idea per paragraph. If a paragraph has three points, split it.
- Short sections beat long ones. A long section that's really two sections should be two sections.
- Tables for comparisons across a shared dimension. Prose for sequential argument.
- Bold key terms on first use when naming something. Don't bold every instance.

## Revision workflow

Run these passes after the draft is down. Don't edit while drafting.

1. **Structure-vs-content pass.** For each section, ask: "if I deleted this, what argumentative move would I lose?" If the answer is "stylistic parallelism with another essay" or "I don't know," cut. Especially check for: invented phase counts, forced threat-model trios, camp taxonomies padded past their natural breakpoints, "named contributions" whose names don't compress anything real, case-study sections that aren't case studies.
2. **Sibling-phrasing pass.** If you have an essay in the same corpus that shares vocabulary or structure, re-read both side by side. Any specific idiom that appears in both ("a less fashionable corollary," `*What:* / *Activates:*`, "Our stance, with the camps named") is a tell. Rewrite the second one in different words that do the same rhetorical work.
3. **Heading pass.** Review every heading. Sentence-case. Specific. Opinionated where possible. Rewrite any that match AI-flavored patterns above.
4. **Opening pass.** Is the hook concrete? Does the reader know by the end of page one what the essay is about and why they should keep reading? Cut "how this came to exist" framings from the top; move to appendix.
5. **Em dash pass.** Search for `—`. Cut most. Replace with comma, period, or colon. Keep one or two where emphasis genuinely warrants.
6. **Vocabulary pass.** Search for AI words (`delve`, `leverage`, `crucial`, etc.). Replace with plainer alternatives.
7. **Phrase pass.** Search for AI tics ("it's worth noting," "at its core," etc.). Cut or replace.
8. **Sentence variety pass.** Read for rhythm. If every sentence is the same length, break some. If everything is tricolons, cut one to two items.
9. **Contraction pass.** Add contractions where formal writing wouldn't forbid them.
10. **Cut-for-cream pass.** Paul Graham: "Cut as much as possible and serve only the cream." Read each paragraph and ask: does every sentence carry weight? If a sentence only restates the one above it, cut.
11. **Example density pass.** Dan Luu: "Add more examples than you'd naturally tend to." For each abstract claim, check if a concrete example is nearby. If not, add one.
12. **Read aloud.** Clunky phrasing reveals itself when spoken. Fix what sounds wrong.
13. **Reality check.** Would a skeptical reader keep reading past page 2? If not, the opening isn't hooking them.

## Exemplars worth studying

Study for voice and structural _range_, not as templates.

- **Dan Luu** (danluu.com) — blunt, data-heavy, opinions stated directly. Often starts mid-thought with a concrete example and builds up through accumulated evidence rather than following a fixed arc. Explicit on his blog that copying another writer's style doesn't work.
- **Simon Willison** (simonwillison.net) — annotated-presentation format for talks, "here's a thing I found and what I made of it" for short posts, pattern-shaped chapters for larger projects. Deliberate choice of form per piece.
- **Julia Evans** (jvns.ca) — "I struggled with X, here's what I learned" narrative shape. Short. Conversational register. Teaches through a single concrete scenario.
- **Paul Graham** (paulgraham.com) — essay built around a central surprising claim, with consequences drawn out. "Writing simply keeps you honest." Willing to be brief.
- **Matt Levine** (Money Stuff) — narrative opening, long paragraphs done well, argumentative work woven into prose rather than sectioned off.
- **Bret Victor** (worrydream.com) — strong thesis, visual thinking, essay structure chosen to match the argument being made.
- **Martin Fowler** (martinfowler.com) — named patterns, crisp definitions, concise per-page scope.

What all of them share: structure chosen for the specific piece, not inherited from a template. What none of them do: write every essay to the same skeleton.

## Where papers live

Strategic writing (position papers, RFCs, design notes, landscape analyses) typically belongs in a place optimized for reading and sharing — a team wiki, Notion workspace, public blog, or internal documentation portal. Operational references (architecture specs, setup guides, contributing docs, theory-of-operation) typically belong in the code repository next to the artifacts they describe.

The split matters because the audiences differ. Strategic writing is meant to persuade and get reviewed; living next to commits makes it easy for readers to lose the thread. Operational writing is meant to be consulted; living on a separate platform makes it drift from the code.

Cross-reference between the two when appropriate. Don't duplicate. Whichever split your organization uses, name it explicitly so contributors know which kind of writing goes where.

## References

- [Wikipedia — Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) — systematic inventory
- [The Em Dash Dilemma](https://medium.com/@brentcsutoras/the-em-dash-dilemma-how-a-punctuation-mark-became-ais-stubborn-signature-684fbcc9f559)
- [Washington Post — AI em dash writing](https://www.washingtonpost.com/technology/2025/04/09/ai-em-dash-writing-punctuation-chatgpt/)
