/**
 * Shared task-status color mapping (mt#2909).
 *
 * Consolidates the FOUR byte-identical raw-hex `statusStyle()` copies that
 * previously lived in TaskGraph.tsx, Workstreams.tsx, TaskList.tsx, and
 * TaskDetail.tsx into one module. Values are expressed as
 * `oklch(var(--token) / alpha)` CSS color strings — the same pattern already
 * used elsewhere in the cockpit for inline-style consumers that can't use a
 * Tailwind `className` directly (e.g. `src/cockpit/web/lib/plant-gestures.ts`,
 * `PlantFlowPage.tsx`) — so every consumer resolves to the SAME semantic
 * design token regardless of whether it renders via `style={}` (react-flow
 * node fills, toggle-pill backgrounds) or could otherwise use `className`.
 *
 * The token family + alpha per status matches the recommended mapping in
 * `.minsky/skills/cockpit-design/SKILL.md` §Status color conventions
 * (READY -> primary, IN-PROGRESS -> accent, IN-REVIEW -> warn-amber/30,
 * DONE -> liveness-healthy/30, BLOCKED -> warn-red/40, PLANNING -> secondary,
 * TODO/CLOSED -> muted). Border colors are not specified by the skill's
 * className list (which targets plain badges with no border utility); this
 * module derives a border from the same token family so consumers that were
 * previously rendering a `1px solid <border>` (all four original call sites)
 * keep a visible outline. This is a token-substitution + consolidation pass
 * only — it does NOT change which status maps to which token family.
 */

export type TaskStatus =
  | "TODO"
  | "PLANNING"
  | "READY"
  | "IN-PROGRESS"
  | "IN-REVIEW"
  | "DONE"
  | "BLOCKED"
  | "CLOSED";

export interface StatusStyle {
  background: string;
  border: string;
  color: string;
}

/**
 * Per-status color triples. Values are CSS `oklch(var(--token) / alpha)`
 * strings, not raw hex — see module doc comment above for the token mapping
 * this mirrors.
 *
 * Alpha choices: `background` alpha matches the SKILL.md className suffix
 * verbatim for the three statuses it specifies one for (`/30` -> 0.3 for
 * IN-REVIEW and DONE, `/40` -> 0.4 for BLOCKED); the remaining statuses
 * (TODO, PLANNING, READY, IN-PROGRESS, CLOSED) use the token at full opacity,
 * matching the SKILL's classNames for those statuses (`bg-muted`,
 * `bg-secondary`, `bg-primary`, `bg-accent` — no alpha suffix). `border` is
 * always full-opacity — it isn't part of the SKILL's className list (which
 * targets borderless badges); see the module doc comment above.
 */
const STATUS_STYLES: Record<TaskStatus, StatusStyle> = {
  TODO: {
    background: "oklch(var(--muted))",
    border: "oklch(var(--muted-foreground) / 0.4)",
    color: "oklch(var(--muted-foreground))",
  },
  PLANNING: {
    background: "oklch(var(--secondary))",
    border: "oklch(var(--foreground) / 0.25)",
    color: "oklch(var(--foreground))",
  },
  READY: {
    background: "oklch(var(--primary))",
    border: "oklch(var(--primary-foreground) / 0.35)",
    color: "oklch(var(--primary-foreground))",
  },
  "IN-PROGRESS": {
    background: "oklch(var(--accent))",
    border: "oklch(var(--foreground) / 0.25)",
    color: "oklch(var(--foreground))",
  },
  "IN-REVIEW": {
    background: "oklch(var(--warn-amber) / 0.3)",
    border: "oklch(var(--warn-amber))",
    color: "oklch(var(--foreground))",
  },
  DONE: {
    background: "oklch(var(--liveness-healthy) / 0.3)",
    border: "oklch(var(--liveness-healthy))",
    color: "oklch(var(--foreground))",
  },
  BLOCKED: {
    background: "oklch(var(--warn-red) / 0.4)",
    border: "oklch(var(--warn-red))",
    color: "oklch(var(--destructive-foreground))",
  },
  CLOSED: {
    background: "oklch(var(--muted))",
    border: "oklch(var(--muted-foreground) / 0.3)",
    color: "oklch(var(--muted-foreground))",
  },
};

const KNOWN_STATUSES = new Set<string>(Object.keys(STATUS_STYLES));

/**
 * Normalize an arbitrary status string to a known `TaskStatus`.
 *
 * Preserves one behavior already present across the four pre-consolidation
 * copies: case-insensitive matching (TaskList.tsx / TaskDetail.tsx called
 * `status.toUpperCase()` before switching).
 *
 * The `COMPLETED` -> `DONE` alias this function carried at mt#2909 shipping
 * time was retired at mt#2919: a `tasks_list(all:true)` probe across the
 * live minsky-backend task set (every TODO/PLANNING/READY/IN-PROGRESS/
 * IN-REVIEW/DONE/BLOCKED/CLOSED row, 5591-line dump) found zero tasks
 * carrying status COMPLETED — it was never part of the canonical state
 * machine (TODO -> PLANNING -> READY -> IN-PROGRESS -> IN-REVIEW -> DONE,
 * side states BLOCKED/CLOSED), and no live data depended on the alias.
 * Unknown statuses (including a stray COMPLETED, should one ever appear)
 * fall back to TODO's neutral styling, matching every original switch's
 * `default` branch.
 */
function normalizeStatus(status: string): TaskStatus {
  const upper = status.trim().toUpperCase();
  return KNOWN_STATUSES.has(upper) ? (upper as TaskStatus) : "TODO";
}

/** Resolve a task status (any case) to its shared color triple. Unknown statuses,
 * including the retired `COMPLETED` alias (see normalizeStatus above), fall back
 * to TODO's neutral styling. */
export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLES[normalizeStatus(status)];
}
