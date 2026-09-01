/**
 * Cross-project needs-me leak computation (mt#4794).
 *
 * When a specific project filter is active, the scoped Attention badge alone
 * can read "clear" while other projects carry pending asks — a self-imposed
 * attentional blind spot verified live during the mt#4757 audit (Peezombie
 * filter active: rail read "clear"; Minsky project: 40+ pending asks). The
 * filter is a VIEW control and must never silence the cockpit's only
 * glance-level needs-me signal — a needs-me signal from outside the selected
 * scope should leak through as a muted secondary indicator, never louder
 * than the primary scoped signal.
 *
 * `elsewhereCount` is the shared decision both the rail Attention nav item
 * (`components/Rail.tsx`) and the home "Needs you" region (`pages/HomePage.tsx`)
 * render as that muted secondary. Pure so the three fixture states (scoped
 * 0/unscoped N, scoped N/unscoped N, All-projects) are testable without a DOM
 * or a live server — see `testing-standards.mdc §Testable Design`.
 */
export function elsewhereCount(
  filterActive: boolean,
  scoped: number | undefined,
  unscoped: number | undefined
): number | null {
  // All-projects: there is no "elsewhere" to leak from — never renders.
  if (!filterActive) return null;
  // Either count still loading/errored — stay quiet rather than flash a
  // wrong number while data settles.
  if (typeof scoped !== "number" || typeof unscoped !== "number") return null;
  const diff = unscoped - scoped;
  // Equal (or, in principle, scoped > unscoped — should not happen since the
  // scoped cohort is a subset of the unscoped one, but a non-positive diff
  // never renders either way) means nothing leaks.
  return diff > 0 ? diff : null;
}
