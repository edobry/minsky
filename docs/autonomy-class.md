# Computed autonomy class

Every open task resolves to one of three classes — `principal-gated`,
`pull-only`, `contained` — plus `unknown` for a task the classifier could not
read. The class is **computed from signals at read time and never stored**, so
nothing that files a task (the EngProd miner, a handoff, an agent) can make its
own task dispatchable. The consumers default to deny: `principal-gated` and
`unknown` are never served.

Decision record: RFC "backlog prioritization — how work gets selected" (Notion
`3ae937f0-3cb4-810c-9131-ff1938f20c61`, Accepted 2026-09-13), §"Autonomy is a
computed floor, default-deny, with principal-gated dominant". Shipped by
mt#5130 (Phase 1c of mt#3483). Code: `packages/domain/src/tasks/autonomy-class.ts`
(pure classifier), `autonomy-class-store.ts` (the bulk spec-section loader).

## The classes

| Class             | Meaning                                                                                                                                                 | Served by `tasks_available`? |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `principal-gated` | A decision the principal reserves: naming, architecture, product surface, vendor, shared or production state. **Dominates** — any one signal is enough. | Never                        |
| `pull-only`       | Ordinary implementation work an agent or the principal must pull. The default.                                                                          | Yes                          |
| `contained`       | Small blast radius **and** gate-passing human provenance. Empty today: no channel writes `human` yet — see "Human origin".                              | Yes                          |
| `unknown`         | The spec signals could not be loaded (no spec row, or no loader on this path). Never a default for a well-formed task.                                  | Never                        |

## The signals, in dominance order

`principal-gated` if **any** of:

- kind `umbrella`, or kind `state-ops` (a shared-state operation);
- a tag in `rfc`, `adr`, `naming`, `product-surface`, `vendor`, `engprod-proposal`;
- the title starts with `RFC` or `ADR`;
- `## Scope` names a **listed surface** (below);
- the title or `## Summary` contains a principal-reserved marker — `rename`,
  `naming`, `product name`, `customer-facing`, `product surface`, `vendor`,
  `paid plan`, `signup`, `pricing`, matched as whole words. The set is
  deliberately narrow: on the 868-task default population (2026-09-13) it gates
  56 tasks; a set including `name`/`architecture`/`product`/`production` gated
  211 on incidental prose.

Else `contained` if **all** of: human-origin evidence, status `READY`, every
scope path outside the listed surfaces, and one of the RFC's shapes — a bugfix
with a reproducing test named in the spec, an incident follow-up (`incident`
tag or an `Origin:` line mentioning one), a cleared-blocker re-surface
(`cleared-blocker` tag), or a docs-only / generated-only scope.

Else `pull-only`. A `work-package` is `pull-only` with the reason "ADR-046:
claimed deliberately" — its own consumer-side exclusion in
`findAvailableTasks` is unchanged.

`unknown` only when the spec signals were not loaded and the row alone did
not resolve `principal-gated`.

### The listed surface

`AUTONOMY_LISTED_SURFACE_PATTERNS` = the deploy **boundaries**
(`CONFIG_SURFACE_PATTERNS` in `deploy-surface.ts`: `infra/`, `Dockerfile`,
`services/*/{Dockerfile,railway.json,deploy.config.ts,railway.config.ts}`,
`.github/workflows/deploy*.yml`), the local-app surface
(`cockpit-tray/src-tauri/`), and the security surfaces: `.github/workflows/**`,
`.minsky/hooks/**`, `.claude/hooks/**`, `packages/domain/src/persistence/**`,
`packages/domain/src/storage/migrations/**`, `drizzle.pg.config.ts`,
`packages/domain/src/auth/**`.

It is **not** `isDeploySurfaceFile`. That predicate carries `^src/`,
`^packages/domain/src/` and `^packages/shared/src/` because deploy
verification needs "anything bundled into an image"; as an autonomy surface it
would gate every code task. Extend the list when a new security surface is
identified; a test pins it.

### Human origin

`contained` requires `humanOrigin === true`, derived from the row's creation
channel: `tasks.origin` (`human` | `agent` | `automated`, mt#5136), mapped by
`humanOriginFromChannel` — only `human` is evidence for; `agent` and
`automated` are evidence against; a NULL row (one that predates the column, no
backfill) is no evidence at all, and the classifier reads both non-`human`
cases as `pull-only` with the reason "no human-origin evidence".

The value is stamped by the code path that files the task, never taken from
the caller: the shared `tasks.create` command (MCP and CLI — an agent in a
Bash tool runs the same CLI path the principal would), `tasks.dispatch`'s
new-task mode and `session_start --description` write `agent`; the EngProd
toil miner and the ops adoption sweeper write `automated`; a backend-to-backend
migration copies the source row's value. `tasks.create` declares no `origin`
parameter, so a payload carrying one is rejected at the MCP boundary (mt#2778)
— a producer cannot claim `human`. One known imprecision: the reviewer
service's adoption sweeper files through `tasks_create` over MCP, so its rows
read `agent` although it is a loop; the classifier asks only `=== "human"`,
so the trust property is unaffected.

**No channel writes `human` yet.** The cockpit has no task-creation form, the
CLI cannot tell the principal at a terminal from an agent in a subprocess
without a heuristic, and a GitHub issue never reaches the minsky task table —
so `contained` is reachable and still empty. Which channel counts as human is
the principal's call (a standing trust default; a cockpit form is product
surface): mt#5161 owns it, ask#12169 carries the options.

The column is one of three "origin"s and the only one that is a channel: the
work-package transfer log's `origin` is the transfer kind (`groomed` |
`succession` | …, ADR-046), and a spec body's `Origin:` line is prose the
classifier reads as incident lineage.

## Where it is read

- **`tasks_available`** (`TaskRoutingService.findAvailableTasksWithClass`):
  classifies each candidate after the status/kind filter and before the
  dependency lookup, serves only `pull-only`/`contained`, and reports
  `excludedByClass: { principalGated, unknown }` in JSON and as a "Withheld by
  autonomy class" line in text. `findAvailableTasks` delegates, so the old
  shape denies too. The spec sections come from one bulk query
  (`loadAutonomySpecSignals`: `## Scope` and `## Summary` extracted
  section-exact in SQL — ~1.2 MB across the default population vs 6.3 MB of
  full content). The no-SQL fallback path reads each candidate's spec through
  the task service, stopping at `limit` servable tasks.
- **`tasks_route`**: a route is navigation toward a caller-named target and
  refuses nothing, but it never presents a gated task as work to start —
  every step and the target carry `autonomyClass`, `readyTasks` counts only
  servable steps, and a gated target replaces "ready to start immediately"
  with the class and its reasons.
- **`tasks pointings candidates`**: each candidate carries `autonomyClass`
  (annotation only — a pointing is the principal's own declaration; the deny
  lands on Phase 2's pull). Membership in a pointing never overrides the
  class.

Not yet wired: the unattended supervisor's child admission (mt#5137).

## EngProd proposals: the BLOCKED hack, retired

Until mt#5130 the toil miner filed proposals `BLOCKED`, and the routing
service's `["TODO", "IN-PROGRESS"]` filter kept them unservable — safety that
lived in a status the filer set. Now:

- proposals are filed **TODO** tagged `engprod-proposal`; the tag makes them
  `principal-gated`, so `tasks_available` never serves them, whatever their
  status;
- **accepting** = the cockpit Proposals page's Accept, which swaps
  `engprod-proposal` for `engprod-accepted` (status untouched) — the task is
  then an ordinary agent-filed TODO, `pull-only`; planning a proposal past TODO
  outside the cockpit counts as acceptance for the ledger too;
- **rejecting** = CLOSED, as before;
- the ledger's reconciliation (`decideReconciliation`) reads the disposition —
  tag or status past TODO — never "left BLOCKED", so migrating the 15 live
  proposals BLOCKED → TODO recorded nothing.

The EngProd RFC (`3ac937f0-3cb4-816e-8af7-e5380f10a24b`) §R2 describes the
retired mechanism; its amendment note points here.

## Overriding a class

There is no override write path. The RFC's sub-decision (accepted 2026-09-13):
an override is principal-only, via an ask, if Phase 2 needs one.
