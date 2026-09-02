/**
 * Activity-feed event rendering — bespoke copy for the types that earn it, and a
 * payload-driven default for everything else (mt#4775).
 *
 * **Why a default rather than one `case` per type.** The server's
 * `SYSTEM_EVENT_TYPE_VALUES` had 30 members while `ActivityPage`'s own union had
 * 9, so 21 event types rendered as `Unknown event (…)`. mt#3240 shipped the
 * fallback that stops an unmodelled type from crashing the page; this closes the
 * remaining half — an unmodelled type now renders its name and its payload
 * instead of the literal word "Unknown".
 *
 * Hand-writing the missing 21 would have drifted again at the 31st type. The
 * client cannot import the server enum (the bundle bans value imports from
 * `@minsky/domain`, mt#3239), so there is no way to make the union track it
 * automatically — which means the default IS the mechanism and the bespoke map
 * is the enhancement. `enum-drift.test.ts` asserts every server type renders
 * without the fallback wording, so a 31st type is covered on the day it lands.
 *
 * This module is deliberately React-free and dependency-free so the drift test
 * in `packages/domain` can import it directly.
 */

export interface EventStyle {
  icon: string;
  label: string;
  badgeClass: string;
}

/** The minimum shape this module renders. Mirrors the page's `SystemEvent`. */
export interface RenderableEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

const MUTED = "bg-muted text-muted-foreground";
const DESTRUCTIVE = "bg-destructive text-destructive-foreground";

/**
 * The event types this module claims hand-written copy for.
 *
 * Named as a union so the `satisfies` below restores compile-time completeness
 * over the BESPOKE set (PR #3577 R1): adding a member here without a map entry
 * fails typecheck. This is deliberately not the wire's type — the map stays
 * partial with respect to the server enum, because the derived default covers
 * the remainder and a union claiming to cover the wire is what drifted to 9 of
 * 30 in the first place.
 */
export type StyledEventType =
  | "ask.created"
  | "task.auto_created"
  | "pr.review_posted"
  | "subagent.failed"
  | "embeddings.provider_degraded"
  | "task.status_changed"
  | "pr.merged"
  | "subagent.completed"
  | "session.started";

/**
 * Event types with hand-written copy. Everything else takes the derived default
 * below — this map is an enhancement over a correct default, never the
 * mechanism, so it is deliberately partial with respect to the server's enum.
 */
export const STYLED_EVENTS: Record<string, EventStyle> = {
  "ask.created": {
    icon: "?",
    label: "Ask created",
    badgeClass: "bg-accent text-accent-foreground",
  },
  "task.auto_created": {
    icon: "+",
    label: "Task auto-filed",
    badgeClass: "bg-secondary text-secondary-foreground",
  },
  "pr.review_posted": { icon: "R", label: "Review posted", badgeClass: MUTED },
  "subagent.failed": { icon: "!", label: "Subagent failed", badgeClass: DESTRUCTIVE },
  "embeddings.provider_degraded": {
    icon: "~",
    label: "Embeddings degraded",
    badgeClass: DESTRUCTIVE,
  },
  "task.status_changed": { icon: ">", label: "Task status changed", badgeClass: MUTED },
  "pr.merged": { icon: "M", label: "PR merged", badgeClass: MUTED },
  "subagent.completed": { icon: "*", label: "Subagent completed", badgeClass: MUTED },
  "session.started": { icon: "S", label: "Session started", badgeClass: MUTED },
} satisfies Record<StyledEventType, EventStyle>;

/**
 * Domain segments that are acronyms, not words (PR #3577 R1).
 *
 * Sentence-casing the first segment renders `mcp.disconnect` as "Mcp
 * disconnect". `mcp` is a live enum member with no bespoke entry, so it hits the
 * derived path today; `pr.*` is listed because the two `pr` types that exist now
 * have hand-written copy, and the next one added would not.
 */
const ACRONYM_SEGMENTS = new Set(["pr", "mcp", "ci", "ai", "db", "api", "url", "sql", "cli"]);

/**
 * Turn `guard.overridden` into `Guard overridden`, and `mcp.disconnect` into
 * `MCP disconnect`.
 *
 * Every server event type is `domain.snake_case_action`, so the type name itself
 * carries a readable label — which is why a derived default is legible rather
 * than a placeholder. A type that does not match that shape still renders its
 * own name, which beats the word "Unknown".
 */
export function deriveEventLabel(type: string): string {
  const words = type.replace(/\./g, " ").replace(/_/g, " ").trim();
  if (!words) return type;
  const parts = words.split(/\s+/);
  const first = parts[0] ?? "";
  const head = ACRONYM_SEGMENTS.has(first.toLowerCase())
    ? first.toUpperCase()
    : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...parts.slice(1)].join(" ");
}

export function eventStyle(type: string): EventStyle {
  const styled = STYLED_EVENTS[type];
  if (styled) return styled;
  return { icon: "•", label: deriveEventLabel(type), badgeClass: MUTED };
}

/** Payload keys that carry no reader value in a one-line summary. */
const NOISY_KEYS = new Set(["id", "timestamp", "ts", "createdAt"]);

/**
 * Render a payload as `key=value` pairs, most useful keys first.
 *
 * Scalars only: an object or array value renders as its type rather than as
 * nested JSON, because a feed row is one line and a stringified object reliably
 * blows past it.
 */
export function deriveEventSummary(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (NOISY_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${String(value)}`);
    if (parts.length === 4) break;
  }
  return parts.length > 0 ? parts.join(" · ") : "(no payload)";
}

export function eventSummary(event: RenderableEvent): string {
  const p = event.payload ?? {};
  switch (event.eventType) {
    case "ask.created":
      return `${String(p.kind ?? "ask")}: ${String(p.title ?? "(untitled)")}`;
    case "task.auto_created":
      return `${String(p.createdBy ?? "sweeper")} filed: ${String(p.title ?? "(untitled)")}`;
    case "pr.review_posted":
      return `PR #${String(p.prNumber ?? "?")} — ${String(p.state ?? "review")} by ${String(p.reviewer ?? "bot")}`;
    case "subagent.failed":
      return `${String(p.agentType ?? "agent")} on ${String(p.taskId ?? "?")} — ${String(p.outcome ?? "failed")}`;
    case "embeddings.provider_degraded":
      return `${String(p.provider ?? "provider")} degraded — ${String(p.degradedReason ?? p.errorCode ?? "error")}`;
    case "task.status_changed":
      return `${String(p.taskId ?? "?")}: ${String(p.previousStatus ?? "?")} → ${String(p.newStatus ?? "?")}`;
    case "pr.merged":
      return `PR #${String(p.prNumber ?? "?")} merged${p.taskId ? ` (${String(p.taskId)})` : ""}`;
    case "subagent.completed":
      return `${String(p.agentType ?? "agent")} on ${String(p.taskId ?? "?")} — ${String(p.outcome ?? "completed")}`;
    case "session.started":
      return `Session started${p.taskId ? ` for ${String(p.taskId)}` : ""}`;
    default:
      return deriveEventSummary(p);
  }
}
