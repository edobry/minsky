# ADR-004: Two-Phase Command Execution (Validate-Then-Execute)

## Status

**ACCEPTED** - 2026-04-20

## Context

### Problem: Validation Interleaved with Mutations

In `startSessionImpl`, task status validation was placed after irreversible side effects (git clone + DB write). When validation failed, the system was left in an inconsistent state — an orphaned session record that blocked future operations. This is a representative example of a broader bug class: **validation-after-mutation**.

The pattern manifests whenever a function:

1. Performs irreversible side effects (DB writes, filesystem operations, API calls)
2. Then validates a precondition that could reject the operation
3. Without cleanup in the error path

Convention-based prevention ("put validation first") is insufficient because agents and humans both forget. Comments and code reviews catch some instances but not all. The wrong thing must be made **structurally impossible**.

### Research

Established patterns that address this:

- **Parse, Don't Validate** (Alexis King) — return validated types from parsers; consumers require the validated type
- **Typestate Pattern** — encode lifecycle state in the type system; methods only exist on valid states
- **Functional Core, Imperative Shell** (Gary Bernhardt) — pure validation returns decisions; shell performs mutations
- **Execute/CanExecute** (DDD) — paired validation/execution methods with framework-enforced ordering
- **Effect Systems** (Effect-TS) — effects are values composed in pipelines; runtime controls ordering

## Decision

All commands in the shared command registry MAY define a two-phase structure:

```typescript
interface CommandDefinition<T, C, R> {
  // ... existing fields (id, category, name, description, parameters) ...

  /** Phase 1: Validate preconditions. Receives read-only deps. Must not mutate. */
  validate?: (params: T, deps: ReadonlyDeps, ctx: CommandExecutionContext) => Promise<C>;

  /** Phase 2: Execute mutations. Receives validated context from phase 1. */
  execute: (params: T, context: CommandExecutionContext, validated?: C) => Promise<R>;
}
```

### Key Design Choices

1. **Read-only dependency interfaces in validation phase.** `validate()` receives narrowed interfaces that expose only read methods (e.g., `getSession`, `listSessions` but not `addSession`, `deleteSession`). The compiler rejects mutation calls inside validation.

2. **Framework-enforced ordering.** The command pipeline calls `validate()` → `execute()`. Individual handlers cannot control or bypass the ordering.

3. **Branded validated context type.** The output of `validate()` is a branded type (`ValidatedContext<C>`) that `execute()` requires. This prevents accidentally constructing a "validated" context without going through validation.

4. **Backward compatible.** `validate` is optional. Commands without it behave exactly as before — the pipeline calls `execute()` directly.

5. **ESLint enforcement.** A custom rule flags `throw ValidationError` inside `execute()` method bodies, catching accidental validation-in-execution at lint time.

### Architecture Invariants

- `validate()` may read state but MUST NOT write state
- `validate()` MUST throw on any precondition failure — never return partial results
- `execute()` MUST NOT throw `ValidationError` — all validation has passed
- If `validate()` throws, the system state is unchanged (structural guarantee)
- The pipeline is the sole caller of both methods — commands do not call themselves

## Rationale

### Why not just "be careful"?

Convention requires cognitive effort from every author on every commit. In an AI-agent-driven codebase, this is doubly fragile — agents don't carry forward institutional knowledge reliably. The environment must make the wrong thing impossible.

### Why read-only interfaces rather than full effect separation?

Full effect systems (Effect-TS) require wholesale paradigm adoption. Read-only interfaces are a lightweight, incremental approach that provides type-level enforcement with zero runtime cost and no framework dependency.

### Why optional validate()?

Mandating it for all commands would create unnecessary ceremony for simple commands (e.g., `config.get`) that have no preconditions. The pipeline is backward-compatible — enforcement is structural where it matters, not bureaucratic everywhere.

## Alternatives Considered

### Alternative 1: Comments and code review only

**Rejected because**: the mt#937 bug existed for weeks. Comments don't prevent; they inform.

### Alternative 2: Full Effect-TS adoption

**Rejected because**: massive learning curve and framework lock-in for a pattern needed in ~20 commands. The type-level guarantee is achievable with lighter tools.

### Alternative 3: Saga/compensation pattern

**Rejected because**: compensating transactions are for distributed systems where upfront validation is impossible. Our mutations are local — we can and should validate first.

## Future Considerations

- Migration of existing commands to the two-phase pattern (prioritize commands with DB writes)
- Semgrep rule for CI enforcement (detect mutation calls before all validation calls complete)
- Possible extraction of `ReadonlyDeps` interfaces into a shared module for reuse

## References

- [Parse, don't validate (Alexis King)](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)
- [Functional Core, Imperative Shell (Kenneth Lange)](https://kennethlange.com/functional-core-imperative-shell/)
- [Domain Command Patterns: Validation (Jimmy Bogard)](https://www.jimmybogard.com/domain-command-patterns-validation/)
- [The Typestate Pattern in Rust](https://cliffle.com/blog/rust-typestate/)
- PR #606: Initial implementation in `session_start`
- Notion retrospective: "session_start orphaned records (validate-after-mutate bug)"

---
