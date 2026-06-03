# Skill Surfaces

Minsky has two distinct skill-related directories. They are NOT integrated and
serve different purposes. This doc names each so future agents don't conflate
them.

## `.minsky/skills/` — Minsky-authored skills (canonical)

Source of truth for skills authored as part of Minsky itself. Authoring is
**hybrid and location-canonical** per [ADR-015](adr-015-skill-authoring-format-policy.md)
(which amends [mt#800](https://www.notion.so/348937f03cb4811eb4bedb7057217dd3)'s
original TypeScript-first stance): a skill source under `.minsky/skills/<name>/`
may be EITHER a TypeScript module (`defineSkill()` in `skill.ts`, type-safe) OR a
markdown source — **canonicity comes from the `.minsky/` location, not the file
format**. Sources compile to harness-specific output under `.claude/skills/`,
`.cursor/rules/`, etc. via `bun run minsky compile`. (The markdown-source reader
is not built yet — mt#2279 — so as of this writing only `skill.ts` sources
compile; the 7 current Minsky-authored skills are all TypeScript.)

These skills participate in the Minsky compile pipeline and are loaded by
agents through harness-native discovery (Claude Code's `.claude/skills/`
auto-load, Cursor's `.cursor/rules/` auto-load, etc.).

Current Minsky-authored skills under `.minsky/skills/`:

- `cockpit-design`
- `fixture`
- `implement-task`
- `orchestrate`
- `plan-task`
- `merge-coordination`
- `verify-task`

Always checked into git. Edit the source (TypeScript or markdown) under
`.minsky/skills/`, then run `bun run minsky compile` to regenerate the
harness-specific outputs.

### Vendored community skills (third category)

Distinct from Minsky-authored skills: ~12 **vendored community skills** live
committed under `.claude/skills/<name>/` with a `_VENDORED.md` provenance marker
(source URL + commit SHA), sourced from upstream repos (e.g. `anthropics/skills`).
These are **upstream-canonical** — they are NOT authored under `.minsky/` and are
NOT compiled from it; update them by refetching from the upstream source URL. Do
not create a `.minsky/` source for a vendored skill (it would falsely claim
authorship and break refetch-update). The unified handling of vendored skills
across the compile pipeline + third-party installer is owned by the mt#1908
RFC. See ADR-015 for the carve-out.

## `.agents/skills/` — retired third-party install destination

`.agents/skills/` was the destination directory for third-party skills
installed by the `npx skills` tool ([vercel-labs/skills](https://github.com/vercel-labs/skills),
npm `skills` package). The `postinstall: npx skills experimental_install -y`
hook that auto-restored these skills was removed in mt#1902 (2026-05-19) after
audit found:

- Zero codebase references to any installed skill (the only locked skill,
  `supabase-postgres-best-practices`, was not consumed by any agent surface,
  rule, or configuration in the project)
- The install hook silently errored on some installs
  (`npm error Override without name: _comment_ansi_regex_strip_ansi`)
- Three accidental reverts of `skills-lock.json` in five weeks (mt#389
  `a2feea26`, mt#1168 `cbd668a9`, mt#1376 `c8367975`) indicated developer
  friction
- The tool is NOT integrated with Minsky's compile pipeline — it copies skill
  bodies into harness-specific destinations without going through the TypeScript
  source or `bun run minsky compile`

If a future need surfaces for third-party skill installation, the recommended
path is to author the desired skills directly under `.minsky/skills/` so they
flow through the compile pipeline. Re-introducing the `npx skills` postinstall
should require a concrete consumer that justifies the install-time cost.

`.agents/` is kept in `.gitignore` as a defensive measure: if any tool or
manual invocation populates the directory, it will not be committed.

### Local cleanup after upgrading

Developers who had the `npx skills` postinstall fire in their local checkout
before this PR landed will have a stale `.agents/skills/` tree under the repo
root. The directory is gitignored, so it stays around indefinitely unless
deleted. To clean up:

```sh
rm -rf .agents
```

This is a one-time cleanup; nothing in the repo will recreate `.agents/` after
the postinstall hook is gone.

## Quick reference

| Question                              | `.minsky/skills/`         | `.agents/skills/`       |
| ------------------------------------- | ------------------------- | ----------------------- |
| Canonical authoring location?         | Yes                       | No                      |
| Compiled by `bun run minsky compile`? | Yes                       | No                      |
| Checked into git?                     | Yes                       | No (gitignored)         |
| Active as of 2026-05-19?              | Yes                       | No (retired in mt#1902) |
| Read by any agent surface?            | Yes (via compiled output) | No                      |

## Cross-references

- [ADR-015](adr-015-skill-authoring-format-policy.md) — skill authoring format
  policy: hybrid (TypeScript or markdown), location-canonical; amends mt#800's
  TS-first stance for skills (mt#2251)
- [mt#800](https://www.notion.so/348937f03cb4811eb4bedb7057217dd3) — original ADR
  for TypeScript-first authoring of behavioral artifacts (skills, rules, agents),
  amended by ADR-015 for skills
- mt#1908 — RFC: unify compile pipeline + third-party skill installer (vendored
  community-skill category); mt#2279 — markdown-source reader; mt#2280 —
  two-compile-systems convergence
- mt#1902 — audit + retirement of the `npx skills` postinstall hook
- mt#1812, mt#1305 — Minsky compile pipeline tasks
- `docs/architecture/main-workspace-ops.md` — references the historical
  `skills-lock.json` pull-blocking incident (mt#1509 / 2026-05-01); the
  general lock-file-drift deadlock pattern remains relevant for other
  lockfiles even though `skills-lock.json` is now gone
