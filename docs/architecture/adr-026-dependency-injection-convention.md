# ADR-026: Dependency injection convention — tsyringe for composition-root services, required deps-param for leaf modules

## Status

**ACCEPTED** — 2026-07-07

## Context

The July 2026 holistic audit (mt#2607, domain-core survey) flagged that Minsky's domain
code has two dependency-injection idioms in simultaneous use, with no rule governing which
one new code should follow:

1. **tsyringe container DI** — classes decorated `@injectable()` (optionally with
   `@inject("token")` on constructor parameters), registered and resolved via
   `TsyringeContainer` (`src/composition/container.ts`) at a composition root.
2. **Hand-rolled parameter-object DI** — plain functions or small classes that take an
   explicit `deps` (or similarly named) parameter object carrying their dependencies,
   with no container involved.

Both idioms are already documented in `docs/architecture.md` §6, but only in passing
("Classes are used for stateful services; pure functions for stateless logic") — with no
explicit ADR backing the split, no migration policy, and (per the audit) an actively
regressing enforcement mechanism (see "Enforcement gap discovered" below).

### Re-verified counts (2026-07-07)

The mt#2623 spec cited approximate counts from the audit; re-verifying via grep against
this session's checkout:

| Pattern                                         | Spec estimate | Re-verified                                         | Method                                                                                                                                                               |
| ----------------------------------------------- | ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files with `@injectable()` (tsyringe)           | 49            | **49 (exact match)**                                | `grep -rl '@injectable' src packages --include='*.ts'`, excluding tests                                                                                              |
| Files with a `deps` parameter object            | 67            | **16–35**, depending on match strictness (see note) | strict: `deps\??:\s*\{` (immediate object-literal type) = 16; loose: `deps\?\s*:` (any type after `deps?:`) = 35                                                     |
| `optionOverride ?? create(...)`-shaped fallback | ~29           | **26–29**                                           | `grep -rlE '(Override\|Deps)\s*\?\?\s*'` = 18 (named-override-variable form); `grep -rlE '\?\?\s*(create\|new )'` = 29 (broader `?? create(...)`/`?? new X()` shape) |

**Note on the deps-param count's variance:** a strict match (an inline object-literal type,
`deps?: { ... }`) undercounts because many deps-param functions reference a named type alias
(`deps?: TaskServiceDeps`) rather than an inline literal; a loose match
(any string containing `deps?:` or `deps:`) overcounts because it also matches non-DI uses
of the identifier `deps` (e.g., doc comments, unrelated destructured objects). The spec's
67 is plausible as a manually-curated count and is not contradicted by the grep range — it
is not independently re-derivable from a single regex, so this ADR reports the range rather
than asserting a single re-verified number. This does not affect the decision below, which
does not depend on the exact count — both idioms are used at a scale (tens of files each)
that rules out treating either as a rare exception.

The `optionOverride ?? create(...)` fallback shape is independently confirmed as a real,
recurring anti-pattern — e.g. `octokitOverride ?? <construct-real-client>` across
`packages/domain/src/repository/github-{pr-review,labels,workflow-runs,checks-run,
branch-protection,pr-operations}.ts` (6 files), plus the task-facade instances tracked by
mt#1024. This is already named as a banned pattern in project memory ("No DI fallbacks" —
`021b612a`): _"Never use `deps?.service ?? createConfiguredService(...)` patterns. Fallbacks
silently connect tests to real infrastructure and hide missing wiring in new callers."_ This
ADR promotes that memory to a corpus-level architectural decision (see Decision, point 3)
and the memory should be considered superseded by this ADR once merged.

### Community practice (per `/plan-task` gate (l) discipline)

One web search was run on "TypeScript dependency injection convention tsyringe vs manual
constructor injection large monorepo best practice" (2026-07-07). Findings, consistent
with the decision below:

- **Container-based DI (tsyringe) earns its complexity at the composition-root / large
  dependency-graph scale.** For managing many interdependent services in a large codebase,
  a DI container "keeps track of all dependencies" and "tags your classes as injectable"
  so the container "can take care of instantiating the whole dependency tree" — exactly
  Minsky's `TsyringeContainer` + `AppServices` shape (docs/architecture.md §6).
- **Plain-parameter-object injection is the recommended shape for smaller/leaf modules.**
  "When all dependencies are explicitly declared as parameters, the module is easier to
  test because we can see what needs to be prepared to run a test" — no container, no
  decorators, dependencies visible in the signature. This is the "functional core" pattern:
  domain-specific code stays simple and testable without special mocking libraries.
  Community sources converge on: using a DI framework is "not mandatory" — what matters is
  decoupling construction from invocation, which a required (non-optional, non-fallback)
  `deps` parameter achieves without a container.

Sources: [tsyringe (GitHub)](https://github.com/microsoft/tsyringe),
[TSyringe and DI in TypeScript (DEV Community)](https://dev.to/gdsources/tsyringe-and-dependency-injection-in-typescript-3i67),
[Dependency Injection in Typescript with tsyringe (GameChanger Tech Blog)](https://tech.gc.com/dependency-injection/),
[Dependency Injection in JavaScript: A Functional Approach](https://www.goetas.com/blog/dependency-injection-in-javascript-a-functional-approach/),
[Building a Decorator-Driven DI Container in TypeScript (Leapcell)](https://leapcell.io/blog/building-a-decorator-driven-dependency-injection-container-in-typescript).

**Match/extend/deviate:** Minsky's existing (undocumented) split — tsyringe-decorated
classes for stateful services registered at the composition root, plain `deps` parameters
for smaller/leaf modules — already **matches** the community pattern. This ADR does not
introduce a new architecture; it ratifies the one that emerged organically, makes it
explicit, bans the anti-pattern that grew in the gap left by having no explicit rule, and
fixes the enforcement mechanism that had silently stopped applying.

### Enforcement gap discovered (2026-07-07)

Two custom ESLint rules exist specifically to enforce the tsyringe half of this
convention:

- `eslint-rules/require-injectable.js` — requires `*Service`/`*Storage`/`*Adapter` classes
  in domain code to carry `@injectable()`.
- `eslint-rules/no-domain-singleton.js` — bans `export const x = new Y(...)` singleton
  exports in domain code.

Both gate on `filename.includes("/src/domain/")`. **This check has been silently broken
since the mt#2108 domain-package extraction**, which moved domain code from `src/domain/`
to `packages/domain/src/`. The substring `/src/domain/` does not occur in
`packages/domain/src/...` (the path segments are in the opposite order — `domain/src`, not
`src/domain`) — so both rules have been no-ops for every file under `packages/domain/` since
mt#2108 landed. `eslint.config.js` applies these rules via a broad `files: ["**/*.ts",
"**/*.js"]` glob (no directory restriction at the config level), so the rules ARE invoked on
`packages/domain/src/*.ts` files — they just always return `{}` (no violations) once
invoked, because the internal path guard never matches. This is fixed in the same PR as
this ADR (see "Enforcement" below); it is a two-line change per file, not a migration.

A third rule, `eslint-rules/no-singleton-reach-in.js`, has a broader
`allowedFiles`-glob-list that is similarly built against pre-mt#2108 `**/src/domain/...`
paths. Its blast radius (fixing ~20 allowlist entries, `warn`-severity, not `error`) is
larger and orthogonal to the DI-convention decision this ADR makes — it's filed as a
follow-up rather than fixed in this PR (see Consequences).

## Decision

**Ratify the two-tier hybrid already in de-facto use, encode it explicitly, and ban the
fallback anti-pattern that grew in the absence of an explicit rule.**

1. **Composition-root / stateful services → tsyringe.** Any class that is (a) a stateful
   service registered in `AppServices` / `TOKENS` (`src/composition/types.ts`,
   `src/composition/tokens.ts`), (b) named `*Service`, `*Storage`, or `*Adapter`, or
   (c) holds a resource with a lifecycle (a DB connection, a long-lived client) MUST be
   decorated `@injectable()` and resolved from the container — never constructed directly
   outside a composition root (`src/composition/*.ts`) or a test fixture. This is the
   existing `require-injectable` / `no-domain-singleton` / `no-direct-service-construction`
   contract; this ADR does not change it, only makes it explicit and fixes its enforcement.

2. **Leaf / stateless domain functions → required `deps` parameter object.** Small
   functions, command handlers, and modules with few (1–4) dependencies and no independent
   lifecycle take an explicit, **required** `deps` parameter (no `?`, no default value) —
   e.g. `function listTasks(params: Params, deps: { taskService: TaskServiceInterface })`.
   This is the pattern already used by ~60+ files across the command-handler and
   repository-resolution layers (see counts above). No container involvement, no
   decorators — dependencies are visible in the function signature and callers (including
   tests) construct fakes directly.

3. **BANNED regardless of tier: the `deps?.x ?? createConfiguredX(...)` fallback shape.**
   This shape is neither sanctioned idiom — it is not container-resolved (bypasses
   registration and the `no-direct-service-construction` contract) and it is not the
   required-deps-param pattern (the `?` and the `?? create...()` fallback defeat the
   "required, visible, test-injectable" property that makes the deps-param idiom safe).
   It silently connects tests to real infrastructure when a caller forgets to inject a
   fake, and it hides missing DI wiring in new callers behind an apparently-working
   default. This promotes project memory `021b612a` ("No DI fallbacks") from a checklist
   memory to an architectural decision — **new code must never introduce this shape**;
   existing instances are cleaned up per the migration policy below.

4. **Decision boundary is deliberately NOT "pick one, migrate everything."** Full tsyringe
   coverage would force container ceremony onto small leaf functions where it adds no
   value (matches community consensus: DI frameworks are "not mandatory," the point is
   decoupling construction from invocation). Full deps-param coverage would lose the
   container's dependency-graph management for the composition root's many interdependent
   long-lived services. The two-tier split is the correct shape, not a compromise pending
   full migration.

### Migration policy (feeds mt#1024, mt#1804)

- **New code**: must follow rules 1–3 above with zero exceptions. This is now a review-time
  and lint-time check (see Enforcement).
- **Existing fallback-shape violations** (~26–29 sites) are cleaned up by the two tasks the
  mt#2623 spec named as coordination targets, plus one new follow-up for uncovered sites:
  - **mt#1024** (TODO) — eliminates the fallback in `src/domain/tasks.ts` facade + the
    `query-commands.ts`/`mutation-commands.ts` command layer (8 + 4 + 5 functions). Scoped
    correctly per this ADR's rule 3; no change needed to that task's spec.
  - **mt#1804** (TODO) — audits `registerXxxTools` MCP-registration-time DI lookups for a
    _timing_ bug (container resolution before `container.initialize()` completes), which is
    a distinct but related DI-discipline issue: whichever idiom is used, resolution must
    happen at dispatch time, not at module-registration time. This ADR notes the
    relationship but does not change mt#1804's scope.
  - **New follow-up task** (filed alongside this ADR — see PR body) for the
    `optionOverride ?? create(...)` fallback sites NOT covered by mt#1024's scope, in
    particular the 6 `packages/domain/src/repository/github-*.ts` files identified above
    (`octokitOverride ?? ...`).
- **No big-bang rewrite.** Neither tsyringe-everywhere nor deps-param-everywhere is
  authorized by this ADR; migrating a file between idioms outside the fallback-removal
  scope above requires its own task/justification (per `docs/architecture.md` §6's
  "classes for stateful services, functions for stateless logic" split).

## Enforcement (where new code gets checked)

Two mechanisms, per the mt#2623 acceptance criterion ("review checklist entry or a
lint-rule follow-up task"):

1. **Lint-rule fix (this PR).** `eslint-rules/require-injectable.js` and
   `eslint-rules/no-domain-singleton.js` are fixed to match both `/src/domain/` (legacy) and
   `packages/domain/src/` (current) paths, restoring their enforcement of rule 1 above on
   the code that actually lives there now. This closes the enforcement gap discovered
   during this audit — not a new capability, a repair of an existing one.
2. **Documentation at the point a new contributor looks.** `docs/architecture.md` §6
   ("Dependency Injection") is amended (companion edit, this PR) with the two-tier
   convention and the banned-fallback rule, cross-referencing this ADR. This is the
   existing canonical reference for "how does DI work here" per CLAUDE.md `§Key
Architecture`.
3. **Lint-rule follow-up (filed, not implemented here).** A new ESLint rule generalizing
   `no-direct-service-construction.js`'s `BANNED_FACTORIES` pattern-match
   (`x ?? createConfiguredY(...)` / `x?.y ?? new Z(...)`) across all of `src/` and
   `packages/domain/src/`, not just the task-service-specific instances that rule already
   catches, would give rule 3 the same mechanical enforcement rules 1–2 already have. Filed
   as a follow-up task rather than implemented in this decision-only PR (see PR body).
4. **`no-singleton-reach-in.js` allowlist staleness** (the broader glob-list issue noted
   above) is filed as a separate follow-up — same root cause (mt#2108 path move) as the
   fix in this PR, but larger blast radius and orthogonal to this ADR's decision.

## Consequences

**Easier:**

- A new contributor asking "which DI idiom do I use for this new module?" has an explicit,
  cited answer (this ADR + `docs/architecture.md` §6) instead of inferring from
  inconsistent examples.
- The tsyringe-enforcement lint rules resume firing on `packages/domain/src/` — the
  post-mt#2108 domain code, which is where nearly all current development happens.
- The fallback anti-pattern has a named architectural decision to cite when a reviewer
  flags a new instance, rather than only a checklist memory.

**Harder / committed:**

- The fallback-removal migration (mt#1024, mt#1804, and the new follow-up) is now framed as
  implementing an ADR-level decision rather than an isolated cleanup, which should raise its
  priority relative to other TODO-status tech debt.
- A generalized fallback-detecting lint rule (follow-up 3 above) is scoped but not
  implemented in this PR — until it ships, new fallback instances are only caught by
  review, not mechanically.

**Deferred, not decided here:**

- Whether `no-singleton-reach-in.js`'s full allowlist should be rewritten for
  `packages/domain/src/` paths (follow-up task).
- Any change to `docs/architecture.md` §6's tsyringe token/service-map documentation beyond
  adding the two-tier convention section — that content remains materially accurate.

## Cross-references

- **Supersedes (promotes to ADR level):** project memory `021b612a` ("No DI fallbacks").
- **Feeds:** mt#1024 (DI fallback elimination, task facade), mt#1804 (eager-DI/MCP
  registration-timing audit).
- **Related:** `eslint-rules/require-injectable.js`, `eslint-rules/no-domain-singleton.js`,
  `eslint-rules/no-direct-service-construction.js`, `eslint-rules/no-singleton-reach-in.js`.
- **Companion doc edit:** `docs/architecture.md` §6 (Dependency Injection).
- **Originating audit:** mt#2607 (July 2026 holistic audit), mt#2623 (this task).
- mt#2108 — domain-package extraction (`src/domain/` → `packages/domain/src/`), the change
  that silently broke the two lint rules' path filters.
