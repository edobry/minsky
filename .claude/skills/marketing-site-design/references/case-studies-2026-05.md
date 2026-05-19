# Marketing-site case studies — 2026-05-19 three-way analysis

Worked example for `marketing-site-design`. Three adjacent AI-tool sites read through the Peirce-Barthes-Oswald framework. Use as the template when analyzing any future competitor or category site.

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

## The two-idiom synthesis

| Dimension                 | Idiom A (Composio)                                | Idiom B (Cursor, Factory)                                                          |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Hero motion               | WebGL shader + multi-system orchestration         | Static or near-static (Factory's rotating gear is the maximum)                     |
| Hero alignment            | Centered                                          | Left caption + right product screenshot                                            |
| Hero typography           | 64px paid grotesque (abcDiatype), centered        | Small-and-restrained (Cursor 26px) or large-and-tight (Factory 60px), left-aligned |
| Color                     | Multi-color saturated tiles (blue/pink/cyan/teal) | Monochrome dark + one accent (Factory's orange)                                    |
| Customer/co-product logos | 1,000+ grid (vastness signal)                     | Single muted row (curation signal)                                                 |
| Section pattern           | Sticky numbered nav + colored panels              | Alternating left/right product screenshots                                         |
| Social proof              | Anonymous use-cases + abstract diagrams           | Named individuals (Cursor) or large-enterprise logos (Factory)                     |
| Sells                     | Concept                                           | The actual product                                                                 |
| Used when                 | Product is invisible plumbing                     | Product has UI worth showing                                                       |

**The decision driver is whether the product has UI surfaces worth showing.** Idiom A is Composio's choice because there is no single coherent UI to display — the product IS the integration layer, which is invisible. Idiom B is Cursor and Factory's choice because the IDE, the CLI, the terminal, the dashboards are themselves the most compelling visual content.

**Minsky's category placement:** Idiom B. Minsky's product surfaces (CLI, MCP tool calls, cockpit, reviewer-bot comments, task graph, memory recall) are at least as visually interesting as Cursor's IDE or Factory's CLI. Substituting decorative motion for these surfaces would underplay what is already there.

---

## Implications for Minsky positioning

The four already-occupied AI-product cultural codes (from Section 5 of the umbrella SKILL.md):

- Consumer-tech polish — claimed by Composio
- Serious IDE / developer tool — claimed by Cursor
- Industrial infrastructure — claimed by Factory, Railway, Render
- AI futurism — claimed by OpenAI, Anthropic, Mistral

The **mission-control / instrument-panel** code is unclaimed in the AI-tool category. Exemplars exist outside it: Bloomberg Terminal, NASA mission-ops displays, ATC scopes, oil-rig SCADA, Palantir Gotham. The code's vocabulary — cockpit, dashboard, attention allocation, asks, status, alarms, dispatch, escalation — is _already_ the vocabulary Minsky's corpus uses. The marketing surface has not yet caught up to where the substrate lives.

Claiming the mission-control code for Minsky is not retrofitting. The corpus is already there. The visual register is the surface that needs to catch up.

---

## Template for future analyses

When analyzing a new adjacent product's marketing site:

1. **Open the site in Chrome DevTools MCP.** Capture hero + 2-3 scroll states + any cursor-reactive interaction states. Inspect typography (font family / weight / size / tracking) and color tokens via `evaluate_script`. Check for canvas/WebGL elements.
2. **Pull positioning copy verbatim.** Hero headline, subhead, section headers, CTAs, customer-logo list, pricing tier names (if any), nav register.
3. **Write the five sections in order:**
   - Captured (artifacts + screenshots)
   - Denotation (literal content)
   - Connotation (cultural associations)
   - Myth (single declarative sentence; the proposition being naturalized)
   - Peirce read (classify principal signs as icon / index / symbol)
   - Cultural codes invoked (per Oswald; cite exemplars)
4. **Compare to the two-idiom synthesis.** Which idiom does the site operate in? Which cultural codes does it claim? Which does it explicitly reject?
5. **Note the implication for Minsky.** Does this analysis change the recommended cultural-code lane for Minsky? Does it open or close a white-space code? Update the umbrella SKILL.md's Section 5 table if a new code emerges.
6. **Apply the Pepsi/Arnell discipline.** When stating the myth, verify it is grounded in the actual visual evidence captured, not constructed post-hoc to make a tactical recommendation sound principled.

The 2026-05 analysis (Composio / Cursor / Factory) is the canonical first instance of this template. Future instances should follow the same shape; archive them in this directory with date-stamped filenames (e.g., `case-studies-2026-08.md`).
