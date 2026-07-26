/**
 * Browser-safe predicate for "was this Ask closed by the system, not an operator?" (mt#3239).
 *
 * This is the SINGLE source of truth for the `system:<event>` / `"timeout"` automated-closure
 * responder convention. Two independent surfaces need it:
 *
 *   - Node side: `packages/domain/src/ask/close-as-resolved.ts` re-exports this for its existing
 *     callers (`src/adapters/shared/commands/asks.ts`, `packages/domain/src/ask/index.ts`).
 *   - Browser side: `src/cockpit/web/pages/AskPage.tsx` imports it directly from here.
 *
 * ## Why this moved out of `packages/domain/src/ask/close-as-resolved.ts` (mt#3239)
 *
 * The predicate itself is pure string matching and needs nothing from the logger. But it USED to
 * live in `close-as-resolved.ts`, a module that also imports `@minsky/shared/logger` for its
 * OTHER exports (`closeAskAsResolved`'s best-effort error logging). ES modules evaluate their
 * entire top-level body — including every import — regardless of which specific export a
 * consumer uses; a bundler can only elide an import when it can prove the import has no side
 * effects, and the logger module reads `process.env.*` at its top level, which is a real side
 * effect the bundler must conservatively preserve. So importing `isAutomatedClosureResponder`
 * from `close-as-resolved.ts` pulled the logger's module graph into the browser bundle too, and
 * `process` has no browser equivalent: the cockpit ask page crashed with
 * `Can't find variable: process` on load (mt#3215 / PR #2315 introduced the import; the crash was
 * reported live 2026-07-26).
 *
 * Moving the predicate into `packages/shared` — a package with NO logger dependency of its own —
 * gives both sides an import that is safe to evaluate anywhere. This is the same shape as
 * `packages/shared/src/ask-approval.ts` (mt#3203): shared ask vocabulary that both a Node adapter
 * and a browser/hook consumer need, living somewhere neither side's constraints veto.
 *
 * ## Why this matters (do not regress mt#3215 while repairing its delivery)
 *
 * `isAutomatedClosureResponder` distinguishes "closed, never actually answered" from a genuine
 * operator response. Both `responded` and `closed` are response-BEARING Ask states — an
 * automated closure (e.g. the stale-suspended-close sweep's parent-terminal signal) leaves
 * `ask.response` populated, the SAME field a real operator answer populates. Without this check,
 * a caller that only tests `ask.response != null` cannot tell the two apart (the ask#6024
 * incident, mt#3215: an operator was told their pending authorization ask had "already been
 * responded to" when it had actually been auto-closed, unanswered, by the parent-terminal sweep).
 * `AskPage.tsx` uses this to render "This ask was auto-closed by the system — it was NOT
 * answered by an operator" instead of presenting an auto-closure as if it were a real response.
 */

/**
 * True when `responder` names a closure that nobody actually answered — the `system:<event>`
 * convention (e.g. `system:commit-landed`, `system:pr-merged`, `system:parent-task-terminal`,
 * `system:superseded-by-later-commit`), OR the fixed `"timeout"` responder recorded when a
 * deadline passed with no response — rather than a genuine operator response or another agent's
 * answer.
 *
 * Deliberately does NOT include `"policy"`: a policy-covered resolution is a real, designed-for-
 * purpose answer (a covering policy statement pre-authorized the action) — not a heuristic
 * mootness signal that may have discarded a still-pending question. It is automated, but it IS
 * an answer, so surfaces are free to render `policy` as resolved; the string itself already
 * tells a reader it wasn't a human operator.
 */
export function isAutomatedClosureResponder(responder: string): boolean {
  return responder.startsWith("system:") || responder === "timeout";
}
