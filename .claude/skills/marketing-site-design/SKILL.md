---
name: marketing-site-design
description: >-
  Myth-first methodology for designing the Minsky marketing site and any
  adjacent marketing surface (microsites, launch pages, position-paper
  landing pages). Encodes the Barthes three-orders model (denotation /
  connotation / myth), Oswald's cultural-codes framework, and Peirce's
  icon/index/symbol triad as the design-decision substrate. Names the
  Pepsi/Arnell trap as the canonical anti-pattern: visual choices must
  instantiate the myth, never retrofit it. The 2026-05-19 workshop locked
  Minsky's positioning as Cyberbrain / Section 9 — autonomous-flock
  cybernetic substrate that extends a principal's cognition, rendered as
  serious operational profession (Magilumiere tonal lock) with Iso warmth
  and Macx (Accelerando) as the literary anchor. Use when designing or
  auditing any Minsky marketing surface, analyzing an adjacent product's
  site, or workshopping a brand-positioning myth. Complements the vendored
  Tier-1 skills (impeccable / frontend-design / web-design-guidelines /
  plan-design-review / information-architecture / engineering-writing /
  seo-skill / motion-framer) with the Minsky-specific positioning layer
  those skills do not cover.
user-invocable: true
---

# marketing-site-design — myth-first methodology for Minsky marketing surfaces

You are designing or auditing a marketing surface for Minsky (`~/Projects/minsky-site` or any future microsite, launch page, or campaign page). The vendored Tier-1 skills cover visual quality, IA, engineering stack, SEO, and motion. This skill adds the layer they do not: **which myth is Minsky naturalizing, which cultural code does that myth live in, and which signs instantiate that code at the visual layer.**

If you are pattern-matching against "what other AI startup sites look like" before deciding what Minsky's site is *for*, stop. That order of operations produces the Pepsi/Arnell trap (see Section 2). The order is: pick the myth, identify the cultural code that carries the myth, then choose the signs that instantiate the code.

## When to invoke

- Designing or rebuilding the Minsky marketing site (`~/Projects/minsky-site`)
- Designing any adjacent marketing surface (launch microsites, campaign pages, position-paper landing pages)
- Auditing an existing marketing surface against the framework
- Analyzing an adjacent product's marketing site (use the worked-example template in `references/case-studies-2026-05.md`)
- Workshopping a brand positioning myth before committing to a visual direction
- Reviewing a design proposal that arrived without explicit myth-statement

## 1. Pick the myth before the visuals

The first design decision is not a font, a color, or a layout. It is the **myth the brand is naturalizing**.

Roland Barthes (*Mythologies*, 1957) distinguishes three orders of signification:

1. **Denotation** — literal content. What is depicted. A photograph of a server rack denotes "a server rack."
2. **Connotation** — culturally-conditioned associations the sign carries. The server-rack photograph connotes industrial mass, server-farm infrastructure, computing power.
3. **Myth** — second-order signification where the connoted meanings get *naturalized* — made to seem obviously true rather than constructed. The server-rack image, in context, can naturalize a myth like "this software is real infrastructure, not just an app."

Marketing surfaces operate primarily at the third order. The visual choices a designer makes are *signs deployed to instantiate a myth* — to make a culturally-constructed proposition feel like an obvious truth. Skipping straight to "what should the hero look like" without first naming the myth means you are instantiating a myth by accident, usually the dominant default of your category (which is rarely the myth that differentiates).

**The workshop sequence for picking a myth** is documented in Section 9 of this skill, and was first walked end-to-end on 2026-05-18/19 (output: `references/minsky-myth-2026-05.md`). The locked myth for Minsky is in that file.

## 2. The Pepsi/Arnell trap — named anti-pattern

The 2008 Pepsi rebrand by the Arnell Group produced a now-infamous 27-page "Breathtaking" document (archived [here](https://www.goldennumber.net/wp-content/uploads/pepsi-arnell-021109.pdf), [Ad Age coverage](https://adage.com/article/agency-news/breathtaking-word-purported-arnell-pepsi-doc/134552/)) that justified a minor logo refresh by invoking the Mona Lisa, the Golden Ratio, the Parthenon, the Earth's geomagnetic field, the Gutenberg Bible, and the theory of relativity. The document was widely mocked because it was **post-hoc theater** — semiotic vocabulary deployed to dress up a thin visual move, rather than semiotic *reasoning* used to drive a strong one.

The discipline encoded here:

- **Pick the myth first.** Let the visual choices follow as instantiations of the myth.
- **Never retrofit.** If you cannot explain a visual choice as a sign carrying a specific connotation that instantiates the stated myth, cut it.
- **Beware of justification documents.** A long explanation of why a design "works" is a warning sign that the design does not actually carry the meaning on its own. Signs should do the work; documentation describes what they do, it does not make them do it.

The Pepsi/Arnell trap is the recommendation-time analogue of the patterns named in `feedback_confabulated_strategic_frame_to_justify_tactical_preference` — manufacturing a strategic frame to make a tactical preference sound principled. The fix is the same: cite first, decide second; or admit you do not know and rescope.

## 3. The framework — Peirce, Barthes, Oswald

Three layers, each useful for a different decision:

**Peirce's triadic categories** ([overview](https://vanseodesign.com/web-design/icon-index-symbol/)) — useful when classifying a specific sign in the design:

- **Icon** — sign by resemblance. A product screenshot resembles the product. A photorealistic render of a "Droid Computer" resembles a physical box.
- **Index** — sign by causal/factual connection. A customer logo points to a real customer. A live install command points to a working CLI.
- **Symbol** — sign by arbitrary cultural convention. A logo, a typeface, an all-caps register, a color. None resemble what they signify; their meaning is learned.

Most marketing surfaces blend all three. Knowing which kind of sign you are deploying clarifies what work it is doing: icons supply *demonstration*, indices supply *evidence*, symbols supply *positioning within a code*.

**Barthes' three orders** ([overview](https://www.allensbach-hochschule.de/en/semiotics-according-to-roland-barthes-and-its-relevance-for-pr-and-communication-between-sign-and-meaning/)) — useful when reading what a competitor's site is doing:

- Denotation = the literal content (the WebGL shader is a moving particle field).
- Connotation = what cultural associations the sign carries (the shader connotes technical sophistication, AI-futurism, agent-platform polish).
- Myth = the naturalized proposition the sign helps construct (Composio's site naturalizes "AI integration as consumer-software experience").

**Oswald's cultural codes** ([Marketing Semiotics, OUP 2012](https://academic.oup.com/book/9313/chapter/156060651); [Creating Value, OUP 2015](https://global.oup.com/academic/product/creating-value-9780199657261)) — useful when picking a positioning lane:

A brand operates by invoking *cultural codes* — sets of signs an audience already recognizes as belonging to a category. Codes have names: codes of luxury, codes of authenticity, codes of innovation, codes of artisan craft. A positioning decision is partly a code-selection decision: which codes does the brand claim, which does it explicitly reject, which white-space codes are available to occupy.

## 4. Bridge-as-affect — how to instantiate an emergent code through residual references

A critical discipline when claiming an emergent code (one with no category instantiation yet). You do NOT expose the audience to the raw emergent code directly; that produces blank stares. Instead, you bridge through **residual codes** — codes the audience already recognizes — that carry the same structure. The audience pattern-matches to the residual reference; their recognition is the bridge; they end up holding the emergent frame as a conclusion they reached themselves, which is much stronger than being told.

The discipline:

- **Borrow at the layer of register, not at the layer of imagery.** Typography, color, density of information, motion budget, copy tone, ops-room layout vocabulary. Not literal characters, mecha, magical girls, or product-name pastiche.
- **The right reader notices the borrowing as taste-signal.** *"I see what you're pulling from."* That recognition is the product.
- **The wrong reader doesn't notice and isn't bothered.** The signs do the work for the audience that can read them; they don't alienate the audience that can't.
- **Evangelion-as-execution.** Eva itself is full of religious/Kabbalistic iconography (AT-Field, Sephirot, Adam/Lilith, cross-shaped explosions, Magi-as-three-wise-men) without ever being *about* religion. The borrowings function as affect; the show's subject is something else. This is the canonical discipline for the move.

**When in doubt, ask:** would the right reader notice the borrowing without being told? If yes, ship it. If you have to caption it, you've gone too literal.

## 5. The competing idioms in AI-product marketing

Empirical observation from the 2026-05 three-way analysis ([Composio / Cursor / Factory case studies](./references/case-studies-2026-05.md)):

**Idiom A — Motion-decorated infographic** (exemplar: Composio)
- WebGL shader / canvas hero
- Centered headlines
- Multiple saturated colors (electric blue / pink / cyan / green tiles)
- Heavy decorative animation orchestrated across multiple systems
- Premium paid typeface (abcDiatype)
- Abstract diagrams and infographic-style use-case carousels
- Sells *concept*. Used when the product is plumbing the buyer cannot see directly.

**Idiom B — Product-screenshot dominant, restrained** (exemplars: Cursor, Factory)
- Static or near-static hero
- Left-aligned caption + right-aligned product screenshot
- Monochrome dark with minimal accent
- Real product UI as the dominant visual element
- Free typeface (Geist) or commissioned bespoke typeface (CursorGothic)
- Customer logos as muted single row
- Sells *the actual product*. Used when the product has surfaces worth showing.

Minsky is in the Idiom-B camp. The CLI, MCP tool calls, cockpit, reviewer-bot PR comments, task graph, memory recall — these are the surfaces that should carry the pitch. Decorative motion would substitute for product proof Minsky already has.

## 6. The cultural codes occupied — and Minsky's lane

From the three-way analysis, the visual codes already in active use in adjacent AI-tool marketing:

| Code | Exemplars | Visual signature |
|---|---|---|
| Consumer-tech polish | Composio, Notion AI, OpenAI Platform | saturated multicolor, premium grotesque, WebGL hero, designer-tech genealogy |
| Serious IDE / developer tool | Cursor, Aider, Continue | dark monochrome, IDE screenshot dominant, restrained type, named-individual testimonials |
| Industrial infrastructure | Factory, Railway, Render | pure black, all-caps signage, terminal aesthetic, deploy-platform genealogy |
| AI futurism | OpenAI, Anthropic, Mistral | abstract shader gradients, minimal copy, conceptual rather than product-shown |
| Mission-control / instrument-panel | (underclaimed) | Bloomberg Terminal, NASA mission-ops, ATC, SCADA — appropriate for the cockpit WIDGET; not the site myth |

**Minsky's primary lane (locked 2026-05-19):** **Cyberbrain / Section 9** — an autonomous-flock cybernetic substrate that extends a principal's cognition, rendered as a serious operational profession. Available white-space in the AI-tool category; native to Minsky's existing intellectual substrate.

The code is anchored at the intersection of five references — none of which the brand uses literally, all of which inform the register:

- **Ghost in the Shell, Stand Alone Complex** (primary visual + structural anchor): cybernetic substrate, autonomous-companion AI (Tachikomas), Section 9 ops register, the Stand Alone Complex concept itself (independent agents converging on coordinated behavior). Minsky's mesh is structurally a Stand Alone Complex; the flock is the Tachikoma frame.
- **Evangelion** (backline; cultural salience to the Eva-sensitive audience): Magi terminal aesthetic when the system speaks, sync ratio as a metaphor for principal-flock coherence, NERV warning palette for hook denials, density-without-decoration discipline.
- **Mitsuo Iso's *Orbital Children* + *Dennō Coil*** (deep-cut texture): AR overlays integrated with daily life, soft warm tones, AI companions with personality embedded in ambient workflow. Differentiates the register from "ops room you visit" to "system you live with."
- **Magilumière Magical Girls, Inc.** (tonal lock): magick-as-corporate-profession. The site reads as a B2B operational platform for serious work; the substrate happens to be cybernetic-magickal. The brand voice is the *agency*, not the protagonists.
- **Stross, *Accelerando***, Manfred Macx and the flock (literary anchor): prose register. Terse, technically loaded, presupposing reader literacy. The manifesto-page register.

**Background-only, NOT foreground:**

- **Operative Ontology corpus** (declarative-magick as substrate; *Notion `35e937f0-3cb4-81a3-9301-cb319cdc6cd2`*): informs the underlying metaphysics. Footnote-only in present-day pitches. Servitor-as-agent framing is structurally cognate but stays internal.
- **Ambient computing** (Dynamicland, Folk Computer, *Blindsight* smart paint): Locus-direction long-term substrate inspiration. Cited as background for the Locus thesis ([Notion home `33a937f0-3cb4-8197-a93e-cd4a98a94261`](https://www.notion.so/33a937f03cb48197a93ecd4a98a94261)) but not surfaced on Minsky's present-day site (per the existing Locus-deferral discipline).

**Explicit rejects** (specific references Eugene calibrated out 2026-05-19): Pacific Rim (audience unfamiliarity), Gundam (operator unfamiliarity — no posing), Iron Man / JARVIS (overdone in Instagram demos), Gurren Lagann (not foregrounded).

## 7. Code architecture — the synthesis

The five references invoked at section 6 are NOT a list to pick one from. They are layered to construct meaning none can carry alone. Oswald calls this **code architecture**: blending multiple cultural codes such that their intersection carries the brand identity.

The intersection: **professional cybernetic-cognitive substrate where the principal extends through a coordinated flock.**

No single reference carries all of it:
- GitS supplies the cybernetic substrate + autonomous-flock-coordination structure
- Eva supplies the sync-as-principal-substrate metric + system-as-personality with soul
- Iso supplies the AR-companion warmth that humanizes the cybernetic register
- Magilumiere supplies the agency-as-employer / work-as-profession tonal lock
- Macx supplies the literary register and the "extension-of-self" proposition

When designing any Minsky marketing surface, the question to ask is: *does this choice carry the intersection, or just one of the codes?* If it carries only one (e.g., a literal GitS reference without the Iso warmth), it's pastiche. The brand identity lives in the layered blend.

## 8. Vendored Tier-1 skill bundle

The marketing-site-design umbrella complements these skills (already present in `.claude/skills/`):

| Skill | Covers | When to invoke during marketing-site work |
|---|---|---|
| `impeccable` | Visual quality audit, design polish, anti-patterns | After draft, before commit — does this read as production-grade? |
| `frontend-design` (Anthropic) | Distinctive frontend interfaces, anti-AI-slop | When generating marketing-page React/Astro components |
| `web-design-guidelines` | Web Interface Guidelines, accessibility, UX | Always — accessibility floor for any public surface |
| `plan-design-review` | Designer's-eye plan critique, 0-10 dimension rating | Before implementing any new section — rate the plan, fix to 10 |
| `information-architecture` | Section structure, hierarchy, navigation model | When deciding page IA, section ordering |
| `engineering-writing` | Long-form argumentative prose, technical voice | For position-paper landing pages, manifesto sections, about pages |
| `seo-skill` (vendored 2026-05-19) | Static-site meta/OG/JSON-LD/sitemap/robots | After draft, before launch — discoverability floor |
| `motion-framer` (vendored 2026-05-19) | Framer Motion patterns for ambient identity motion, scroll reveals | When implementing the motion budget (see section 10) |
| `tailwind-v4-shadcn` | Tailwind v4 + shadcn/ui setup | If using shadcn for component primitives |
| `react-best-practices` | React/Next.js performance patterns | For Astro islands or Next.js page implementation |
| `composition-patterns` | React composition (compound components, render props) | When building reusable section primitives (Hero, FeatureRow, etc.) |

## 9. The Minsky-specific layer — concrete decisions from the locked code

Decisions that the vendored skills do not make. These are the substrate that holds the myth.

### Idiom: B (product-screenshot dominant)

Minsky has product surfaces worth showing; decorative motion would substitute for them.

### Cultural code: Cyberbrain / Section 9

See Section 6 for the reference set and rationale. See `references/minsky-myth-2026-05.md` for the full workshop output.

### Typography

- **Display + body:** Geist (free, Vercel-published, what Factory uses) at the regular weight (400). Bold-at-large reads marketing-y; light-at-large reads confident.
- **Eyebrows + structural labels + code:** JetBrains Mono.
- **System-speaks surfaces** (places where Minsky itself "talks" — reviewer-bot output, memory recall, system messages): consider a slightly warmer mono like Berkeley Mono or IBM Plex Mono italic, channeling the Magi-aesthetic warmth of Eva's supercomputer-as-personality.
- **Tracking:** -2% to -5% of font size for display. Roughly -2.88px at 60px (Factory's measured value).
- **Avoid Inter and Roboto + Lucide icons** — the AI-slop trifecta. Reject explicitly.

### Color

- **Background:** near-black between `rgb(2, 2, 2)` (Factory's pure black, also GitS register) and `rgb(20, 18, 11)` (Cursor's slight warm dark).
- **Text:** near-white around `rgb(238, 238, 238)`.
- **Primary accent (signal):** cyan — channeling GitS Section 9 ops palette. Used for active status, links, sync indicators, "live" dots.
- **Warning / blocked / escalation accent:** amber moving toward NERV-red. Used sparingly for hook denials, blocked actions, escalation alerts.
- **Iso-pastel warmth:** allowed *very* sparingly, in surfaces where an agent's companion-personality is being shown (e.g., agent identity indicators in product screenshots).
- **Reject** multi-color saturation. Composio's blue+pink+cyan+green palette is the anti-pattern.

### Layout pattern

- **Hero:** left-aligned caption column + right-aligned product proof. Never centered.
- **Sections:** alternating left/right caption + product screenshot.
- **Customer logo strip:** single muted row of **co-product logos** (Claude Code / Cursor / Codex / MCP / GitHub / Notion / Railway) framed as *"Minsky composes with"*, not *"trusted by."* Minsky doesn't yet have public customer logos.
- **No sticky-numbered-nav + colored-tile-panel section pattern.** That's Idiom A's signature.

### Motion budget

- **Ambient identity-level motion only.** A small rotating element in the wordmark (Factory's gear precedent), a single scroll-driven fade per section, possibly a sync-gauge motif as a recurring micro-instrument.
- **No decorative shaders or WebGL.** They signal Idiom A.
- **No multi-system orchestrated motion.** Liveness should come from real product instrumentation (a status dot that reflects actual state), not from decorative continuous animation.
- **Respect `prefers-reduced-motion`.** Hook `useReducedMotion()` (or equivalent for non-React stacks) and zero out motion when set.

### Product surfaces to show (the iconic-sign layer)

Specific Minsky scenes that should appear as real screenshots — Idiom B carries through the homepage:

1. CLI output of a session running a real task (`minsky session start mt#NNNN` → agent picks up work)
2. MCP tool call result inside Claude Code (e.g., `mcp__minsky__tasks_get`)
3. Cockpit widget showing active workstreams (the mission-control organ inside the larger frame)
4. Reviewer-bot PR comment catching a real contract violation
5. Task graph visualization showing parent/child + dependency edges
6. Memory recall stopping a repeat mistake (search hit, prior incident referenced)
7. A hook denial in action (e.g., the bypass-merge guard blocking a subagent's PUT /merge)
8. The asks subsystem surfacing an attention-required event

Each scene is a real screenshot or terminal recording, not a mockup. The site is the surface where Minsky's substrate becomes visible.

### Voice register

- **Manifesto / About page voice:** Macx prose. Terse, technically loaded, presupposing literacy. Sentences that assume you already know.
- **Section headlines:** three- to four-word conceptual. Examples to noodle on:
  - *"Tasks that converge"*
  - *"Reviews that hold"*
  - *"Memory that compounds"*
  - *"Attention that allocates"*
  - *"Hooks that catch"*
  - *"Asks that escalate"*
- **Sentence case, present tense, no exclamation.**
- **All-caps for structural labels only** (nav, eyebrows, numbered section markers).
- **Avoid SaaS hyperbole** ("the future of," "transforms your," "supercharge your," "from your first X to your IPO").
- **Magilumiere tonal lock:** brand voice is the *agency* operating the magickal substrate, not the *protagonists*. Serious B2B operational platform; substrate happens to be cybernetic-magickal. The whimsy stays at the *reference* layer; the surface is professional.
- **Peer-to-peer, not vendor-to-buyer.** The reader is a principal; address them as one.

### Brand vocabulary (locked 2026-05-19)

Specific terms the site can use, drawn from the layered references:

| Term | Source | Use |
|---|---|---|
| **Cyberbrain** | GitS | The substrate Minsky is. Category name. *"The cyberbrain for software orgs led by one mind."* |
| **Stand Alone Complex** | GitS SAC | Operating principle for the mesh — independent agents converging on coordinated behavior. Use carefully; not as flag-waving reference. |
| **Sync rate** / **sync ratio** | Eva | Metric vocabulary for principal-flock coherence. A recurring instrument motif. |
| **Section** | GitS | Unit-of-operation noun (a Section runs a specific workstream). |
| **Flock** | Stross | The multi-agent unit. Direct borrow from Macx. |
| **Ghost** | GitS | Used carefully — the philosophical-continuity sense (the principal's continuity of self through substrate), NOT the spooky sense. |
| **Servitor** | Operative Ontology corpus | Footnote-only in foreground; used in manifesto / About-page register. |
| **Substrate** | Eugene's existing vocabulary | The thing Minsky is. Heavy use is fine — it's already canonical. |

### Customer-logo / co-product-logo strategy

Minsky does not yet have public customer logos. Substitute with **co-product logos** — systems Minsky composes with:

- Claude Code, Cursor, Codex (harness compatibility)
- MCP (protocol)
- GitHub, Notion (backend integrations)
- Railway (deploy)
- Bun (runtime)

Frame as *"Minsky composes with"* — borrows credibility from the named products without claiming customers that do not yet exist.

## 10. Anti-patterns (named)

Reject these explicitly. They instantiate either Idiom A or AI-slop defaults:

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
- **Literal anime characters, mecha, magical girls, or product-name pastiche.** Per Section 4 (bridge-as-affect) — borrow at the layer of register, not at the layer of imagery.
- **Iron Man / JARVIS framing.** Overdone in Instagram cloud-AI demos; would read as derivative.

## 11. Workshop process — how to walk a brand through myth selection

Use this when pairing with the operator (or self-running) to pick the myth before any visual work begins. Each step produces a written artifact; together they constitute the brief. The first end-to-end walk-through is `references/minsky-myth-2026-05.md` — use it as the worked example.

### Step 1 — Audit the existing category myth

- What proposition do AI-product buyers already accept as obvious before they encounter the brand?
- What does the category's default site say without saying — what myth does it naturalize?
- Output: 1-2 sentences naming the category-default myth.

### Step 2 — Audit the brand's existing corpus

- Walk the strategic docs (position papers, RFCs, manifesto-shaped pages).
- Walk the principal's public corpus (writings, talks, social posts) for recurring propositions.
- Identify 3-5 candidate myths the existing voice already naturalizes.
- Output: 3-5 candidate myth-statements, each one declarative sentence.

### Step 3 — Test each candidate

For each candidate myth:

- Is it *contestable*? (Would a buyer disagree before encountering the site? Would a competitor find it awkward to claim?)
- Is it *carried by the actual product*? (Can the product surfaces in section 9 instantiate this myth?)
- Is it *durable*? (Will it still be true and important in 2-3 years?)
- Is it *aligned with the principal's investment*? (Does the operator want to spend years naturalizing this proposition?)

Output: one selected myth, written as a single declarative sentence.

### Step 4 — Identify the cultural code

Given the selected myth, name the cultural code that carries it. Use Section 6's table as starting points; new codes are allowed if justified.

- If the myth lives in an *occupied* code, name the competitor whose visual register the brand will partially share. Decide which signs to adopt and which to reject.
- If the myth lives in an *available* code, name the code and its existing exemplars OUTSIDE the AI category (residual codes per Section 4).

Output: 1 cultural code, with 2-3 exemplars cited. If the code is layered (per Section 7's code-architecture), name each reference and the role it plays.

### Step 5 — Derive the visual specification

Now and only now, derive the visual decisions from the code:

- Typography (display, body, mono)
- Color (background, text, accent)
- Layout pattern (hero, sections, customer logos)
- Motion budget (ambient, scroll, gesture)
- Product surfaces to show
- Vocabulary inventory (brand terms borrowed from the references)

Each decision must be traceable to a sign that instantiates the chosen code. If a proposed decision does not carry the code, drop it.

Output: the brief — myth, code, visual spec, vocabulary.

### Step 6 — Build a first surface, then test the brief

Implement the hero + one feature section. Show it to a buyer-archetype reader. Ask: "what does this site naturalize?" If their answer matches the myth statement, the brief is working. If it does not, the visual choices are instantiating a different code; iterate.

## 12. Worked examples

- **2026-05-19 three-way analysis** of Composio / Cursor / Factory through the Peirce-Barthes-Oswald framework: `references/case-studies-2026-05.md`. Use as the template when analyzing any future competitor or category site.
- **2026-05-19 Minsky myth workshop** end-to-end output: `references/minsky-myth-2026-05.md`. Locked brand thesis including myth statement, cultural code with reference rankings, code-architecture synthesis, vocabulary inventory, and the "drawn from, not literally" discipline as applied to Minsky specifically.

## Cross-references

- `.claude/skills/cockpit-design/SKILL.md` — structural template; this skill is its marketing-surface sibling. Cockpit's mission-control register is one organ inside the Cyberbrain frame, not an independent design language. Future revision: extract shared brand foundation into a dedicated `minsky-brand` skill that both umbrellas reference.
- `feedback_confabulated_strategic_frame_to_justify_tactical_preference` — discipline against post-hoc framing (the Pepsi/Arnell trap at the recommendation surface)
- `feedback_strategic_reframe_first` — the connecting direction (when a tactical ask is an instance of a strategic frame, name the frame)
- CLAUDE.md `§Principal Context` — Minsky's commercial-product framing; the audience this skill addresses
- CLAUDE.md `§Decision Defaults` — Minsky-grounded defaults that supersede generic SaaS-marketing defaults
- Notion strategic anchors:
  - [Minsky home](https://www.notion.so/33a937f03cb48197a93ecd4a98a94261)
  - [Vision & theory: the viable cognitive system](https://www.notion.so/33a937f03cb4815c8394d7fe62d61355)
  - [The cockpit problem: from Locus theory to first instantiation](https://www.notion.so/33a937f03cb4819a8865e11164cbb1c8) (Locus convergence is footnote-only per the existing deferral discipline)
  - [Operative Ontology — declarative cosmology, sigil-as-program, and the architecture of realization](https://www.notion.so/35e937f03cb481a39301cb319cdc6cd2) (background, footnote-only)
  - [Digital Twin & Cognitive Interface](https://www.notion.so/1d1937f03cb480008bbdc529dfb5eb68) (early formulation of the exocortex frame, 2025-04)
- Source texts (semiotic framework):
  - Roland Barthes, *Mythologies* (1957) — denotation / connotation / myth
  - Laura R. Oswald, *Marketing Semiotics: Signs, Strategies, and Brand Value* (Oxford, 2012)
  - Laura R. Oswald, *Creating Value: The Theory and Practice of Marketing Semiotics Research* (Oxford, 2015)
  - C.S. Peirce — icon / index / symbol triad ([overview](https://vanseodesign.com/web-design/icon-index-symbol/))
- Source texts (Minsky brand register):
  - Charles Stross, *Accelerando* (2005) — Manfred Macx and the flock
  - *Ghost in the Shell: Stand Alone Complex* (Production I.G., 2002–2005) — Section 9, Tachikomas, Stand Alone Complex concept
  - *Neon Genesis Evangelion* (Anno / Gainax, 1995–1996) — Magi, NERV, sync ratio, density-with-soul
  - Mitsuo Iso, *Dennō Coil* (2007) and *Orbital Children* (2022) — AR/AI/companion warmth
  - *Magilumière Magical Girls, Inc.* (Magilumiere Co. Ltd., 2024 manga/anime) — magick-as-corporate-profession tonal lock
- Anti-pattern citation: Pepsi "Breathtaking" document (Arnell Group, 2008) — [archived PDF](https://www.goldennumber.net/wp-content/uploads/pepsi-arnell-021109.pdf), [Ad Age coverage](https://adage.com/article/agency-news/breathtaking-word-purported-arnell-pepsi-doc/134552/), [Fast Company](https://www.fastcompany.com/1160304/pepsi-logo-design-brief-branding-lunacy-max)
- Originating session: 2026-05-18/19 workshop — Composio / Cursor / Factory case studies + Minsky myth selection. Captured in `references/case-studies-2026-05.md` and `references/minsky-myth-2026-05.md`.
- mt#1927 — task that installed this skill bundle
