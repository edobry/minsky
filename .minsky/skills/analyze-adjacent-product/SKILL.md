---
name: analyze-adjacent-product
description: >-
  Semiotic analysis of an adjacent product's marketing surface or brand
  positioning. Encodes the Peirce icon/index/symbol triad, Barthes' three
  orders of signification (denotation / connotation / myth), and Oswald's
  cultural-codes framework as the analytical substrate. Names the
  Pepsi/Arnell trap as the anti-pattern: semiotic vocabulary as post-hoc
  theater rather than driving reasoning. Use when reading a competitor's
  marketing site, an inspirational reference, or any adjacent brand you
  want to understand structurally — for competitive positioning, RFC
  support, build-vs-buy decisions, or feeding the marketing-site-design
  workshop's cultural-code identification step. Pairs with
  marketing-site-design (which consumes this skill's analytical output to
  drive brand-positioning decisions).
user-invocable: true
---

# analyze-adjacent-product — semiotic analysis of adjacent brands and products

You are analyzing an adjacent product's marketing surface or brand positioning. The goal is to read what the brand is constructing semiotically — what myth it naturalizes, which cultural codes it invokes, which signs it deploys — and produce a structured analysis that downstream work (positioning decisions, RFC writing, build-vs-buy framing, marketing-site-design's workshop) can consume.

If you're pattern-matching at the surface ("their site looks polished" / "their copy is good") without naming the _signs_ doing the work, stop. The framework below makes the analysis layered enough to extract transferable lessons rather than vibes.

## When to invoke

- Analyzing a competitor's marketing site to understand their positioning
- Reading an inspirational reference (a peer product, a brand you admire) to extract design and positioning lessons
- Feeding the `marketing-site-design` skill's workshop process (Step 4 — cultural-code identification, which uses this skill's output as input)
- Doing competitive analysis for an RFC or strategic doc
- Workshopping a positioning argument that needs grounding in adjacent-brand reality rather than abstract claims
- Build-vs-buy decisions where understanding what an existing product _is_ (semiotically) helps clarify what your alternative would have to do

## 1. The framework — Peirce, Barthes, Oswald

Three layers, each useful for a different decision:

**Peirce's triadic categories of signs** ([overview](https://vanseodesign.com/web-design/icon-index-symbol/)) — useful when classifying a specific sign in the design:

- **Icon** — sign by resemblance. A product screenshot resembles the product. A photorealistic render of a "Droid Computer" resembles a physical box.
- **Index** — sign by causal/factual connection. A customer logo points to a real customer. A live install command points to a working CLI.
- **Symbol** — sign by arbitrary cultural convention. A logo, a typeface, an all-caps register, a color. None resemble what they signify; their meaning is learned.

Most marketing surfaces blend all three. Knowing which kind of sign you are reading clarifies what work it is doing: icons supply _demonstration_, indices supply _evidence_, symbols supply _positioning within a code_.

**Barthes' three orders of signification** ([overview](https://www.allensbach-hochschule.de/en/semiotics-according-to-roland-barthes-and-its-relevance-for-pr-and-communication-between-sign-and-meaning/)) — useful when reading what a brand is doing:

- **Denotation** — literal content. The thing depicted. A WebGL shader is a moving particle field.
- **Connotation** — culturally-conditioned associations the sign carries. The shader connotes technical sophistication, AI-futurism, agent-platform polish.
- **Myth** — second-order signification where the connoted meanings get _naturalized_ — made to seem obviously true rather than constructed. Composio's site, in context, naturalizes "AI integration as consumer-software experience."

Marketing surfaces operate primarily at the third order. The visual choices a designer makes are _signs deployed to instantiate a myth_ — to make a culturally-constructed proposition feel like an obvious truth. Reading a brand means peeling the orders apart: literal → cultural association → naturalized proposition.

**Oswald's cultural codes** ([Marketing Semiotics, OUP 2012](https://academic.oup.com/book/9313/chapter/156060651); [Creating Value, OUP 2015](https://global.oup.com/academic/product/creating-value-9780199657261)) — useful when placing a brand in a category-wide landscape:

A brand operates by invoking _cultural codes_ — sets of signs an audience already recognizes as belonging to a category. Codes have names: codes of luxury, codes of authenticity, codes of innovation, codes of artisan craft, codes of industrial infrastructure, codes of consumer-tech polish. A positioning decision is partly a code-selection decision: which codes does the brand claim, which does it explicitly reject, which white-space codes are available to occupy.

## 2. The Pepsi/Arnell trap — named anti-pattern

The 2008 Pepsi rebrand by the Arnell Group produced a now-infamous 27-page "Breathtaking" document (archived [here](https://www.goldennumber.net/wp-content/uploads/pepsi-arnell-021109.pdf), [Ad Age coverage](https://adage.com/article/agency-news/breathtaking-word-purported-arnell-pepsi-doc/134552/)) that justified a minor logo refresh by invoking the Mona Lisa, the Golden Ratio, the Parthenon, the Earth's geomagnetic field, the Gutenberg Bible, and the theory of relativity. The document was widely mocked because it was **post-hoc theater** — semiotic vocabulary deployed to dress up a thin visual move, rather than semiotic _reasoning_ used to drive a strong one.

The discipline this encodes — applies symmetrically to analysis and to design:

- **For analysis:** when reading a brand, name what the signs _actually_ do, not what a theoretically-impressive frame would predict they do. If the analysis sounds clever but the visual evidence is thin, the analysis is theater. The signs should support the claim; if they don't, the claim is wrong.
- **For your own design:** pick the myth first; let visual choices follow as instantiations of the myth. Never retrofit semiotic justification onto a thin visual move. A long explanation of why a design "works" is a warning sign that the design does not actually carry the meaning on its own.

The Pepsi/Arnell trap is the recommendation-time analogue of the patterns named in `feedback_confabulated_strategic_frame_to_justify_tactical_preference` — manufacturing a frame to make a tactical preference sound principled. The fix is the same: cite first, decide second; or admit you do not know and rescope.

## 3. Bridge-as-affect — how brands instantiate emergent codes through residual references

A critical discipline when reading or building positioning that claims an _emergent_ code (one with no category instantiation yet). Brands do NOT typically expose the audience to the raw emergent code directly; that produces blank stares. Instead, they bridge through **residual codes** — codes the audience already recognizes — that carry the same structure. The audience pattern-matches to the residual reference; their recognition is the bridge; they end up holding the emergent frame as a conclusion they reached themselves.

The discipline (applied symmetrically to analysis and design):

- **For analysis:** when reading a brand that's making an emergent claim, name both the emergent code and the residual code(s) being used to bridge. Don't confuse the bridge (residual) with the destination (emergent). A brand that visually borrows from "industrial manufacturing" codes to claim "software engineering as factory work" is using the industrial code as the bridge — the destination myth is the emergent claim about software, not the industrial reality.
- **For your own design:** borrow at the layer of register (typography, color, density, motion budget, copy tone), not at the layer of imagery (literal characters, mecha, products). The right reader notices the borrowing as taste-signal; the wrong reader doesn't notice and isn't bothered. Evangelion's discipline is the canonical execution: dense with religious/Kabbalistic iconography (AT-Field, Sephirot, Magi-as-three-wise-men) without ever being _about_ religion. The borrowings function as affect; the show's subject is something else.

**When in doubt, ask:** would the right reader notice the borrowing without being told? If yes, the borrowing is doing its work. If you have to caption it, it's gone too literal.

## 4. Per-analysis workflow

Each analysis produces a structured artifact suitable for archiving as `references/case-studies-<date>.md` (one date file per analysis batch). Use the canonical case-studies file at `references/case-studies-2026-05.md` as the template.

**Method (per analysis):**

1. **Capture.** Open the site in Chrome DevTools MCP. Take hero + scroll-state screenshots (at least 3-4 scroll positions). Inspect typography stack via `evaluate_script` (font family / weight / size / tracking / line-height). Check for canvas / WebGL / video elements. Pull color tokens (background, text, accent). Pull positioning copy verbatim — hero headline, subhead, section headers, CTAs, customer-logo list, pricing tier names if any, nav register.

   **Anti-pattern: aggregator-staleness on JS-rendered AI-product sites.** Do NOT substitute review aggregators (capterra.com, futuretools.io, automateed.com, g2.com, softwareadvice.com), VC press releases, or Google Cloud / AWS customer case studies for the live site. AI-product sites are routinely JS-rendered, which means `WebFetch` returns a near-empty DOM and forces the agent down the aggregator path. Aggregators describe whatever the product was at _content-cataloging time_ — for fast-moving AI products, that's 6–18 months stale; pivots are common; the "no overlap with X" verdict on aggregator data is reliably wrong when the product has repositioned. Originating incident: 2026-05-19 Macro (macro.com) analysis. First-pass WebFetch + 5 aggregator sources unanimously described Macro as "AI document workspace" (its 2023 product); Chrome DevTools snapshot of the live homepage corrected the picture in one turn to "operating system for your startup" (its late-2024 / 2025 pivot). If Chrome DevTools is unavailable, state the aggregator-fallback explicitly in the analysis: _"Live-site capture failed; describing from <aggregator>, dated <month>; verdict applies to that snapshot only."_ Don't elide the staleness.

2. **Denotation.** What is literally on the page. Restate the captured content as the literal-content layer: which fonts at which sizes, which colors, which animation systems, which sections, which copy. Resist interpretation at this layer.

3. **Connotation.** What cultural associations the signs carry. For each major sign captured (typography, color, motion, layout, copy register, social proof), name the connotation. Format as bullets: "X connotes Y" — where Y is a learned cultural association, not a designer's intent.

4. **Myth.** What proposition the brand is naturalizing. Single declarative sentence. The proposition that, if accepted, makes the rest of the brand's positioning trivial. Examples from the 2026-05 case studies:

   - Composio: _"AI integration plumbing is now a consumer-software experience."_
   - Cursor: _"Cursor is the IDE the engineers you admire use."_
   - Factory: _"Software engineering is shifting from craft to industrial manufacturing."_

5. **Peirce read.** Classify the principal signs as icon, index, or symbol. For each, name what work it's doing in the brand's argument (demonstration, evidence, or positioning-within-a-code).

6. **Cultural codes invoked.** Per Oswald: name the cultural codes the brand is operating within. Cite exemplars (other brands or domains in the same code). Codes are not invented per-brand; they are pre-existing categories the brand claims or rejects. Examples:
   - _Consumer-tech polish_ (Notion / Linear / Vercel designer-tech genealogy)
   - _Serious developer tools_ (Sublime / VS Code / IntelliJ genealogy)
   - _Industrial infrastructure_ (Vercel / Railway / Render deploy-platform genealogy)
   - _AI futurism_ (OpenAI / Anthropic / Mistral)

When the analysis is complete, also produce:

- **Idiom placement.** Place the brand against the three-idiom synthesis (see §5 below — Idiom A motion-decorated-infographic / Idiom B product-screenshot-dominant / Idiom C founder-essay). Which idiom is the brand operating in? Are there hybrid moves? If the brand fits none of the three cleanly, it may be evidence for a fourth idiom — surface it.
- **Implications.** What does this analysis change about positioning for whoever consumes the output? (E.g., for `marketing-site-design` / `minsky-brand` consumers: which codes does this analysis open or close for our own brand? If a new code emerges or an existing claim is invalidated, the cultural-code table to update is the one in [`/minsky-brand`](../minsky-brand/SKILL.md) §4 — that's the brand-foundation source of truth.)

## 5. The three-idiom synthesis (current state — 2026-05)

From the 2026-05 four-way analysis (Composio / Cursor / Factory / Macro). Idioms A and B emerged from the 2026-05-18 three-way; Idiom C was added 2026-05-19 from the Macro analysis. The earlier "two-idiom synthesis" framing is superseded.

**Idiom A — Motion-decorated infographic** (exemplar: Composio)

- WebGL shader / canvas hero
- Centered headlines
- Multiple saturated colors (electric blue / pink / cyan / green tiles)
- Heavy decorative animation orchestrated across multiple systems
- Premium paid typeface (abcDiatype)
- Abstract diagrams and infographic-style use-case carousels
- Sells _concept_. Used when the product is plumbing the buyer cannot see directly.

**Idiom B — Product-screenshot dominant, restrained** (exemplars: Cursor, Factory)

- Static or near-static hero
- Left-aligned caption + right-aligned product screenshot
- Monochrome dark with minimal accent
- Real product UI as the dominant visual element
- Free typeface (Geist) or commissioned bespoke typeface (CursorGothic)
- Customer logos as muted single row
- Sells _the actual product_. Used when the product has surfaces worth showing.

**Idiom C — Founder-essay** (exemplar: Macro; pre-AI exemplars: Linear founding era, Superhuman) — added 2026-05-19 from the Macro analysis

- Embedded founder/customer testimonial videos as hero content (no large hero screenshot, no canvas-orchestrated motion)
- Stage-selector mirror language replaces feature-tour ("we know your stage")
- Warm-tinted dark (not industrial-cold, not neutral) with amber/gold accents — atelier / lamp-light / founder's-room register
- Comparison strip linking to long-form "What We Learned from X" essays — the canon-citation move
- Custom semantic-token typography (e.g., `display` / `body` family tokens with a custom weight like 410) — the in-house design system is itself the taste signal
- H1 often absent; brand-mark image carries the visual top
- Single-tier pricing; minimal sales surface
- Named-founder titles foreground design (`CEO / Product Designer`)
- Sells _the founder's philosophy_. Used when the product is multi-surface (no single screenshot represents it) AND the buyer is another founder who reads essays.

**Decision drivers (revised):**

- Idiom A when the product is invisible plumbing.
- Idiom B when the product has UI worth showing.
- Idiom C when the product is multi-surface AND the founder's taste IS the differentiation.

The three-idiom synthesis is empirical observation, not a closed taxonomy. New idioms may emerge; revise this section when an analysis produces a clearly-different idiom that doesn't fit any of these three.

## 6. Worked example

`references/case-studies-2026-05.md` contains the canonical four-way analysis: Composio (Idiom A), Cursor + Factory (Idiom B), and Macro (Idiom C — added 2026-05-19 from the macro.com investigation; see Idiom C synthesis row in that file). Read it when:

- Analyzing a new adjacent product's marketing site (use it as the structural template)
- Re-grounding your sense of what the three idioms (A motion-decorated-infographic / B product-screenshot-dominant / C founder-essay) actually look like
- Pairing with the operator on a competitive read-out
- Onboarding to the methodology

## 7. Template for future analyses

When analyzing a new adjacent product's marketing site:

1. **Open the site in Chrome DevTools MCP.** Capture hero + 2-3 scroll states + any cursor-reactive interaction states. Inspect typography (font family / weight / size / tracking) and color tokens via `evaluate_script`. Check for canvas/WebGL elements. **Do not substitute review aggregators or VC press releases for the live site** — see §4 step 1 anti-pattern (aggregator-staleness on JS-rendered AI-product sites).
2. **Pull positioning copy verbatim.** Hero headline, subhead, section headers, CTAs, customer-logo list, pricing tier names (if any), nav register.
3. **Write the six sections in order:**
   - Captured (artifacts + screenshots)
   - Denotation (literal content)
   - Connotation (cultural associations)
   - Myth (single declarative sentence; the proposition being naturalized)
   - Peirce read (classify principal signs as icon / index / symbol)
   - Cultural codes invoked (per Oswald; cite exemplars)
4. **Compare to the three-idiom synthesis** (Idiom A motion-decorated-infographic / Idiom B product-screenshot-dominant / Idiom C founder-essay). Which idiom does the site operate in? Which cultural codes does it claim? Which does it explicitly reject?
5. **Note the implications for the consumer.** For `marketing-site-design` / `minsky-brand` consumers: does this analysis change the recommended cultural-code lane for our own brand? Does it open or close a white-space code? If yes, update the cultural-code table in [`/minsky-brand`](../minsky-brand/SKILL.md) §4 — that's the brand-foundation source of truth (was previously in `marketing-site-design` §5 before mt#1933 extraction).
6. **Apply the Pepsi/Arnell discipline.** When stating the myth, verify it is grounded in the actual visual evidence captured, not constructed post-hoc to make a tactical recommendation sound principled.

The 2026-05 analysis (Composio / Cursor / Factory / Macro) is the canonical four-way instance of this template. Future instances should follow the same shape; archive them in this directory with date-stamped filenames (e.g., `case-studies-2026-08.md`).

## Cross-references

- [`/name-product`](../name-product/SKILL.md) — _synthesis dual_ of this skill. This skill reads an existing name/brand semiotically (analysis); `name-product` generates one using the Lexicon framework (synthesis). Use it when an adjacent-product naming read should feed a naming decision of our own.
- `/marketing-site-design` — sibling skill that consumes this skill's output. The marketing-site-design workshop's Step 4 (cultural-code identification) uses this skill as input. The Minsky-specific positioning decisions live there.
- `feedback_confabulated_strategic_frame_to_justify_tactical_preference` — sibling discipline against post-hoc framing (the Pepsi/Arnell trap at the recommendation surface)
- `feedback_strategic_reframe_first` — the connecting direction (when a tactical ask is an instance of a strategic frame, name the frame)
- CLAUDE.md `§Principal Context` — informs the audience for which this skill's output is relevant
- CLAUDE.md `§Decision Defaults > Build vs buy` — informs when this skill is invoked for build-vs-buy reasoning
- Source texts:
  - Roland Barthes, _Mythologies_ (1957) — denotation / connotation / myth
  - Laura R. Oswald, _Marketing Semiotics: Signs, Strategies, and Brand Value_ (Oxford, 2012)
  - Laura R. Oswald, _Creating Value: The Theory and Practice of Marketing Semiotics Research_ (Oxford, 2015)
  - C.S. Peirce — icon / index / symbol triad
- Anti-pattern citation: Pepsi "Breathtaking" document (Arnell Group, 2008) — [archived PDF](https://www.goldennumber.net/wp-content/uploads/pepsi-arnell-021109.pdf), [Ad Age coverage](https://adage.com/article/agency-news/breathtaking-word-purported-arnell-pepsi-doc/134552/), [Fast Company](https://www.fastcompany.com/1160304/pepsi-logo-design-brief-branding-lunacy-max)
- Originating session: 2026-05-18/19 brand workshop in mt#1927; methodology was originally embedded in `marketing-site-design/SKILL.md` and extracted into this standalone skill on 2026-05-19 via mt#1944.
- mt#1944 — extraction task

---

**Extracted 2026-05-19 (mt#1944):** This skill was originally a set of sections inside `marketing-site-design/SKILL.md` (§3 framework, §2 Pepsi/Arnell trap, §4 bridge-as-affect, the implicit per-analysis workflow, the two-idiom synthesis). Extracted into a standalone skill so the methodology is invokable for any adjacent-product read (RFC support, competitive analysis, build-vs-buy decisions), not only for marketing-positioning work. The Composio / Cursor / Factory worked example was moved with the methodology to `references/case-studies-2026-05.md`. No semantic changes to the methodology itself.
