# Cockpit (src/cockpit/**) — design, engineering, and IA conventions

This file auto-loads when any file under `src/cockpit/**` is read. It carries the design vocabulary, engineering standards, and information-architecture posture for Cockpit work — Minsky's mission-control web app.

## What Cockpit is

Operator-facing dashboard for Minsky's own state: agents in flight, tasks as a tech tree, attention-debt and open Asks. Architecture is shell + widget framework — each widget is a self-contained module declaring its data dependencies, shipping independently, degrading gracefully when dependencies aren't ready. Web-primary; no TUI investment. Local-only v0 (`minsky cockpit`).

Parent task: mt#1143. Bundle umbrella: mt#1768 (this CLAUDE.md is its phase-A deliverable, mt#1772).

## Invocation

For substantial Cockpit design or engineering work, prefer `/agents cockpit-dev` — the explicit invocation surface for focused Cockpit work. The agent's `skills:` list (`.claude/agents/cockpit-dev.md` frontmatter) ships 13 preloaded skills: `cockpit-design` (mt#1774, encoding the deeper Minsky-domain patterns) plus the 12 vendored Tier-1 community skills (mt#1777) — `composition-patterns`, `frontend-design`, `impeccable`, `information-architecture`, `interface-design`, `plan-design-review`, `playwright-skill`, `react-best-practices`, `shadcn-ui`, `tailwind-v4-shadcn`, `tanstack-query`, `web-design-guidelines`. This CLAUDE.md is the always-on floor (auto-loaded path-scoped via Claude Code's subdirectory CLAUDE.md mechanism); the agent is the explicit unit of focused work.

## Stack

| Layer | Value |
|---|---|
| Runtime | Bun |
| Language | TypeScript strict |
| Server | Express (`src/cockpit/server.ts`) |
| Frontend | React (`src/cockpit/web/{pages,widgets,components}/*.tsx` — see §Widget vocabulary below) |
| Styling | Tailwind (`tailwind.config.ts`, scoped to `src/cockpit/web/**`) |
| Component lib | shadcn/ui conventions (mt#1773 shipped — `src/cockpit/web/components/ui/*.tsx`). Primitives are **hand-authored** thin Radix wrappers following shadcn's documented subcomponent contracts. Add one by matching the house idiom in `ui/popover.tsx` / `ui/select.tsx`; do **not** use `shadcn add` — see §Why primitives are hand-authored below. |
| Data layer | TanStack Query (mt#1773 shipped — pages/widgets self-fetch via `useQuery`/`useMutation`; no bare `fetch` + `useState` for server data anywhere in `web/**` per mt#2616 + mt#2641, which migrated the last two `Rail.tsx` holdouts) |
| Build | Vite (`vite.config.ts`) |
| Tests | Server-side (`src/cockpit/*.test.ts`, e.g. `cockpit.test.ts`) run in the MAIN suite — `bun run test`, no happy-dom. Everything under `src/cockpit/web/`, including files at its top level (mt#3496), runs in `bun run test:components` under happy-dom. The two suites do not overlap. |
| Widget contract | Custom registry (`src/cockpit/widget-registry.ts` + `types.ts`) — backend contract only, see §Widget vocabulary |
| Config | None per-widget — registry-gated; future cockpit config goes under a `cockpit` tree in `~/.config/minsky/config.yaml` (mt#2294) |
| DI | None (standalone Express, no tsyringe) |

### Why primitives are hand-authored (mt#4062)

**Not because the CLI is unusable here.** `src/cockpit/web/components.json` exists and is a valid
shadcn config; `shadcn add` reads it, resolves, and proceeds.

The reason is that the CLI now defaults to **Base UI**. It prompts `Select a component library ›
Base UI (Recommended) / React Aria / Radix UI`, and `--yes` does not answer that prompt — so an
unattended `shadcn add` drops a Base UI primitive into a tree whose primitives are all Radix
wrappers. That is the second-primitive-library deviation mt#3347's gate-(l) analysis identified and
rejected. If you do want the CLI, answer the prompt with Radix UI and then reconcile the output
against the house idiom by hand.

**A verification note, which is the more portable lesson.** Until mt#4062 this row asserted the
opposite — that no such config existed, and that this was why the CLI was unavailable. It
carried a verification stamp, which is what let it survive: readers saw a checked claim. The check
was real but bounded. mt#3347 recorded it as `find -maxdepth 3 -not -path node_modules`, and
`./src/cockpit/web/components.json` is four path components deep, so that search could not have
found the file no matter what was there:

```
$ find . -maxdepth 3 -name components.json -not -path '*/node_modules/*'
(no output)
$ find . -maxdepth 4 -name components.json -not -path '*/node_modules/*'
./src/cockpit/web/components.json
```

**Generalize it: a depth-bounded or path-bounded absence check is evidence about the region it
searched, not about the repo.** When you record a negative, record its bound with it — "no match
under `src/cockpit/web`", not "does not exist" — so the next reader can see what the check could
not have seen. This is the same discipline `claim-confidence.mdc` states for negatives bounded to
one channel; a nearby instance is mt#3362's stale `sticky h-14 AppHeader` premise elsewhere in
these docs.

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

### Guard/interlock vocabulary (mt#2626)

"Hook" names the Claude Code registration mechanics only (`.claude/hooks/`, `.minsky/hooks/`); **"interlock" is the domain noun** for the guard mechanism everywhere else in docs and UI copy (the Plant Board's S2 valves, its "interlock history →" drill-down link); "weld" survives at most as a verb ("welding an interlock").

The `/plant/interlock-history` PAGE was this rule's other standing example until mt#4229 absorbed it into `/interceptors`. The rule is unchanged by that move, and the move is a worked example of it: the destination became an `/interceptors` route while the plant board's link kept saying "interlock history", because the link is plant UI copy and the genus noun below governs the catalog, not the board.

**The genus noun is `interceptor` (ask#7119, closed 2026-08-11).** The ~90-entity enforcement corpus — merge gates, PreToolUse denials, Stop scanners, per-turn injections, calibration recorders, pre-commit checks — is named **interceptors**; **guard**, **detector**, and **injector** are COMPUTED family words (filters over intervention type: deny/allow, calibration-first record, and inject respectively), not assigned labels. The activity noun is "interception"; the catalog route is `/interceptors`, and a catalog deeplink type follows the same noun. Describe an individual entity by its coordinates — `<interception point> + <intervention type(s)> + <decision mechanism>` — when precision matters.

**This does NOT reopen mt#2626, and the paragraph above stands unchanged:** "hook" stays registration mechanics (the MCP Interceptors WG charter makes the same split, ruling client-specific hook internals out of protocol scope), and "interlock" stays the plant-UI deny noun in shipped copy. Nor does it rename any code or storage: `guardName` fire-log keys are not migrated — new code reaches interceptor vocabulary via a read-side alias only.

Full model — the three axes, the four amendments the codebase audit forced, the entity strata, and the MCP disambiguation — is [`docs/architecture/interceptors.md`](../../docs/architecture/interceptors.md). Read it before writing cockpit copy or component names for any surface that renders this corpus.

## Design vocabulary

**Declared design system (mt#2915).** [`docs/design-system.md`](../../docs/design-system.md) is the declared design-system artifact for cockpit: type scale, spacing-scale decision, component inventory with interaction states, status/severity color semantics (incl. the red-scarcity rule), and the icon decision. `docs/brand-system.md` remains the color/typography/motion source of truth; `design-system.md` is the layer brand-system.md explicitly defers (components, spacing, interaction states) plus the cockpit-specific type scale. Read both before a cockpit visual or component decision.

**Product mode, not marketing mode.** Cockpit is a functional operator dashboard, not an editorial surface. Restrained, dense, useful. No decorative gradients, no oversized hero text, no marketing-mode typography. The aesthetic anchor is the Data-Dense Pro family (Sentry, PostHog, Grafana, Supabase, Linear) — every pixel serves operator workflow.

**Dark-mode-first, elevation via surface lightness.** Cockpit uses a dark color scheme as default. Higher-elevation surfaces are LIGHTER (not shadowed). The base surface is near-black; cards sit lighter; popovers and dialogs even lighter. Shadows are decorative, not structural — use them sparingly.

**Semantic tokens only — structurally enforced (mt#2916).** Every color, spacing, and typography choice goes through Tailwind's semantic layer: `bg-background`, `bg-card`, `bg-popover`, `text-foreground`, `text-muted-foreground`, `border-border`, `ring-ring`. Never raw hex. Never `bg-gray-900`. The semantic layer is what makes dark-mode-first work and what lets the design evolve without per-widget rewrites. This was prose-only until mt#2916 added `custom/no-raw-colors-in-cockpit` (`eslint-rules/no-raw-colors-in-cockpit.js`, declared coverage + allowlist in `eslint.config.js`): it errors on raw hex literals (always) and raw Tailwind palette classes (outside the declared exceptions below) across `src/cockpit/web/**`.

**Status colors (healthy/warning) are a documented exception — raw Tailwind palette, never hex (mt#2641; lint-enforced via the rule's `statusFiles`/`blessedHues` options, mt#2916).** Every status widget that renders a healthy/warning indicator — `Changesets`, `McpServerStatus`, `MemoriesHealth`, `EmbeddingsPage`, and others — uses raw Tailwind palette classes for that purpose: `bg-emerald-500`/`text-emerald-500` and `bg-green-400`/`text-green-400` for healthy, `bg-amber-500`/`text-amber-500` and `bg-amber-400`/`text-amber-400` for warning. This is the BLESSED convention, not a violation of "semantic tokens only" above: that rule governs structural/surface colors (background, foreground, border) where a semantic layer is what makes dark-mode-first and per-theme evolution work. Per-status healthy/warning color is a narrower convention, already consistent across every widget that needs it, and introducing dedicated `success`/`warning` design tokens (a `tailwind.config.ts` extension plus a multi-file migration) is a bigger design-system change with no concrete driver today. Two things stay non-negotiable regardless, and both are lint-enforced with zero exceptions: (a) **error states always use the semantic `destructive` token** — never a raw color like `text-red-400` (see `ErrorState`, `src/cockpit/web/components/ErrorState.tsx`); (b) **never raw hex or arbitrary values** (`bg-[#10b981]`) — only Tailwind's named palette, and only the emerald/green/amber families, and only in the `COCKPIT_STATUS_FILES` list declared in `eslint.config.js`. A genuinely new status-indicator widget adds itself to that list (a design decision, not a lint tweak); a widget with a legitimately different raw-color need (syntax highlighting, categorical entity badges, a third-party color convention like GitHub's PR states) gets a fully-exempted file-level entry with a recorded justification instead, per the same config block. If the raw-color repetition ever becomes a real migration cost, or a widget needs a third distinct status, revisit as a `success`/`warning` token pair — `tailwind.config.ts` already carries adjacent prior art for that pattern (`warn.amber`, used by `Rail.tsx`'s attention badge, and the `liveness.*` scale used by session-liveness indicators).

**Density as a feature.** Information density is rewarded. Tighter spacing than a marketing site. Tables with row-density toggles. Compact typography in data areas. Generous whitespace ONLY where it serves scanning or focus — not as default.

**No template defaults.** If another agent given the same prompt would produce the same output, the design has failed. The Cockpit aesthetic should feel chosen, not generated.

## Engineering standards

**Composition over configuration.** Compound components. Lifted state when shared. Explicit variant props (`<Button variant="destructive">`) over boolean explosions (`<Button isDanger>`). Pattern reference: `vercel-labs/composition-patterns`.

**Server state via TanStack Query.** All server-state fetching goes through `useQuery`/`useMutation` (mt#1773 shipped this stack; mt#2616 finished migrating the last raw-`fetch`+`useState` holdouts). Set sensible `staleTime` and `refetchInterval` per widget. Invalidate the query cache on mutations. Do not use bare `fetch` + `useState` for server data — it doesn't compose with cache invalidation, error retry, or loading states. Use the shared `LoadingState`/`ErrorState` components (`src/cockpit/web/components/`) for `isLoading`/`isError` branches instead of hand-rolled inline text.

**Accessibility-first primitives.** Use shadcn/ui's Radix-backed primitives (Button, Card, Dialog, Tabs, Command — `src/cockpit/web/components/ui/`). Every interactive element has a visible focus state. Every icon has an `aria-label`. Keyboard navigation works (Tab/Shift+Tab/Enter/Esc). Test with the browser DevTools accessibility audit.

**Avoid waterfalls.** Don't sequence client-side data fetches when they can run in parallel. Use `Promise.all` for parallel fetches. Use `useQueries` for parallel TanStack Query calls. Pattern reference: `vercel-labs/react-best-practices`.

**Tailwind config: semantic tokens + `dark` class.** `tailwind.config.ts` defines CSS variables in `:root` and `.dark` for every semantic color. `darkMode: "class"`. The base layer (`src/cockpit/web/index.css`) declares the CSS variable values, following shadcn/ui's documented CSS-variable convention.

## Information architecture

**Workflow-driven layout.** Before placing a widget or panel, ask: what operator task does this view serve? Organize by user journey, not by data shape. Cockpit serves four primary journeys: (1) "what's running?" (Agents widget), (2) "what's the work?" (TaskGraph + Workstreams widgets), (3) "what needs my attention?" (Attention widget), (4) "what does the agent's context look like?" (Context Inspector).

**Page vs. card placement.** The home page has two tiers: a **System Status** card grid (compact status indicators — BasicHealth, Attention, Credentials) and **nav tiles** linking to feature pages. The decision criteria: **status indicators and health-check surfaces → card**. **Interactive tools with list+detail, filtering, session pickers, or multi-step workflows → dedicated page route** (`/agents`, `/context`, `/tasks`, etc.). A widget whose spec says "tab" means a page route in cockpit vocabulary. Originating incident: mt#2136 (ContextInspector was specced as a tab but placed as a card).

**Progressive disclosure as state pattern.** Loading, empty, error, and success states are first-class. Show what's necessary right now; reveal more on demand. Avoid the "skeleton everywhere then fully-rendered" jump — prefer staged reveals where useful. Don't render an empty widget shell when the data isn't ready; render a meaningful placeholder.

**Mental-model alignment to Minsky's domain.** Tasks, sessions, changesets, PRs, attention/asks ARE the organizing entities. Widgets respect their conventions: task IDs (`mt#X`) are universal anchors; session liveness is a first-class status; PR state maps cleanly to changeset state. Don't invent abstractions — surface the existing domain.

**Drill-down navigation.** Dashboard → entity detail → action → back. Breadcrumbs when depth exceeds 2. Keyboard shortcuts for back/forward. Command palette (`Cmd+K`, `src/cockpit/web/components/CommandPalette.tsx`) for cross-entity jumps when navigation depth would otherwise be tedious.

## Operator dev loop

**A merged/pulled change is usually ALREADY LIVE — don't reflexively rebuild/restart (mt#2970).**
Under a tray-supervised cockpit (`Minsky Cockpit.app`), the tray watches the source tree and
self-updates: `cockpit-tray/src-tauri/src/watcher_web.rs` (mt#2297) auto-rebuilds the web bundle on
`src/cockpit/web` changes, and `cockpit-tray/src-tauri/src/watcher_backend.rs` (mt#2299)
auto-restarts the daemon on any other `src/cockpit` change. The daemon spawns from SOURCE
(`bun run src/cli.ts`), so a restart picks up
backend TS with no build step. Net effect: when `main` fast-forwards to a merge touching
`src/cockpit/**`, the running cockpit reflects it within seconds — no manual `cockpit:build` or
restart needed.

- **PROBE before claiming the running cockpit is stale, or telling the operator to rebuild/restart.**
  "It's merged, so the running cockpit must be old" is an UNVERIFIED premise — the tray has very
  likely already applied it. Check the live daemon first: `curl http://127.0.0.1:<port>/api/tasks/<id>`
  and confirm the changed field is present/absent. Killing a healthy daemon before reading its served
  state destroys the evidence of whether the restart was even needed. (Premise-verification family:
  memory `da2b73ea`; merged≠usable altitude: `427cdf15`.)
- **`packages/**` changes auto-restart too, as of mt#4230.** The daemon spawns from source
  (`bun run src/cli.ts`), so its import closure is `src/**` plus `packages/**`. `watcher_backend`
  watched `src/cockpit` alone until mt#4230, which made a `packages/domain`-only change invisible to
  all three mechanisms that read that root — the auto-restart, the adoption-staleness check, and the
  `(src @ …)` uptime hint — so the daemon served stale code while the hint read as current. Bun
  caches ES modules, so a domain change genuinely needs a process restart (eager-vs-lazy import makes
  no difference); what changed is that the restart now fires on its own.
  `cockpit_backend_roots()` (`cockpit-tray/src-tauri/src/watcher_backend.rs`) is the single list all
  three read — add a root there, not at a call site. **Remember the tray binary is NOT auto-rebuilt**
  (`cockpit-tray-dev`): a checkout that predates mt#4230's tray release still has the old
  single-root watcher, so probe before assuming this applies to the tray you are running.
- **When a restart IS needed, run `minsky cockpit restart` (mt#4232).** It works under the
  tray-supervised default, under launchd, and from an agent shell — no GUI click, no hand
  `kill`/respawn. It resolves the serving pid (from `/api/health`'s `pid`, falling back to the port
  holder for a daemon whose build predates that field), verifies the process's live command line
  before signalling it, and does not report success until `processStartedAtMs` actually changes.
  `--port` follows the same `cockpit.port` precedence as the other cockpit subcommands.
  - Until mt#4232 this bullet recommended `restartDaemon()` in `src/cockpit/launchd.ts`. That
    function is GONE: it required a launchd plist, so it threw "No cockpit daemon installed" under
    the default setup — the defect mt#4232 fixed. Do not reintroduce a launchd-gated restart.
  - **The tray records a signalled restart as a crash-class exit.** A SIGTERMed process reports no
    exit code, which `classify_exit` cannot distinguish from a real crash. It respawns normally, but
    four restarts inside ten minutes trip the restart-storm alert and two inside five seconds hit the
    respawn throttle. Both are the supervisor behaving correctly; pace accordingly.
  - **`minsky cockpit stop` is NOT the mirror of restart.** A signal cannot stop a supervised daemon
    — respawning is the supervisor's job. Under launchd it runs `launchctl unload` (the only stop
    launchd honours); under the tray it signals, observes the respawn, and reports that plainly with
    a non-zero exit rather than claiming a stop. To actually stop a tray-supervised daemon, use the
    tray menu's Stop item.
  - **Check for a mid-turn driven session first** when the restart is discretionary:
    `curl http://127.0.0.1:<port>/api/driven-session/turn-active`. The daemon has no shutdown handler
    (mt#4040), so a mid-turn kill leaves no record that the turn was never checkpointed. This is the
    same gate the tray consults before auto-restarting.

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

**Asserting layout geometry — a verify script, not a component test.** The guidance above is about
LOOKING at a rendered cockpit. ASSERTING on its box model is a separate job with a separate tool.
The component suite runs under happy-dom, which has **no layout engine**: `clientHeight`,
`scrollHeight`, and `getBoundingClientRect()` all read 0 there (measured mt#3338), so a
"this container scrolls" assertion cannot be written in it — only a class-name surrogate, which
pins the CSS shape that produced correct geometry and cannot catch a regression that leaves those
classes intact while breaking the layout (a new wrapper element, a changed breakpoint, an ancestor
that starts clipping). That is exactly the defect class mt#3335 was.

For those, add a `scripts/verify-*.ts` that drives the SAME shared dev chromium over CDP —
`scripts/verify-cockpit-shell-scroll.ts` (mt#3338) and `scripts/verify-conversation-live-tail.ts`
(mt#3376/mt#3445) are the worked examples, and `scripts/README.md` §Running the browser-driving
scripts carries their shared prerequisites. This EXTENDS the chrome-devtools/CDP posture above
rather than departing from it: same browser, same attachment, `Runtime.evaluate` instead of a
screenshot. Playwright remains the fallback for neither of these jobs.

Which to reach for:

| Question | Tool |
| --- | --- |
| Does this render / behave / call the right handler? | component test (`bun run test:components`) |
| Does this have the right box model — does it scroll, overflow, fit? | `scripts/verify-*.ts` over CDP |
| What does this look like right now? | chrome-devtools-mcp on the shared canary |

These verify scripts are local/operator-run, not CI jobs — CI has neither a cockpit daemon nor a
dev chromium. Each exits 0 with a `SKIP:` line when its prerequisites are absent, so running one
unattended is safe.

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

- **`docs/design-system.md`** (mt#2915) — declared design-system artifact: type scale, spacing decision, component inventory, status/severity semantics, icon decision.
- **`docs/brand-system.md`** — color/typography/motion source of truth; §7 carries the current cockpit token mapping.
- **mt#2914** — design-system umbrella (declare / unify / enforce). **mt#2917** — register-unification pass that adopts `design-system.md`'s tokens across widgets.
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