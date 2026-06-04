# ADR-016: Compile Pipeline Convergence — One `compile` System, Sunset Legacy `rules compile`

## Status

Accepted (2026-06-03). Decision task: mt#2280. Migration epic: mt#2293.

## Context

Minsky has **two coexisting compile systems** that don't share a code path:

1. **Legacy `rules compile`** — command at `src/adapters/shared/commands/rules/compile-migrate-commands.ts`, implementation under `src/domain/rules/compile/`. Targets: `agents.md`, `claude.md`, `cursor-rules`. Reads **flat `.minsky/rules/*.mdc`** files. Writes the **monolithic `CLAUDE.md` / `AGENTS.md`** plus `.cursor/rules/<name>.mdc`. Pre-commit staleness: `runRulesCompileCheck` in `src/hooks/pre-commit.ts`.

2. **New `compile`** — command at `src/adapters/shared/commands/compile/compile-commands.ts`, implementation under `packages/domain/src/compile/`. Targets: `claude-skills`, `claude-agents`, `cursor-rules-ts`. Reads **per-artifact definition sources** (`.minsky/skills/<name>/{skill.ts,SKILL.md}`, `.minsky/agents/<name>/agent.ts`, `.minsky/rules/<name>/rule.ts`). Writes `.claude/skills/`, `.claude/agents/`, `.cursor/rules/<name>.mdc`. Pre-commit staleness: `runCompileCheck` in `src/hooks/pre-commit.ts` (added in mt#2252).

The two overlap and the split is incoherent:

- **Both write `.cursor/rules/*.mdc`** — legacy from flat `.mdc` rule sources, new (`cursor-rules-ts`) from `<name>/rule.ts` sources. The `cursor-rules-ts.ts` header documents this coexistence: "Both may write to `.cursor/rules/` but to different files."
- **Rules are split across two source formats and two pipelines** (~51 flat `.minsky/rules/*.mdc` in legacy; `<name>/rule.ts` in new).
- **Skills and agents** live only in the new system.
- **The monolithic `CLAUDE.md` / `AGENTS.md`** generation lives only in legacy.
- **Two pre-commit staleness checks** (`runRulesCompileCheck` + `runCompileCheck`) must both run and be maintained.

This dual-system state is a recurring source of confusion (which command regenerates which output?) and was a direct contributor to the mt#2182 / mt#2252 / mt#2253 / mt#2279 work — the new system had no staleness guard for weeks, and the `rules compile` vs `compile` distinction is non-obvious (`rules compile` with no `--target` does the monolithic compile, NOT the per-rule `.cursor/rules` generation).

## Decision

**Converge onto the new `compile` system as the single compile pipeline, and sunset the legacy `rules compile` system.**

The new `compile` system becomes the one pipeline for all behavioral-artifact compilation — skills, agents, AND rules — across all source formats (TypeScript `<name>/X.ts` and the hybrid markdown/`.mdc` forms per ADR-015) to all targets (per-artifact harness outputs, the monolithic `CLAUDE.md`/`AGENTS.md`, and `.cursor/rules/`). The legacy `rules compile` command and `src/domain/rules/compile/` implementation are deprecated and removed once every legacy target is served by the new system.

This matches the established direction: mt#800's `.minsky/`-canonical authoring, ADR-015's hybrid (TS-or-markdown) location-canonical policy, and the per-artifact-definition model the new `compile` already implements for skills and agents.

## Consequences

- This is a **multi-phase migration**, tracked as epic **mt#2293**:
  1. New `compile` gains monolithic `claude.md` / `agents.md` targets (byte-parity verified against legacy before switching).
  2. New `compile` handles the ~51 flat `.minsky/rules/*.mdc` rules — preferably via a flat-`.mdc` reader mirroring the mt#2279 hybrid SKILL.md reader, rather than forcing migration to `<name>/rule.ts`.
  3. Deduplicate the `.cursor/rules/` writers (`cursor-rules` + `cursor-rules-ts`) into one.
  4. Consolidate the two pre-commit staleness checks into one.
  5. Remove/deprecate `rules compile`; update CLAUDE.md `§Build & Test` and docs.
- **Until the migration completes, both systems coexist** — both pre-commit checks run, and the `cursor-rules` / `cursor-rules-ts` dual-write continues (to distinct files). This ADR records the target end-state and direction; it does not change behavior on its own.
- The `claude-agents` drift carried out of mt#2252 (excluded from the new staleness check; tracked by mt#1654) should be reconciled as part of, or before, phase 4.
- Retiring the `rules compile` command is a **contract change** — phase 5 must enumerate consumers (CLAUDE.md `§Build & Test`, `docs/*`, any `scripts/` or `.github/` invocations) per the contract-propagation discipline.

## References

- mt#2280 — this decision (two-compile-systems convergence)
- mt#2293 — the migration epic (5 phases above)
- mt#2249 — skill-compile source-of-truth umbrella
- ADR-015 / mt#2251 — hybrid, location-canonical authoring (the flat-`.mdc` reader in phase 2 mirrors mt#2279's SKILL.md reader)
- mt#2252 — `runCompileCheck` (the new-system pre-commit staleness check)
- mt#2279 — markdown-source reader (the hybrid reader pattern phase 2 follows)
- mt#1654 — `claude-agents` source-of-truth drift (reconcile before/with phase 4)
- mt#1908 — RFC: unify compile pipeline + third-party installer (a DISTINCT axis: Minsky-vs-third-party, not legacy-vs-new-compile)
- mt#800 — TypeScript-first authoring (the `.minsky/`-canonical direction this convergence completes)
