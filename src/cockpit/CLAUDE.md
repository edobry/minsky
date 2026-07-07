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
| Frontend | React (`src/cockpit/web/{pages,widgets,components}/*.tsx` — see §Widget vocabulary below) |
| Styling | Tailwind (`tailwind.config.ts`, scoped to `src/cockpit/web/**`) |
| Component lib | shadcn/ui (mt#1773 shipped — `src/cockpit/web/components/ui/*.tsx`, `components.json`) |
| Data layer | TanStack Query (mt#1773 shipped — pages/widgets self-fetch via `useQuery`/`useMutation`; no bare `fetch` + `useState` for server data in pages/widgets per mt#2616, with two small `Rail.tsx` remnants tracked in mt#2641) |
| Build | Vite (`vite.config.ts`) |
| Tests | bun test (`src/cockpit/cockpit.test.ts`, `bun run test:components` for pages/widgets/components) |
| Widget contract | Custom registry (`src/cockpit/widget-registry.ts` + `types.ts`) — backend contract only, see §Widget vocabulary |
| Config | None per-widget — registry-gated; future cockpit config goes under a `cockpit` tree in `~/.config/minsky/config.yaml` (mt#2294) |
| DI | None (standalone Express, no tsyringe) |

### Widget vocabulary (mt#2616)

"Widget" is overloaded across the codebase — two distinct meanings share the word:

1. **Backend `WidgetModule`** (`src/cockpit/types.ts`, registered in `widget-registry.ts`): a
   self-contained data module with an `id`, `updateMode`, and `fetch()`. Serves
   `GET /api/widget/<id>/data`. This is the contract `docs/architecture/cockpit.md`'s
   "Adding a new widget" guidance describes. ~15 of these exist (agents, attention,
   basic-health, context-inspector, credentials, embeddings-health, task-graph, task-list,
   workstreams, memories-health/-list/-search/-stats/-detail, mcp-server-status, slow-topology).
2. **Frontend `web/widgets/*.tsx` directory**: a broader "chrome-agnostic render body"
   convention (mt#2373's `WidgetShell` variant system — `card` / `compact` / `page-body` /
   `rail-item`). Most files here render via a registered backend widget's data endpoint, but
   several are page-detail bodies with their own bespoke REST endpoints and NO backend
   registry entry: `SessionDetail`, `TaskDetail`, `AskDetail`, `ChangesetDetail`, `Changesets`,
   `ConversationView`. They live in `web/widgets/` because they share the `WidgetShell`
   composition contract, not because they implement `WidgetModule`.

**Resolution (mt#2616):** kept the single `web/widgets/` directory rather than splitting into
`web/widgets/` (registry-backed) + `web/panels/` (page-content bodies). The `WidgetShell`
render-context contract (variant-driven chrome, not data source) is the thing these files
actually have in common and is already the documented organizing principle (mt#2373); a
directory split by *data source* would cut across that and force every future
component to justify which side of the line it's on. If this directory keeps growing and the
ambiguity recurs in review, revisit the split — but don't invent a second axis of
categorization for a naming problem that a doc paragraph already resolves.

## Design vocabulary

**Product mode, not marketing mode.** Cockpit is a functional operator dashboard, not an editorial surface. Restrained, dense, useful. No decorative gradients, no oversized hero text, no marketing-mode typography. The aesthetic anchor is the Data-Dense Pro family (Sentry, PostHog, Grafana, Supabase, Linear) — every pixel serves operator workflow.

**Dark-mode-first, elevation via surface lightness.** Cockpit uses a dark color scheme as default. Higher-elevation surfaces are LIGHTER (not shadowed). The base surface is near-black; cards sit lighter; popovers and dialogs even lighter. Shadows are decorative, not structural — use them sparingly.

**Semantic tokens only.** Every color, spacing, and typography choice goes through Tailwind's semantic layer: `bg-background`, `bg-card`, `bg-popover`, `text-foreground`, `text-muted-foreground`, `border-border`, `ring-ring`. Never raw hex. Never `bg-gray-900`. The semantic layer is what makes dark-mode-first work and what lets the design evolve without per-widget rewrites.

**Density as a feature.** Information density is rewarded. Tighter spacing than a marketing site. Tables with row-density toggles. Compact typography in data areas. Generous whitespace ONLY where it serves scanning or focus — not as default.

**No template defaults.** If another agent given the same prompt would produce the same output, the design has failed. The Cockpit aesthetic should feel chosen, not generated.

## Engineering standards

**Composition over configuration.** Compound components. Lifted state when shared. Explicit variant props (`<Button variant="destructive">`) over boolean explosions (`<Button isDanger>`). Pattern reference: `vercel-labs/composition-patterns`.

**Server state via TanStack Query.** All server-state fetching goes through `useQuery`/`useMutation` (mt#1773 shipped this stack; mt#2616 finished migrating the last raw-`fetch`+`useState` holdouts). Set sensible `staleTime` and `refetchInterval` per widget. Invalidate the query cache on mutations. Do not use bare `fetch` + `useState` for server data — it doesn't compose with cache invalidation, error retry, or loading states. Use the shared `LoadingState`/`ErrorState` components (`src/cockpit/web/components/`) for `isLoading`/`isError` branches instead of hand-rolled inline text.

**Accessibility-first primitives.** Use shadcn/ui's Radix-backed primitives (Button, Card, Dialog, Tabs, Command — `src/cockpit/web/components/ui/`). Every interactive element has a visible focus state. Every icon has an `aria-label`. Keyboard navigation works (Tab/Shift+Tab/Enter/Esc). Test with the browser DevTools accessibility audit.

**Avoid waterfalls.** Don't sequence client-side data fetches when they can run in parallel. Use `Promise.all` for parallel fetches. Use `useQueries` for parallel TanStack Query calls. Pattern reference: `vercel-labs/react-best-practices`.

**Tailwind config: semantic tokens + `dark` class.** `tailwind.config.ts` defines CSS variables in `:root` and `.dark` for every semantic color. `darkMode: "class"`. The base layer (`src/cockpit/web/index.css`) declares the CSS variable values, per shadcn/ui's `components.json` scaffold.

## Information architecture

**Workflow-driven layout.** Before placing a widget or panel, ask: what operator task does this view serve? Organize by user journey, not by data shape. Cockpit serves four primary journeys: (1) "what's running?" (Agents widget), (2) "what's the work?" (TaskGraph + Workstreams widgets), (3) "what needs my attention?" (Attention widget), (4) "what does the agent's context look like?" (Context Inspector).

**Page vs. card placement.** The home page has two tiers: a **System Status** card grid (compact status indicators — BasicHealth, Attention, Credentials) and **nav tiles** linking to feature pages. The decision criteria: **status indicators and health-check surfaces → card**. **Interactive tools with list+detail, filtering, session pickers, or multi-step workflows → dedicated page route** (`/agents`, `/context`, `/tasks`, etc.). A widget whose spec says "tab" means a page route in cockpit vocabulary. Originating incident: mt#2136 (ContextInspector was specced as a tab but placed as a card).

**Progressive disclosure as state pattern.** Loading, empty, error, and success states are first-class. Show what's necessary right now; reveal more on demand. Avoid the "skeleton everywhere then fully-rendered" jump — prefer staged reveals where useful. Don't render an empty widget shell when the data isn't ready; render a meaningful placeholder.

**Mental-model alignment to Minsky's domain.** Tasks, sessions, changesets, PRs, attention/asks ARE the organizing entities. Widgets respect their conventions: task IDs (`mt#X`) are universal anchors; session liveness is a first-class status; PR state maps cleanly to changeset state. Don't invent abstractions — surface the existing domain.

**Drill-down navigation.** Dashboard → entity detail → action → back. Breadcrumbs when depth exceeds 2. Keyboard shortcuts for back/forward. Command palette (`Cmd+K`, `src/cockpit/web/components/CommandPalette.tsx`) for cross-entity jumps when navigation depth would otherwise be tedious.

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

**Visual verification — use chrome-devtools-mcp + the shared dev canary, not Playwright.**
The canonical way to look at a rendered cockpit is **chrome-devtools-mcp**
(`mcp__chrome-devtools__*`) attached to the shared dev canary chromium (the
`--remote-debugging-port=9222` instance described above). Start the server so the
canary launches — do **NOT** pass `--no-dev-chromium`, which disables exactly the
browser chrome-devtools-mcp attaches to:

```bash
bun run cockpit:build               # PROD bundle — Vite HMR is unreliable for screenshots
bun src/cli.ts cockpit start --port=<N>   # keep the :9222 canary up (no --no-dev-chromium)
```

Then drive the canary via chrome-devtools-mcp: `list_pages` -> `new_page` (your cockpit
URL) or `select_page` -> `take_snapshot` (a11y tree; preferred for textual reasoning) or
`take_screenshot` (pixels). **Pass `pageId` explicitly on every page-scoped call** — the
canary is shared across sessions and has a cross-tab race (mt#1912); a `pageId`-less call
can land on another session's tab. The full procedure (find-your-tab-by-URL -> select ->
act) is in the `cockpit-design` skill §0. Use the PROD bundle, not dev HMR, for screenshot
verification: WS-port conflicts, segfaults, and zero-renders (especially react-flow, which
measures the DOM) make HMR unreliable here.

**Playwright is the FALLBACK** — use it only when chrome-devtools-mcp is unavailable (not
configured, or the canary can't launch). It is a legit ad-hoc tool (memory `f2df223d`), not
the default for cockpit verification. Recipe: `bun src/cli.ts cockpit start --port=<N>` then
playwright at 1440x900 with `waitUntil: "domcontentloaded"` (NOT networkidle — the page
polls `/api/*` forever), wait for a known `data-testid`, save a PNG, then Read it. If
playwright's browser binary is missing, install the version pinned to the bun-cached
`playwright-core`: `bunx playwright@<ver> install chromium`.

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