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

The **tier defaults**: `base` and `opinionated`. `style` is off and opt-in.

`init` then reports the declinable set — every `opinionated` rule it installed,
with that rule's own one-line description — on stdout and in the MCP tool result,
so a user or their agent can turn any of them off:

```bash
minsky rules disable --id <id>   # decline
minsky rules enable --id <id>    # change your mind
minsky compile                   # apply it to the harness outputs
```

**Optional rules stay installed until someone removes them.** That is the cost the
principal accepted in choosing "propose then decline" (ask#11764) over withholding,
and it is why `init` says plainly what it installed rather than only that the rules
exist.

> Earlier revisions of this page said `init` wrote **only** the base tier, because
> until Phase 2 (mt#573) wired selection there was no way for a user to decline
> anything. Phase 2 shipped; mt#4872 widened the scaffold and added the report.

### Overwrite is content-aware

`init --overwrite` used to replace rule files unconditionally, which for a file a
user may have edited is indistinguishable from discarding their work. It now
replaces a file whose content matches a hash Minsky is known to have shipped, and
**reports** one that does not, leaving it alone. The hash table and its coverage
bound are documented in `scaffold-history.ts`.

## Minsky never overwrites a `CLAUDE.md` or `AGENTS.md` it did not write

If your project already has agent instructions, they are yours. `minsky init` and
`minsky compile` leave them exactly as they are.

**How ownership is decided.** Every file the compile pipeline produces starts with a
generation banner:

```
<!-- Generated by minsky rules compile. Do not edit directly. -->
```

A `CLAUDE.md` or `AGENTS.md` carrying that banner in its first five lines is Minsky's
output and is regenerated normally. One without it is treated as yours and is **never
written** — not by `init`, not by a bare `compile`, and not by an explicit
`compile --target claude.md`. A file that is absent is not "yours": a fresh project
has nothing to protect and gets the full output. A file that exists but cannot be
read is treated as yours, on the principle that Minsky does not overwrite what it
cannot verify it owns.

**What you are told.** The run names the file, says why it was skipped, and says where
the rules went instead:

```
$ minsky compile
[compile] /path/to/CLAUDE.md was left untouched — it does not carry Minsky's
  generated-file banner, so it is treated as yours and is never overwritten.
  Minsky's rule sources are in .minsky/rules/; nothing loads them into your agent
  automatically while this file is yours, so an agent has to ask for one by name
  with `rules_get <name>`. To hand the file over to Minsky instead, move it aside
  and re-run.
```

**Your rules still reach the agent** (mt#5003). Minsky's always-apply rules are written
to `.claude/rules/` as files with **no `paths` frontmatter**, which Claude Code loads at
launch at the same priority `./CLAUDE.md` would have had — so your instructions and
Minsky's coexist rather than competing for one file. Path-scoped rules land in the same
directory with their `paths:` frontmatter, as they always have.

> Earlier revisions of this page said the opposite — that the base rules reached your
> agent through no automatic channel and had to be requested by name. That was true
> between mt#4986 and mt#5003 and is no longer.

**Minsky does not create a `CLAUDE.md` for you.** A project that has none stays that
way; the rules go to `.claude/rules/`. If you want the file, ask for it once —
`minsky compile --target claude.md` — and it is maintained from then on, because it now
carries the banner. A `CLAUDE.md` Minsky already generated keeps being regenerated
exactly as before, which is why Minsky's own repository is unaffected by any of this.

**To hand an existing file over to Minsky**, move it aside (or delete it) and re-run.
There is no flag to force an overwrite, deliberately: the file is the only copy of your
instructions, and a flag that discards them is a flag someone will pass by accident.

**`AGENTS.md` is different, and the run says so.** `.claude/rules/` is a Claude Code
mechanism; Claude Code itself reads `CLAUDE.md`, not `AGENTS.md`. So for a project whose
`AGENTS.md` is its own, Minsky's rules genuinely have no automatic channel — they are
installed under `.minsky/rules/` and an agent has to ask for one by name with
`rules_get <name>`.

**Effect on `compile --check` and pre-commit.** A file Minsky does not own is not one
of Minsky's outputs, so it is never reported stale and the pre-commit compile check
does not ask for it to be refreshed. Without this you would be told at every commit
that the file is out of date, with no command able to fix it. Hand-editing such a file
is likewise not blocked by the generated-file edit guard, which keys on the same
banner.

This posture is what Minsky already does everywhere else — `.claude/rules/` keeps
hand-authored files beside generated ones, `.claude/settings.json` preserves foreign
hook groups, and `.minsky/config.yaml` merges every key `init` does not own. The two
monolithic files were the exception by inheritance rather than by choice: in Minsky's
own repository `CLAUDE.md` genuinely is wholly generated.

## Selection: which of the shipped rules a project actually gets

Shipped in mt#573 (RFC Phase 2). Selection is **corpus membership** — a rule is
either in this project's active set or it is not, and the same answer is used
everywhere.

### Where the answer comes from

Three things combine, in this order:

1. **Tier defaults.** `base` and `opinionated` are on; `style` is off and opt-in.
   A rule with **no** `tier:` is on — that is the common case, and it is what
   keeps rules you wrote yourself, and every project that predates the shipped
   corpus, working unchanged.
2. **The project's rung**, if `.minsky/config.yaml` declares one under
   `rules.rung`. A rule whose `minimumRung` is above it is not proposed. No
   `rung` means no rung filter at all, not `T0`.
3. **The project's own selection**, under `rules:` in `.minsky/config.yaml`:
   `presets` and `enabled` add, `disabled` subtracts. Every addition is
   intersected with the rules the project actually has, so naming a rule you do
   not have cannot conjure one.

`base` is the one tier `disabled` cannot remove — declining it breaks Minsky
(ask#11286). The entry is ignored and `minsky compile` says so rather than
letting it look honoured.

### Presets are derived, not listed

`minsky rules presets` computes one bundle per tier from the `tier` and
`minimumRung` frontmatter on the project's own rules. There is no table of
preset names to maintain, and a preset **cannot** name a rule the project does
not have. A bundle may legitimately be empty — `style` is, in a fresh project,
because nothing installs a `style` rule until you opt in. `opinionated` is not:
`init` scaffolds it by default (mt#4872), so its bundle lists what you can
decline.

### Where it is applied

Both readers of `.minsky/rules/` honour it:

- **`minsky compile`**, so a deselected rule leaves `CLAUDE.md`,
  `.claude/rules/` and `.cursor/rules/` — and its stale `.cursor/rules/*.mdc` is
  deleted rather than left behind. Only files carrying Minsky's generated-file
  banner are ever deleted; a rule you hand-wrote into `.cursor/rules/` is left
  alone.
- **`minsky rules list`**, the agent's context assembly, and the rules
  embeddings index, so a deselected rule is not delivered or indexed either.

`minsky rules get <id>` is deliberately **not** filtered: asking for one rule by
name is a request, not a listing, and the file is still on disk.

### Reversing a choice

`minsky rules enable <id>` then `minsky compile`. Compiled outputs are always
regenerated from `.minsky/rules/`, never hand-edited, so nothing is lost by
turning a rule off and back on. `minsky rules config` shows the current
selection and how many rules are active out of the total.

### One source directory, every harness

`.minsky/rules/` is where rule sources live regardless of `--rule-format`.
`.cursor/rules/` is compiled output, exactly like `.claude/rules/`. Before
mt#573 a Cursor project — which is also what a project with no detected harness
gets — had its sources written straight into `.cursor/rules/`, so there was
nothing upstream for selection to filter and the rule set was fixed at `init`
forever.

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
- mt#573 — Phase 2, which wired selection so a declined rule actually leaves the
  compiled output.
- mt#4872 — Phase 3, which scaffolds the opinionated tier by default and reports
  the declinable set (ask#11764, "propose then decline").
- ADR-016 — the compile pipeline this corpus feeds.
