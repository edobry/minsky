# Marketing-site case studies — 2026-05 four-way analysis (Composio / Cursor / Factory / Macro)

Worked example for `marketing-site-design` and `analyze-adjacent-product`. Four adjacent AI-tool / AI-adjacent sites read through the Peirce-Barthes-Oswald framework. The three-way analysis (Composio / Cursor / Factory) was conducted 2026-05-18; Macro was added 2026-05-19 from the macro.com investigation, and proposed Idiom C alongside the existing Idiom A and Idiom B. Use as the template when analyzing any future competitor or category site.

**Method (per analysis):**

1. **Capture:** open the site in Chrome DevTools MCP. Take hero + scroll-state screenshots. Inspect typography stack (font family / weight / size / tracking), color tokens, canvas/video elements. Pull positioning copy verbatim.
2. **Denotation:** what is literally on the page.
3. **Connotation:** what cultural associations the signs carry.
4. **Myth:** what proposition the brand is naturalizing.
5. **Peirce read:** classify the principal signs as icon, index, or symbol.
6. **Cultural codes invoked:** which named codes the brand is operating within (per Oswald).

---

## Composio (composio.dev) — Idiom A exemplar

### Captured (2026-05-18)

- Hero headline: _"Your agent decides what to do. We handle the rest."_
- Hero subhead: _"Just-in-time tool calls, secure delegated auth, sandboxed environments, and parallel execution across 1,000+ apps."_
- CTAs: "Get started for free" (filled), "Get a demo" (outlined).
- Hero canvas: 1800x660 WebGL2, particle/bar shader. Time-driven slow rotation. Cursor input modulates color/parallax but motion exists without input.
- Typography: abcDiatype (paid grotesque, ABC Dinamo) + JetBrains Mono for eyebrows. H1 at 64px, weight 400, letter-spacing -1.6px, line-height 64px.
- Color: dark hero with saturated-blue, pink, cyan, teal feature panels below. Multi-color palette.
- IA: hero / customer logo bar (agent.ai / zoom / Letta / glean / HubSpot) / use-case carousel / colored-tile feature section with sticky numbered nav (01 SMART TOOLS / 02 CONSTANT EVOLUTION / 03 END USER AUTH / 04 DYNAMIC SANDBOX) / SDK section / security section / footer CTA.
- Pricing tiers: "Totally Free / Ridiculously Cheap / Serious Business" — playful naming.
- Three independent animation systems running in parallel: WebGL shader, logo marquee, use-case carousel.

### Denotation

WebGL bar-stack particles, saturated full-bleed colored panels, dark terminal cards floating on colored fields, mono-eyebrow + grotesque-headline typography, dual headline structure (clean primary + punchy secondary), three-bullet right column per feature tile, "1,000+ apps" repeated everywhere.

### Connotation

- WebGL shader -> "we are technically advanced enough to ship WebGL on a marketing page"
- Saturated multi-color -> consumer-software vitality; Notion/Linear/Vercel designer-tech adjacency
- Continuous orchestrated motion across 3 systems -> liveness, the product is alive, work happens here
- 1,000+ logo grid -> vastness, comprehensiveness, ubiquity
- Terminal aesthetics inside saturated panels -> "the technical layer is wrapped in approachable design"
- Pricing names with attitude -> confidence, plain talk, anti-corporate

### Myth

_"AI integration plumbing is now a consumer-software experience."_ The brand naturalizes the proposition that agent integration is no longer arcane API work — it is a beautifully-designed magical product layer that lives in the conversational surface alongside the agent.

### Peirce read

- WebGL shader = primarily **iconic** of technical sophistication (visually resembles the kind of complex graphical capability that signals advanced engineering)
- "1,000+ apps" grid = **indexical** of breadth (the count points to a fact)
- Saturated tile colors = **symbolic** (blue↔intelligence, green↔learning, pink↔auth — learned conventions, not resemblances)
- Pricing names = **symbolic** (the names are arbitrary; their meaning is the attitude they convey via convention)

### Cultural codes invoked

- _Consumer-tech polish_ (Notion / Linear / Vercel designer-tech genealogy)
- _AI futurism_ (abstract shader/gradient aesthetic shared with OpenAI, Anthropic, Mistral product surfaces)
- _Wrapped enterprise_ (GitHub-style terminal cards inside explicitly commercial / branded dressing)

---

## Cursor (cursor.com) — Idiom B exemplar

### Captured (2026-05-18)

- Hero headline: _"Built to make you extraordinarily productive, Cursor is the best way to code with AI."_
- CTAs: "Download for macOS ↓" (filled white pill), "Request a demo →" (outlined)
- No canvas, no WebGL — fully static.
- One video element: a logo MP4.
- Typography: bespoke **CursorGothic** + CursorGothic Fallback. H1 at 26px (small for a hero), weight 400, tracking -0.325px, line-height 32.5px.
- Color: background `rgb(20, 18, 11)` — near-black with slight warm tint.
- Hero layout: 40% caption column (left) + 60% full IDE screenshot showing real Cursor session running "Build Landing Page" task.
- Customer logos: single muted row — stripe / OpenAI / Linear / DATADOG / NVIDIA / Figma / ramp / Adobe.
- Section pattern: alternating left/right — caption-left + screenshot-right, then caption-right + screenshot-left. Each section pinned to a real product screenshot.
- Section headers: _"Agents turn ideas into code"_ / _"Works autonomously, runs in parallel"_ / _"In every tool, at every step"_ / _"Magically accurate autocomplete"_ / _"Complete codebase understanding"_ / _"The new way to build software"_.
- Social proof: named individuals (Jensen Huang/NVIDIA, Patrick Collison/Stripe, Diana Hu/YC, shadcn/shadcn-ui) — quotes attached to specific technical leaders, not anonymous testimonials.

### Denotation

Near-black page, small left-aligned headline, full-bleed IDE screenshot, customer logo strip, alternating-column sections with screenshots, named-individual quotes, install command shown verbatim mid-page (`curl https://cursor.com/install -fsS | █`).

### Connotation

- Small headline -> "we don't need to shout; look at the work"
- Static hero -> stability, finished thing, no anxious motion
- Product screenshot as hero -> "the product speaks for itself; we are not hiding behind marketing language"
- Customer logos (Stripe / OpenAI / NVIDIA / etc.) -> "the engineers you respect already use this"
- CursorGothic (commissioned typeface) -> investment in our own visual identity at a level most startups cannot match
- Named-individual quotes -> trust by association with specific identifiable technical leaders, not anonymous social proof

### Myth

_"Cursor is the IDE the engineers you admire use."_ The brand naturalizes AI-assisted coding as the default for serious engineering, with the Cursor brand standing in for that default.

### Peirce read

- IDE screenshot = pure **icon** (literally resembles the product)
- Stripe / NVIDIA / OpenAI / shadcn social proof = **indexical** (those companies/people factually use Cursor)
- CursorGothic typeface = **symbolic** (bespoke letterforms have no resemblance to engineering; the meaning is learned — investment in craft, premium brand)
- The install command shown mid-page = **indexical** (it actually works; it points to a real downloadable product)

### Cultural codes invoked

- _Serious developer tools_ (Sublime / VS Code / IntelliJ genealogy — restrained, technical, screen-first)
- _Silicon Valley success register_ (named technical leaders, not paragraphs of marketing copy)
- _Minimalism as confidence_ (residual modernist code — less is more, restraint signals power)

---

## Factory.ai (factory.ai) — Idiom B variant, industrial register

### Captured (2026-05-18)

- Hero headline: _"Your software Factory powered by Droid"_
- Hero install command shown verbatim: `curl -fsSL https://app.factory.ai/cli | sh`
- CTAs: "DOWNLOAD FOR MAC" (filled white pill, all caps), "REQUEST A DEMO" (outlined, all caps).
- One 2D canvas (1512x1104) for a rotating-gear animation in the wordmark.
- 79 SVGs, 858 total DOM elements — extremely sparse page.
- Typography: **Geist** (free, Vercel-published) + Geist Fallback. H1 at 60px, weight 400, tracking -2.88px (~4.8% of font size, very tight), line-height 60px (1:1, no breathing room).
- Color: background `rgb(2, 2, 2)` — near-pure black, more aggressive than Cursor.
- Hero layout: ~40% caption + ~60% terminal-screenshot showing multi-pane Droid CLI (Monitor / Tasks / Plan / Output with orange progress bar).
- Nav: ALL CAPS — PRODUCT / ENTERPRISE / PRICING / NEWS / COMPANY / CAREERS / DOCS / LOG IN / CONTACT SALES.
- Section labels (eyebrows): also all caps, mono — `● DROID COMPUTER`, etc.
- Customer logos: adyen / mongoDB / Monte Carlo / WRITER / groq / Chainguard / Profound / Klarna / Upstart — large-enterprise names.
- "One platform, every surface your team works on" with tabs: Droid CLI / Desktop / Web / Mobile / Slack / Jira & Linear.
- _"Spin up a Droid Computer"_ section: photorealistic render of a Mac-Mini-style box with green LED. Treats Factory as if it had a physical-infrastructure object.
- _"Factory Standard Credits"_ section: real usage charts (Last 7/30/90 days).

### Denotation

Pure black background, large headline in Geist, all-caps nav and section labels, terminal screenshot, photorealistic render of a physical box, install command verbatim, customer logos, real-product usage charts surfaced as marketing.

### Connotation

- Pure black + all caps -> industrial signage, server-rack, control room
- All-caps nav/labels -> factory-floor signage, equipment labeling, control-panel language
- Geist -> Vercel-aligned modern-deploy aesthetic (Vercel/Linear/Cal/Resend peer set)
- Photorealistic physical-box render -> "we have infrastructure mass; you can almost touch it" (despite Factory being software)
- Install command shown verbatim -> "we are reachable directly via your shell; this is real, this is ready"
- Names "Factory" + "Droid" -> manufacturing site + worker robot; software-as-manufacturing
- Rotating gear in wordmark -> machinery at work, ambient mechanical motion
- Real usage charts as marketing copy -> "the product instruments itself; what you see is real"

### Myth

_"Software engineering is shifting from craft to industrial manufacturing."_ The brand naturalizes the proposition that code production is moving from artisanal hand-coding to industrial-scale agent-operated factories, with Factory as the operator of that shift.

### Peirce read

- Droid Computer render = **iconic** of physical infrastructure (resembles a physical object even though Factory is software)
- Terminal screenshot = **icon + index** (looks like the product, IS the product)
- Customer logos (mongoDB / Adyen / Klarna) = **indexical** (factual customers — enterprise-grade)
- "FACTORY" + "Droid" naming = **symbolic** (manufacturing-as-software-development is a learned cultural framing)
- All-caps nav register = **symbolic** (factory-floor signage convention — no inherent connection between letterforms and infrastructure)
- Rotating gear icon = **symbolic** (gear-as-machinery is a learned convention)

### Cultural codes invoked

- _Industrial manufacturing_ (factory / droid / gear / all-caps signage — vertical code reaching back to mid-20th-century industrial aesthetics)
- _Vercel-aligned modern deploy platform_ (Geist, dark mode, terminal-aesthetic, contemporary deploy-platform peer set)
- _Enterprise gravity_ (mongoDB / Adyen / Klarna customer logos — large enterprise, not startup)

---

## Macro (macro.com) — Idiom C exemplar

> **Capture provenance.** Typography weights, OKLCH color tokens, DOM-element counts, and verbatim copy below were captured via `mcp__chrome-devtools__evaluate_script` and `mcp__chrome-devtools__take_snapshot` on 2026-05-19 against the live homepage. Full capture artifacts (snapshot, screenshot, evaluate-script JSON output) are archived in the originating Notion analysis page [Analysis: Macro (macro.com) × Minsky](https://www.notion.so/365937f03cb481e0b19bfeeae10b033e); see its `## Captured` section for the verbatim DevTools output. The mt#1945 commit message also captures the full incident chain. Future readers verifying the technical details should re-capture against the current live site rather than treating the values below as canonical — the site evolves; the methodology does not.

### Captured (2026-05-19)

- Top nav: `Github` (links to `macro-inc/macro`), `Pricing`, `Login`, `BOOK DEMO`, `TRY FOR FREE`. Minimal — no `PRODUCT`, `FEATURES`, `CUSTOMERS`, `BLOG`.
- Opening sequence: `FOUNDER STORY` eyebrow → blockquote: _"We used to have 157 Slack channels and constant mixed signals. Now we have a unified cadence."_ — Jacob Beckerman, CEO / Product Designer → `HOW MACRO USES MACRO` (founder-dogfood frame).
- **No H1 on the homepage.** The brand-mark `Macro` appears as an image only; H2 is _"It all works as a single system."_, H3 is _"Macro is the operating system for your startup."_
- Stage selector → pricing: _"Macro accelerates your startup from [idea ▾ / pre-seed / seed / Series A / growth] to IPO."_ Single price: $100 / month, up to 3 seats. No tier ladder.
- 4 `<video>` elements with named-founder/CTO testimonials (Mark Evgenev/Desync; Teo Nys/CTO). 1 `<canvas>`. 44 `<svg>`. 2023 total DOM nodes (moderate density — less sparse than Factory's 858).
- Feature card eyebrows (all caps): `VIDEO CALLS`, `EMAIL, MESSAGES & AGENTS`, `TEAM-LEVEL MEMORY`, `ALL IN ONE`, `LAUNCHER`, `TASKS`, `SHORTCUTS`. Bodies are short prose, not bullet lists.
- Launcher actions: _"Send a message, spawn an agent, draft an email, start a video call, create a task."_ — agent-spawn-as-keystroke-action as a first-class verb.
- Signal/Noise framing on the inbox card: _"Every ping goes into one inbox, split into `SIGNAL` and `NOISE`."_
- Comparison strip linking to long-form essays: _Quieter than Slack_, _Simpler than Notion_, _Faster than Superhuman_, _Lighter than Linear_.
- Typography: semantic font tokens `font-family: display` (H2/H3, weight 410, 44px, letter-spacing −0.66px / ~1.5%, line-height 52.8px) and `font-family: body` (16px body, 14px nav weight 600). Also `rajdhani` (geometric techno-display) for incidental UI, `Courier New` for CMD-key glyphs.
- Color: `oklch(0.14 0 59)` background (very dark, hue 59 / warm yellow-orange tint — warm-near-black, not industrial-cold or neutral). Text `oklch(0.9 0 59)`. Accent `oklch(0.76 0.18 59)` (saturated amber / signal-orange). Secondary `oklch(0.65 0.26 47)` red-orange, `oklch(0.77 0.17 64)` warm gold.
- BSL→AGPL license; public `agents/` and `.claude/` (commands + skills + settings.json) directories committed; they dogfood Claude Code.
- $30M total raised, led by a16z (Series A Nov 2024); NYC; SolidJS + Rust stack; SOC 2 Type II + ISO 27001.

### Denotation

Warm-dark page (`oklch(0.14 0 59)`), brand-mark as image only (no H1 text), all-caps micro-eyebrows over short-prose feature bodies, four founder/customer testimonial videos as the primary visual content, a comparison strip linking to four "What We Learned from X" essays, a stage-selector dropdown that pins pricing to startup growth stage, single $100 / 3-seat price, semantic-token typography (`display` / `body`) with a custom weight (410), the `SIGNAL` / `NOISE` inbox-split as an explicit named feature, and `spawn an agent` as one of five first-class launcher verbs.

### Connotation

- Warm-tinted dark (hue 59) → atelier, lamp-light, founder's room. Not Factory's cold industrial-black; not Cursor's neutral-near-black.
- Custom semantic font tokens + custom weight (410) → in-house typography system, not commodity Geist/Inter pulled off the shelf.
- Brand-mark as image with **no H1** → typographic restraint as taste-signal.
- Four founder / customer videos as hero content → people-and-relationships register, not product-screenshot register. Trust built from named founders, not feature lists.
- Comparison-strip-to-essays → "we read the canon and have a position on it." Intellectual posture.
- Stage selector → pricing → mirror; "we know your stage."
- Single $100 / 3-seat price → confidence by absence of tier ladder.
- ALL-CAPS micro-eyebrows → broadcast / signage / signal-grade.
- Mono CMD+K glyphs + `Courier New` → "used with hands on the keyboard."
- `Github` in primary nav + BSL→AGPL public repo + `agents/` + `.claude/skills/` → "we are not a black box; you can read us; we dogfood Claude Code."
- Founder titles foreground design (`CEO / Product Designer`) → the artifact carries the founder's signature.
- Amber/orange-on-warm-black accents → command-room / mission-ops register (Bloomberg-terminal-adjacent, warmed).
- `SIGNAL` / `NOISE` capitalization → cybernetics-vocabulary borrowed as positioning lexicon.

### Myth

_"Founders build a single environment for their team — including the AI agents — and that environment is what makes the team coherent."_

The brand naturalizes the proposition that team identity is **constituted by** the substrate the team operates inside, not assembled from independent SaaS products via a tool-stack. Choosing Macro is choosing a kind of team. "Agents as team members" is naturalized as already-decided rather than argued for.

The README's framing — _"There are many good products, but nothing works together. So, we rebuilt everything from scratch, from first principles"_ — is the substrate-as-coherence-mechanism thesis: individual products acknowledged as good; the failure is in the seams between them; Macro removes the seams by collapsing the substrate.

### Peirce read

- Founder / customer videos with attributed quotes = **indexical** (the named CEO actually said that; faces and company names point to real customers).
- Stage selector → pricing card = **iconic** (literally resembles the founder's "where am I in the journey?" check).
- "Quieter than Slack / Simpler than Notion / Faster than Superhuman / Lighter than Linear" = **symbolic** (shared cultural knowledge of what each brand represents; no resemblance / no causal link).
- ALL-CAPS micro-eyebrows = **symbolic** (broadcast / signage convention).
- Mono CMD+K glyphs = **iconic** (mono font resembles the keys it points to).
- Brand-mark image-only, no H1 = **symbolic** (typographic restraint as a learned cultural convention).
- "Operating system" phrase = **symbolic** (learned cultural framing of OS-as-substrate-that-defines-environment).
- $30M a16z + ISO 27001 + SOC 2 badges + named-CTO quotes = **indexical** (real funding, real audit, real customers).
- Public source + SolidJS-and-Rust disclosure + 2-years-of-dogfooding framing = **indexical** (the code is there; the long timeline points to real conviction).

### Cultural codes invoked

- _Founder-OS / hacker-founder atelier_ (Linear early-Karri-Saarinen era, Superhuman, Tailscale, Notion founding era) — founder-as-designer's taste IS the product positioning.
- _Office-suite seriousness, reframed_ (Microsoft Office / Notion-OS / Coda / Quip / Bench) — "one app for all of work" code stripped of enterprise-tech aesthetic and re-skinned in designer-tech aesthetic.
- _Open-core credibility_ (Linear, Cal.com, Plausible, Supabase, Ghost) — BSL→AGPL + public source signal "credible engineers, not just marketers."
- _Designer-founder authorship_ (Karri Saarinen / Ivan Zhao / Rahul Vohra) — `CEO / Product Designer` titles are a tell.
- _Quietness / focus / signal-vs-noise_ (Superhuman, Things, iA Writer, Linear) — "we deliberately remove" register opposing maximalism.
- _Cybernetics-lexicon-as-positioning_ (emerging code; Macro and Minsky are both touching it) — SIGNAL/NOISE, unified cadence, attention-allocation vocabulary as positioning surface.

### Bridge-as-affect read

Macro is making the emergent claim "agents are team members in a substrate that determines team identity." It bridges through residual codes: office-suite seriousness (Microsoft/Notion-OS), founder-OS taste-signal (Linear/Superhuman), cybernetics vocabulary (SIGNAL/NOISE / unified cadence). The right reader (a founder whose team already includes Cursor / Claude Code / Devin / Replit agents) recognizes the borrowings as taste-signals and arrives at the destination claim as a conclusion they reached themselves.

---

## The three-idiom synthesis

| Dimension                 | Idiom A (Composio)                                | Idiom B (Cursor, Factory)                                                          | Idiom C (Macro)                                                               |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Hero motion               | WebGL shader + multi-system orchestration         | Static or near-static (Factory's rotating gear is the maximum)                     | Embedded testimonial videos (4) + minimal canvas (1)                          |
| Hero alignment            | Centered                                          | Left caption + right product screenshot                                            | Founder-quote sequence → stage-selector → pricing card                        |
| Hero typography           | 64px paid grotesque (abcDiatype), centered        | Small-and-restrained (Cursor 26px) or large-and-tight (Factory 60px), left-aligned | 44px semantic-token display with custom weight (410); H1 absent               |
| Color                     | Multi-color saturated tiles (blue/pink/cyan/teal) | Monochrome dark + one accent (Factory's orange)                                    | Warm-tinted dark (`oklch(0.14 0 59)`) + amber/gold accents — atelier register |
| Customer/co-product logos | 1,000+ grid (vastness signal)                     | Single muted row (curation signal)                                                 | Named-founder/CTO testimonial videos (no logo wall)                           |
| Section pattern           | Sticky numbered nav + colored panels              | Alternating left/right product screenshots                                         | Comparison strip linking to long-form essays                                  |
| Social proof              | Anonymous use-cases + abstract diagrams           | Named individuals (Cursor) or large-enterprise logos (Factory)                     | Named CTOs of small startups (peer-founder authority, not enterprise gravity) |
| Sells                     | Concept                                           | The actual product                                                                 | The founder's philosophy                                                      |
| Used when                 | Product is invisible plumbing                     | Product has UI worth showing                                                       | Product is multi-surface AND the founder's taste IS the differentiation       |

**Decision drivers (revised, three idioms):** Idiom A when the product is invisible plumbing (Composio's choice — the integration layer has no coherent UI to display). Idiom B when the product has UI worth showing (Cursor's IDE, Factory's CLI). Idiom C when the product is multi-surface (chat + tasks + email + docs + calls + agents — no single screenshot represents it) AND the buyer is another founder who reads essays (Macro's choice; Linear's founding-era choice; Superhuman's choice).

**Minsky's category placement (revised):** likely **Idiom C** (founder-essay), not Idiom B. The earlier B-placement was based on the binary A/B framing and on Minsky's product surfaces (CLI, MCP tool calls, cockpit, reviewer-bot comments, task graph, memory recall) being visually interesting. Those surfaces _are_ interesting, but they are **multi-surface** — Minsky has at least six distinct UIs across CLI / MCP / cockpit / reviewer / memory / tasks, and no single screenshot represents the product. That structural fact aligns Minsky with Macro's situation, not Cursor's (Cursor IS the IDE; one screenshot is sufficient). Idiom C's founder-essayist register matches Minsky's existing position-paper corpus (Notion vision / insights / position papers / companion principles — the canon is already written). The shift from B to C is provisional pending the mt#1945 design-workshop pass; it should be re-evaluated when the Cockpit becomes a single dominant surface (which may collapse the multi-surface objection).

---

## Implications for Minsky positioning

The five already-occupied AI-product / AI-adjacent cultural codes (revised 2026-05-19 to include Macro's claim):

- _Consumer-tech polish_ — claimed by Composio
- _Serious IDE / developer tool_ — claimed by Cursor
- _Industrial infrastructure_ — claimed by Factory, Railway, Render
- _AI futurism_ — claimed by OpenAI, Anthropic, Mistral
- _Founder-OS / hacker-founder atelier_ — claimed by Macro (and historically Linear founding-era, Superhuman, Tailscale, Notion founding era)

Two codes are emerging or contested:

- _Cybernetics-lexicon-as-positioning_ (SIGNAL/NOISE / attention / unified cadence vocabulary) — Macro is touching it from the productivity-suite side; Minsky is operating _underneath_ it from the substrate side. Same vocabulary, different floors.
- _Mission-control / instrument-panel_ — still unclaimed in the AI-tool category. Exemplars outside it: Bloomberg Terminal, NASA mission-ops, ATC scopes, oil-rig SCADA, Palantir Gotham. The code's vocabulary — cockpit, dashboard, attention allocation, asks, status, alarms, dispatch, escalation — is _already_ the vocabulary Minsky's corpus uses. **Macro's arrival in founder-OS accelerates the strategic value of claiming mission-control** — that whitespace is the one Minsky can plausibly own, and it's adjacent enough to Macro's warm-amber register that a colder SCADA / control-room differentiation is the obvious move.

Claiming the mission-control code for Minsky is not retrofitting. The corpus is already there. The visual register is the surface that needs to catch up.

**Macro-specific gap and Minsky's defensible response (added 2026-05-19):**

- The `SIGNAL` / `NOISE` framing is now claimed by Macro at the marketing surface. Minsky's defensible move: raise the abstraction — Macro's inbox-split is one stage of Minsky's 8-stage Ask lifecycle (per mt#1034). Don't re-litigate the binary frame; name the floor-difference.
- The `agents-as-team-members` framing is naturalized by Macro. Minsky should shift the unit of analysis from team to principal: Macro is the **team substrate** (3-seat-priced; founder + small team); Minsky is the **principal substrate** (the one technical leader's cognitive surface across many agents). The principal-vs-team axis is a defensible positioning differentiator — Macro can't pivot to it without abandoning its pricing model and founder-OS code.
- The `comparison-strip-to-essays` pattern (Macro's _Quieter than Slack / Simpler than Notion / Faster than Superhuman / Lighter than Linear_) is a credibility move worth borrowing. Minsky's natural canon: Cursor, Claude Code, Devin, LangGraph, Cognition. The position-paper corpus has the raw material; surfacing it under a public essay-index is the missing piece.

---

## Template for future analyses

When analyzing a new adjacent product's marketing site:

1. **Open the site in Chrome DevTools MCP.** Capture hero + 2-3 scroll states + any cursor-reactive interaction states. Inspect typography (font family / weight / size / tracking) and color tokens via `evaluate_script`. Check for canvas/WebGL elements.
2. **Pull positioning copy verbatim.** Hero headline, subhead, section headers, CTAs, customer-logo list, pricing tier names (if any), nav register.
3. **Write the six sections in order:**
   - Captured (artifacts + screenshots)
   - Denotation (literal content)
   - Connotation (cultural associations)
   - Myth (single declarative sentence; the proposition being naturalized)
   - Peirce read (classify principal signs as icon / index / symbol)
   - Cultural codes invoked (per Oswald; cite exemplars)
4. **Compare to the three-idiom synthesis** (Idiom A motion-decorated-infographic / Idiom B product-screenshot-dominant / Idiom C founder-essay). Which idiom does the site operate in? Which cultural codes does it claim? Which does it explicitly reject?
5. **Note the implication for Minsky.** Does this analysis change the recommended cultural-code lane for Minsky? Does it open or close a white-space code? If yes, update the cultural-code table in [`minsky-brand`](../../minsky-brand/SKILL.md) §4 (the brand-foundation source of truth; was previously in `marketing-site-design` §5 before mt#1933 extraction).
6. **Apply the Pepsi/Arnell discipline.** When stating the myth, verify it is grounded in the actual visual evidence captured, not constructed post-hoc to make a tactical recommendation sound principled.

The 2026-05 analysis (Composio / Cursor / Factory / Macro) is the canonical four-way instance of this template. Future instances should follow the same shape; archive them in this directory with date-stamped filenames (e.g., `case-studies-2026-08.md`).
