# Brand system — operational reference

Concrete tokens (typography, color, motion), vocabulary inventory, and anti-pattern list for any surface that renders the Minsky brand: the marketing site (mt#1934), cockpit (mt#1935), README and `docs/*` refresh (mt#1936), and any future channel.

The _why_ lives in the position paper — [Principal Substrate: Minsky as a recursive principal-substrate](https://www.notion.so/365937f03cb481e78fd5e0594a6507c1). This doc is the _how_: the implementation tokens that put the brand on a surface without re-deriving the thesis each time.

## Locked register (one-line summary)

**Cyberbrain / Section 9.** Autonomous-flock cybernetic substrate that extends a principal's cognition, rendered as a serious operational profession. Five-layer reference architecture (none literal): GitS SAC (primary) + Evangelion (backline) + Mitsuo Iso (texture) + Magilumière Magical Girls Inc. (tonal lock) + Stross _Accelerando_ / Manfred Macx (literary). Worked example: [`.claude/skills/marketing-site-design/references/minsky-myth-2026-05.md`](../.claude/skills/marketing-site-design/references/minsky-myth-2026-05.md). Strategic framing: [Principal Substrate](https://www.notion.so/365937f03cb481e78fd5e0594a6507c1).

## Reference use and trademarks

The cited franchises and works (Ghost in the Shell, Stand Alone Complex, Neon Genesis Evangelion, Mitsuo Iso's _Orbital Children_ and _Dennō Coil_, Magilumière Magical Girls Inc., Stross's _Accelerando_, and others) are referenced nominatively for cultural-code recognition only. No affiliation, sponsorship, or endorsement is claimed. All trademarks belong to their respective owners. Surface implementations must follow the bridge-as-affect discipline in §5 — atmospheric register, never literal depiction.

## Upstream sources

- **Thesis:** [Position: Principal substrate vs team substrate](https://www.notion.so/365937f03cb481e78fd5e0594a6507c1) — why Minsky is a recursive principal-substrate, not a team tool.
- **Corpus:** mt#1930 — pee_zombie principal-corpus indexed under the `principal-corpus` namespace. Query with `mcp__minsky__principal_corpus_search` / `principal_corpus_similar`. Synthesized memeplex memories tagged `principal-thinking`, `principal-corpus`, `theme:*` (exocortex, cybernetics, ego-plurality, egregore, magick-as-substrate, agency, decentralization, memetics, consciousness-as-infrastructure, cognitive-economics, cognitive-flexibility, cognitive-hazard, process-ontology, consciousness). Queryable via `mcp__minsky__memory_search`.
- **Workshop:** [`.claude/skills/marketing-site-design/`](../.claude/skills/marketing-site-design/) — myth-first methodology + §8 (Minsky-specific layer) + worked example in `references/minsky-myth-2026-05.md`.
- **Voice:** [`.claude/skills/pz-voice/SKILL.md`](../.claude/skills/pz-voice/SKILL.md) — the principal's literary voice as the signal layer of the brand identity.

**Access and archival.** The Notion page (Minsky workspace) is private; principals with workspace access can read directly, others should request export. The `~/Projects/minsky-site` path in §7 is a local-only working tree until mt#1934 ships the public site; treat it as an out-of-repo reference, not a clonable URL.

## 1. Typography

| Role                                                                                                                                    | Family                                                      | Weight        | Notes                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------- |
| Display + body                                                                                                                          | **Geist** (Vercel-published, free)                          | 400 (regular) | Bold-at-large reads marketing-y; light reads confident. Tight tracking.      |
| Eyebrows + structural labels + code                                                                                                     | **JetBrains Mono**                                          | 400 / 500     | Caps for eyebrows; sentence case for code.                                   |
| System-speaks surfaces (places where Minsky itself talks: reviewer-bot output, memory recall, system messages, agent-identity overlays) | **Berkeley Mono** (preferred) _or_ **IBM Plex Mono italic** | 400 italic    | Slightly warmer mono — channels the Magi terminal aesthetic from Evangelion. |

### Font licensing and fallback stacks

- **Geist** — SIL Open Font License 1.1 (open). Self-host or load from Google Fonts / Vercel's CDN.
- **JetBrains Mono** — SIL Open Font License 1.1 (open). Self-host or load from Google Fonts.
- **IBM Plex Mono** — SIL Open Font License 1.1 (open). Self-host or load from Google Fonts. **Required default** for open-source / public-bundle surfaces.
- **Berkeley Mono** — paid commercial license; not redistributable. Use only on surfaces where the principal owns a license and self-hosts. Open-source surfaces must fall back to **IBM Plex Mono italic**.

Required CSS fallback stacks for any surface:

```css
--font-sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono:
  "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
  "Courier New", monospace;
--font-warm-mono:
  "Berkeley Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
```

### Sizing (starting scale; surfaces refine)

| Token     | Px    | Tracking                       | Use                                  |
| --------- | ----- | ------------------------------ | ------------------------------------ |
| `display` | 60–80 | -2% to -5% (≈ -2.88px at 60px) | Hero headlines, landing sections.    |
| `h1`      | 36–48 | -2%                            | Page titles.                         |
| `h2`      | 24–32 | -1%                            | Section headings.                    |
| `h3`      | 18–22 | 0                              | Sub-section headings.                |
| `body`    | 16–18 | 0                              | Paragraph text.                      |
| `small`   | 13–14 | 0                              | Captions, footnotes.                 |
| `eyebrow` | 11–13 | +4% to +8% (caps)              | Section markers, nav, status labels. |
| `code`    | 14–15 | 0                              | Inline + block code.                 |

### Rules

- **Tracking on display.** Roughly -2% to -5% of font size for any glyph ≥ 32px. Factory's measured value (-2.88px at 60px) is the calibration point.
- **All-caps for structural labels only.** Nav items, eyebrows, numbered section markers. Never for body or headlines.
- **Sentence case** everywhere else. Present tense. No exclamation marks.
- **Avoid the AI-slop trifecta:** Inter + Roboto + Lucide icons. If a layout is reaching for these defaults, the brand has not been applied. See §6 (Anti-patterns).
- **Interactive eyebrows** (when an eyebrow is a clickable label, nav item, or status pill) must keep ≥ 24px line-height and a ≥ 44px tap-target (per WCAG 2.5.5 / Apple HIG); pad the hit area rather than scaling the glyph.

## 2. Color

The palette is grounded in cybernetic-ops register: near-black ground, near-white text, cyan signal, amber→NERV-red for warnings, Iso pastels reserved for companion-personality surfaces.

| Token             | Hex       | OKLCH                    | Use                                                                                                                                                                        |
| ----------------- | --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bg.base`         | `#020202` | `oklch(0.078 0 0)`       | Default background — Factory's pure black, also Section 9 ops register.                                                                                                    |
| `bg.warm`         | `#14120B` | `oklch(0.142 0.012 95)`  | Optional slightly-warm dark (Cursor reference). Use for surfaces that need to feel "lived in" rather than clinical.                                                        |
| `bg.elevated`     | `#0E0E0E` | `oklch(0.155 0 0)`       | One step above `bg.base` — cards, modals, raised panels.                                                                                                                   |
| `text.primary`    | `#EEEEEE` | `oklch(0.946 0 0)`       | Near-white body text.                                                                                                                                                      |
| `text.muted`      | `#A3A3A3` | `oklch(0.717 0 0)`       | Secondary text, captions, metadata.                                                                                                                                        |
| `text.subtle`     | `#6B6B6B` | `oklch(0.517 0 0)`       | Tertiary text, deemphasized labels.                                                                                                                                        |
| `signal.cyan`     | `#00BFD8` | `oklch(0.745 0.124 215)` | **Primary accent.** Active status, links, sync indicators, "live" dots. Section 9 ops palette.                                                                             |
| `signal.cyan.dim` | `#0080A0` | `oklch(0.560 0.092 220)` | Cyan for less-urgent uses (hover-off states, secondary highlights).                                                                                                        |
| `warn.amber`      | `#F59E0B` | `oklch(0.756 0.180 70)`  | Warning state, attention-required, soft alerts.                                                                                                                            |
| `warn.red`        | `#DC2626` | `oklch(0.585 0.219 27)`  | Hard warning, hook denials, blocked actions, escalation alerts. NERV-warning end of the spectrum. Use sparingly.                                                           |
| `iso.pastel`      | `#F5E6D3` | `oklch(0.911 0.030 75)`  | Iso-pastel warmth. **Reserved** for surfaces where an agent's companion-personality is being shown (agent identity indicators, "ghost" overlays). Never as primary accent. |

### Source-of-truth, derivation, and gamut

- **OKLCH is canonical; hex is derived.** When a surface adopts these tokens, generate the sRGB hex (and any HSL form needed for legacy CSS) from the OKLCH values, not the other way around. This prevents perceptual drift across surfaces.
- **Conversion tooling.** Use [`culori`](https://culori.js.org/) (`culori.formatHex(culori.oklch({ ... }))`) or [`colorjs.io`](https://colorjs.io/) (`new Color("oklch", [L, C, H]).to("srgb").toString({ format: "hex" })`). Both implement the CSS Color Level 4 spec and produce identical results within rounding tolerance.
- **The values in the table above are starting points** rounded to 3 decimals (lightness/chroma) and integer hue, derived from the principal's anchor hex values listed in the same row. Downstream surfaces (mt#1934, mt#1935) may refine via measured conversion + display-gamut clipping; commit any refinement back to this table so all surfaces stay in sync.
- **Gamut clipping.** Surfaces rendering on wide-gamut displays (P3, Rec.2020) may render OKLCH values that fall outside sRGB. The fallback hex is intentionally clipped to sRGB; if a surface targets P3, allow the OKLCH value to render directly.
- **Browser support floor.** `oklch()` requires Chrome 111+, Safari 16.4+, Firefox 113+. Surfaces supporting older engines must ship sRGB hex (or HSL) fallback values. CSS's `var()` fallback **does not** apply when the resolved value is unsupported (it only applies when the variable itself is missing/invalid), so use one of:

```css
/* Pattern A — cascade duplicate declarations (older browsers take the last valid one) */
.text-primary {
  color: #eeeeee;
  color: oklch(0.946 0 0);
}

/* Pattern B — gate with @supports */
.text-primary {
  color: #eeeeee;
}
@supports (color: oklch(0 0 0)) {
  .text-primary {
    color: oklch(0.946 0 0);
  }
}

/* Pattern C — two custom-property declarations; hex first as legacy fallback, OKLCH last so it wins in modern engines (and is invalid + skipped in legacy engines) */
.text-primary {
  color: var(--text-primary-hex); /* legacy fallback */
  color: var(--text-primary-oklch); /* preferred when supported */
}
```

### Contrast targets (WCAG 2.2 AA)

The palette satisfies these floors on `bg.base` (`#020202`); surfaces must re-verify when composing on `bg.warm` or `bg.elevated`.

| Foreground                                   | Background | Required                       | Notes                                 |
| -------------------------------------------- | ---------- | ------------------------------ | ------------------------------------- |
| `text.primary` (body text ≥ 16px)            | `bg.base`  | ≥ 4.5:1                        | `#EEEEEE` on `#020202` ≈ 18.9:1 ✓ AAA |
| `text.muted` (large text ≥ 18px / 14px bold) | `bg.base`  | ≥ 3:1                          | `#A3A3A3` on `#020202` ≈ 8.7:1 ✓ AAA  |
| `text.subtle` (UI components, decorative)    | `bg.base`  | ≥ 3:1                          | `#6B6B6B` on `#020202` ≈ 3.9:1 ✓ AA   |
| `signal.cyan` (link / active state)          | `bg.base`  | ≥ 4.5:1 (link text) / 3:1 (UI) | `#00BFD8` on `#020202` ≈ 9.0:1 ✓ AAA  |
| `warn.amber` (warning text)                  | `bg.base`  | ≥ 4.5:1                        | `#F59E0B` on `#020202` ≈ 9.1:1 ✓ AAA  |
| `warn.red` (escalation text)                 | `bg.base`  | ≥ 4.5:1                        | `#DC2626` on `#020202` ≈ 4.6:1 ✓ AA   |

Measurement method: WCAG 2.2 relative-luminance ratio on sRGB. Re-verify with [`@adobe/leonardo-contrast-colors`](https://leonardocolor.io/) or browser DevTools' contrast picker when porting to a new surface. **Do not** ship a token combination below the listed floor.

### Rules

- **Hex is the surface format; OKLCH is the canonical token format.** Render values in OKLCH for any new design system (`oklch()` is supported in modern browsers and gives perceptually-uniform tuning). Cockpit currently uses HSL (`src/cockpit/web/index.css`); mt#1935 migrates cockpit tokens onto this palette in OKLCH.
- **One accent. Two warning tiers. One pastel reserved.** That's the budget. The brand reads coherent because the palette is narrow.
- **Reject multi-color saturation.** Composio's blue + pink + cyan + green is the anti-pattern. Adding a fifth accent erodes the cybernetic-ops register.
- **Iso-pastel is companion-personality territory only.** If a surface uses pastel without showing an agent-as-companion, drop it.

## 3. Motion

Motion is signal infrastructure, not decoration. The budget is "ambient identity-level" — small, recurring, never-shaders.

### Permitted motion

| Pattern                          | Where                                                    | Spec                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Wordmark micro-rotation**      | Site-wide identity surface (header, hero)                | Single ambient rotation on one glyph or symbol. Factory's spinning gear precedent. ~6–12s per rotation, easing `cubic-bezier(0.4, 0.0, 0.2, 1)`.                   |
| **Sync-gauge motif**             | Recurring micro-instrument for principal-flock coherence | A small ring or arc whose fill represents sync-rate. Eva-coded without depicting the cockpit. Animate to current value over ~400ms ease-out on change; idle still. |
| **Scroll-driven section reveal** | Marketing site sections                                  | Single fade-in per section as it enters viewport. ~200–300ms ease-out. One per section, no chained per-element staggers.                                           |
| **Status-dot pulse**             | "Live" indicators on real product data                   | Subtle opacity pulse (0.6 → 1.0 → 0.6) over ~1.6s. Only when the dot reflects actual live state (not decorative).                                                  |
| **Hook-denial flash**            | Cockpit / reviewer-bot surfaces                          | One-shot amber→base fade on a denial event. ~600ms. Never repeating.                                                                                               |

### `prefers-reduced-motion`

**Required.** Hook `useReducedMotion()` (React) or its equivalent and zero out every motion in the table above when the user has opted out. Concrete defaults:

- All transitions > 100ms become instant (duration 0).
- Continuous animations (wordmark rotation, status-dot pulse) stop on the current frame; static value remains visible.
- Scroll-driven reveals: content renders immediately at final state — no fade, no offset.
- Sync-gauge: render the final value directly; do not animate to it on change.
- Hook-denial flash: replace with a static amber border or text colour for ~600ms then revert (visual signal without motion).

**Test matrix.** Before shipping any surface, verify reduced-motion on:

- macOS — System Settings → Accessibility → Display → Reduce motion.
- Windows — Settings → Accessibility → Visual effects → Animation effects (off).
- iOS — Settings → Accessibility → Motion → Reduce Motion.
- Android — Settings → Accessibility → Color and motion → Remove animations.

The CSS query `@media (prefers-reduced-motion: reduce) { ... }` and the React hook `useReducedMotion()` from Motion (formerly Framer Motion) both honor each OS setting above.

### Rules

- **No decorative shaders or WebGL.** They signal Idiom A (the "everything moves" AI-tool aesthetic). The site is Idiom B — product-screenshot dominant.
- **No multi-system orchestrated motion.** Liveness comes from real instrumentation, not from continuous animation choreography.
- **No looping background gradients, animated noise, parallax layers, or particle systems.** Identity motion is _small and few_, not _constant and many_.

## 4. Vocabulary inventory

Locked 2026-05-19. Specific terms the brand can use; sources cited so consumers know the layer each term is drawn from.

| Term                           | Source                       | Use                                                                                                      | Don't                                                                             |
| ------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Cyberbrain**                 | Ghost in the Shell           | Category name. _"The cyberbrain for software organizations led by a principal."_                         | Don't pluralize as "cyberbrains" in marketing copy.                               |
| **Stand Alone Complex**        | Ghost in the Shell: SAC      | Operating principle for the mesh — independent agents converging on coordinated behavior. Use sparingly. | Don't flag-wave the reference; if a reader needs the citation explained, cut it.  |
| **Sync rate** / **sync ratio** | Evangelion                   | Metric vocabulary for principal-flock coherence. Use as a recurring instrument motif.                    | Don't over-personify ("the agent's mood is at 73%").                              |
| **Section**                    | Ghost in the Shell           | Unit-of-operation noun. _"A Section runs a specific workstream."_                                        | Don't capitalize mid-sentence unless naming a specific Section.                   |
| **Flock**                      | Stross, _Accelerando_        | The multi-agent unit. Direct borrow from Manfred Macx.                                                   | Don't confuse with "swarm" or "herd" — flock is intentional and coordinated.      |
| **Ghost**                      | Ghost in the Shell           | Philosophical-continuity sense — the principal's continuity of self through substrate.                   | **Never the spooky sense.** Don't use for haunted-system framing.                 |
| **Servitor**                   | Operative Ontology corpus    | Footnote-only in foreground. Manifesto / About-page register.                                            | Don't surface on landing pages; reads as occult to engineers.                     |
| **Substrate**                  | Eugene's existing vocabulary | The thing Minsky is. Already canonical; heavy use is fine.                                               | —                                                                                 |
| **Principal**                  | Minsky vocabulary            | The agent's primary — the human whose cognition Minsky extends.                                          | Don't substitute "user," "operator," or "customer" in brand-register copy.        |
| **Mesh**                       | Minsky vocabulary            | The coordination substrate.                                                                              | Don't conflate with "graph" — the mesh is operational, not just a data structure. |

### Voice rules

- **Magilumière tonal lock.** Brand voice is the _agency_ operating the cybernetic-magickal substrate, not the _protagonists_. Serious B2B operational platform; the whimsy stays at the reference layer. The surface is professional.
- **Macx prose for manifesto / About / position-paper surfaces.** Terse, technically loaded, presupposing reader literacy. Sentences that assume the reader already knows.
- **Section headlines: three to four words, conceptual.** Examples to noodle on: _"Tasks that converge."_ / _"Reviews that hold."_ / _"Memory that compounds."_ / _"Attention that allocates."_ / _"Hooks that catch."_
- **Sentence case. Present tense. No exclamation.**
- **Peer-to-peer, not vendor-to-buyer.** The reader is a principal; address them as one.
- **Reject SaaS hyperbole.** No _"the future of,"_ _"transforms your,"_ _"supercharge your,"_ _"from your first X to your IPO."_

For full voice register (cadence, rhythm, characteristic moves), see [`pz-voice` skill](../.claude/skills/pz-voice/SKILL.md).

## 5. Bridge-as-affect — applied to Minsky

The cyberbrain / Section 9 register is an _emergent_ cultural code with no current AI-tool category instantiation. Per the marketing-site-design skill (§3 Bridge-as-affect), the discipline is to invoke the emergent code through _residual_ codes the audience already recognizes — without going literal.

### What goes on the surface

- Typography that pattern-matches GitS Section 9 ops register: mono eyebrows + light grotesque body.
- Color palette that pattern-matches Section 9 + Eva: near-black + cyan signal + amber/NERV-red warning.
- Magi-aesthetic warmth in _system-speaks_ surfaces (Eva-coded but never depicting Eva).
- HUD-style status overlays in product screenshots (cyberbrain-link aesthetic, not labeled).
- Sync-rate gauges as a recurring micro-instrument (Eva-coded without depicting the cockpit interior).
- Iso-pastel softness in agent-companion surfaces (Iso-coded without depicting characters).
- Macx-register prose in manifesto / About copy (literary register without quoting _Accelerando_).
- Magilumière-style "this is a serious profession" tonal seriousness (without any magical-girl imagery).
- A literary epigraph (possibly from Macx) naming the flock proposition. One per site, not many.
- Stand Alone Complex as a named operating concept the brand can claim (carefully, not as flag-waving).

### What never appears

- Literal Tachikomas, Major Kusanagi, Section 9 characters, or any GitS still frames.
- Eva units, Shinji / Asuka / Rei, NERV terminal imagery.
- Magical girls, Magilumière protagonists, sigils-as-pastiche.
- Iron Man / JARVIS visual cues (rejected — overdone in Instagram cloud-AI demos).
- Pacific Rim Jaeger / Drift visuals (rejected — operator unfamiliarity).
- Mecha as a visual element at the literal-character layer.
- Anime stills, anime fanart, anime stylization.
- Skynet / Terminator-coded futurism (wrong cultural code entirely).

### Point-of-decision heuristic

**Would the right reader recognize the borrowing without being told?** If yes, ship it. If you have to caption the reference for it to read, it's gone literal — cut and replace.

This is the load-bearing discipline. The reference layer is _atmospheric_; surface depiction belongs to the product itself (real CLI output, real cockpit screenshots, real reviewer-bot comments). The substrate happens to be cybernetic-magickal; the brand never _announces_ that.

## 6. Anti-patterns (named, reject explicitly)

| Anti-pattern                                                     | Why rejected                                                                                                    | Source / instance                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Inter + Roboto + Lucide icons trifecta**                       | The AI-slop default. If a layout reaches for these, the brand has not been applied.                             | Generic AI-product template.             |
| **Multi-color saturation** (blue + pink + cyan + green)          | Erodes the cybernetic-ops register. One accent + two warning tiers is the budget.                               | Composio.                                |
| **Centered marketing-hero**                                      | Idiom A's signature. The brand uses left-caption + right-product-screenshot, alternating.                       | Generic SaaS template.                   |
| **Sticky-numbered-nav + colored-tile-panel section pattern**     | Idiom A's signature. The brand uses progressive disclosure through scroll, not a side-rail with colored panels. | Composio, Pinecone.                      |
| **Decorative WebGL shaders / animated noise / particle systems** | Idiom A's "everything moves" register. The brand is Idiom B (product-screenshot dominant).                      | Many AI-tool landings.                   |
| **Iron Man / JARVIS visual cues**                                | Overdone in Instagram cloud-AI demos; reads as derivative.                                                      | Generic generative-AI demo aesthetic.    |
| **Pacific Rim Jaeger / Drift visuals**                           | Operator unfamiliar with the source; would be posing.                                                           | Operator preference (locked 2026-05-19). |
| **Gundam imagery**                                               | Operator unfamiliar with the source; would be posing.                                                           | Operator preference (locked 2026-05-19). |
| **Gurren Lagann exuberance**                                     | Tonal mismatch with the Magilumière professional lock.                                                          | Operator preference (locked 2026-05-19). |
| **Literal mecha imagery**                                        | Bridge-as-affect violation: borrow at the register, never at the literal-character layer.                       | Bridge discipline.                       |
| **Anime stills, fanart, or stylization**                         | Bridge-as-affect violation: the reference layer is atmospheric, never depicted.                                 | Bridge discipline.                       |
| **Skynet / Terminator-coded futurism**                           | Wrong cultural code entirely. The brand is _operational substrate_, not _adversarial AI menace_.                | Generic AI-doom aesthetic.               |

## 7. Implementation hand-off

This doc is the operational reference. The actual surfaces are owned by sibling tasks:

- **Site rebuild:** mt#1934 — applies these tokens to `~/Projects/minsky-site` (Idiom B founder-essay register).
- **Cockpit refresh:** mt#1935 — migrates `src/cockpit/web/**` color tokens from HSL to OKLCH per §2 and brings the cyberbrain register into mission-control surfaces.
- **README + docs voice refresh:** mt#1936 — top-level README and selected `docs/*` updated to the locked voice register (§4 voice rules).
- **Notion strategic-doc audit:** mt#1937 — register-consistency pass across existing position papers + RFCs.
- **Brand-foundation skill:** mt#1933 — extracts the cyberbrain register into a separately-consumable skill so `marketing-site-design` and `cockpit-design` can both depend on it.

### Cockpit token mapping (mt#1935 in-scope)

The cockpit currently uses shadcn-style HSL custom properties (`src/cockpit/web/index.css`). mt#1935 migrates these onto the brand tokens above. The mapping is roughly 1:1 with one rename and one split:

| Cockpit (HSL today)   | Brand token (OKLCH after mt#1935)              | Notes                                                                                                                            |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--background`        | `bg.base`                                      | Dark theme: `222.2 47% 4%` → `oklch(0.078 0 0)`.                                                                                 |
| `--foreground`        | `text.primary`                                 | Dark theme: `210 40% 98%` → `oklch(0.946 0 0)`.                                                                                  |
| `--card`              | `bg.elevated`                                  | Dark theme: `222.2 47% 7%` → `oklch(0.155 0 0)`.                                                                                 |
| `--muted-foreground`  | `text.muted`                                   | Slight tone shift; verify contrast after migration.                                                                              |
| `--primary` (dark)    | `text.primary`                                 | Used as button background; reassess: cockpit may want a `signal.cyan`-keyed primary instead.                                     |
| `--destructive`       | `warn.red`                                     | Direct rename.                                                                                                                   |
| `--liveness-healthy`  | (new) `liveness.healthy`                       | Keep cockpit-local liveness sub-tokens; add to the brand palette in a future revision once cockpit has settled.                  |
| `--liveness-idle`     | (new) `liveness.idle`                          | Map onto `warn.amber` range; preserve cockpit semantic if the visual differs.                                                    |
| `--liveness-stale`    | (new) `liveness.stale`                         | Map onto `warn.red` range.                                                                                                       |
| `--liveness-orphaned` | (new) `liveness.orphaned`                      | Map onto `text.subtle` range.                                                                                                    |
| —                     | `signal.cyan`, `signal.cyan.dim`, `iso.pastel` | **New**: add to cockpit during mt#1935 — used for active-status indicators, agent-identity surfaces, and sync-gauge instruments. |

For agent-consumable brand discipline, see the `minsky-brand` skill (filed under mt#1933) once it ships. Until then, the marketing-site-design skill's §8 plus this doc are the agent-facing surfaces.

## Cross-references

- **Skill:** [`.claude/skills/marketing-site-design/SKILL.md`](../.claude/skills/marketing-site-design/SKILL.md) §8 — concrete decisions from the locked code (the upstream of this doc's tokens).
- **Workshop:** [`.claude/skills/marketing-site-design/references/minsky-myth-2026-05.md`](../.claude/skills/marketing-site-design/references/minsky-myth-2026-05.md) — Steps 1–5 worked example with the five-layer reference architecture.
- **Voice skill:** [`.claude/skills/pz-voice/SKILL.md`](../.claude/skills/pz-voice/SKILL.md) — the principal's literary voice as the brand signal layer.
- **Position paper:** [Principal Substrate](https://www.notion.so/365937f03cb481e78fd5e0594a6507c1).
- **Corpus surface:** `mcp__minsky__principal_corpus_search` / `principal_corpus_similar` (mt#1930) — query the principal's five-year corpus directly. Synthesized memeplex via `mcp__minsky__memory_search` with tag `principal-thinking`.
- **Umbrella:** mt#1929 — brand workstream (this doc is child #3 / Phase 1).
- **Predecessor:** mt#1927 — locked the brand register (marketing-site-design skill bundle).
- **Cockpit color tokens:** `src/cockpit/web/index.css` (current HSL; migrates to OKLCH under mt#1935).
