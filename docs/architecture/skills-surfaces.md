# Skill Surfaces

Minsky has two distinct skill-related directories. They are NOT integrated and
serve different purposes. This doc names each so future agents don't conflate
them.

## `.minsky/skills/` — Minsky-authored skills (canonical)

Source of truth for skills authored as part of Minsky itself. TypeScript-first
authoring per [mt#800](https://www.notion.so/348937f03cb4811eb4bedb7057217dd3):
each skill is defined via `defineSkill()` in `.minsky/skills/<name>/skill.ts`
and compiled to harness-specific output under `.claude/skills/`,
`.cursor/rules/`, etc. via `bun run minsky compile`.

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

Always checked into git. Edit the TypeScript source under `.minsky/skills/`,
then run `bun run minsky compile` to regenerate the harness-specific outputs.

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

- [mt#800](https://www.notion.so/348937f03cb4811eb4bedb7057217dd3) — ADR for
  TypeScript-first authoring of behavioral artifacts (skills, rules, agents)
- mt#1902 — audit + retirement of the `npx skills` postinstall hook
- mt#1812, mt#1305 — Minsky compile pipeline tasks
- `docs/architecture/main-workspace-ops.md` — references the historical
  `skills-lock.json` pull-blocking incident (mt#1509 / 2026-05-01); the
  general lock-file-drift deadlock pattern remains relevant for other
  lockfiles even though `skills-lock.json` is now gone
