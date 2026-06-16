# Cockpit (src/cockpit/**) — design, engineering, and IA conventions

This file auto-loads when any file under `src/cockpit/**` is read. It carries the design vocabulary, engineering standards, and information-architecture posture for Cockpit work — Minsky's mission-control web app.

## What Cockpit is

Operator-facing dashboard for Minsky's own state: agents in flight, tasks as a tech tree, attention-debt and open Asks. Architecture is shell + widget framework — each widget is a self-contained module declaring its data dependencies, shipping independently, degrading gracefully when dependencies aren't ready. Web-primary; no TUI investment. Local-only v0 (`minsky cockpit`).

Parent task: mt#1143. Bundle umbrella: mt#1768 (this CLAUDE.md is its phase-A deliverable, mt#1772).

## Invocation

For substantial Cockpit design or engineering work, prefer `/agents cockpit-dev` — the explicit invocation surface for focused Cockpit work. The agent currently ships with no preloaded skills (`skills: []`); mt#1774 will add the `cockpit-design` skill and mt#1777 will add the Tier-1 community skill bundle to its `skills:` list. This CLAUDE.md is the always-on floor (auto-loaded path-scoped via Claude Code's subdirectory CLAUDE.md mechanism); the agent is the explicit unit of focused work.

## Stack

| Layer | Value |
|---|---|
| Runtime | Bun |
| Language | TypeScript strict |
| Server | Express (`src/cockpit/server.ts`) |
| Frontend | React (`src/cockpit/web/widgets/*.tsx`) |
| Styling | Tailwind (`tailwind.config.ts`, scoped to `src/cockpit/web/**`) |
| Component lib | shadcn/ui (when mt#1773 ships; bare Tailwind until then) |
| Data layer | TanStack Query (when mt#1773 ships; bare fetch + useState until then) |
| Build | Vite (`vite.config.ts`) |
| Tests | bun test (`src/cockpit/cockpit.test.ts`) |
| Widget contract | Custom registry (`src/cockpit/widget-registry.ts` + `types.ts`) |
| Config | None per-widget — registry-gated; future cockpit config goes under a `cockpit` tree in `~/.config/minsky/config.yaml` (mt#2294) |
| DI | None (standalone Express, no tsyringe) |

## Design vocabulary

**Product mode, not marketing mode.** Cockpit is a functional operator dashboard, not an editorial surface. Restrained, dense, useful. No decorative gradients, no oversized hero text, no marketing-mode typography. The aesthetic anchor is the Data-Dense Pro family (Sentry, PostHog, Grafana, Supabase, Linear) — every pixel serves operator workflow.

**Dark-mode-first, elevation via surface lightness.** Cockpit uses a dark color scheme as default. Higher-elevation surfaces are LIGHTER (not shadowed). The base surface is near-black; cards sit lighter; popovers and dialogs even lighter. Shadows are decorative, not structural — use them sparingly.

**Semantic tokens only.** Every color, spacing, and typography choice goes through Tailwind's semantic layer: `bg-background`, `bg-card`, `bg-popover`, `text-foreground`, `text-muted-foreground`, `border-border`, `ring-ring`. Never raw hex. Never `bg-gray-900`. The semantic layer is what makes dark-mode-first work and what lets the design evolve without per-widget rewrites.

**Density as a feature.** Information density is rewarded. Tighter spacing than a marketing site. Tables with row-density toggles. Compact typography in data areas. Generous whitespace ONLY where it serves scanning or focus — not as default.

**No template defaults.** If another agent given the same prompt would produce the same output, the design has failed. The Cockpit aesthetic should feel chosen, not generated.

## Engineering standards

**Composition over configuration.** Compound components. Lifted state when shared. Explicit variant props (`<Button variant="destructive">`) over boolean explosions (`<Button isDanger>`). Pattern reference: `vercel-labs/composition-patterns`.

**Server state via TanStack Query.** When mt#1773 ships, all server-state fetching goes through `useQuery`. Set sensible `staleTime` and `refetchInterval` per widget. Invalidate the query cache on mutations. Do not use bare `fetch` + `useState` for server data once TanStack Query is available — it doesn't compose with cache invalidation, error retry, or loading states.

**Accessibility-first primitives.** Use shadcn/ui's Radix-backed primitives (Button, Card, Dialog, Tabs, Command) once mt#1773 ships. Every interactive element has a visible focus state. Every icon has an `aria-label`. Keyboard navigation works (Tab/Shift+Tab/Enter/Esc). Test with the browser DevTools accessibility audit.

**Avoid waterfalls.** Don't sequence client-side data fetches when they can run in parallel. Use `Promise.all` for parallel fetches. Use `useQueries` for parallel TanStack Query calls. Pattern reference: `vercel-labs/react-best-practices`.

**Tailwind config: semantic tokens + `dark` class.** `tailwind.config.ts` defines CSS variables in `:root` and `.dark` for every semantic color. `darkMode: "class"`. The base layer (`src/cockpit/web/index.css` or equivalent) declares the CSS variable values. shadcn/ui's `components.json` will scaffold this when mt#1773 ships.

## Information architecture

**Workflow-driven layout.** Before placing a widget or panel, ask: what operator task does this view serve? Organize by user journey, not by data shape. Cockpit serves four primary journeys: (1) "what's running?" (Agents widget), (2) "what's the work?" (TaskGraph + Workstreams widgets), (3) "what needs my attention?" (Attention widget), (4) "what does the agent's context look like?" (Context Inspector).

**Page vs. card placement.** The home page has two tiers: a **System Status** card grid (compact status indicators — BasicHealth, Attention, Credentials) and **nav tiles** linking to feature pages. The decision criteria: **status indicators and health-check surfaces → card**. **Interactive tools with list+detail, filtering, session pickers, or multi-step workflows → dedicated page route** (`/agents`, `/context`, `/tasks`, etc.). A widget whose spec says "tab" means a page route in cockpit vocabulary. Originating incident: mt#2136 (ContextInspector was specced as a tab but placed as a card).

**Progressive disclosure as state pattern.** Loading, empty, error, and success states are first-class. Show what's necessary right now; reveal more on demand. Avoid the "skeleton everywhere then fully-rendered" jump — prefer staged reveals where useful. Don't render an empty widget shell when the data isn't ready; render a meaningful placeholder.

**Mental-model alignment to Minsky's domain.** Tasks, sessions, changesets, PRs, attention/asks ARE the organizing entities. Widgets respect their conventions: task IDs (`mt#X`) are universal anchors; session liveness is a first-class status; PR state maps cleanly to changeset state. Don't invent abstractions — surface the existing domain.

**Drill-down navigation.** Dashboard → entity detail → action → back. Breadcrumbs when depth exceeds 2. Keyboard shortcuts for back/forward. Command palette (`Cmd+K`) for cross-entity jumps when navigation depth would otherwise be tedious. (Command palette ships when mt#1773 lands the `<Command>` primitive.)

## Operator dev loop

**Dev mode (recommended for active UI work):**

```bash
minsky cockpit start --dev --port 3737
```

Starts Express API + Vite dev middleware on a single port. Frontend changes
(React components, CSS, Tailwind classes) hot-reload via Vite HMR — no
rebuild, no page refresh. API routes are served by Express as normal. No
pre-built SPA bundle required.

For server-side auto-restart (new API routes, server.ts changes), wrap with
`bun --watch`:

```bash
bun --watch run src/cli.ts cockpit start --dev --port 3737
```

`bun --watch` restarts the process when imported server-side files change.
The Vite HMR websocket reconnects automatically after restart.

**Production mode (pre-built bundle):**

```bash
bun run cockpit:build && minsky cockpit start --port 3737
```

Serves the pre-built SPA from `src/cockpit/web/dist/`. Use for testing the
production bundle or when running as a background daemon.

**Shared dev chromium:** both modes launch a shared dev chromium with
`--remote-debugging-port=9222` for chrome-devtools-mcp attachment (opt-out:
`--no-dev-chromium`). Owners: `src/cockpit/lifecycle.ts` (state file) and
`src/cockpit/dev-chromium.ts` (chromium spawn + state at `~/.local/state/minsky/dev-chromium.json`).
mt#1887's port-recovery (`src/cockpit/port-recovery.ts`) reads recognition state from
the lifecycle module so per-workspace cockpits don't false-positive each other.
Full architecture: [`docs/architecture/cockpit.md#operator-dev-loop`](../../docs/architecture/cockpit.md). Tracking task: mt#1904.

**Visual verification (screenshots / react-flow) — use the PROD bundle, not dev HMR.**
The Vite HMR dev server is great for iterating on code but UNRELIABLE for
screenshot verification: WS-port conflicts, segfaults, and intermittent
zero-renders (especially with react-flow, which measures the DOM). To verify a
render reliably:

```bash
bun run cockpit:build
bun src/cli.ts cockpit start --port=<N>
# then screenshot via playwright at 1440x900:
#   waitUntil: "domcontentloaded"  (NOT networkidle — the page polls /api/* forever)
#   wait for a known data-testid, save a PNG, then Read the PNG to inspect
```

`chrome-devtools-mcp` may be unavailable; playwright is the fallback. If
playwright's browser binary is missing, install the version pinned to the
bun-cached `playwright-core`: `bunx playwright@<ver> install chromium`.

**react-flow height trap:** the `<ReactFlow>` container needs an EXPLICIT
height. Under the cockpit shell (sticky `h-14` AppHeader + `min-h-screen`
Layout root), a `h-full` page collapses to `height:0` — a blank canvas that
still passes unit tests. Size the page `h-[calc(100vh-3.5rem)]`. The fuller
react-flow gotcha set (silently-dropped edges, `fitView`-before-measurement,
smoothstep routing, undefined `style` spread, underlay paint order) lives in
the `cockpit-design` skill §Whole-system view.

## Future architecture decision

**Express → Hono migration (deferred).** Cockpit's server is Express today (`src/cockpit/server.ts`, ~10 routes). The skill research strongly flagged Hono as a better Bun fit (native TypeScript RPC, ~10KB, Zod validators, multi-runtime). Migration ROI doesn't materialize at the current server surface size. Revisit when Cockpit grows past ~25 routes or hits a multi-runtime requirement.

## Cross-references

- **mt#1143** — Cockpit v0 umbrella
- **mt#1144** — Shell + widget framework (DONE)
- **mt#1145** — Agents widget (DONE)
- **mt#1146** — TaskGraph widget (DONE)
- **mt#1147** — Attention widget (gated on mt#1034)
- **mt#1148** — Push transport (polling → SSE)
- **mt#1452** — Workstreams widget (DONE)
- **mt#1768** — Bundle umbrella (this CLAUDE.md is its phase-A deliverable; mt#1772)
- **mt#1773** — shadcn/ui + TanStack Query install (phase B)
- **mt#1774** — `cockpit-design` skill (phase C — encodes deeper Minsky-domain patterns)
- **mt#1775** — Demonstrator widget rebuild (phase D)
- **mt#1777** — Tier-1 community skill vendoring (mt#1772 follow-up; will populate the agent's `skills:` list)
- **Memory** `Cockpit stack and design/engineering bundle` (id `0cc1304c-0de3-4e5e-8e7a-b446bc70a995`) — durable cross-cutting reference

## Open meta-question

Should this file be hand-authored at destination (current state) OR compiled from `.minsky/rules/cockpit-bundle.mdc` with `globs: ["src/cockpit/**"]` IF the Minsky rules pipeline supports per-subdirectory CLAUDE.md emission? Investigation deferred (was originally in-scope for mt#1772; scope-cut 2026-05-12). Hand-authoring is sufficient for v0; revisit when there's a clear authoring-friction need.