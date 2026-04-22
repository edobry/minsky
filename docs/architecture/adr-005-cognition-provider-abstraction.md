# ADR-005: Cognition Provider Abstraction for Dual-Mode AI Operation

## Status

Proposed — 2026-04-22. First consumer: mt#321.2 (AI criterion evaluation and synthesis for the agent-readiness assessment system).

## Context

Minsky is designed to run in multiple execution contexts, and those contexts place incompatible assumptions on how AI work is performed.

**Standalone CLI use.** A user runs `minsky <command>` in a terminal. Minsky has its own process, owns its AI provider configuration, and makes direct API calls through `AICompletionService`. This is the mode all existing AI code assumes.

**Embedded in an agent harness.** A user invokes Minsky via an MCP tool call from Claude Code, Cursor, or another AI-capable host. The harness is already an AI agent. It has its own model access, its own context, and a conversation history Minsky cannot see. Having Minsky make its own API call inside this context is wasteful (paying for cognition twice) and uncoordinated (Minsky's output reflects none of the harness's context).

**Skill or plugin distribution.** With the skills architecture (mt#800) compiling `.minsky/` to Claude Code skills, Cursor rules, and AGENTS.md, Minsky capabilities can be delivered as behavioral artifacts executed entirely by the host agent. In this mode there may be no Minsky runtime process at all — just compiled prompts and structured instructions the harness interprets.

The progressive adoption model treats standalone as a possible _later_ mode, not a prerequisite. A user trying Minsky at T0 (assessment as a plugin) must not need an API key configured. The thesis is that Minsky's job is _structured cognition_, and structured cognition can be done by borrowing the harness's model access, by using Minsky's own, or — for deterministic portions — by neither.

Delegating cognitive work to a surrounding agent is not new in Minsky. `session_generate_prompt` does exactly this for subagent dispatch: Minsky generates a prompt the host agent executes, rather than dispatching itself. mt#915 formalizes a dual-path `generate_prompt` with lean payloads for native harnesses and full prompts for standalone mode. What is missing is a general abstraction for cognitive work — criterion evaluation, narrative synthesis, semantic judgment — that honors all execution modes uniformly.

Without this abstraction, every new AI-using feature will re-invent dual-mode branching inline, producing drift; or (more likely) features will hard-code direct-only execution and silently break the embedded-mode contract. The agent-readiness assessment in mt#321 is the first feature that would be user-facing in all three contexts and cannot ship without a principled answer.

## Decision

Introduce **`CognitionProvider`** as a first-class domain abstraction for cognitive work. It is the peer of `PersistenceProvider` (ADR-002) and `RepositoryBackend` (ADR-003) within Minsky's domain layer: a capability axis every feature may depend on without caring about its concrete realization.

Cognitive work is represented as a `CognitionTask<T>` — a declarative bundle of system prompt, user prompt, evidence, and Zod output schema. Tasks do not know how they will be executed. Providers own execution.

Three modes are supported, selected at runtime via execution context:

- **Direct** — `DirectCognitionProvider` wraps `AICompletionService`. Used when Minsky runs standalone with a configured AI provider. Tasks are executed immediately; results returned.
- **Delegated** — `DelegatedCognitionProvider` packages tasks into a `CognitionBundle` for external execution by the surrounding agent. Used when Minsky is invoked via MCP from an AI host, or when commands compile to skill artifacts. The provider does not resolve results; it yields structured prompts the caller executes.
- **Degraded** — `DegradedCognitionProvider` refuses to execute cognitive tasks and forces callers to supply a deterministic fallback. Used when neither direct nor delegated modes are available (standalone CLI, no API key, no harness). Features that can operate partially without cognition do so; features that cannot fail cleanly with a diagnostic pointing to either configuration path.

Mode resolution happens once per command invocation at the composition root. Features consume a resolved `CognitionProvider` and do not themselves decide the mode.

`AICompletionService` becomes an implementation detail of `DirectCognitionProvider`. After this ADR lands, feature code never imports `AICompletionService` directly. Existing AI-using features continue to work through retrofitting (tracked separately, mt#1058) but new features must use `CognitionProvider`.

## Interface Sketch

```typescript
// Pure declaration of cognitive work — no execution coupling.
interface CognitionTask<T> {
  kind: string; // e.g. "evaluate-criterion", "synthesize-narrative"
  systemPrompt: string;
  userPrompt: string;
  evidence: Record<string, unknown>; // structured input the prompt references
  schema: ZodType<T>;
  model?: ModelHint; // advisory, not prescriptive
}

// Bundle returned by delegated mode for external execution.
interface CognitionBundle {
  tasks: CognitionTask<unknown>[];
  order: "parallel" | "sequential";
  contextHint?: string; // free-form guidance for the executing harness
}

// Result wrapper distinguishes execution outcomes across modes.
type CognitionResult<T> =
  | { kind: "completed"; value: T } // direct mode
  | { kind: "packaged"; bundle: CognitionBundle } // delegated mode
  | { kind: "unavailable"; reason: string }; // degraded mode

interface CognitionProvider {
  perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>>;
  performBatch<T>(tasks: CognitionTask<T>[]): Promise<CognitionResult<T[]>>;
}
```

Features handle the three result kinds explicitly. Illustrative for mt#321.2:

```typescript
const result = await cognition.performBatch(criterionTasks);
switch (result.kind) {
  case "completed":
    return render(report, result.value);
  case "packaged":
    return { kind: "delegation", bundle: result.bundle, partialReport: deterministicReport };
  case "unavailable":
    return { kind: "deterministic-only", report: deterministicReport, pending: criterionTasks };
}
```

## Mode Resolution

```typescript
function resolveCognitionMode(ctx: CognitionResolutionContext): CognitionMode {
  if (ctx.explicit) return ctx.explicit;

  // Embedded: surrounding harness provides cognition.
  if (ctx.invocation === "mcp" || detectAgentHarness() !== "standalone") {
    return "delegated";
  }

  // Standalone with configured provider.
  if (hasConfiguredAIProvider()) return "direct";

  // Fallback.
  return "degraded";
}
```

`CognitionResolutionContext` includes the command invocation kind (CLI, MCP, skill), an explicit override (`--cognition-mode=...`), and access to the harness-detection layer at `src/domain/runtime/harness-detection.ts`.

MCP invocations default to delegated because the caller is almost always an AI agent. CLI invocations default to direct when possible. Tests inject the provider explicitly.

## Consequences

### Positive

- **T0 zero-setup works by construction.** A user running `/assess` in Claude Code with no Minsky config and no API key still gets a useful result — the deterministic rubric plus a delegated-cognition bundle the surrounding agent executes.
- **Skill distribution is clean.** A compiled Minsky skill carries no runtime dependency on API keys. The harness executes the cognition; Minsky provides structure.
- **Testability improves.** Stub cognition providers produce deterministic, canned results for unit tests. No AI SDK mocking, no fake API keys, no flaky LLM-dependent tests.
- **MCP tool semantics match caller expectations.** A Minsky MCP tool invoked by an AI agent returns evidence + prompts, not opaque AI-generated text. The caller retains control of the cognitive work inside its own context.
- **Layer separation.** `CognitionProvider` (domain-facing) and `AICompletionService` (infrastructure) read as distinct abstractions. Future contributors see the boundary at a glance.
- **Cost alignment.** In embedded mode, the user pays for cognition once through their harness. Minsky does not double-bill.

### Negative

- **Another abstraction layer.** Every AI-using feature now routes through `CognitionProvider`. Readers must learn one more interface.
- **Delegated mode has different external UX.** Features that complete synchronously in direct mode return a bundle in delegated mode; the command's contract is mode-dependent. Callers must handle both kinds.
- **Retrofit debt.** Existing AI-using features (task embeddings, code review, task decomposition) use `AICompletionService` directly. They will need migration. Tracked separately as mt#1058; not a blocker.
- **Streaming semantics differ.** Direct mode can stream partial results; delegated mode cannot. Features relying on streaming in direct mode must render a static output in delegated mode.

### Neutral / Follow-ups

- Cost tracking, caching, and rate limiting are direct-mode concerns. Delegated mode defers these to the calling harness. Not solved here; features address them locally.
- Error taxonomies differ between modes (LLM errors vs bundle-parsing errors vs mode-unavailable errors). A shared error hierarchy should emerge in implementation.
- Future hybrid mode: some tasks direct (cheap embeddings), others delegated (narrative synthesis), within the same invocation. Out of scope; achievable later via per-task mode hints.

## Alternatives Considered

**Status quo (`AICompletionService` directly, no abstraction).** Rejected. Silently fails the embedded-mode contract. Every feature would reinvent dual-path branching, producing drift. Fails T0 zero-setup.

**Direct-only, require configuration for any AI work.** Rejected. Breaks the progressive-adoption ladder at T0. Users evaluating Minsky via a Claude Code skill should not need an API key.

**Delegated-only, no standalone execution.** Rejected. CLI use in terminal scripts (CI, automation, non-agent shells) is legitimate. Removing direct execution eliminates that entire class of users.

**Hardcoded branching per feature.** Rejected. Produces drift, duplication, inconsistent mode semantics. Violates capability-based provider conventions established in ADR-002 and ADR-003.

**External policy service (Cerbos/Captain Hook pattern) as the abstraction.** Rejected. Those are the right pattern for enforcement (mt#762 tracks that concern), not cognition. Cognition is about producing judgments and narratives, not evaluating compliance against predefined rules. Different problem shape.

**Extend `AICompletionService` with a mode flag.** Rejected. Conflates infrastructure (raw LLM access) with domain orchestration (cognitive tasks). Leaves feature code depending on an infrastructure abstraction, obscuring the layer boundary. Keep `AICompletionService` at the right level and layer `CognitionProvider` above it.

## Relationship to Existing Work

- **mt#800 skills architecture, mt#915 dual-path `generate_prompt`.** The delegated execution pattern is already partly built for subagent dispatch. This ADR generalizes it to all cognitive work. `CognitionBundle` and the skills-architecture prompt payloads should converge on a single shape; the implementation task will unify them.
- **ADR-002 (capability-based persistence).** Same pattern family: a first-class domain provider with multiple runtime implementations selected at the composition root. `CognitionProvider` inherits the conventions — composition-root resolution, no direct imports in feature code, test-friendly stubs.
- **mt#321 agent-readiness assessment.** First feature-level consumer. mt#321.2 depends on `CognitionProvider` existing; it does not build the abstraction itself.
- **`AICompletionService`.** Becomes the infrastructure backing `DirectCognitionProvider`. Feature code no longer imports it after this ADR. No breaking changes to the service; existing callers continue to work pending retrofit (mt#1058).
- **`docs/theory-of-operation.md` (VSM).** Maps conceptually to System 4 (environmental intelligence): the cognitive capacity the system draws on to interpret evidence and synthesize responses. Gives System 4 a concrete infrastructure organ.
- **Progressive adoption model (mt#1059).** `CognitionProvider` delegated mode is the mechanism that makes T0 zero-setup possible. The adoption-model task documents the ladder; this ADR documents one of its structural enablers.

## Implementation Plan

1. **Phase 1 — Abstraction.** This task (mt#1057): define `src/domain/cognition/` with the interfaces above. Implement `DirectCognitionProvider` wrapping `AICompletionService`. Implement `DelegatedCognitionProvider` producing `CognitionBundle` outputs. Implement `DegradedCognitionProvider`. Mode resolution via composition-root wiring. Stub provider for tests.

2. **Phase 2 — First consumer.** mt#321.2 consumes the abstraction for criterion evaluation and synthesis. Validates interface shape under real use before any generalization.

3. **Phase 3 — Unification with mt#915.** Coordinate with skills architecture: ensure `session_generate_prompt` and delegated-cognition bundles share a consistent payload shape. Likely yields a common `PromptBundle` type.

4. **Phase 4 — Retrofit umbrella (mt#1058).** Migration of existing AI-using features (embeddings, semantic search, code review, task decomposition) from direct `AICompletionService` use to `CognitionProvider`. One sub-task per feature.

5. **Phase 5 — MCP default.** Once the abstraction is stable, MCP tool handlers default to delegated mode unless a tool explicitly opts into direct. This is the largest behavioral change and is sequenced last so Minsky's own CLI validates the abstraction first.

## Open Questions

- **Streaming.** Should delegated mode support progressive bundle assembly, or always return a complete bundle? Likely the latter for simplicity.
- **Model hinting.** `CognitionTask.model` is advisory. Direct mode can honor hints; delegated mode cannot guarantee. Document as provider-dependent.
- **Security boundary.** A delegated `CognitionBundle` contains evidence the caller's harness will inject into its own context. What data sanitization is required? Follow-up task on cognition-boundary sanitization.
- **Idempotency.** Direct mode may retry failed LLM calls. Delegated mode cannot. Features requiring idempotent cognition must flag this explicitly in their task declarations.

## References

- ADR-002: Persistence Provider Architecture with Type-Safe Capability Detection
- ADR-003: Project-Level Repository Backend Configuration
- ADR-004: Two-Phase Command Execution
- `src/domain/ai/types.ts` — existing `AICompletionService` interface
- `src/domain/runtime/harness-detection.ts` — existing mode-detection helpers
- `docs/theory-of-operation.md` §System 4 — VSM framing
- mt#321 — agent-readiness assessment (first consumer)
- mt#800 / mt#915 — skills architecture with dual-path prompt generation
- mt#762 — agent-agnostic enforcement research (separate pattern, not this ADR)
- mt#1057 — this task (implementation)
- mt#1058 — retrofit umbrella
- mt#1059 — progressive adoption model (upstream design input)
