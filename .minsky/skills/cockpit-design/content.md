# cockpit-design — Minsky-domain patterns for Cockpit UI work

You are designing or implementing UI for Minsky's Cockpit web app (`src/cockpit/web/**`). The 12 vendored community skills (Impeccable, frontend-design, react-best-practices, tailwind-v4-shadcn, etc.) cover general patterns. This skill adds the Minsky-specific layer: which entities exist, what their states mean, what UI conventions apply, and what NOT to abstract.

The path-scoped surface `src/cockpit/CLAUDE.md` is the always-on floor — read it first if you haven't. This skill is the depth layer; CLAUDE.md is the breadth.

## When to invoke

- Designing a new Cockpit widget
- Rebuilding an existing widget on the bundle stack (shadcn/ui + TanStack Query)
- Adding entity displays (tasks, sessions, changesets, PRs, asks)
- Implementing command-palette interactions
- Implementing drill-down navigation
- Auditing existing Cockpit UI against Minsky-domain conventions

## The Minsky domain model

Cockpit visualizes Minsky's internal state. Six core entities + their states are the IA organizing layer. Surface them; don't abstract them away.

### Tasks (mt#X)

The canonical work-item primitive. Every task has:

- **Anchor:** `mt#X` (always monospace, always lowercase `mt`, e.g., `mt#1772`). Display this prominently — it's the universal cross-reference.
- **Title:** human-readable description.
- **Status:** state machine — `TODO → PLANNING → READY → IN-PROGRESS → IN-REVIEW → DONE`, plus side branches `BLOCKED` and `CLOSED`.
- **Parent + children:** optional task graph edges (mt#X has parent mt#Y, children mt#Z1, mt#Z2).
- **Tags:** keyword labels (e.g., "cockpit", "bug", "build").

#### Status state machine

The forward path is `TODO → PLANNING → READY → IN-PROGRESS → IN-REVIEW → DONE`. Backward transitions are forbidden (e.g., `IN-PROGRESS → READY` refuses). Side states: `BLOCKED` (from PLANNING/READY/IN-PROGRESS), `CLOSED` (from any state — abandoned or superseded).

#### Status color conventions

Use semantic tokens, not raw colors. Pattern (uses shadcn semantic palette + may need a `warning` semantic token added):

- TODO: `text-muted-foreground bg-muted` — neutral gray
- PLANNING: `text-foreground bg-secondary` — active but pre-work
- READY: `text-primary-foreground bg-primary` — calls action
- IN-PROGRESS: `text-foreground bg-accent` — distinct from READY
- IN-REVIEW: `text-foreground bg-warning` — needs attention (warning palette may need addition)
- DONE: `text-muted-foreground bg-muted opacity-60` — settled, dim
- BLOCKED: `text-destructive-foreground bg-destructive/30` — urgent
- CLOSED: `text-muted-foreground line-through opacity-50` — terminal

If the `warning` token doesn't exist in the semantic palette, add it to `tailwind.config.ts` and the CSS variable system before using it. Don't fall back to raw hex.

### Sessions

A session is the agent's workspace for a task. Has:

- **Session ID:** UUID-shaped, e.g., `577bbf25-90e5-4229-bc6a-60bcd4083b38`. Display the first 8 chars + ellipsis when space-constrained; full ID on hover or detail view.
- **Task ID:** the `mt#X` this session implements.
- **Branch:** the git branch (typically `task/mt-NNNN`).
- **Liveness:** `healthy | idle | stale | exited` — see mt#951 SessionRecord.
- **Last activity timestamp:** absolute + relative (`2m ago`, `1h ago`).

#### Session liveness conventions

- `healthy`: green dot (`bg-success` if added, else `bg-green-500`) + relative time
- `idle`: yellow dot + relative time
- `stale`: orange dot + relative time + "stale" label
- `exited`: gray dot + "exited" label, optional reason

### Changesets

VCS-agnostic abstraction for "a unit of proposed change" (mt#1335 ADR-008). Maps to:

- GitHub PR (most common today)
- GitLab MR (future)
- Local-only diff (future)

Display fields:

- **Reference:** `#NNNN` for GitHub (e.g., `#1077`), `!NN` for GitLab, hash prefix for local
- **Title:** short description
- **State:** `open | closed | merged | draft`
- **Author:** bot identity (`minsky-ai[bot]` or `minsky-reviewer[bot]`) or user login
- **Branch:** head ref

### PRs (GitHub-specific)

Subtype of changeset. Adds:

- **Review state:** combination of CI status + reviewer-bot state
- **Reviews:** `APPROVED` / `CHANGES_REQUESTED` / `COMMENT` counts by reviewer
- **CI:** N of M checks passing

When displaying PRs in lists, the canonical first column is the PR number (`#1077`); the canonical second column is the linked task (`mt#1772`). Operators connect those two anchors first.

### Asks (mt#1034)

Attention-requiring events. Eight ask kinds: `capability.escalate`, `information.retrieve`, `authorization.approve`, `direction.decide`, `coordination.notify`, `quality.review`, `stuck.unblock`, plus `compliance.audit` (latest). See `feedback_ask_subsystem_mcp_elicitation` for the routing/transport model.

Display fields:

- **Kind:** color-coded per category (sync vs. async, principal-facing vs. agent-to-agent)
- **Window:** `sync` (seconds), `async` (hours), or `open-ended`
- **Age:** how long the ask has been open
- **Source:** which agent or subsystem raised it
- **State:** `open | answered | expired | superseded`

Attention widget mt#1147 will render these; gated on mt#1034 + mt#454.

### Agents

The running unit of agent activity. Display fields:

- **Agent ID:** e.g., `a1b6015a2c0d23c5c` (16-char hex). Show prefix + ellipsis when space-constrained.
- **Model:** `sonnet` / `opus` / `haiku` (badge)
- **Type:** `implementer` / `reviewer` / `auditor` / `refactorer` / `cleaner` / `cockpit-dev` / etc.
- **Liveness:** mirrors session liveness
- **Current activity:** what tool last fired, when

## Mission-control density patterns

Cockpit is a dense operator dashboard, not an editorial surface. Operators scan, drill down, take action. The density posture:

### Tables with row-density toggles

Default to compact rows (single-line content + small padding). Provide a toggle for comfortable (multi-line content + larger padding). Match Linear / Sentry / Grafana conventions — keep density user-controlled.

Tailwind row sizing:

- Compact row: `py-1.5 text-sm`
- Comfortable row: `py-3 text-base`

### Information density cards

Cards aren't decorative. Each card carries 3–6 pieces of operator-relevant info in a compact layout. Avoid `<Card><CardTitle>X</CardTitle><CardContent>Y</CardContent></Card>` for one-fact displays — that's marketing-mode padding. Use cards when you have a coherent cluster of related info.

Compact card pattern for a single entity (session example):

```tsx
<Card className="p-3">
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2">
      <SessionLivenessDot status={session.liveness} />
      <span className="font-mono text-sm">{shortId(session.id)}</span>
      <Badge variant="secondary">{session.taskId}</Badge>
    </div>
    <span className="text-xs text-muted-foreground">{relativeTime(session.lastActivity)}</span>
  </div>
  <div className="mt-1 text-sm text-muted-foreground truncate">{session.branch}</div>
</Card>
```

### Status rollups at parent levels

When showing a parent task with children, display a status rollup (`3 IN-PROGRESS, 1 BLOCKED, 2 DONE`) rather than re-stating each child's full state. Operators scan rollups first, drill down for detail.

Rollup pattern: small badges in a row, colored by state, with count.

### Sparkline indicators

Trends matter for some entities (CI duration over time, ask close-time over last N, agent activity rate). Use sparklines — small inline charts — to encode trends without consuming screen space. The 12 vendored skills include `tanstack-query` for the data; pick a small chart lib (recharts, visx, hand-rolled SVG) per widget needs.

## Command palette (Cmd+K) UX

Cockpit needs a command palette for cross-entity jumps. Use the shadcn-ui `<Command>` primitive (from `cmdk`) once mt#1773 ships.

Conventions:

- **Cmd+K** opens the palette globally (Ctrl+K on non-Mac)
- **Esc** closes
- Typing filters live across all sources
- **Enter** executes the selected item
- **Arrow keys** navigate results

### Sources (categorized in palette)

1. **Tasks:** type `mt` or task number to jump (e.g., `mt 1772` → jump to task detail)
2. **Sessions:** type session ID prefix or branch name
3. **PRs:** type `#1077` or PR title text
4. **Agents:** type agent ID or type
5. **Actions:** common actions (`Start session for current task`, `Open PR for current session`, `Toggle widget X`)

### Visual structure

```tsx
<Command>
  <CommandInput placeholder="Search tasks, sessions, PRs, or actions..." />
  <CommandList>
    <CommandEmpty>No results.</CommandEmpty>
    <CommandGroup heading="Tasks">
      {tasks.map((t) => (
        <CommandItem key={t.id} value={`${t.id} ${t.title}`}>
          ...
        </CommandItem>
      ))}
    </CommandGroup>
    <CommandGroup heading="Sessions">...</CommandGroup>
    <CommandGroup heading="Actions">...</CommandGroup>
  </CommandList>
</Command>
```

### Anti-patterns to refuse

- **Cmd+K as menu replacement** — palette is for SEARCH + JUMP, not hierarchical action menus. Use a separate menubar/sidebar for navigation.
- **Modal blocking input** — Cmd+K should be a transient overlay, not a modal that blocks the dashboard.
- **Recent items as default** — show NOTHING until typing. Operators know what they want; stale recents obscure search.
- **Mouse-only navigation** — keyboard arrows + Enter must work; mouse is secondary.

## Drill-down navigation

Cockpit's primary navigation is drill-down: dashboard → entity detail → action → back.

### URL conventions

- Dashboard: `/` (no path)
- Task detail: `/task/mt#X` (URL-encode the `#` as `%23` if router requires)
- Session detail: `/session/<id>` (full UUID)
- PR detail: `/pr/<number>` (number only, repo is implicit)
- Agent detail: `/agent/<id>`
- Widget panels: `/widget/<name>` (e.g., `/widget/agents`)

### Breadcrumb conventions

When drill-down depth exceeds 2, render breadcrumbs:

```
Dashboard → Tasks → mt#1772 → Session 577bbf25
```

### Back / forward

The browser back/forward should work. Keyboard shortcuts:

- `Cmd+[` or `Backspace` (when not in an input): go back
- `Cmd+]`: go forward

### Drill-down patterns

- A clickable entity row → opens detail view
- Detail view has tabs for sub-views (e.g., session has tabs: overview, files, logs, PR)
- Each tab has its own URL fragment (`/session/<id>#files`)
- Deep links work — load any URL directly into the correct drilled-down state

## Dark-mode elevation conventions

Already covered in `src/cockpit/CLAUDE.md` and the `interface-design` vendored skill. Quick summary for cross-reference:

- Base background: near-black (HSL L ~3-5%)
- Card surfaces: lighter than background (L ~7%)
- Popover/dialog surfaces: even lighter (L ~10%)
- Elevation via lightness, not shadow
- Shadows decorative only

Refer to the `interface-design` skill for full treatment.

## Attention-debt visualization

Gated on mt#1034 + mt#454 (Asks subsystem + open-ask persistence). The Attention widget (mt#1147) will render this. Pattern stubs for when it ships:

### Open asks display

- Group by kind (`direction.decide`, `authorization.approve`, etc.)
- Sort by age within each group
- Color-code by urgency: red (>24h old or window expired), yellow (within window), gray (fresh)

### Window-bounded asks

Some asks have a deadline (sync window). Show the deadline visibly:

```tsx
<AskCard>
  <AskKind>{ask.kind}</AskKind>
  <AskAge>{relativeTime(ask.createdAt)}</AskAge>
  {ask.deadline && <AskDeadline>{deadlineRelative(ask.deadline)}</AskDeadline>}
</AskCard>
```

### Escalation badges

When an ask has escalated (deadline missed, bot intervention triggered, principal-level need), show an escalation badge with the reason.

## Workstream visualization

The Workstreams widget (mt#1452, DONE) shows parent tasks with collapsible children. Patterns:

### Parent task card

```tsx
<Card>
  <CardHeader>
    <CardTitle>
      <span className="font-mono">{parent.id}</span>: {parent.title}
    </CardTitle>
    <CardDescription className="flex items-center gap-3">
      <StatusBadge status={parent.status} />
      <ChildrenRollup children={children} />
      <LastActivity>{relativeTime(lastActivityTimestamp)}</LastActivity>
    </CardDescription>
  </CardHeader>
  <CardContent>
    <Collapsible>
      <CollapsibleTrigger>{children.length} children</CollapsibleTrigger>
      <CollapsibleContent>
        {children.map((c) => (
          <ChildRow key={c.id} task={c} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  </CardContent>
</Card>
```

### Activity feed integration

Each workstream card can show a recent-activity feed (last N events: commits, PRs, status changes). Implementation choice: separate `activity_events` table OR derive from PR + commit + status-set audit logs. The vendored skill `tanstack-query` covers caching the feed.

## Anti-patterns specific to Minsky

Refuse these Minsky-domain anti-patterns when designing Cockpit UI:

### 1. Generic "user" UI for a single-operator system

Cockpit is single-principal (edobry). Don't add multi-user concepts (avatars, teams, permissions, sharing) — they're noise for v0.

### 2. Marketing-mode entity displays

Tasks/sessions/PRs are operational entities. Don't add hero images, marketing copy, "celebrate completion" animations. Surface state, age, ID, branch — that's it.

### 3. Abstracted entity IDs

Show `mt#1772`, `#1077`, full session UUID directly. Don't replace with "Task A" / "Session 1" / "PR 3" — operators reference by ID across all surfaces (CLI, GitHub, MCP); a UI breaking that convention forces a translation layer.

### 4. Hiding the state machine

Show full status (`TODO`, `PLANNING`, `READY`, `IN-PROGRESS`, `IN-REVIEW`, `DONE`, `BLOCKED`, `CLOSED`). Don't compress to "active / done" or other 2-state collapses — operators need to distinguish PLANNING from READY from IN-PROGRESS.

### 5. Hover-only critical info

Critical state (status, age, blocking) should be visible without hover. Use hover for SECONDARY info (full timestamps, full IDs, expanded metadata).

### 6. Modal-everything

Cockpit is multi-panel by design. Avoid modals that block the dashboard for routine entity views — use side panels or full-page drill-down instead. Modals are for confirmations and ephemeral inputs only.

### 7. Polling without TanStack Query

When mt#1773 lands TanStack Query, all data fetching should use `useQuery` with sensible `staleTime` / `refetchInterval`. Don't use bare `fetch` + `setInterval` — it breaks cache invalidation on mutations and doesn't compose with the rest of the widget framework.

### 8. Treating widgets as standalone

The widget framework (mt#1144) lets each widget declare its data dependencies and degrade gracefully. Don't write a widget that crashes the dashboard when its data source is down — the framework expects you to return a `degraded` state with a useful message. Pattern: `<DegradedCard reason="session_provider unavailable" />`.

## Cross-references

- `src/cockpit/CLAUDE.md` — descriptive companion (path-scoped activation surface)
- `.minsky/agents/cockpit-dev/prompt.md` — prescriptive companion (agent prompt directives)
- The 12 vendored Tier-1 skills — general patterns this skill specializes (notably `interface-design` for elevation, `shadcn-ui` for primitives, `tanstack-query` for data, `react-best-practices` + `composition-patterns` for engineering)
- mt#1034 — Asks subsystem (attention layer; provides the data for attention-debt visualization)
- mt#1143 — Cockpit v0 umbrella
- mt#1144 — Shell + widget framework
- mt#1145 — Agents widget (existing implementation reference)
- mt#1146 — TaskGraph widget
- mt#1147 — Attention widget (gated on mt#1034)
- mt#1148 — Push transport (polling → SSE)
- mt#1335 ADR-008 — Changeset abstraction
- mt#1452 — Workstreams widget (existing implementation reference)
- mt#951 — SessionRecord liveness
- Memory `project_cockpit_stack_and_bundle` (id `0cc1304c-0de3-4e5e-8e7a-b446bc70a995`) — bundle reference
