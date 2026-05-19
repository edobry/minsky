---
name: marketing-site-design
description: >-
  Myth-first methodology for designing the Minsky marketing site and any
  adjacent marketing surface (microsites, launch pages, position-paper
  landing pages). Encodes the Barthes three-orders model (denotation /
  connotation / myth), Oswald's cultural-codes framework, and Peirce's
  icon/index/symbol triad as the design-decision substrate. Names the
  Pepsi/Arnell trap as the canonical anti-pattern: visual choices must
  instantiate the myth, never retrofit it. Use when designing or auditing
  any Minsky marketing surface, analyzing an adjacent product's site,
  or workshopping a brand-positioning myth. Complements the vendored
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

**The workshop sequence for picking a myth:**

1. **Name the audience's existing myth about the category.** What do AI-product buyers already believe about "agent platforms" or "coordination substrates"? What proposition arrives as obvious common sense before your site loads?
2. **Name the myth your brand wants to displace or extend.** Where does the category's default myth fall short for your specific positioning? What proposition do you want the buyer to find obvious after they read your site?
3. **State the myth as a single declarative sentence.** Not a tagline, not a product description — a proposition that, if accepted, makes the rest of your positioning trivial. Examples (one per nearby competitor):
   - Composio: *"AI integration plumbing is now a consumer-software experience."*
   - Cursor: *"Cursor is the IDE the engineers you admire use."*
   - Factory: *"Software engineering is shifting from craft to industrial manufacturing."*
4. **Test whether the myth is contestable.** A myth that everyone in the category already accepts is not a positioning move; it is the default. A myth that no one in the category accepts is too far. The right myth is one that current customers will recognize as true once stated, and competitors will find awkward to claim.

Carry the myth statement through to every subsequent design decision. When choosing typography / color / layout / motion, the question is always: *does this sign instantiate the myth, or does it instantiate a different myth (usually the category default)?*

## 2. The Pepsi/Arnell trap — named anti-pattern

The 2008 Pepsi rebrand by the Arnell Group produced a now-infamous 27-page "Breathtaking" document (archived [here](https://www.goldennumber.net/wp-content/uploads/pepsi-arnell-021109.pdf), [Ad Age coverage](https://adage.com/article/agency-news/breathtaking-word-purported-arnell-pepsi-doc/134552/)) that justified a minor logo refresh by invoking the Mona Lisa, the Golden Ratio, the Parthenon, the Earth's geomagnetic field, the Gutenberg Bible, and the theory of relativity. The document was widely mocked because it was **post-hoc theater** — semiotic vocabulary deployed to dress up a thin visual move, rather than semiotic *reasoning* used to drive a strong one.

The discipline encoded here:

- **Pick the myth first.** Let the visual choices follow as instantiations of the myth.
- **Never retrofit.** If you cannot explain a visual choice as a sign carrying a specific connotation that instantiates the stated myth, cut it.
- **Beware of justification documents.** A long explanation of why a design "works" is a warning sign that the design does not actually carry the meaning on its own. Signs should do the work; documentation describes what they do, it does not make them do it.

The Pepsi/Arnell trap is the recommendation-time analogue of the patterns named in [`feedback_confabulated_strategic_frame_to_justify_tactical_preference`](mt#1820 + bridge memory) — manufacturing a strategic frame to make a tactical preference sound principled. The fix is the same: cite first, decide second; or admit you do not know and rescope.

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

## 4. The two competing idioms in AI-product marketing

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

Minsky is in the Cursor/Factory camp. The CLI, MCP tool calls, cockpit, reviewer-bot PR comments, task graph, memory recall — these are the surfaces that should carry the pitch. Decorative motion would substitute for product proof Minsky already has.

## 5. The cultural codes occupied (and the white space)

From the three-way analysis, the visual codes already in active use in adjacent AI-tool marketing:

| Code | Exemplars | Visual signature |
|---|---|---|
| Consumer-tech polish | Composio, Notion AI, OpenAI Platform | saturated multicolor, premium grotesque, WebGL hero, designer-tech genealogy |
| Serious IDE / developer tool | Cursor, Aider, Continue | dark monochrome, IDE screenshot dominant, restrained type, named-individual testimonials |
| Industrial infrastructure | Factory, Railway, Render | pure black, all-caps signage, terminal aesthetic, deploy-platform genealogy |
| AI futurism | OpenAI, Anthropic, Mistral | abstract shader gradients, minimal copy, conceptual rather than product-shown |

The **mission-control / instrument-panel** code is *available white space*: Bloomberg Terminal, NASA mission-ops displays, ATC scopes, oil-rig SCADA. Underclaimed in AI tooling. It is the code closest to Minsky's actual self-understanding — cockpit, attention allocation, asks subsystem, viable system model. The vocabulary of the corpus already lives in this code; the marketing surface has not yet caught up.

Recommended positioning for Minsky: claim the mission-control code explicitly. Treat the marketing site as the surface where an operator sees a control panel for an AI-led organization, not as a category-default agent-platform homepage.

## 6. Vendored Tier-1 skill bundle

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
| `motion-framer` (vendored 2026-05-19) | Framer Motion patterns for ambient identity motion, scroll reveals | When implementing the motion budget (see section 8) |
| `tailwind-v4-shadcn` | Tailwind v4 + shadcn/ui setup | If using shadcn for component primitives |
| `react-best-practices` | React/Next.js performance patterns | For Astro islands or Next.js page implementation |
| `composition-patterns` | React composition (compound components, render props) | When building reusable section primitives (Hero, FeatureRow, etc.) |

## 7. The Minsky-specific layer

Decisions that the vendored skills do not make. These are the substrate that holds the myth.

### Idiom: B (product-screenshot dominant)

Recommended. Minsky has product surfaces worth showing; decorative motion would substitute for them.

### Cultural code: mission-control / instrument-panel

Recommended. White-space in the category, native to Minsky's existing vocabulary.

### Typography

- **Display + body:** Geist (free, Vercel-published, what Factory uses) or Söhne / Aktiv Grotesk if a paid grotesque is acceptable. Avoid Inter and Roboto — they are the AI-slop defaults.
- **Eyebrows + structural labels + code:** JetBrains Mono.
- **Weights:** display headlines at 400 (regular), not bold. Large size + light weight + tight tracking signals confidence; bold-at-large reads as marketing-y.
- **Tracking:** -2% to -5% of font size for display sizes. Roughly equivalent to -2.88px at 60px (Factory's measured value).

### Color

- Background: near-black, between `rgb(2, 2, 2)` (Factory) and `rgb(20, 18, 11)` (Cursor's slightly warm dark).
- Text: near-white, around `rgb(238, 238, 238)`.
- One accent for liveness signals (status indicators, progress bars, "live" dots). Candidate: signal-cyan or sodium-orange (Factory's orange progress bar is a strong precedent for the mission-control code).
- Refuse multi-color saturation. Reject the Composio palette explicitly. Mission-control instruments are monochrome with single-accent signal lights for a reason.

### Layout pattern

- Hero: left-aligned caption column + right-aligned product proof. Never centered.
- Section pattern: alternating left/right caption + product screenshot. Avoid the sticky-numbered-nav + colored-tile-panel pattern (that is Idiom A's signature).
- Customer logo strip: single muted row. Co-products Minsky composes with (Claude Code / Cursor / Codex / MCP / GitHub / Notion / Railway) rather than fake customer logos.
- Footer-CTA: terse, single CTA, no email-capture form unless the user requested it.

### Motion budget

- **Ambient identity-level motion only.** A small rotating element in the wordmark (Factory's gear), a single scroll-driven fade per section.
- **No decorative shaders or WebGL.** They signal Idiom A.
- **No multi-system orchestrated motion.** Liveness should come from real product instrumentation (a status dot that reflects actual state), not from decorative continuous animation.
- **Respect `prefers-reduced-motion`.** Hook `useReducedMotion()` or the equivalent and zero out motion when set.

### Product surfaces to show

Specific Minsky scenes that should appear as iconic signs (resembling what Minsky actually does):

1. CLI output of a session running a real task (`minsky session start mt#NNNN` -> agent picks up work)
2. MCP tool call result inside Claude Code (e.g. `mcp__minsky__tasks_get`)
3. Cockpit widget showing active workstreams
4. Reviewer-bot PR comment catching a real contract violation
5. Task graph visualization showing parent/child + dependency edges
6. Memory recall stopping a repeat mistake (search hit, prior incident referenced)
7. A hook denial in action (e.g., the bypass-merge guard blocking a subagent's PUT /merge)
8. The asks subsystem surfacing an attention-required event

Each scene is a real screenshot or terminal recording, not a mockup. The site is the surface where Minsky's substrate becomes visible.

### Voice register

- Three- or four-word conceptual section headlines. Examples to noodle on:
  - "Tasks that converge"
  - "Reviews that hold"
  - "Memory that compounds"
  - "Attention that allocates"
  - "Hooks that catch"
  - "Asks that escalate"
- Sentence case, present tense, no exclamation.
- All-caps for *structural* labels only (nav, eyebrows, numbered section markers).
- Avoid SaaS hyperbole ("the future of," "transforms your," "supercharge your," "from your first X to your IPO").
- The voice should sound like a peer engineer / principal operator, not a vendor.

### Customer-logo strategy

Minsky does not yet have customer logos worth displaying. Substitute with **co-product logos** — the systems Minsky composes with:

- Claude Code, Cursor, Codex (harness compatibility)
- MCP (protocol)
- GitHub, Notion (backend integrations)
- Railway (deploy)
- Bun (runtime)

Frame as "Minsky composes with" rather than "trusted by." Borrows credibility from the named products without claiming customers that do not yet exist.

## 8. Anti-patterns (named)

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

## 9. Workshop process — how to walk a brand through myth selection

Use this when pairing with the operator (or self-running) to pick the myth before any visual work begins. Each step produces a written artifact; together they constitute the brief.

### Step 1 — Audit the existing category myth

- What proposition do AI-product buyers already accept as obvious before they encounter Minsky?
- What does the category's default site (e.g., a generic agent platform homepage) say without saying — what myth does it naturalize?
- Output: 1-2 sentences naming the category-default myth.

### Step 2 — Audit Minsky's existing corpus

- Walk the Notion strategic docs ([Minsky home](https://www.notion.so/33a937f03cb48197a93ecd4a98a94261) + position papers + RFCs).
- Walk the principal-context corpus (CLAUDE.md `§Principal Context`, `decision-defaults.mdc`, mt#1034).
- Identify three to five propositions that recur across the corpus and that Minsky's existing voice already naturalizes. These are candidate myths.
- Output: 3-5 candidate myth-statements, each one declarative sentence.

### Step 3 — Test each candidate

For each candidate myth, ask:

- Is it *contestable*? (Would a buyer disagree before encountering the site? Would a competitor find it awkward to claim?)
- Is it *carried by Minsky's actual product*? (Can the product surfaces in section 7 instantiate this myth?)
- Is it *durable*? (Will it still be true and important in 2-3 years?)
- Is it *aligned with the principal's investment*? (Does the operator want to spend years naturalizing this proposition?)

Output: one selected myth, written as a single declarative sentence.

### Step 4 — Identify the cultural code

Given the selected myth, name the cultural code that carries it. Use Section 5's table as starting points; new codes are allowed if justified.

- If the myth lives in an *occupied* code, name the competitor whose visual register Minsky will partially share. Decide which signs you will adopt and which you will reject.
- If the myth lives in an *available* code (mission-control is the strong candidate for Minsky), name the code and its existing exemplars outside the AI category (Bloomberg Terminal, NASA, ATC, oil-rig SCADA).

Output: 1 cultural code, with 2-3 exemplars cited.

### Step 5 — Derive the visual specification

Now and only now, derive the visual decisions from the code:

- Typography (display, body, mono)
- Color (background, text, accent)
- Layout pattern (hero, sections, customer logos)
- Motion budget (ambient, scroll, gesture)
- Product surfaces to show

Each decision must be traceable to a sign that instantiates the chosen code. If a proposed decision does not carry the code, drop it.

Output: the brief — myth, code, visual spec.

### Step 6 — Build a first surface, then test the brief

Implement the hero + one feature section. Show it to a buyer-archetype reader. Ask: "what does this site naturalize?" If their answer matches the myth statement, the brief is working. If it does not, the visual choices are instantiating a different code; iterate.

## 10. Worked example

The 2026-05-19 three-way analysis of Composio / Cursor / Factory through the Peirce-Barthes-Oswald framework is stored at `./references/case-studies-2026-05.md`. Read it when:

- Analyzing a new adjacent product's marketing site (use it as the template)
- Re-grounding your sense of what the two idioms actually look like
- Pairing with the operator on a competitive read-out

## Cross-references

- `.claude/skills/cockpit-design/SKILL.md` — structural template; this skill is its marketing-surface sibling
- `feedback_confabulated_strategic_frame_to_justify_tactical_preference` — discipline against post-hoc framing (the Pepsi/Arnell trap at the recommendation surface)
- `feedback_strategic_reframe_first` — the connecting direction (when a tactical ask is an instance of a strategic frame, name the frame)
- CLAUDE.md `§Principal Context` — Minsky's commercial-product framing; the audience this skill addresses
- CLAUDE.md `§Decision Defaults` — Minsky-grounded defaults that supersede generic SaaS-marketing defaults
- Notion: [Minsky home](https://www.notion.so/33a937f03cb48197a93ecd4a98a94261), [Vision & theory: the viable cognitive system](https://www.notion.so/33a937f03cb4815c8394d7fe62d61355), [The cockpit problem](https://www.notion.so/33a937f03cb4819a8865e11164cbb1c8)
- Source texts:
  - Roland Barthes, *Mythologies* (1957) — denotation / connotation / myth
  - Laura R. Oswald, *Marketing Semiotics: Signs, Strategies, and Brand Value* (Oxford, 2012)
  - Laura R. Oswald, *Creating Value: The Theory and Practice of Marketing Semiotics Research* (Oxford, 2015)
  - C.S. Peirce — icon / index / symbol triad ([overview](https://vanseodesign.com/web-design/icon-index-symbol/))
- Anti-pattern citation: Pepsi "Breathtaking" document (Arnell Group, 2008) — [archived PDF](https://www.goldennumber.net/wp-content/uploads/pepsi-arnell-021109.pdf), [Ad Age coverage](https://adage.com/article/agency-news/breathtaking-word-purported-arnell-pepsi-doc/134552/), [Fast Company](https://www.fastcompany.com/1160304/pepsi-logo-design-brief-branding-lunacy-max)
- Originating session: 2026-05-18/19 working session comparing Composio / Cursor / Factory through a semiotic lens
- mt#1927 — task that installed this skill bundle
