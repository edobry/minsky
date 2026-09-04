# The shipped rule corpus

> **This file replaced the rule _template system_ guide (mt#4974).** The template
> system it documented — `packages/domain/src/rules/templates/*.ts`,
> `RuleTemplateService`, and the `minsky rules generate` command — no longer
> exists. The path is kept so old links resolve to an explanation rather than a 404. Skip to [What replaced it](#what-replaced-it) for the current mechanism.

## What was retired, and why

Until mt#4974, the only rules Minsky installed into a project it manages were six
TypeScript string templates rendered at `init` time. Measured in a scratch repo on
2026-09-04, that mechanism was broken in three independent ways:

- **Nothing read the output.** None of the six carried `alwaysApply: true` or
  `globs`, so they landed in neither `CLAUDE.md` nor `.claude/rules` — the only
  two channels Claude Code retrieves automatically. A fresh project got a 90-byte
  `CLAUDE.md` and 43 KB of prose no agent would ever open.
- **Three carried wrong instructions.** They told agents to run `git approve` (a
  command that does not exist), to set IN-REVIEW before creating the PR, and to
  set DONE by hand — which this repository's own rules forbid outright.
- **The failure was invisible.** Rendering required the shared command registry,
  and `init` wrapped the call in a bare `catch {}`, so a genuine scaffolding
  failure and a unit-test environment produced identical output: none.

The content worth shipping already existed as markdown in `.minsky/rules/*.mdc`.
Re-encoding it as TypeScript string literals is what let the templates drift from
reality without anything noticing.

## What replaced it

**A package-resident corpus of markdown rules**, at
`packages/domain/src/rules/corpus/*.mdc`. A shipped rule is the same kind of
artifact the compile pipeline already reads, with three metadata fields added.

| Piece                       | Where                                              |
| --------------------------- | -------------------------------------------------- |
| The rules themselves        | `packages/domain/src/rules/corpus/*.mdc`           |
| Loading + tier selection    | `packages/domain/src/rules/corpus.ts`              |
| Writing them into a project | `packages/domain/src/init/rule-corpus-scaffold.ts` |
| Migration hashes            | `packages/domain/src/init/scaffold-history.ts`     |
| Build copy into `dist/`     | `package.json` → `build:copy-rule-corpus`          |

### Frontmatter

Beyond the existing `description` / `alwaysApply` / `globs` / `tags`, a corpus
rule declares:

```yaml
plane: product # product | plant | mixed | template
tier: base # base | opinionated | style
minimumRung: T1 # T0-T4
onDemand: true # optional; see below
```

`plane` records whether a rule is useful outside Minsky itself. `tier` decides
what ships and what a user may decline. `minimumRung` is the lowest adoption rung
at which the rule is proposed.

**A tier is not an enforcement level.** `base` does not bind more strongly than
`opinionated` once both are present — it means the user cannot decline it, because
declining breaks Minsky.

`onDemand: true` declares that landing in neither `CLAUDE.md` nor `.claude/rules`
is _deliberate_ — the rule is fetched by name with `rules_get`. Without the marker,
that state is indistinguishable from a misconfigured rule (mt#3107).

**These fields never reach harness output.** `buildRuleMdc` composes
`.cursor/rules/*.mdc` frontmatter from its own allow-list, so metadata that steers
_shipping_ cannot leak into an artifact that steers _behavior_.

### What `init` writes

Only the `base` tier. Opinionated rules ship in the corpus and are deliberately
**not** written, because until Phase 2 (mt#573) wires selection there is no way for
a user to decline one — and installing a declinable rule nobody was asked about is
the thing that must not happen at any intermediate step. `init` reports what it
withheld.

### Overwrite is content-aware

`init --overwrite` used to replace rule files unconditionally, which for a file a
user may have edited is indistinguishable from discarding their work. It now
replaces a file whose content matches a hash Minsky is known to have shipped, and
**reports** one that does not, leaving it alone. The hash table and its coverage
bound are documented in `scaffold-history.ts`.

## Adding or changing a shipped rule

1. Add or edit the `.mdc` under `packages/domain/src/rules/corpus/`.
2. Give it `plane`, `tier`, and `minimumRung`. If it is neither always-apply nor
   glob-scoped, add `onDemand: true` — or it ships unreachable.
3. Run the corpus tests: `bun test packages/domain/src/rules/corpus.test.ts`.

Promoting a rule to `base` is not a routine edit: it makes the rule
non-declinable for every Minsky user. The current base set was scoped by the
principal (recorded on mt#4964) rather than derived from the corpus audit's
candidate tier column.

## Related

- RFC "The rules Minsky ships" (Notion `3ce937f0`, Accepted 2026-09-04) — the
  plane split, tiers, and selection-at-init design.
- mt#4744 — the 61-row corpus audit the promotion set comes from.
- mt#573 — Phase 2, which wires selection so opinionated rules become installable.
- ADR-016 — the compile pipeline this corpus feeds.
