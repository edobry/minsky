# Cockpit design system

The declared design-system artifact for Cockpit (`src/cockpit/web/**`). Closes the gap
`docs/brand-system.md` names explicitly: that doc covers color, typography, and motion for
_any_ Minsky surface, but "not components, spacing, or interaction states" — and cockpit
shipped with no type scale at all (stock Tailwind sizes only) while the marketing site has
shipped a concrete one since mt#1934. This doc is that missing layer for cockpit.

Parent: [mt#2914](minsky://task/mt%232914) (design-system umbrella). This doc is
[mt#2915](minsky://task/mt%232915)'s deliverable — token _definitions_ only. Applying the
scale across widgets is [mt#2917](minsky://task/mt%232917)'s register-unification pass;
structural lint enforcement is a separate umbrella child.

## 1. Relationship to brand-system.md — no duplication

[`docs/brand-system.md`](brand-system.md) is the color / typography / motion source of truth
for every Minsky surface (site, cockpit, docs, future channels). This doc does not restate
those tokens — it adds the layer brand-system.md explicitly defers:

| Layer                                                                  | Owned by                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| Color palette (hex + OKLCH), WCAG floors, font families, motion budget | `brand-system.md` §1–3                                         |
| Vocabulary, bridge-as-affect, anti-patterns                            | `brand-system.md` §4–6, `.claude/skills/minsky-brand/SKILL.md` |
| Cockpit token mapping (which CSS var carries which brand token)        | `brand-system.md` §7                                           |
| **Cockpit type scale**                                                 | This doc, §2                                                   |
| **Spacing scale decision**                                             | This doc, §3                                                   |
| **Component inventory + interaction states**                           | This doc, §4                                                   |
| **Status/severity color semantics + red-scarcity boundary**            | This doc, §5                                                   |
| **Icon decision**                                                      | This doc, §6                                                   |

Minsky-domain entity conventions (task/session/changeset/PR/ask/agent display, mission-control
density, command-palette UX, drill-down nav) live in `.claude/skills/cockpit-design/SKILL.md` —
that skill is the IA/interaction layer; this doc is the token/component layer underneath it.

## 2. Type scale

Cockpit shipped with zero named type tokens — every heading and label reaches for stock
Tailwind (`text-xs` … `text-2xl`). An audit of current usage across `src/cockpit/web/`
(`grep -rhoE "text-(xs|sm|base|lg|xl|2xl)\b"`) found:

| Stock class        | Count | Role it's actually playing              |
| ------------------ | ----- | --------------------------------------- |
| `text-xs` (12px)   | 357   | captions, metadata, table cells, badges |
| `text-sm` (14px)   | 174   | primary readable content                |
| `text-base` (16px) | 8     | sub-section headings                    |
| `text-lg` (18px)   | 6     | section headings                        |
| `text-2xl` (24px)  | 1     | page title (`CardTitle`)                |

Cockpit is a mission-control dashboard, not editorial copy (`src/cockpit/CLAUDE.md` "Density as
a feature") — its real body-text size is ~14px, not the marketing site's 16px. Rather than
import the site's literal pixel values, this scale **names the roles cockpit has already
organically converged on**, mirroring the site's _technique_ (named tokens as
`line-height`/`letter-spacing` pairs, `services/site/src/styles/global.css`) at cockpit's
measured density. `display` is new — reserved for a big-stat callout (a Grafana/Sentry-style
single-number panel) cockpit doesn't use yet but the mission-control aesthetic anchor implies.

| Token     | Size             | Line-height | Letter-spacing | Maps onto (today) | Use                                                                |
| --------- | ---------------- | ----------- | -------------- | ----------------- | ------------------------------------------------------------------ |
| `display` | 2rem (32px)      | 1.1         | -0.02em        | (new, unused)     | Reserved: single big-number stat panel.                            |
| `h1`      | 1.5rem (24px)    | 1.2         | -0.01em        | `text-2xl`        | Page titles (matches `CardTitle` today).                           |
| `h2`      | 1.125rem (18px)  | 1.3         | —              | `text-lg`         | Section headings.                                                  |
| `h3`      | 1rem (16px)      | 1.4         | —              | `text-base`       | Sub-section headings.                                              |
| `body`    | 0.875rem (14px)  | 1.5         | —              | `text-sm`         | Primary readable content.                                          |
| `small`   | 0.75rem (12px)   | 1.4         | —              | `text-xs`         | Captions, metadata, table cells.                                   |
| `eyebrow` | 0.6875rem (11px) | 1.3         | +6%            | (new)             | Caps structural labels, per brand-system §1's 11–13px eyebrow row. |
| `code`    | 0.8125rem (13px) | 1.5         | —              | (new)             | Inline + block code.                                               |

Shipped as CSS custom properties in `src/cockpit/web/index.css` (`:root`, theme-independent —
typography doesn't change between light/dark) and exposed as Tailwind `fontSize` theme entries
in `tailwind.config.ts`, giving `text-display` / `text-h1` / `text-h2` / `text-h3` / `text-body`
/ `text-small` / `text-eyebrow` / `text-code` utility classes **alongside** the stock scale
(additive, not a replacement — nothing currently using `text-xs`/`text-sm`/etc. breaks).

**Explicitly out of scope here:** migrating existing widgets onto these classes. That's
[mt#2917](minsky://task/mt%232917)'s register-unification pass — this task only ships the
token definitions so that pass has something to adopt.

## 3. Spacing scale

**Decision: bless Tailwind's stock 4px-based spacing scale. No cockpit-specific spacing tokens.**

The cockpit-design skill's density model already codifies the only two spacing conventions
cockpit actually needs, built entirely from the stock scale:

- Compact row: `py-1.5 text-sm`
- Comfortable row: `py-3 text-base`

Rationale against inventing a custom scale: (1) no widget currently exhibits a spacing need the
4px scale can't express — the density audit for §2 above turned up no arbitrary-value spacing
(`p-[13px]` etc.) hits; (2) the plant board's instrument layout (tanks, gauges, valve nodes) is
pixel-precise SVG/react-flow node geometry, not a Tailwind-spacing-utility consumer, so it sits
outside this decision's scope entirely; (3) a custom spacing scale is real ongoing maintenance
cost (a second scale to keep in sync, migration surface) for zero identified gap today. If a
future widget needs a spacing value the 4px scale can't hit cleanly, revisit as a scoped
addition — don't pre-build one speculatively.

## 4. Component inventory

Existing `src/cockpit/web/components/ui/*.tsx` primitives (shadcn/ui + Radix), what interaction
states they already carry, and where a "component" cockpit visibly needs doesn't exist yet.

| Component          | Exists?                                                                                                                                                                                                                                       | Hover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Focus                                                                                                                               | Active / selected                                                                                                                                                                                                                                                                | Disabled                                                                                                                           | Loading                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Button             | `ui/button.tsx`                                                                                                                                                                                                                               | `hover:bg-*/90` per variant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `focus-visible:ring-2 ring-ring ring-offset-2`                                                                                      | n/a                                                                                                                                                                                                                                                                              | `disabled:opacity-50 disabled:pointer-events-none`                                                                                 | **Gap** — no loading variant. Convention: disable the button and prepend a `lucide-react` `Loader2` with `animate-spin`.                                                                                                                                                                                                                                                                                                                                     |
| Card               | `ui/card.tsx`                                                                                                                                                                                                                                 | none (static container)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | n/a                                                                                                                                 | n/a                                                                                                                                                                                                                                                                              | n/a                                                                                                                                | n/a — wrap contents in the shared `LoadingState`/`ErrorState` (`components/`) instead of a card-level loading prop.                                                                                                                                                                                                                                                                                                                                          |
| Badge / chip       | **No shared component.** Every status pill is hand-rolled per call site (`status-colors.ts`'s `statusStyle()` returns inline `style={}` triples; `KindBadge`/`NeedsMeBadge` in `Agents.tsx` are bespoke local components).                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                   | —                                                                                                                                                                                                                                                                                | —                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Checkbox           | `ui/checkbox.tsx` (Radix, mt#3348)                                                                                                                                                                                                            | inherits trigger surface; no separate hover fill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `focus-visible:ring-2 ring-ring ring-offset-2` (matches Button/Select)                                                              | `data-[state=checked]:bg-primary` + `Check` indicator; `data-[state=indeterminate]` renders a `Minus`                                                                                                                                                                            | `disabled:opacity-50 disabled:cursor-not-allowed`                                                                                  | n/a — reflects local UI state, not a fetch. **Separate non-interactive variant:** markdown task-list checkboxes (`- [ ] x`) are rendered by `Prose.tsx`'s `input` override as a styled `role="checkbox"` span with `aria-disabled`, deliberately NOT this primitive — markdown task state is not editable from that surface.                                                                                                                                 |
| Command (`Cmd+K`)  | `ui/command.tsx` (cmdk)                                                                                                                                                                                                                       | n/a — keyboard-driven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `aria-selected:bg-accent aria-selected:text-accent-foreground`                                                                      | cmdk conflates selected+focused (same class)                                                                                                                                                                                                                                     | `data-[disabled]:opacity-50 data-[disabled]:pointer-events-none`                                                                   | n/a — palette sources resolve before the palette opens.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Dialog             | `ui/dialog.tsx` (Radix)                                                                                                                                                                                                                       | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | close button: `hover:opacity-100 focus:ring-2 ring-ring ring-offset-2`                                                              | `data-[state=open/closed]` drives enter/exit animation                                                                                                                                                                                                                           | close button: `disabled:pointer-events-none`                                                                                       | **Gap** — no documented in-dialog loading convention. Recommend: swap `DialogContent`'s body for `<LoadingState/>` while the mutation/query is pending.                                                                                                                                                                                                                                                                                                      |
| Select             | `ui/select.tsx` (Radix, mt#3347)                                                                                                                                                                                                              | trigger: `hover:bg-muted/70`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | trigger: `focus-visible:ring-2 ring-ring ring-offset-2` (matches Button/Tabs); item: `focus:bg-accent focus:text-accent-foreground` | item: `data-[state=checked]` renders a `Check` indicator; trigger shows the selected label via `SelectValue`                                                                                                                                                                     | trigger: `disabled:opacity-50 disabled:cursor-not-allowed`; item: `data-[disabled]:opacity-50 data-[disabled]:pointer-events-none` | n/a — options are resolved before the panel opens. Disable the trigger while a dependent mutation is pending (see `TaskDetail.tsx`'s model picker). **Naming:** where a visible label span sits beside the trigger (control bars in `Agents`/`TaskList`/`Workstreams`), tie it via `aria-labelledby` + `useId` rather than duplicating the text in `aria-label`.                                                                                             |
| Tabs               | `ui/tabs.tsx` (Radix)                                                                                                                                                                                                                         | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `focus-visible:ring-2 ring-ring ring-offset-2`                                                                                      | `data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm`                                                                                                                                                                            | `disabled:opacity-50 disabled:pointer-events-none`                                                                                 | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Disclosure control | `DisclosureChevron` + `HOVER_ROW` + `BURST_CHILDREN` (`components/ConversationElementRenderers.tsx`, mt#4348). Covers the conversation view's expanders: tool row, injected span, thinking `<summary>`, command, action-burst fold.           | `hover:bg-muted/50` (`HOVER_ROW`, mt#4251) on the control's **actual hit-area**. For the four row-shaped controls that is the full-width row rather than the inner toggle — a toggle is `flex-1` and stops short of trailing siblings, so highlighting it lights part of a row meant to read as one object. **`CommandInvocation` is the deliberate exception**: its row is CONTENT and only its trailing chevron toggles anything, so the treatment covers the chevron's own box (`rounded px-1`). Widening what is clickable there would be a behaviour change, not an affordance fix. | `FOCUS_RING` — `focus-visible:ring-2 ring-ring ring-inset`                                                                          | **Chevron is LEADING, never `ml-auto`.** `▸` collapsed / `▾` expanded, `text-muted-foreground/60`. A `<summary>` host must suppress the user agent's own marker (`list-none` + `[&::-webkit-details-marker]:hidden`) — otherwise the browser draws a second, unmatched triangle. | n/a                                                                                                                                | n/a — expansion is local UI state, not a fetch. **Nested groups:** an expanded group wraps its children in `BURST_CHILDREN` (`border-l border-border/40 pl-3`), one step lighter than `RunView`'s `border-l-2` + accent, so a nested rail cannot compete with the run rail containing it. The leading chevron is what makes that indent read as depth: a trailing marker leaves every level's glyph in the same column and no indent recovers the hierarchy. |
| Table rows         | **No shared `<Table>` component.** Every list widget hand-rolls its row markup.                                                                                                                                                               | Recommended convention: `hover:bg-muted/50`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | n/a — rows aren't focusable by default                                                                                              | n/a                                                                                                                                                                                                                                                                              | n/a                                                                                                                                | Loading state goes above the row list via `LoadingState`, not per-row.                                                                                                                                                                                                                                                                                                                                                                                       |
| Pane divider       | `components/PaneDivider.tsx` (mt#3701) — draggable vertical separator; first host is the film's ribbon/stage split                                                                                                                            | seam + grip go `bg-border` → `bg-ring`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `group-focus-visible:bg-ring`; `role="separator"` with live `aria-valuenow`/`min`/`max`, arrow keys step, `Home` resets             | `data-[dragging=true]` holds the `bg-ring` state for the whole drag                                                                                                                                                                                                              | n/a                                                                                                                                | n/a — reflects a layout preference, not a fetch                                                                                                                                                                                                                                                                                                                                                                                                              |
| Scrollbar          | `index.css` `@layer base` (mt#3701, rescoped mt#4355) — `color-scheme` makes the PLATFORM's bar match the theme everywhere; `.scrollbar-readout` opts a long scroller into the token-styled bar; `.scrollbar-none` suppresses chrome entirely | thumb `--border` → `--muted-foreground`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | n/a — not focusable                                                                                                                 | thumb `--muted-foreground` while dragging                                                                                                                                                                                                                                        | n/a                                                                                                                                | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Status dot         | `lib/liveness-colors.ts` (`livenessDotClass`) + `animate-status-dot` keyframe (`index.css`)                                                                                                                                                   | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | n/a                                                                                                                                 | n/a — reflects a data value, not a UI toggle                                                                                                                                                                                                                                     | n/a                                                                                                                                | The pulse animation IS the "live" signal (per brand-system §3); a static (non-pulsing) dot means "not live," not "loading."                                                                                                                                                                                                                                                                                                                                  |

**Two real gaps this inventory surfaces** (not fixed here — token-definition scope only):

1. **No shared Badge/chip primitive.** Four widgets independently render status pills through
   `status-colors.ts`'s color triples via inline `style={}`; there is no `<Badge>` component
   wrapping that into a consistent DOM/className shape. A future task should introduce one
   (shadcn's standard `Badge` component, parameterized by the same `TaskStatus` union
   `status-colors.ts` already exports) so hover/focus states can be added in one place instead
   of per-callsite.
2. **No shared `<Table>` primitive.** Row markup, hover state, and density (compact/comfortable)
   are each hand-rolled per widget. A shared table primitive would let the compact/comfortable
   toggle (§3) live in one component instead of being re-implemented per list.

**Scrollbar decision (mt#3701, rescoped mt#4355).** Two mechanisms, and keeping them apart is the
whole of this section — mt#3701 shipped only the second and the first was what actually mattered.

**1. `color-scheme` decides what the PLATFORM draws.** `:root` declares `light`, `.dark` declares
`dark`. This is what tells the engine which scheme the document is painted in, so every control
the platform renders itself — scrollbars, `<select>` popups, date pickers, form controls,
spellcheck underlines, the canvas before first paint — comes back matching. `<html class="dark">`
drives Tailwind's `dark:` variant and says nothing to the engine, which is why its absence was
invisible for as long as it was: the cockpit computed `color-scheme: normal`, so the platform
assumed a light page. In Chromium that was masked by mechanism 2. In the tray's WebKit window,
which honors neither of mechanism 2's property sets, it was not — the macOS light-appearance
scrollbar (track ~`#f8f8f8`, thumb ~`#c1c1c1`) rendered inside a near-black surface for as long
as mt#3701 was shipped. **This mechanism reaches every engine; prefer it.**

**2. `.scrollbar-readout` REPLACES the platform's bar with ours.** Thin, `--border` at rest,
`--muted-foreground` on hover, transparent track, no stepper buttons, always visible. Two
properties of it worth knowing before applying it:

- **The thumb stays visible instead of fading in on hover.** On a long virtualized surface a
  scrollbar is a position-and-extent readout, not only a drag target, and a readout that appears
  after you have reached for it is not one. Density (§Design vocabulary) argues the same way.
- **Styling a scrollbar opts out of macOS overlay scrollbars**, so the gutter takes layout width
  (~10px) on every container it is applied to. On a long scroller that is the right trade — it
  also means content stops reflowing when a scrollbar appears. Everywhere else it is a permanent
  bar on something that overflows by a line.

**It is opt-IN, and that is the mt#4355 change.** mt#3701 applied it through a bare `*` selector,
so all 31 scroll containers across 21 files carried a permanent gutter — every markdown code
block, every table wrapper, every small pane. The principal's report was "a ton of these ugly
scrollbars"; the reach was the defect, not the treatment. Apply `.scrollbar-readout` to a surface
long enough that the bar reads as a position indicator. Currently two: the app's main content
scroller (`components/Layout.tsx`) and the virtualized film ribbon
(`components/session-film/SessionFilmRibbon.tsx`). Everything else gets the platform's bar, which
mechanism 1 now renders dark.

`.scrollbar-none` (TabBar) still suppresses chrome entirely and is unaffected — it lives in the
utilities layer, which outranks the base layer `.scrollbar-readout` sits in. All four states are
asserted in `scripts/verify-session-film-panes.ts`: `color-scheme` is `dark`, `.scrollbar-readout`
resolves to the token, a BARE container resolves to `auto`, and `.scrollbar-none` suppresses.
The bare-container assertion is the one that keeps the global reach from creeping back.

**A caveat on that verification.** It drives Chromium, so it can confirm the `color-scheme`
declaration SHIPPED — not that the tray renders correctly. There is no headless WKWebView path
(mt#2226), and mt#3475 is precedent for how this class gets settled: the principal looks at the
tray window and reports. Do not read a green verify run as evidence about WebKit.

Root-scoping the base selector (`.cockpit *`) was considered and skipped when the rule was still
global: the cockpit bundle styles only its own document, and no external or third-party content is
hosted inside it (PR #2632 R1). Opt-in scoping makes the question moot.

## 5. Status and severity color semantics

### 5.1 The red-scarcity rule (exact boundary)

`warn.red` / `bg-warn-red` / `text-warn-red` / `bg-destructive` is reserved for **hard-alarm
states that call for action now**:

- `BLOCKED` task status
- Hook-denial flash (a blocked/denied action)
- A hard service failure (a check gone red, a service down)
- An escalation ask requiring immediate principal action

It is **not** for informational classification or routine attention-debt signaling, even when
that information feels "important":

- **Priority badges** (P0/P1/P2 labels) are classification, not an active alarm — use amber or
  neutral, never red, regardless of priority tier.
- **Standing / open asks** that are not yet past their window are attention debt, not an alarm —
  amber (or neutral, if not yet due) is correct; red is reserved for an ask that has actually
  escalated (deadline missed, bot intervention triggered).
- **A "stale" liveness dot** on an agent that's simply been idle a while is a different signal
  than a genuinely dead/errored session — reserve red liveness for real failure states; amber
  for stale/idle.

The distinction: red means "act now," amber means "attention debt exists." Conflating them
(the mt#2914 audit found red at volume — a P2 badge on every ask row, a red dot on every stale
agent row) erodes the signal red is supposed to carry. **Fixing already-shipped over-use of red
is out of this task's scope** (that's widget-level work — mt#2917's register pass); this section
records the boundary those fixes should converge on.

### 5.2 The blessed healthy/warning raw-palette exception (exact boundary)

`src/cockpit/CLAUDE.md` already documents one deliberate exception to "semantic tokens only":
per-status healthy/warning indicators (`Changesets`, `McpServerStatus`, `MemoriesHealth`,
`EmbeddingsPage`, and similar widgets) use raw Tailwind palette classes —
`bg-emerald-500`/`text-emerald-500` or `bg-green-400`/`text-green-400` for healthy,
`bg-amber-500`/`text-amber-500` or `bg-amber-400`/`text-amber-400` for warning — rather than a
dedicated `success`/`warning` design token. This is blessed, not a violation, because the brand
palette (`brand-system.md` §2) deliberately carries no `success` token ("one accent, two warning
tiers, one pastel — that's the budget"), and this repetition is narrow and already consistent.

The boundary does **not** extend further:

- **Error states always use the semantic `destructive`/`warn-red` token** — never a raw color
  like `text-red-400`. See `ErrorState` (`src/cockpit/web/components/ErrorState.tsx`).
- **Never raw hex or arbitrary values** (`bg-[#10b981]`) — only Tailwind's named palette, and
  only for the healthy/warning pair specifically.
- Any widget needing a **third** distinct status beyond healthy/warning is a signal to revisit
  as a real `success`/`warning` token pair, not to extend the raw-palette exception further.

**Lint enforcement scope (mt#2916): cockpit only, not the marketing site.** The
`custom/no-raw-colors-in-cockpit` ESLint rule enforces this boundary structurally, but only for
`src/cockpit/web/**` — `services/site/**` (the marketing site) is Astro, runs through a separate
build/lint pipeline, and is explicitly out of this rule's scope. Extending equivalent enforcement
to the site is future work, not folded into mt#2916.

### 5.3 Resolved: `--muted`/`--secondary`/`--accent` dark-mode collision

The mt#2909 visual-verification pass found `--muted`, `--secondary`, and `--accent` resolving to
the **identical** OKLCH triplet (`0.200 0 0`) in `.dark` — so the TODO/PLANNING/IN-PROGRESS
badges (which map to muted/secondary/accent respectively, per the cockpit-design skill's status
mapping) render as the same dark gray, and TaskGraph DAG node fills using the same tokens are
correspondingly low-contrast against the near-black canvas.

**Fix (this task): differentiate the three tokens by lightness only** — chroma and hue stay at
`0 0` (still neutral gray; no new hue is introduced, staying inside brand-system §2's "one
accent, two warning tiers, neutrals" budget). The spacing principle: **prominence tracks
distance from the base canvas lightness** (`--background: 0.078 0 0` in dark, `1 0 0` in light)
— the same principle the existing `card`(0.155) → `popover`(0.200) → `border`(0.270) ladder
already uses, just applied to the three collided tokens:

| Token                    | Dark (was → now)  | Distance from `--background` (0.078) | Light (was → now, placeholder) |
| ------------------------ | ----------------- | ------------------------------------ | ------------------------------ |
| `--muted` (TODO/CLOSED)  | `0.200` → `0.180` | 0.102                                | `0.945` → `0.960`              |
| `--secondary` (PLANNING) | `0.200` → `0.240` | 0.162                                | `0.945` → `0.900`              |
| `--accent` (IN-PROGRESS) | `0.200` → `0.300` | 0.222                                | `0.945` → `0.830`              |

This resolves badge distinguishability directly (three visibly distinct grays instead of one),
and improves — without fully solving — DAG node-fill contrast, since the same three tokens
back `statusStyle()`'s node fills. A full node-fill fix (a dedicated lighter/higher-chroma fill
octave for large-area instrument surfaces, distinct from the badge-oriented subtle-surface
tokens) is a further register-pass decision for mt#2917 if screenshots after this change still
read as low-contrast — not pre-built here speculatively.

Applied in `src/cockpit/web/index.css`; `docs/brand-system.md` §7 records the current values.

## 6. Icon decision

**APPROVED 2026-07-31 (ask#6551): Lucide is blessed for Cockpit product UI, and stays banned on
marketing surfaces (`services/site/**`).\*\*

Evidence this is already the de facto choice, not a new pick: `lucide-react` is a declared
`package.json` dependency, already imported in 15 `src/cockpit/web/**` files, and already
declared as `"iconLibrary": "lucide"` in `src/cockpit/web/components.json` (the shadcn/ui
scaffold config) — blessing it formalizes existing practice rather than introducing a new one.

This does not contradict `brand-system.md` §6's "Inter + Roboto + Lucide icons trifecta"
anti-pattern. That anti-pattern targets the generic AI-SaaS marketing-site default — a landing
page reaching for the same three defaults everyone else's AI product reaches for, signaling "not
designed." Cockpit is not a marketing surface: it's an internal, single-operator mission-control
dashboard in the Data-Dense-Pro family (Sentry, Linear, Grafana, PostHog) — tools whose UI is
substantially Lucide-based today, where the icon set is a professional-tool convention, not an
AI-slop tell. The anti-pattern's boundary is the surface, not the icon set in isolation.

**The veto window is closed.** [mt#2914](minsky://task/mt%232914)'s spec flagged this decision
for principal veto ("Icon decision (child 2) carries a recommendation for principal veto"). It
was routed as ask#6551 on 2026-07-30 and answered on 2026-07-31: _"Bless Lucide for the cockpit
only."_ No code change was required — `lucide-react` was already the declared dependency and
`components.json` already set `"iconLibrary": "lucide"`. Revisiting this is a new decision, not
an open question.

## 7. Token sync contract (mt#3411)

`docs/brand-system.md` §2 is the **single source of truth** for brand color. It already said so
— "OKLCH is canonical; hex is derived", "commit any refinement back to this table so all surfaces
stay in sync" — but until mt#3411 nothing read it, so the obligation was prose and prose does not
fail a build.

The same seven values live in **three** copies, in three syntaxes, because the surfaces consume
them differently:

| Copy                                                      | Syntax                                              | Why it differs                                                         |
| --------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/cockpit/web/index.css`                               | bare components — `--signal-cyan: 0.745 0.124 215;` | Tailwind/shadcn wrap them in `oklch()` at the use site                 |
| `services/site/src/styles/global.css`                     | `--color-signal: oklch(0.745 0.124 215);`           | consumed directly                                                      |
| the same file's `@supports not (color: oklch(...))` block | `--color-signal: #00bfd8;`                          | sRGB fallback for engines below Chrome 111 / Safari 16.4 / Firefox 113 |

**The contract.** Change a brand color in `brand-system.md` §2 first, then re-derive every
surface from it. `src/design-system/brand-token-drift.ts` enforces this: it parses the §2 table
and asserts all three copies match, failing with the token name, the surface, and both values.
Comparison is numeric, not textual — the surfaces legitimately write `0.56` and `0.560` for the
same value, and a string compare would report drift constantly and be switched off within a day.

**Adding a token.** Add the row to §2 AND an entry to `TOKEN_MAP` in that module. The map is
declared rather than inferred on purpose: distinct tokens can share a value (cockpit's light-mode
`--primary` is `0.078 0 0`, the same triple as the site's `--color-bg-base`), so matching on
value would pair unrelated tokens and then "verify" that pairing forever. A canonical name with
no map entry fails the check rather than being skipped.

**Why a check and not a generated pipeline.** The canonical answer to one-source-many-surfaces is
a token-transform pipeline (Style Dictionary and similar) generating per-platform output. That
means a new dependency wired into two build systems, with three output transforms, to keep seven
values in sync — heavier than the problem. Revisit when the shared set exceeds ~15 tokens or a
third surface appears; at that point the manual path is the one the tooling literature warns
about, and the check should be replaced by generation rather than extended.

## Cross-references

- [`docs/brand-system.md`](brand-system.md) — color/typography/motion source of truth; §7 carries
  the current cockpit token mapping this doc's §5.3 fix updates.
- [`.claude/skills/cockpit-design/SKILL.md`](../.claude/skills/cockpit-design/SKILL.md) —
  Minsky-domain entity/IA layer above this doc's token/component layer.
- [`.claude/skills/minsky-brand/SKILL.md`](../.claude/skills/minsky-brand/SKILL.md) — brand
  foundation (myth, cultural code, bridge-as-affect) this doc's tokens instantiate.
- `src/cockpit/CLAUDE.md` — engineering/IA conventions; §Design vocabulary is the source for
  the healthy/warning raw-palette exception cited in §5.2.
- `src/cockpit/web/lib/status-colors.ts`, `src/cockpit/web/lib/liveness-colors.ts` — the shared
  token-consuming modules §4/§5 reference (mt#2909).
- [mt#2914](minsky://task/mt%232914) — umbrella. [mt#2909](minsky://task/mt%232909) — prior
  sibling (status-color consolidation; surfaced the §5.3 finding). [mt#2917](minsky://task/mt%232917)
  — register-unification pass that adopts this doc's tokens across widgets. [mt#2916](minsky://task/mt%232916)
  — structural lint enforcement (`custom/no-raw-colors-in-cockpit`,
  `eslint-rules/no-raw-colors-in-cockpit.js` + `eslint.config.js`) of this section's
  §5.2 boundary — the umbrella child §1 forward-references above.
