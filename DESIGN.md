<!--
This file exists so tooling that reads a literal `DESIGN.md` (e.g. the vendored
plan-design-review skill's "Read: DESIGN.md — if it exists" gate) finds one at
the repo root. It is a real file, not a symlink — a repo-root symlink to
docs/design-system.md was tried first and reverted (mt#2915 PR #2042 review):
GitHub's contents API and non-symlink-following tools return the symlink's
TARGET STRING, not the target file's content, which would silently defeat the
gate for exactly the tooling this file exists to satisfy.

The canonical, single-source-of-truth content lives at docs/design-system.md
(do not duplicate it here — see that file's §1 for why brand-system.md and
this doc each own a distinct, non-overlapping layer).
-->

# Cockpit design system

See [`docs/design-system.md`](docs/design-system.md) for the full, canonical design-system
declaration: type scale, spacing-scale decision, component inventory with interaction states,
status/severity color semantics (incl. the red-scarcity rule), and the icon decision.
