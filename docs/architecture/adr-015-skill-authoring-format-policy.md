# ADR-015: Skill Authoring Format Policy — Hybrid (TypeScript or Markdown), Location-Canonical

## Status

Accepted (2026-06-03). Amends the prior **TypeScript-first** decision in mt#800 ("TypeScript-first authoring for skills, rules, and agents"; Notion ADR https://www.notion.so/348937f03cb4811eb4bedb7057217dd3) — narrows its TS-first stance, for **skills**, to "TS-or-MD, location-canonical." TypeScript remains a first-class, recommended option; it is no longer mandatory.

## Context

Minsky skills compile from canonical sources in `.minsky/skills/<name>/` to harness outputs at `.claude/skills/<name>/SKILL.md`. As of 2026-06-02 the repo had **three coexisting authoring patterns with no policy**:

1. **7 TypeScript-sourced skills** — `.minsky/skills/<name>/skill.ts` (via `defineSkill`), type-safe and schema-validated, compiling to SKILL.md.
2. **~43 markdown-only skills** — authored directly as hand-written `.claude/skills/<name>/SKILL.md`, i.e. inside the harness-OUTPUT directory, with no `.minsky/` source at all.
3. **~12 vendored community skills** — installed from upstream into `.claude/skills/<name>/` with a `_VENDORED.md` provenance marker (upstream-canonical); a separate `skills` CLI (skills.sh) installer path lands third-party skills in `.agents/skills/`.

mt#800's prior ADR committed to TypeScript-first authoring across skills/rules/agents. Two forces pull against a TS-only mandate for skills:

- **Empirical:** 43 skills are authored as markdown and work fine; forcing them to TS is a large mechanical migration with no functional payoff for skills that are pure prose.
- **Principal position (2026-06-02):** canonicity comes from **location** (`.minsky/`), not from file format. `.claude/skills/` is a harness-output directory, not an authoring directory.

The compile pipeline is currently **TS-only**: `packages/domain/src/compile/targets/claude-skills.ts` `discoverSkillDirNames` finds only `skill.ts` and `extractSkillDefinition` dynamically imports the TS module. There is no markdown-source reader yet.

## Decision

**Skill authoring is HYBRID.** A canonical skill source lives under `.minsky/skills/<name>/` and may be EITHER:

- a **TypeScript** module (`skill.ts` via `defineSkill`) — type-safe, schema-validated, recommended for skills with structured metadata; OR
- a **markdown** source (`SKILL.md` / `content.md` + minimal metadata) — plain-text editable, appropriate for prose-dominant skills.

**Canonicity is by location, not format:** any source under `.minsky/skills/<name>/` is canonical; `.claude/skills/<name>/SKILL.md` is ALWAYS a compile output, never the canonical source.

**Exception — vendored community skills:** skills installed from upstream (marked by `_VENDORED.md`, or installed via the `skills` CLI into `.agents/skills/`) are **upstream-canonical** — they are NOT authored under `.minsky/` and are NOT compiled from it. Their source of truth is the upstream repo (update by refetching from the source URL). The unified handling of vendored skills across the compile pipeline + third-party installer is owned by mt#1908.

This **amends** mt#800: TypeScript stays first-class and recommended (type-safety + validation); markdown becomes an equally-canonical alternative. It does NOT force-migrate either the 7 TS-sourced skills or the 43 markdown skills.

## Consequences

- The compile pipeline must gain a **markdown-source reader** (it is TS-only today) — **mt#2279**. Until that ships, markdown sources placed under `.minsky/skills/` will not compile.
- The 43 markdown-only skills get backfilled as markdown sources under `.minsky/skills/` — **mt#2254** — EXCLUDING the ~12 vendored skills (backfilling those would falsely claim authorship and break refetch-update).
- When both `skill.ts` and a markdown source exist for one skill, precedence must be defined (mt#2279); an ambiguous canonical source is an error/warn, not a silent pick.
- Vendored-skill source-of-truth and the compile/installer unification remain open under **mt#1908**.
- The legacy `rules compile` vs new `compile` two-systems convergence question is separate and deferred to **mt#2280**.
- `.minsky/rules/skill-authoring.mdc` documents the canonical authoring workflow that follows from this decision.

## References

- mt#2251 — this decision (skill authoring format policy)
- mt#2249 — skill-compile source-of-truth umbrella
- mt#800 — amended TS-first authoring ADR (Notion)
- mt#2279 — markdown-source reader (the pipeline cost of this decision)
- mt#2254 — backfill the 43 markdown-only skills (excludes vendored)
- mt#1908 — RFC: unify compile pipeline + third-party skill installer (vendored category)
- mt#2280 — two-compile-systems convergence (legacy `rules compile` vs new `compile`)
- mt#2252 / mt#2253 — compile-hardening + drift reconciliation that preceded this decision
