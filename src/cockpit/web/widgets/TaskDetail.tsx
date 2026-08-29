/**
 * TaskDetail widget frontend (mt#1918)
 *
 * Self-fetching via TanStack Query. Renders a single task's full detail view:
 * header (ID + title + status + kind), spec content, parent, children, and
 * deps (incoming + outgoing). Read-only; editing is deferred to v0.2.
 *
 * Takes the task ID from a URL param passed by the parent page component.
 */
import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { Button } from "../components/ui/button";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { Prose } from "../components/Prose";
import { EntityRef } from "../components/EntityRef";
import { useEntityIndex } from "../lib/use-entity-index";
import { useStartDrivenSession } from "../hooks/useStartDrivenSession";
import { statusStyle } from "../lib/status-colors";
import { cn } from "../lib/utils";
import { DISPATCH_MODELS, DEFAULT_DISPATCH_MODEL_ID } from "@minsky/domain/ai/dispatch-models";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

// ---------------------------------------------------------------------------
// Types — mirrors the /api/tasks/:id response shape
// ---------------------------------------------------------------------------

export interface TaskRef {
  id: string;
  title: string;
  status: string;
}

export interface TaskDetailPayload {
  task: {
    id: string;
    title: string;
    status: string;
    kind: string;
    tags: string[];
  };
  spec: string | null;
  parent: TaskRef | null;
  children: TaskRef[];
  deps: {
    outgoing: TaskRef[];
    incoming: TaskRef[];
  };
  /**
   * Stage-appropriate act-here actions (mt#2986) — computed server-side per the
   * stage→action map; empty for terminal statuses. Replaces mt#2959's
   * button-shaped `startability` boolean.
   */
  actions: TaskAction[];
}

export interface TaskAction {
  kind: "plan" | "start" | "resume" | "view-pr" | "drive";
  sessionId?: string;
  /** Driven-session local id — set on "drive" (mt#3400). */
  drivenSessionId?: string;
  prNumber?: number;
  /**
   * Qualified changeset id (mt#4724 `owner/repo#N` form; mt#4731 added
   * scope) — prefer this over `prNumber` when navigating, since a bare PR
   * number is ambiguous across projects. Bare (== `String(prNumber)`) when
   * the PR belongs to the default project.
   */
  changesetId?: string;
  note?: string;
}

// Must list EVERY kind the server can emit: `isTaskAction` gates the whole
// payload, so a kind missing here fails `isTaskDetailPayload` and drops the
// entire task page into ErrorState — not just the one unrecognized action.
const ACTION_KINDS = new Set(["plan", "start", "resume", "view-pr", "drive"]);

function isTaskAction(v: unknown): v is TaskAction {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.kind === "string" && ACTION_KINDS.has(a.kind);
}

function isTaskDetailPayload(v: unknown): v is TaskDetailPayload {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.task !== "object" || obj.task === null) return false;
  // Validate the actions contract (mt#2986) so a payload missing it fails
  // loudly (ErrorState) rather than silently dropping the act-here region.
  if (!Array.isArray(obj.actions)) return false;
  return (obj.actions as unknown[]).every(isTaskAction);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchTaskDetail(taskId: string): Promise<TaskDetailPayload> {
  const encoded = encodeURIComponent(taskId);
  const res = await fetch(`/api/tasks/${encoded}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<TaskDetailPayload>;
}

// ---------------------------------------------------------------------------
// Status badge — colors come from the shared ../lib/status-colors module
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const s = statusStyle(status);
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap"
      style={{ background: s.background, color: s.color, border: `1px solid ${s.border}` }}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Task ID chip — monospace, links to detail page.
//
// Routed through the shared <EntityRef> (mt#3187) rather than a hand-rolled
// <Link> so this chip gains the hover-card treatment. Children mode (id
// verbatim, no derived "id · label" text): every call site already renders
// the referenced task's title and <StatusBadge> immediately adjacent
// (TaskRefRow's title span; the Parent section's inline title span) — default
// mode would duplicate that info inline, the same "no duplicated title"
// discipline mt#3175 established for TaskGraph's node chip.
// ---------------------------------------------------------------------------

function TaskIdChip({ id }: { id: string }) {
  return (
    <EntityRef
      type="task"
      id={id}
      className="text-xs px-1.5 py-0.5 rounded bg-muted text-foreground hover:bg-muted/70 hover:no-underline transition-colors"
    >
      {id}
    </EntityRef>
  );
}

// ---------------------------------------------------------------------------
// Task reference row — ID chip + title + status badge
// ---------------------------------------------------------------------------

export function TaskRefRow({ task }: { task: TaskRef }) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border last:border-0">
      <StatusBadge status={task.status} />
      <TaskIdChip id={task.id} />
      <span className="text-sm truncate flex-1">{task.title}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spec content — rendered as Markdown via the shared <Prose> (mt#2550). Task
// specs are full Markdown documents (headings, lists, fenced code, tables) and
// reference other entities (mt#NNNN), so entity-linkification is wired in.
// ---------------------------------------------------------------------------

function SpecContent({ content, inPeek }: { content: string | null; inPeek: boolean }) {
  const entityIndex = useEntityIndex();
  if (!content) {
    return <p className="text-sm text-muted-foreground italic">No spec content</p>;
  }
  // In a peek pane the spec flows into the PANE's scroller and wears the PANE's
  // frame — it gets neither of its own (mt#4123).
  //
  // The page treatment is `max-h-[60vh] overflow-auto rounded bg-muted/20 p-3`,
  // and every part of it is page-reasoning: a route showing a long spec beside
  // other sections caps it so the page stays navigable, and tints it so it reads
  // as one block within a wider measure. Carried into a 416px pane, the cap
  // becomes a 540px window on a document measured at 10,845px — a scrollbar
  // inside a scrollbar, where the outer one then has almost nothing to move —
  // and the tint plus radius become a second frame drawn 16px inside the first.
  //
  // Nothing is hidden by removing them: the pane scrolls the whole spec, which
  // is what the operator opened it to read.
  return (
    <Prose
      entityIndex={entityIndex}
      className={inPeek ? undefined : "max-h-[60vh] overflow-auto rounded bg-muted/20 p-3"}
    >
      {content}
    </Prose>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper — consistent heading + content layout
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
  inPeek = false,
}: {
  title: string;
  children: React.ReactNode;
  inPeek?: boolean;
}) {
  // One step tighter in a pane, on the stock 4px scale: 16px between sections and
  // 8px under a heading is page rhythm, and a glance column is short of exactly
  // the axis it spends (mt#4123).
  return (
    <div className={inPeek ? "mt-3 first:mt-0" : "mt-4 first:mt-0"}>
      <h3
        className={cn(
          "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
          inPeek ? "mb-1.5" : "mb-2"
        )}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner — rendered after data is confirmed
// ---------------------------------------------------------------------------

/**
 * Act-here action region (mt#2986; supersedes mt#2959's single gated button).
 *
 * Renders the server-computed stage-appropriate actions: every non-terminal
 * stage offers at least one action that can actually succeed (principal-driven
 * launches are exempt from the planning gate); terminal stages render nothing.
 * A note, when present, is the honesty layer — secondary text under the
 * control, never the sole content.
 */
export function TaskActions({ taskId, actions }: { taskId: string; actions: TaskAction[] }) {
  if (actions.length === 0) return null;

  return (
    <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
      {actions.map((action, i) => (
        <TaskActionControl key={`${action.kind}-${i}`} taskId={taskId} action={action} />
      ))}
    </span>
  );
}

function TaskActionControl({ taskId, action }: { taskId: string; action: TaskAction }) {
  switch (action.kind) {
    case "plan":
      return (
        <LaunchActionButton
          taskId={taskId}
          label="Plan in session"
          ariaLabel={`Plan ${taskId} in a new session`}
          title="Starts a claude session in this task's workspace, composer primed with /plan-task"
          composePrefill={`/plan-task ${taskId}`}
          note={action.note}
        />
      );
    case "start":
      return (
        <LaunchActionButton
          taskId={taskId}
          label="Start session"
          ariaLabel={`Start a session for ${taskId}`}
          title="Starts a claude session (bypassPermissions) in the task's isolated workspace clone"
          note={action.note}
        />
      );
    case "drive":
      if (!action.drivenSessionId) return null;
      // mt#3400 — the one-hop return to a live driven session. Rendered
      // `default` (not `outline` like its siblings) because when this action is
      // present it IS the primary: the operator has work in flight here.
      //
      // Copy says "drive view", not "session": this control sits directly
      // beside the workspace action labeled "Open session", and two adjacent
      // buttons reading "Return to session" / "Open session" for two DIFFERENT
      // destinations is the ambiguity PR #2448 R1 flagged. "Drive view" is the
      // vocabulary the existing RunDetail banner already uses for this surface,
      // so this aligns with shipped copy rather than coining a new term.
      return (
        <Button asChild size="sm" className="h-7 px-2.5 text-xs">
          <Link
            to={`/driven/${encodeURIComponent(action.drivenSessionId)}`}
            aria-label={`Return to the live drive view for ${taskId}`}
            title="Return to the drive view for the session already running for this task"
          >
            Return to drive view
          </Link>
        </Button>
      );
    case "resume":
      if (!action.sessionId) return null;
      return (
        <Button asChild size="sm" variant="outline" className="h-7 px-2.5 text-xs">
          <Link to={`/agents/${encodeURIComponent(action.sessionId)}`}>Open session</Link>
        </Button>
      );
    case "view-pr": {
      if (action.prNumber === undefined || action.prNumber === null) return null;
      // mt#4731 (added scope): prefer the server-qualified changesetId
      // (mt#4724's `owner/repo#N` form) over the bare PR number — a bare
      // number is ambiguous once a second project can claim the same PR
      // number, the exact defect mt#4724's PR body flagged here. Falls back
      // to the bare number for a payload that predates the field.
      const changesetId = action.changesetId ?? String(action.prNumber);
      return (
        <Button asChild size="sm" variant="outline" className="h-7 px-2.5 text-xs">
          <Link to={`/changeset/${encodeURIComponent(changesetId)}`}>
            View PR #{action.prNumber}
          </Link>
        </Button>
      );
    }
    default:
      return null;
  }
}

/** Launchable control — the only path that mounts the launch mutation hook. */
function LaunchActionButton({
  taskId,
  label,
  ariaLabel,
  title,
  composePrefill,
  note,
}: {
  taskId: string;
  label: string;
  ariaLabel: string;
  title: string;
  composePrefill?: string;
  note?: string;
}) {
  const start = useStartDrivenSession();
  // mt#3040: the principal picks the model the driven session runs on.
  // Defaulted (Sonnet) with a visible override — the override IS the point (a
  // principal who can see a task needs Fable now has a channel), so it must not
  // force a per-launch choice (the approval-fatigue anti-pattern, mt#2880).
  const [modelId, setModelId] = useState(DEFAULT_DISPATCH_MODEL_ID);

  return (
    <span className="flex items-center gap-2">
      {start.isError && (
        <span className="text-xs text-destructive" role="alert">
          {start.error.message}
        </span>
      )}
      {note && !start.isError && (
        <span className="text-xs text-muted-foreground" role="note">
          {note}
        </span>
      )}
      <Select value={modelId} onValueChange={setModelId} disabled={start.isPending}>
        <SelectTrigger
          className="h-7"
          aria-label={`Model for ${label.toLowerCase()}`}
          title="Model the session runs on"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DISPATCH_MODELS.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        onClick={() => start.mutate({ taskId, composePrefill, model: modelId })}
        disabled={start.isPending}
        className="h-7 px-2.5 text-xs"
        aria-label={ariaLabel}
        title={title}
      >
        <Play className="h-3.5 w-3.5 mr-1" />
        {start.isPending ? "Starting…" : label}
      </Button>
    </span>
  );
}

function TaskDetailInner({
  data,
  inPeek = false,
}: {
  data: TaskDetailPayload;
  inPeek?: boolean;
}) {
  const { task, spec, parent, children, deps, actions } = data;

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div
        className={cn(
          "flex items-start gap-3 flex-wrap border-b border-border",
          inPeek ? "pb-3" : "pb-4"
        )}
      >
        <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-foreground">
          {task.id}
        </span>
        <StatusBadge status={task.status} />
        <span className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground">
          {task.kind}
        </span>
        {task.tags.map((tag) => (
          <span
            key={tag}
            className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
          >
            {tag}
          </span>
        ))}
        <TaskActions taskId={task.id} actions={actions} />
      </div>

      {/* Parent */}
      {parent && (
        <Section title="Parent" inPeek={inPeek}>
          <div className="flex items-center gap-2">
            <StatusBadge status={parent.status} />
            <TaskIdChip id={parent.id} />
            <span className="text-sm text-muted-foreground truncate">{parent.title}</span>
          </div>
        </Section>
      )}

      {/* Spec */}
      <Section title="Spec" inPeek={inPeek}>
        <SpecContent content={spec} inPeek={inPeek} />
      </Section>

      {/* Children */}
      <Section title={`Children (${children.length})`} inPeek={inPeek}>
        {children.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No children</p>
        ) : (
          <div>
            {children.map((c) => (
              <TaskRefRow key={c.id} task={c} />
            ))}
          </div>
        )}
      </Section>

      {/* Dependencies */}
      {(deps.outgoing.length > 0 || deps.incoming.length > 0) && (
        <Section title="Dependencies" inPeek={inPeek}>
          {deps.outgoing.length > 0 && (
            <div className="mb-3">
              <p className="text-xs text-muted-foreground mb-1">
                Depends on ({deps.outgoing.length}):
              </p>
              {deps.outgoing.map((d) => (
                <TaskRefRow key={d.id} task={d} />
              ))}
            </div>
          )}
          {deps.incoming.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Required by ({deps.incoming.length}):
              </p>
              {deps.incoming.map((d) => (
                <TaskRefRow key={d.id} task={d} />
              ))}
            </div>
          )}
        </Section>
      )}

      {deps.outgoing.length === 0 && deps.incoming.length === 0 && (
        <Section title="Dependencies" inPeek={inPeek}>
          <p className="text-sm text-muted-foreground italic">No dependencies</p>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch
// ---------------------------------------------------------------------------

interface TaskDetailBodyProps {
  taskId: string;
  query: UseQueryResult<TaskDetailPayload, Error>;
  /**
   * True when this body is rendering inside a peek pane (mt#4123).
   *
   * Threaded rather than read from a context: `variant` already travels this
   * path, one body needs the answer, and a context provider would be a second
   * render-context mechanism beside `WidgetVariant` — which is the one thing
   * `WidgetShell`'s docblock says the variant exists to avoid.
   */
  inPeek?: boolean;
}

function TaskDetailBody({ taskId, query, inPeek = false }: TaskDetailBodyProps) {
  if (query.isLoading) {
    return <LoadingState message={`Loading ${taskId}…`} className="font-mono" />;
  }

  if (query.isError) {
    const msg = query.error.message;
    const isNotFound = msg.includes("not found") || msg.includes("404");
    return (
      <ErrorState
        message={isNotFound ? `Task ${taskId} not found.` : `Error: ${msg}`}
        className="font-mono"
      />
    );
  }

  const data = query.data;
  if (!data || !isTaskDetailPayload(data)) {
    return <ErrorState message="Unexpected response shape." className="font-mono" />;
  }

  return <TaskDetailInner data={data} inPeek={inPeek} />;
}

// ---------------------------------------------------------------------------
// Main widget export — self-fetching via TanStack Query (mt#2373)
//
// Title is dynamic: taskId (font-mono) while loading/error, data.task.title
// (leading-snug) on success. WidgetShell title is registry-driven; the
// font-mono/leading-snug styling difference is preserved by rendering the
// title text inline via a `title` prop that switches on query state.
// ---------------------------------------------------------------------------

interface TaskDetailProps {
  taskId: string;
  /** Render-context variant; defaults to the full-page card frame. */
  variant?: WidgetVariant;
}

export function TaskDetail({ taskId, variant = "card" }: TaskDetailProps) {
  const query = useQuery<TaskDetailPayload, Error>({
    queryKey: ["task-detail", taskId],
    queryFn: () => fetchTaskDetail(taskId),
    staleTime: 30_000,
    retry: 1,
  });

  // Dynamic title: task.title on success, taskId while loading/error
  const title = query.data && isTaskDetailPayload(query.data) ? query.data.task.title : taskId;

  return (
    <WidgetShell variant={variant} title={title}>
      <TaskDetailBody taskId={taskId} query={query} inPeek={variant === "peek"} />
    </WidgetShell>
  );
}
