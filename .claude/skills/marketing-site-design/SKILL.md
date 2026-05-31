---
name: marketing-site-design
description: >-
  Myth-first methodology for designing the Minsky marketing site and any
  adjacent marketing surface (microsites, launch pages, position-paper
  landing pages). Layers marketing-specific patterns (Idiom B product-
  screenshot-dominant, left-caption + right-product hero, alternating
  sections, co-product logo strategy, marketing-format anti-patterns) on
  top of the `minsky-brand` foundation (locked myth, cultural code,
  five-layer reference architecture, vocabulary). Consumes the
  analytical output of `analyze-adjacent-product` for new-surface
  workshops. Use when designing or auditing any Minsky marketing
  surface, or workshopping a brand-positioning myth for a new surface.
  Complements the vendored Tier-1 skills (impeccable / frontend-design
  / web-design-guidelines / plan-design-review / information-architecture
  / engineering-writing / seo-skill / motion-framer).
user-invocable: true
---

# marketing-site-design — marketing-surface patterns over the Minsky brand foundation

You are designing or auditing a marketing surface for Minsky (`services/site/` in this monorepo, or any future microsite, launch page, or campaign page). The vendored Tier-1 skills cover visual quality, IA, engineering stack, SEO, and motion. The sibling `analyze-adjacent-product` skill encodes the Peirce-Barthes-Oswald semiotic framework for reading other brands. The sibling `minsky-brand` skill carries the locked brand foundation (myth, cultural code, references, vocabulary). **This skill adds the marketing-surface layer on top of that foundation:** which idiom marketing uses, how marketing pages are structured, what marketing-format anti-patterns are forbidden, and how to run a workshop for a new marketing-surface myth.

If you are pattern-matching against "what other AI startup sites look like" before invoking `minsky-brand` to load the locked myth and code, stop. That order of operations produces the Pepsi/Arnell trap (§2). The order is: load `minsky-brand` → pick the marketing idiom that carries the code → choose the signs that instantiate it on the marketing surface.

## When to invoke

- Designing or rebuilding the Minsky marketing site (`services/site/` in this monorepo; rebuilt under mt#1934 and live at https://minsky-site-production.up.railway.app)
- Designing any adjacent marketing surface (launch microsites, campaign pages, position-paper landing pages)
- Auditing an existing marketing surface against the locked brand register
- Workshopping a brand-positioning myth for a _new_ marketing surface (the locked Minsky myth is in `minsky-brand` §1 — don't re-derive)
- Reviewing a design proposal that arrived without explicit myth-statement
- _(For analyzing an adjacent product's marketing site, use the sibling skill `analyze-adjacent-product` instead — this skill consumes that one's output during §7 workshop Step 4.)_

## 1. Load the brand foundation first

The brand foundation — locked myth (exocortex / flock), cultural code (Cyberbrain / Section 9), five-layer reference architecture, bridge-as-affect discipline, code-architecture synthesis, vocabulary inventory — lives in [`minsky-brand`](../minsky-brand/SKILL.md). Load it before any marketing-surface decision.

The operational tokens (typography stack, color palette with hex + OKLCH, motion budget, WCAG contrast targets, font licensing, fallback stacks) live in [`docs/brand-system.md`](../../../docs/brand-system.md). Consume those directly when implementing.

The voice substance (Macx-register prose, semicolon rhythm, vocabulary precision, no-go register) lives in [`pz-voice`](../pz-voice/SKILL.md). Compose with `minsky-brand` per its §8 (signal/channel split) — voice carries WHAT is claimed; cultural codes carry HOW it feels.

This skill begins where those leave off.

## 2. The Pepsi/Arnell trap (marketing-surface application)

Visual choices must instantiate the myth, never retrofit it. The canonical anti-pattern is the 2008 Pepsi rebrand's "Breathtaking" document — semiotic vocabulary as post-hoc theater. The full discussion of the trap and its symmetrical disciplines lives in [`analyze-adjacent-product/SKILL.md`](../analyze-adjacent-product/SKILL.md) §2; the brand-foundation cut lives in [`minsky-brand/SKILL.md`](../minsky-brand/SKILL.md) §6.

For marketing-surface work specifically: if you cannot explain a visual choice on a marketing page as a sign carrying a specific connotation that instantiates the locked myth (per `minsky-brand` §1), cut it.

## 3. Bridge-as-affect (marketing-surface application)

The discipline for invoking emergent cultural codes through residual references the audience already recognizes — without going literal. Full framework discussion in [`analyze-adjacent-product/SKILL.md`](../analyze-adjacent-product/SKILL.md) §3; Minsky-specific application in [`minsky-brand/SKILL.md`](../minsky-brand/SKILL.md) §3.

On a marketing surface specifically: **borrow at the layer of register, never at the layer of imagery.** Specific register-borrowing rules live in `minsky-brand` §3 ("What goes on every surface" / "What never appears"). On marketing pages, the imagery-rejection rules apply with extra force because the marketing context tempts toward "more dramatic" visuals — the Iron Man / JARVIS framing, the Composio-style multicolor saturation, the WebGL-shader hero. The brand foundation forbids all of these; this skill names the marketing-format equivalents in §8 below.

## 4. The competing idioms in AI-product marketing

Empirical observation from the 2026-05 three-way analysis (full version in [`analyze-adjacent-product/references/case-studies-2026-05.md`](../analyze-adjacent-product/references/case-studies-2026-05.md)):

**Idiom A — Motion-decorated infographic** (exemplar: Composio): WebGL shader, centered headlines, multi-color saturated tiles, decorative animation, premium paid typeface. Sells _concept_. Used when the product is invisible plumbing.

**Idiom B — Product-screenshot dominant, restrained** (exemplars: Cursor, Factory): static/near-static hero, left-caption + right-product-screenshot, monochrome dark with minimal accent, real product UI as dominant visual element, free or commissioned typeface, muted customer-logo row. Sells _the actual product_. Used when the product has surfaces worth showing.

**Idiom C — Founder-essay** (exemplar: Macro): long-form first-person prose, principal-as-narrator, embedded artifacts (screenshots, code, diagrams) inside the essay rather than as separate sections. Sells _the principal's frame_. Used when the principal's perspective IS the product's differentiator.

Minsky's primary marketing surface (the site) is **Idiom B** — the CLI, MCP tool calls, cockpit, reviewer-bot PR comments, task graph, memory recall are the surfaces that should carry the pitch; decorative motion would substitute for product proof Minsky already has. Position-paper landing pages and About sections may lean toward **Idiom C** (founder-essay) for the principal-substrate framing.

## 5. Vendored Tier-1 skill bundle

The marketing-site-design umbrella complements these skills (already present in `.claude/skills/`):

| Skill                                 | Covers                                                                                                         | When to invoke during marketing-site work                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `minsky-brand`                        | Brand foundation — locked myth, cultural code, layered references, vocabulary, bridge-as-affect                | **Always — load first**. Strategic anchor for every marketing-surface decision.            |
| `pz-voice`                            | Principal's literary voice — semicolon rhythm, vocabulary precision, no-go register, operative-ontology stance | When drafting any marketing copy or section text — the signal layer per `minsky-brand` §8. |
| `analyze-adjacent-product`            | Semiotic analysis methodology (Peirce-Barthes-Oswald + Chrome DevTools capture + per-analysis template)        | When reading a competitor's surface to inform positioning decisions (workshop §7 Step 4)   |
| `impeccable`                          | Visual quality audit, design polish, anti-patterns                                                             | After draft, before commit — does this read as production-grade?                           |
| `frontend-design` (Anthropic)         | Distinctive frontend interfaces, anti-AI-slop                                                                  | When generating marketing-page React/Astro components                                      |
| `web-design-guidelines`               | Web Interface Guidelines, accessibility, UX                                                                    | Always — accessibility floor for any public surface                                        |
| `plan-design-review`                  | Designer's-eye plan critique, 0-10 dimension rating                                                            | Before implementing any new section — rate the plan, fix to 10                             |
| `information-architecture`            | Section structure, hierarchy, navigation model                                                                 | When deciding page IA, section ordering                                                    |
| `engineering-writing`                 | Long-form argumentative prose, technical voice                                                                 | For position-paper landing pages, manifesto sections, about pages                          |
| `seo-skill` (vendored 2026-05-19)     | Static-site meta/OG/JSON-LD/sitemap/robots                                                                     | After draft, before launch — discoverability floor                                         |
| `motion-framer` (vendored 2026-05-19) | Framer Motion patterns for ambient identity motion, scroll reveals                                             | When implementing the motion budget (see §6)                                               |
| `tailwind-v4-shadcn`                  | Tailwind v4 + shadcn/ui setup                                                                                  | If using shadcn for component primitives                                                   |
| `react-best-practices`                | React/Next.js performance patterns                                                                             | For Astro islands or Next.js page implementation                                           |
| `composition-patterns`                | React composition (compound components, render props)                                                          | When building reusable section primitives (Hero, FeatureRow, etc.)                         |

## 6. The marketing-specific layer — concrete decisions over the brand foundation

The brand foundation (`minsky-brand`) names the cultural code and vocabulary; the operational reference (`docs/brand-system.md`) names the typography, color, motion, and accessibility tokens. **This section names the marketing-surface-specific decisions that compose on top:** idiom selection, layout patterns, product surfaces to show, voice register choices for marketing copy, customer-logo strategy.

### Idiom: B (product-screenshot dominant)

Minsky has product surfaces worth showing; decorative motion would substitute for them. For position-paper landing pages and About sections, lean toward Idiom C (founder-essay) — the principal's voice as the narrator carries the substrate framing per `pz-voice` §7 (the per-surface signal/channel balance).

### Cultural code: see `minsky-brand` §2 and §4

Cyberbrain / Section 9, five-layer reference architecture. Don't re-derive. The marketing surface inherits this foundation directly.

### Layout pattern (marketing-specific)

- **Hero:** left-aligned caption column + right-aligned product proof. Never centered. (Centered hero is Idiom A's signature — see §8 anti-patterns.)
- **Sections:** alternating left/right caption + product screenshot.
- **Customer logo strip:** single muted row of **co-product logos** (Claude Code / Cursor / Codex / MCP / GitHub / Notion / Railway) framed as _"Minsky composes with"_, not _"trusted by."_ Minsky doesn't yet have public customer logos.
- **No sticky-numbered-nav + colored-tile-panel section pattern.** That's Idiom A's signature.

### Motion budget (marketing-specific application)

The full motion budget — five permitted patterns, `prefers-reduced-motion` defaults, 4-OS test matrix — lives in [`docs/brand-system.md`](../../../docs/brand-system.md) §3. On marketing surfaces specifically:

- **Single scroll-driven fade per section** is the appropriate pattern for marketing pages — one per section, no chained per-element staggers. Implementation via `motion-framer` skill.
- **Sync-gauge motif** as a recurring micro-instrument on the marketing surface ties the brand register to a single repeating sign without becoming decorative.
- **No decorative shaders or WebGL.** They signal Idiom A.
- **No multi-system orchestrated motion.** Liveness should come from real product instrumentation (a status dot that reflects actual state), not from decorative continuous animation.
- **Respect `prefers-reduced-motion`** per `docs/brand-system.md` §3 — required, with the 4-OS test matrix.

### Product surfaces to show (the iconic-sign layer)

Idiom B carries through the homepage — specific Minsky scenes that should appear as real screenshots:

1. CLI output of a session running a real task (`minsky session start mt#NNNN` → agent picks up work)
2. MCP tool call result inside Claude Code (e.g., `mcp__minsky__tasks_get`)
3. Cockpit widget showing active workstreams (the mission-control organ inside the larger frame)
4. Reviewer-bot PR comment catching a real contract violation
5. Task graph visualization showing parent/child + dependency edges
6. Memory recall stopping a repeat mistake (search hit, prior incident referenced)
7. A hook denial in action (e.g., the bypass-merge guard blocking a subagent's PUT /merge)
8. The asks subsystem surfacing an attention-required event

Each scene is a real screenshot or terminal recording, not a mockup. The site is the surface where Minsky's substrate becomes visible.

### Voice register (marketing-surface choices)

The brand-vocabulary table lives in [`minsky-brand`](../minsky-brand/SKILL.md) §7. The Macx-prose rhythm and no-go register live in [`pz-voice/SKILL.md`](../pz-voice/SKILL.md). Marketing-surface-specific choices on top:

- **Section headlines:** three- to four-word conceptual. Examples to noodle on:
  - _"Tasks that converge"_
  - _"Reviews that hold"_
  - _"Memory that compounds"_
  - _"Attention that allocates"_
  - _"Hooks that catch"_
  - _"Asks that escalate"_
- **All-caps for structural labels only** (nav, eyebrows, numbered section markers).
- **CTAs:** sentence case ("Read the docs," "Try the CLI") — never SaaS imperative ("Get started for FREE"). Per `pz-voice` no-go register.
- **No email-capture popup, banner, or footer form.** Reject by default. The mission-control register does not interrupt the user.

### Customer-logo / co-product-logo strategy

Minsky does not yet have public customer logos. Substitute with **co-product logos** — systems Minsky composes with:

- Claude Code, Cursor, Codex (harness compatibility)
- MCP (protocol)
- GitHub, Notion (backend integrations)
- Railway (deploy)
- Bun (runtime)

Frame as _"Minsky composes with"_ — borrows credibility from the named products without claiming customers that do not yet exist.

## 7. Workshop process — how to pick a NEW marketing-surface myth

Use this when pairing with the operator (or self-running) to pick the myth for a _new_ marketing surface (microsite, launch page, campaign page) before any visual work begins. **The Minsky site itself does not need this — its myth is already locked in [`minsky-brand`](../minsky-brand/SKILL.md) §1.** The first end-to-end walk-through is [`references/minsky-myth-2026-05.md`](references/minsky-myth-2026-05.md) — use it as the worked example.

Each step produces a written artifact; together they constitute the brief.

### Step 1 — Audit the existing category myth

- What proposition do AI-product buyers already accept as obvious before they encounter the brand?
- What does the category's default site say without saying — what myth does it naturalize?
- Output: 1-2 sentences naming the category-default myth.

### Step 2 — Audit the brand's existing corpus

- Walk the strategic docs (position papers, RFCs, manifesto-shaped pages).
- Walk the principal's public corpus (writings, talks, social posts — query the principal-corpus via `mcp__minsky__principal_corpus_search`) for recurring propositions.
- Identify 3-5 candidate myths the existing voice already naturalizes.
- Output: 3-5 candidate myth-statements, each one declarative sentence.

### Step 3 — Test each candidate

For each candidate myth:

- Is it _contestable_? (Would a buyer disagree before encountering the site? Would a competitor find it awkward to claim?)
- Is it _carried by the actual product_? (Can the product surfaces in the "Product surfaces to show" subsection of §6 instantiate this myth?)
- Is it _durable_? (Will it still be true and important in 2-3 years?)
- Is it _aligned with the principal's investment_? (Does the operator want to spend years naturalizing this proposition?)

Output: one selected myth, written as a single declarative sentence.

### Step 4 — Identify the cultural code

Given the selected myth, name the cultural code that carries it. **Invoke the sibling skill `analyze-adjacent-product`** to read adjacent brands and identify which codes are occupied vs. white-space:

- Use the cultural-code-lane discussion in [`minsky-brand`](../minsky-brand/SKILL.md) §4 as the reference for the Minsky-brand layered architecture; new codes are allowed if justified.
- If the myth lives in an _occupied_ code, name the competitor whose visual register the brand will partially share. Decide which signs to adopt and which to reject.
- If the myth lives in an _available_ code, name the code and its existing exemplars OUTSIDE the AI category (residual codes — see `analyze-adjacent-product` SKILL.md §3 for the bridge-as-affect discipline).

Output: 1 cultural code, with 2-3 exemplars cited. If the code is layered (per `minsky-brand` §5's code-architecture), name each reference and the role it plays.

### Step 5 — Derive the visual specification

Now and only now, derive the visual decisions from the code:

- Typography (display, body, mono) — consume from `docs/brand-system.md` §1 if Minsky-branded; derive new if novel surface.
- Color (background, text, accent) — consume from `docs/brand-system.md` §2.
- Layout pattern (hero, sections, customer logos) — per §6 above.
- Motion budget (ambient, scroll, gesture) — per `docs/brand-system.md` §3 + §6 marketing-specific.
- Product surfaces to show — per §6.
- Vocabulary inventory (brand terms borrowed from the references) — consume from `minsky-brand` §7.

Each decision must be traceable to a sign that instantiates the chosen code. If a proposed decision does not carry the code, drop it.

Output: the brief — myth, code, visual spec, vocabulary.

### Step 6 — Build a first surface, then test the brief

Implement the hero + one feature section. Show it to a buyer-archetype reader. Ask: "what does this site naturalize?" If their answer matches the myth statement, the brief is working. If it does not, the visual choices are instantiating a different code; iterate.

## 7a. Naming the surface (Lexicon framework)

§7 picks the _myth_ for a new marketing surface; this section picks its _name_ — a microsite title, campaign name, launch handle, or a section/feature label that must read as Minsky. The foundation-layer encoding (five principles, sound-symbolism table, compound multiplier, anti-patterns) lives in [`minsky-brand`](../minsky-brand/SKILL.md) §7.1; for full end-to-end naming work invoke the [`name-product`](../name-product/SKILL.md) skill. This section is the marketing-surface cut.

**Three-phase methodology (identify → invent → implement)** applied to a marketing surface:

1. **Identify.** Run the bidirectional-behavior question (`minsky-brand` §7.1, principle 5) for _this surface_: how should the audience behave toward it, and it toward them? Run the diamond exercise below to surface the message that becomes the name.
2. **Invent.** Generate candidates in _generative_ mode — suspend evaluation; ask \"what could we do with this name?\" not \"is it good?\". Pull from the sound-symbolism table and the compound-multiplier rule in `minsky-brand` §7.1; lean tangible over abstract.
3. **Implement.** Screen survivors for polarization, compound fit, and code-coherence (`minsky-brand` §7.1 three checks) AND the mandatory trademark-collision screen (`name-product`). Only then derive the visual treatment per §7 Step 5.

**The diamond exercise.** Four corners; iterate over days, not an hour:

- **Win** — how do you define winning for this surface?
- **Have to win** — the assets already in hand (locked myth, product proof, corpus).
- **Need to win** — the gaps (what's missing to win).
- **Have to say to win** — the message that closes the gap. _This message is what becomes the name._

**The competitor drill.** Ask a buyer-archetype reader: _\"We just got a new competitor and their name is X — what do you think about them?\"_ This surfaces what the name does for the imagination, bypassing the evaluative reflex (\"is it good?\"). Run it on each finalist.

**The not-like-the-other-guys signal.** When a reader says \"they're not like the other guys\" _before_ they know what the surface is for, the name is working — it has created _predisposition to consider_. This is the marketing-surface read on the same signal `analyze-adjacent-product` reads in competitors.

**Polarization on first hearing.** Per `minsky-brand` §7.1, principle 2: if the team is comfortable with the surface name, it's too safe. Argument is energy, not weakness — don't sand a name down to consensus before launch, or you ship no name at all.

## 8. Anti-patterns (marketing-format specific)

Reject these explicitly. They instantiate Idiom A or AI-slop defaults on a marketing surface. **For brand-foundation anti-patterns** (literal anime, Iron Man / JARVIS, Skynet futurism, mecha imagery, single-reference pastiche) see [`minsky-brand`](../minsky-brand/SKILL.md) §9.

- **WebGL shader hero.** Signals Idiom A; substitutes decorative motion for product proof.
- **Centered hero text + centered subhead.** Conference-talk register, not operator-control register.
- **Purple gradients + Inter/Roboto + Lucide icons.** The AI-slop trifecta named in landing-page-design conventions; immediate marketing dilution.
- **Multi-color saturated tile panels** (blue + pink + green + cyan rotation). Composio signature; reads as consumer-software.
- **Sticky-numbered-nav + scrolly section pattern.** Composio signature.
- **Anonymous testimonial paragraphs** ("Game-changer for our team!"). Either name the individual (Cursor's Jensen Huang / shadcn / Patrick Collison approach) or omit entirely.
- **Email-capture popup, banner, or footer form.** Reject by default. The mission-control register does not interrupt the user.
- **Hand-wavy "infrastructure for X" copy** without concrete instantiation. State the mechanism, not the metaphor.
- **Pricing presented before the product is understood.** Pricing belongs on its own page, not on the homepage, unless usage-tier-as-positioning is intentional.
- **Long justification copy under a visual.** If a sign needs a paragraph to explain its meaning, the sign is doing the wrong work. Replace it with a sign that carries the meaning directly.

## 9. Worked examples

- **2026-05-19 three-way analysis** of Composio / Cursor / Factory through the Peirce-Barthes-Oswald framework: [`../analyze-adjacent-product/references/case-studies-2026-05.md`](../analyze-adjacent-product/references/case-studies-2026-05.md). This is the canonical worked example of the analytical methodology — read it when running the analyze-adjacent-product workflow.
- **2026-05-19 Minsky myth workshop** end-to-end output: [`references/minsky-myth-2026-05.md`](references/minsky-myth-2026-05.md). Locked brand thesis including myth statement, cultural code with reference rankings, code-architecture synthesis, vocabulary inventory, and the "drawn from, not literally" discipline as applied to Minsky specifically. **This worked example is now codified into [`minsky-brand`](../minsky-brand/SKILL.md)** — use the reference file when running the workshop for a new surface; use the brand skill when consuming the locked Minsky output.

## Cross-references

- [`.claude/skills/minsky-brand/SKILL.md`](../minsky-brand/SKILL.md) — **strategic anchor**. Locked myth, cultural code, five-layer reference architecture, vocabulary, bridge-as-affect discipline, code-architecture synthesis. Load first; this skill depends on it.
- [`.claude/skills/pz-voice/SKILL.md`](../pz-voice/SKILL.md) — signal layer. Compose with `minsky-brand` per its §8 (signal/channel split). Required when drafting marketing copy.
- [`.claude/skills/analyze-adjacent-product/SKILL.md`](../analyze-adjacent-product/SKILL.md) — sibling skill providing the analytical foundation (Peirce-Barthes-Oswald framework, Pepsi/Arnell discipline, bridge-as-affect, per-analysis workflow, two-idiom synthesis). This skill consumes that one's output at §7 workshop Step 4.
- [`.claude/skills/cockpit-design/SKILL.md`](../cockpit-design/SKILL.md) — structural template; this skill is its marketing-surface sibling. Cockpit's mission-control register is one organ inside the cyberbrain frame, not an independent design language — both depend on `minsky-brand`.
- [`docs/brand-system.md`](../../../docs/brand-system.md) — operational reference. Typography stack, color palette (hex + OKLCH), motion budget with `prefers-reduced-motion`, WCAG contrast targets, font licensing, fallback stacks. Consume directly when implementing.
- `feedback_confabulated_strategic_frame_to_justify_tactical_preference` — discipline against post-hoc framing (the Pepsi/Arnell trap at the recommendation surface)
- `feedback_strategic_reframe_first` — the connecting direction (when a tactical ask is an instance of a strategic frame, name the frame)
- CLAUDE.md `§Principal Context` — Minsky's commercial-product framing; the audience this skill addresses
- CLAUDE.md `§Decision Defaults` — Minsky-grounded defaults that supersede generic SaaS-marketing defaults
- Notion strategic anchors:
  - [Minsky home](https://www.notion.so/33a937f03cb48197a93ecd4a98a94261)
  - [Position: Principal substrate vs team substrate](https://www.notion.so/365937f03cb481e78fd5e0594a6507c1) (the strategic thesis behind the locked myth)
  - [Vision & theory: the viable cognitive system](https://www.notion.so/33a937f03cb4815c8394d7fe62d61355)
  - [The cockpit problem: from Locus theory to first instantiation](https://www.notion.so/33a937f03cb4819a8865e11164cbb1c8) (Locus convergence is footnote-only per the existing deferral discipline)
- Source texts (Minsky brand register — full discussion in `minsky-brand`):
  - Charles Stross, _Accelerando_ (2005)
  - _Ghost in the Shell: Stand Alone Complex_ (Production I.G., 2002–2005)
  - _Neon Genesis Evangelion_ (Anno / Gainax, 1995–1996)
  - Mitsuo Iso, _Dennō Coil_ (2007) and _Orbital Children_ (2022)
  - _Magilumière Magical Girls, Inc._ (Magilumière Co. Ltd., 2024 manga/anime)
- Originating session: 2026-05-18/19 workshop — Composio / Cursor / Factory case studies + Minsky myth selection. Captured in [`../analyze-adjacent-product/references/case-studies-2026-05.md`](../analyze-adjacent-product/references/case-studies-2026-05.md) and [`references/minsky-myth-2026-05.md`](references/minsky-myth-2026-05.md).
- mt#1927 — task that installed this skill bundle with the methodology absorbed inline
- mt#1933 — task that extracted the brand foundation into the standalone `minsky-brand` skill (this refactor)
- mt#1944 — task that extracted the analytical methodology into the standalone `analyze-adjacent-product` skill

---

**Refactor 2026-05-20 (mt#1933):** Extracted the brand foundation — locked myth, cultural code (Cyberbrain / Section 9), five-layer reference architecture, bridge-as-affect Minsky-specific application, code-architecture synthesis, vocabulary inventory, and brand-foundation anti-patterns — into the standalone [`minsky-brand`](../minsky-brand/SKILL.md) skill. This file now layers marketing-surface-specific patterns (Idiom B, layout, motion-budget marketing application, product surfaces to show, customer-logo strategy, marketing-format anti-patterns, new-surface workshop process) on top of that foundation. Sections renumbered: prior §5 (cultural codes) and §6 (code architecture) moved to `minsky-brand`; prior §7 (vendored bundle) becomes new §5; prior §8 (Minsky-specific layer) becomes new §6 (split — tokens moved to `docs/brand-system.md` per mt#1932; vocabulary moved to `minsky-brand` §7); prior §9 (workshop) becomes new §7; prior §10 (anti-patterns) becomes new §8 with brand-foundation rejects moved to `minsky-brand` §9; prior §11 (worked examples) becomes new §9. The Idiom C (founder-essay) reference was added to §4 to match the 2026-05-19 three-idiom synthesis. No semantic changes to the methodology — same content, relocated for reusability.

**Refactor 2026-05-19 (mt#1944):** Extracted the semiotic-analysis framework, Pepsi/Arnell trap, bridge-as-affect discipline, per-analysis capture workflow, and per-analysis template into the standalone `analyze-adjacent-product` skill. Moved `references/case-studies-2026-05.md` to `../analyze-adjacent-product/references/case-studies-2026-05.md`. No semantic changes to the methodology itself — same content, relocated for reusability.
