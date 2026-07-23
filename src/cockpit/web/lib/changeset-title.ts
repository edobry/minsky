/**
 * Changeset display-title helper (mt#3096).
 *
 * WHY THIS LIVES IN web/lib AND NOT IN `src/cockpit/session-detail.ts`:
 * `session-detail.ts` is a SERVER module — it imports `@minsky/domain` at
 * runtime (session types, task-id utils, changeset types). Web files may import
 * TYPES from it, because `import type` is erased before bundling, but importing
 * a runtime VALUE forces Vite/Rollup to resolve and bundle the whole server
 * module graph into the browser bundle. That fails the production build outright
 * ("Could not resolve ../../session-detail"), and would be wrong even if it
 * resolved.
 *
 * So the shared *runtime* helper lives here, where both the changesets LIST row
 * and the changeset DETAIL header can import it. Sharing it is the point: the
 * originating bug was those two surfaces drifting, with the detail page
 * rendering a literal "(no title)" where the row it was reached from already
 * fell back to the task title.
 *
 * Type-only imports below are erased at build time and are safe.
 */
import type { SessionPrRef, SessionDetailMeta } from "../../session-detail";

/** First value that is a non-blank string, else undefined. */
function firstNonBlank(...values: (string | null | undefined)[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Display title for a changeset, with the fallback chain that keeps a missing
 * PR title from rendering as a placeholder.
 *
 * Treats blank/whitespace titles as missing, not just null, and never returns
 * an empty string.
 */
export function changesetDisplayTitle(
  pr: Pick<SessionPrRef, "title" | "headBranch" | "number">,
  session: Pick<SessionDetailMeta, "taskTitle" | "taskId"> | null | undefined
): string {
  return (
    firstNonBlank(pr.title, session?.taskTitle, session?.taskId, pr.headBranch) ??
    (pr.number != null ? `PR #${pr.number}` : "Untitled changeset")
  );
}
