# ADR-011: MCP-Bridge Category Discovery Loop

## Status

Accepted (2026-05-21)

## Context

Minsky's CLI and MCP surfaces are built from the same source of truth: a
`SharedCommandRegistry` of command definitions. Each command is tagged with a
`CommandCategory` enum value (`GIT`, `TASKS`, `SESSION`, `MEMORY`, `FORGE`, …),
and a CLI bridge + MCP bridge adapt the registry to each interface.

Until this ADR, **the MCP bridge required hand-editing five layers in lockstep**
whenever a new category was added:

1. Register commands in `src/adapters/shared/commands/<group>.ts`
2. Invoke the registration from `src/adapters/shared/commands/index.ts`
3. Add the enum value in both `src/adapters/shared/command-registry.ts` and
   `src/schemas/command-registry.ts` (Zod schema mirror)
4. Create `src/adapters/mcp/<group>.ts` — per-category MCP adapter that calls
   `register<Group>CommandsWithMcp`
5. Import and invoke `register<Group>Tools` in `src/commands/mcp/start-command.ts`'s
   `registerAllTools` (which was a flat 15-line list of explicit calls)

Missing **any** layer broke the surface — but each layer failed differently. The
(4)+(5) layer failed **silently**: CLI commands worked; MCP `tools/list` did not
include them. No error, no warning. Layer (3) failed loudly with a Zod schema
validation crash on startup; layer (1)/(2) failed loudly with a missing CLI
command. So the silent layer recurred while the loud ones self-healed.

### Recurrence history (4 documented)

| Task        | Date       | Symptom                                                                                                                                                                                                                                                                                         |
| ----------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mt#386**  | historical | `registerGitTools` call commented out; git commands not callable via MCP. Fixed by uncommenting.                                                                                                                                                                                                |
| **mt#1517** | 2026-05-01 | Memory commands not callable via MCP; mt#1007 added the `MEMORY` category but no `src/adapters/mcp/memory.ts` adapter and no `registerMemoryTools` call. Originated **mt#1521** as the structural fix.                                                                                          |
| **mt#1957** | 2026-05-20 | Shipped 9 forge commands with (1)(2)(3) wired; missed (4)(5). Post-merge live verification caught the gap.                                                                                                                                                                                      |
| **mt#2003** | 2026-05-21 | Tactical fix for mt#1957 escape. First attempt added `FORGE` only to `registerAllMainCommandsWithMcp` array (zero production callers — functionally a no-op). PR R1 caught it and required `src/adapters/mcp/forge.ts` + `start-command.ts` wiring. Within-PR recurrence of the same bug class. |

mt#1521 (TODO since 2026-05-01) prescribed the structural fix but sat unimplemented
for ~20 days while two further recurrences (mt#1957, mt#2003) occurred within a
24-hour window. CLAUDE.md `§Work Completion > Process corrections require structural fixes`
explicitly names "the same feedback given repeatedly" as the structural-fix
escalation trigger.

### What the silent failure actually exposed

A pre-mt#2010 audit of `start-command.ts` against the shared registry's
`CommandCategory` enum revealed that **8 categories with active shared commands
were not being bridged to MCP at all**:

| Category        | Commands                                      | Surfaced to MCP today? |
| --------------- | --------------------------------------------- | ---------------------- |
| `AI`            | 9 (ai.chat, ai.complete, ai.fast-apply, …)    | NO                     |
| `AUTHORSHIP`    | 2 (authorship.get, authorship.recompute)      | NO                     |
| `COMPILE`       | 1 (compile)                                   | NO                     |
| `KNOWLEDGE`     | 4 (knowledge.search/fetch/sources/sync)       | NO                     |
| `OBSERVABILITY` | 1 (observability.smoke-test)                  | NO                     |
| `PROVENANCE`    | 2 (provenance.get, provenance.recompute)      | NO                     |
| `TRANSCRIPTS`   | 7 (transcripts.search/get/index-embeddings/…) | NO                     |
| `WORKSPACE`     | 1 (workspace.info)                            | NO                     |

`registerAllMainCommandsWithMcp` (a function in `shared-command-integration.ts`)
listed several of these in its `categories` array — but the function had
**zero production callers**. The "intent" was frozen in a dead function while
the real composition root (`start-command.ts`'s flat list) silently dropped
those categories.

## Decision

Replace `registerAllTools`'s flat list of explicit per-category calls with a
**discovery loop over `Object.values(CommandCategory)`**, dispatched through a
static table of per-category MCP adapters.

### Architecture

`src/commands/mcp/start-command.ts` now defines:

1. **`type McpCategoryAdapter`** — the signature every per-category MCP
   adapter satisfies: `(commandMapper, container) => void`.
2. **`MCP_CATEGORY_ADAPTERS`** — a static dispatch table mapping
   `CommandCategory` → ordered list of adapters. Categories listed here have
   intentional per-command overrides (hidden flags, description overrides,
   `argDefaults`); the discovery loop invokes their adapter(s) explicitly to
   preserve those overrides. Multiple adapters per category are supported
   (REPO has both `registerRepoTools` and `registerChangesetTools` — second-call
   override-merge via `addTool`'s Map semantics, by design).
3. **`DEFAULT_EXCLUDE_CATEGORIES`** — categories that should NOT auto-bridge
   to MCP under the default deployment. Currently contains only `AI` (see
   §Audit below for rationale).
4. **The discovery loop** — `registerAllTools` iterates
   `Object.values(CommandCategory)`. For each category:
   - If it's in `excludeCategories`, skip.
   - If it's in the dispatch table, invoke each registered adapter (preserves
     overrides).
   - Otherwise, fall back to `registerSharedCommandsWithMcp(commandMapper, { categories: [category] })`
     with no overrides — the **auto-bridge path**.

### Behavioral guarantee

Adding a new `CommandCategory.X` to the enum + the Zod schema mirror +
registering an `X.*` command in the shared registry is **sufficient to expose
it via MCP**. No edit to `start-command.ts` is required unless the new
category needs per-command overrides.

The previously-silent (4)+(5) failure mode is structurally impossible: any
new category enumerated by `Object.values(CommandCategory)` is reached by the
discovery loop on the next MCP startup.

### What was deleted

- `registerAllMainCommandsWithMcp` in `src/adapters/mcp/shared-command-integration.ts`
  (zero production callers; the silent-overwrite hazard it documented is no
  longer possible because every category is bridged exactly once).
- Two regression-guard tests in `shared-command-integration.test.ts` that
  asserted MEMORY and DETECTORS were NOT in the deleted function's category
  list.

### What was preserved

- Per-category adapter files (`git.ts`, `tasks.ts`, …, `forge.ts`) remain as
  the dispatch targets when overrides are needed.
- The `excludeCategories` opt-out parameter on `registerAllTools` preserves
  the narrowed-deployment hook (mt#1227 / mt#1254 intent), even though no
  narrowed deployment ships today.
- Native MCP tools (session-workspace, session-files, session-edit-tools)
  remain as explicit calls — they register directly via
  `commandMapper.addCommand` rather than going through the shared registry,
  so the discovery loop does not cover them.

## Audit

Per `## Success Criteria` 7 of the mt#2010 spec, every `CommandCategory` value
has been audited for auto-exposure safety. Verdicts below; categories without
a verdict have no commands registered.

| Category           | Pre-mt#2010 status | Verdict                         | Rationale                                                                                                                                                                                  |
| ------------------ | ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CORE`             | not bridged        | auto-skip                       | Empty category; auto-bridge call is idempotent on zero commands.                                                                                                                           |
| `GIT`              | bridged (adapter)  | dispatch                        | `registerGitTools` hides `git.clone/checkout/merge/rebase/branch` for main-workspace MCP — overrides preserved via dispatch entry.                                                         |
| `REPO`             | bridged (adapter)  | dispatch                        | Two adapters: `registerRepoTools` + `registerChangesetTools` (changeset descriptions). Both preserved.                                                                                     |
| `TASKS`            | bridged (adapter)  | dispatch                        | `registerTaskTools` overrides preserved.                                                                                                                                                   |
| `SESSION`          | bridged (adapter)  | dispatch                        | `registerSessionTools` overrides preserved.                                                                                                                                                |
| `PERSISTENCE`      | bridged (adapter)  | dispatch                        | `registerPersistenceTools` overrides preserved.                                                                                                                                            |
| `RULES`            | bridged (adapter)  | dispatch                        | `registerRulesTools` overrides preserved.                                                                                                                                                  |
| `INIT`             | bridged (adapter)  | dispatch                        | `registerInitTools` overrides preserved.                                                                                                                                                   |
| `CONFIG`           | bridged (adapter)  | dispatch                        | `registerConfigTools` overrides preserved.                                                                                                                                                 |
| `DEBUG`            | bridged (adapter)  | dispatch                        | `registerDebugTools` overrides preserved.                                                                                                                                                  |
| `AI`               | not bridged        | **EXCLUDE (default)**           | `ai.chat` / `ai.complete` invoke external paid LLM APIs. Auto-exposing creates runaway-cost risk. CLI access remains; a follow-up task may evaluate a narrower MCP exposure.               |
| `TOOLS`            | bridged (adapter)  | dispatch                        | `registerValidateTools` overrides `validate.lint`/`validate.typecheck` descriptions; bridges the entire TOOLS category (asks/attention/deployment/pr-watch/reviewer-watch/validate, etc.). |
| `MCP`              | bridged (adapter)  | dispatch                        | `registerMcpManagementTools` overrides preserved.                                                                                                                                          |
| `KNOWLEDGE`        | not bridged        | **AUTO-BRIDGE (newly exposed)** | knowledge.search/fetch/sources/sync — useful agent surface; original intent per dead `registerAllMainCommandsWithMcp`.                                                                     |
| `PROVENANCE`       | not bridged        | **AUTO-BRIDGE (newly exposed)** | provenance.get/recompute — agent provenance inspection. Consistent with the deleted bulk-array's original "main MCP" intent (mt#1227/mt#1254).                                             |
| `AUTHORSHIP`       | not bridged        | **AUTO-BRIDGE (newly exposed)** | authorship.get/recompute — agent identity. Same rationale as PROVENANCE.                                                                                                                   |
| `MEMORY`           | bridged (adapter)  | dispatch                        | `registerMemoryTools` overrides preserved.                                                                                                                                                 |
| `COMPILE`          | not bridged        | **AUTO-BRIDGE (newly exposed)** | `compile` — rule compilation, idempotent local operation, safe to expose.                                                                                                                  |
| `WORKSPACE`        | not bridged        | **AUTO-BRIDGE (newly exposed)** | workspace.info — useful agent surface.                                                                                                                                                     |
| `TRANSCRIPTS`      | not bridged        | **AUTO-BRIDGE (newly exposed)** | transcripts.\* (7 commands) — agent introspection.                                                                                                                                         |
| `DETECTORS`        | bridged (adapter)  | dispatch                        | `registerDetectorsTools` overrides preserved.                                                                                                                                              |
| `OBSERVABILITY`    | not bridged        | **AUTO-BRIDGE (newly exposed)** | observability.smoke-test — one-shot Braintrust health check. Low cost.                                                                                                                     |
| `PRINCIPAL_CORPUS` | bridged (adapter)  | dispatch                        | `registerPrincipalCorpusTools` overrides preserved.                                                                                                                                        |
| `FORGE`            | bridged (adapter)  | dispatch                        | `registerForgeTools` (mt#1957/mt#2003 wiring) overrides preserved.                                                                                                                         |

**Net effect:** 7 categories newly auto-exposed (KNOWLEDGE, PROVENANCE,
AUTHORSHIP, COMPILE, WORKSPACE, TRANSCRIPTS, OBSERVABILITY — total 18 commands,
per the smoke-script live count). 1 category newly excluded by default (AI).
15 categories continue with their per-category adapter dispatch unchanged.

## Consequences

### Positive

- New `CommandCategory` enum values auto-surface in MCP without `start-command.ts`
  edits — closes the recurring silent (4)+(5) failure mode.
- Seven previously-unbridged categories with active CLI commands gain MCP
  exposure, realizing the intent the dead `registerAllMainCommandsWithMcp`
  function had documented but never realized.
- The dispatch table makes the override surface explicit — adding a new
  override means adding an entry to one table, not chasing flat lists.
- Tests cover the structural invariants of the dispatch table directly
  (`src/commands/mcp/discovery-loop.test.ts`).

### Negative

- The dispatch-table-vs-fallback distinction is a new implicit contract:
  forgetting to add a dispatch entry for a category that NEEDS overrides
  results in commands surfacing without those overrides (a non-silent
  degradation — overrides are missing but commands work). The optional
  Success Criteria 9 regression test (deferred per scope) could catch
  this if needed later.
- AI is now an "opt-out, not opt-in" category. If a future agent loop wants
  ai.chat via MCP, the path is to remove `CommandCategory.AI` from
  `DEFAULT_EXCLUDE_CATEGORIES` (a one-line change) — but this requires an
  explicit decision rather than the implicit-via-flat-list status quo.

### Neutral

- The `excludeCategories` parameter is a forward-compat hook for narrowed
  deployments (mt#1227/mt#1254). No narrowed deployment exists today; the
  parameter is dormant infrastructure. This is the design memory
  `d624c862` ("doc-comment intent vs caller reality") warned about: structure
  preserved for hypothetical future callers. Acceptable here because the
  cost is a single function parameter with empty default — near-zero
  complexity — and the parameter is needed by the discovery loop's
  iteration logic regardless.

## Cross-references

- mt#2010 — this task; the structural fix shipping the discovery loop.
- mt#1521 — original structural-fix task, subsumed by mt#2010.
- mt#386 — 1st historical recurrence (git commands).
- mt#1517 — 2nd recurrence (memory commands; originated mt#1521).
- mt#1957 — 3rd recurrence (forge tools, mt#2003 follow-up).
- mt#2003 — 4th recurrence (within-PR; the mt#1957 fix that itself recurred).
- mt#1227 / mt#1254 — narrowed-deployment intent preserved via
  `excludeCategories` hook.
- mt#1779 — dual-name (dotted + underscored) MCP tool registration pattern
  (adjacent; the discovery loop does not change this).
- mt#264 — broader RFC on SharedCommandRegistry architecture (out of scope
  for mt#2010; this ADR documents an incremental decision compatible with
  that future work).
- `feedback_chinese_wall_reviewer_directionally_correct_wrong_mechanism_pattern`
  (memory `83237129`) — pattern that allowed mt#1957 to escape with the bug;
  this ADR's structural fix prevents the bug class regardless.
- ADR-005 — ForgeBackend sub-interfaces (FORGE category routes through it).
- ADR-008 — attention-allocation subsystem (uses `CommandCategory.TOOLS`).
