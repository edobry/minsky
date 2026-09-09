# ADR-002: Persistence Provider Architecture with Type-Safe Capability Detection

## Status

**ACCEPTED** - Implemented 2025-01-10

> **Addendum (2026-07-07, ADR-027):** the capability-detection axis described below
> (`PostgresPersistenceProvider` vs `PostgresVectorPersistenceProvider`) is **intra-Postgres**
> — both subclasses wrap the same PostgreSQL connection and differ only in whether `pgvector`
> is installed. This ADR never specified a second storage engine. For the backend-count
> decision (Postgres is the only supported backend; SQLite was removed), see
> [ADR-018](adr-018-domain-persistence-pattern.md) §"SQLite consequence (explicit)" and
> [ADR-027](adr-027-postgres-only-persistence-confirmed.md).

> **Addendum (2026-08-03, ADR-035):** the "graceful degradation" constraint below, and
> §Architecture Invariants item 5 ("Commands own fallback strategies"), assign degradation to the
> **command** layer. A composition root that catches an initialization failure and substitutes one
> placeholder provider for every consumer at once is a layer transposition of that constraint, not
> an application of it — and it also defeats §Architecture Invariants item 3 ("Database commands
> always receive initialized provider"). See
> [ADR-035](adr-035-failed-initializer-must-not-be-memoized-as-a-value.md) for the rule that a
> failed initializer must not be memoized as a value, and for why it generalizes past persistence.

> **Addendum (2026-09-09, mt#5037): pgvector is a PREREQUISITE, not a runtime capability axis.**
> Three statements below are superseded — `## Context`'s constraint _"PostgreSQL may or may not have
> pgvector extension available"_, the `### Capability Detection Challenge` framing of that
> availability as _"a runtime constraint that must be handled gracefully across different deployment
> environments"_, and `### Operational Benefits`' _"Same code works in dev (no pgvector) and prod
> (with pgvector)"_. **Postgres WITH pgvector is the supported deployment; a Postgres without it is
> not a supported target.**
>
> **Evidence, measured rather than asserted (mt#5016).** The schema declares `vector(1536)` columns
> in six tables plus six HNSW indexes, and the fresh-DB bootstrap snapshot's first statement is
> `CREATE EXTENSION IF NOT EXISTS vector`. Run against a stock `postgres:17`, migration fails with
> SQLSTATE `0A000`, exit 1, and zero tables written — before any provider is constructed. So the
> degraded `PostgresPersistenceProvider` branch this ADR describes was unreachable on every fresh
> install: the install fails first.
>
> **What this does NOT retire.** The two-class hierarchy stays, and so does the capability probe.
> `PostgresPersistenceProvider` remains the BASE class of `PostgresVectorPersistenceProvider` — it is
> not merely the degraded branch — and the `pg_extension` probe remains as a **precondition
> assertion** rather than a branch selector: a missing or unreadable extension now fails fast naming
> the requirement, where it previously produced a silently reduced-capability provider. Deleting the
> probe outright would have asserted a capability nothing checked, since
> `PostgresVectorPersistenceProvider.initialize()` skips its own re-probe precisely when the factory
> reports one already ran (mt#2973). mt#3833's inconclusive-probe distinction is retained and matters
> MORE under a hard requirement, not less: "absent" and "could not tell" now both fail, so
> conflating them would misreport the cause.
>
> **The reachable case that remains.** A database migrated WITH pgvector that later loses the
> extension is still detectable — that is what the assertion catches. It is not a supported
> deployment shape; it is a failure mode with a clear message.
>
> **Decision provenance:** the principal, via ask#11882 (`direction.decide`, 2026-09-09), choosing
> "Require pgvector" with its cost stated and accepted — this closes off "runs on any Postgres",
> which matters if a customer's managed Postgres lacks the extension. That exposure is known and
> accepted, not overlooked.

## Context

### System Characteristics

- **CLI tool with MCP server capability**: Short-lived processes (seconds) for CLI, variable lifetime for MCP server
- **Unified codebase**: Same commands must work in both CLI and MCP modes without duplication
- **Variable deployment environments**: PostgreSQL may or may not have pgvector extension available
- **Multiple contributors**: Different developers implement commands with varying persistence layer expertise

### Technical Constraints

- **Type safety priority**: "Maximum developer safety and IDE support" explicitly prioritized
- **Performance requirement**: Avoid database connections for non-database commands (`minsky --help`, file-based operations)
- **Testing requirement**: Clean, isolated tests without global state pollution
- **Graceful degradation**: Commands should fallback when possible rather than fail completely

### Capability Detection Challenge

PostgreSQL persistence provider can support vector operations **only if** the pgvector extension is installed. This is a **runtime constraint** that must be handled gracefully across different deployment environments while maintaining compile-time safety.

## Decision

We chose **Type-Safe Factory Pattern** with the following architecture:

### Core Components

1. **Class Hierarchy for Capabilities**

   ```typescript
   // Base provider - core PostgreSQL functionality
   class PostgresPersistenceProvider {
     capabilities = { sql: true, vectorStorage: false, jsonb: true, migrations: true };
     // No getVectorStorage() method
   }

   // Extended provider - adds vector capabilities
   class PostgresVectorPersistenceProvider extends PostgresPersistenceProvider {
     capabilities = { ...super.capabilities, vectorStorage: true };
     getVectorStorage(dimension: number): VectorStorage {
       /* */
     }
   }
   ```

2. **Runtime Capability Detection Factory**

   ```typescript
   export class PostgresProviderFactory {
     static async create(
       config
     ): Promise<PostgresPersistenceProvider | PostgresVectorPersistenceProvider> {
       // Runtime database probe
       const hasVector = await this.checkPgVectorExtension(config);

       return hasVector
         ? new PostgresVectorPersistenceProvider(config) // TypeScript knows it has vector methods
         : new PostgresPersistenceProvider(config); // TypeScript knows it doesn't
     }
   }
   ```

3. **DatabaseCommand Abstract Base Class**

   ```typescript
   abstract class DatabaseCommand<TParams, TResult> {
     abstract execute(
       params: TParams, // Fully typed from Zod schema
       context: DatabaseCommandContext // Provider injected by dispatcher
     ): Promise<TResult>;
   }

   interface DatabaseCommandContext extends CommandExecutionContext {
     provider: PersistenceProvider; // Guaranteed to be initialized
   }
   ```

4. **Dispatch-Level Lazy Initialization**

   ```typescript
   class CommandDispatcher {
     async executeCommand(commandId: string, params: any, context: CommandExecutionContext) {
       const command = sharedCommandRegistry.getCommand(commandId);

       if (command instanceof DatabaseCommand) {
         // Lazy initialization only for database commands
         if (!PersistenceService.isInitialized()) {
           await PersistenceService.initialize(); // Factory detects capabilities
         }

         return command.execute(params, { ...context, provider: PersistenceService.getProvider() });
       } else {
         return command.execute(params, context); // No provider needed
       }
     }
   }
   ```

5. **Command-Level Capability Adaptation**
   ```typescript
   class SimilaritySearchCommand extends DatabaseCommand {
     async execute(params: SimilarityParams, context: DatabaseCommandContext) {
       if (context.provider instanceof PostgresVectorPersistenceProvider) {
         // Vector search available - use it
         return this.vectorSearch(params.query, context.provider);
       } else {
         // Graceful fallback
         log.cliWarn("Vector search unavailable, using lexical similarity");
         return this.lexicalSearch(params.query);
       }
     }
   }
   ```

## Rationale

### Decision Matrix Analysis

**Team Characteristics (Type-Safe Factories)**:

- ✅ **Multiple contributors**: Different developers implement commands with varying persistence expertise
- ✅ **Distributed development**: Commands implemented across different modules by different people
- ✅ **Expertise variation**: Not all developers understand persistence layer nuances

**Command Complexity (Type-Safe Factories)**:

- ✅ **Complex business logic**: Similarity search, task relationships, session management
- ✅ **Multiple fallback strategies**: Vector → lexical → AI similarity chains
- ✅ **Clean handler separation**: Commands focus on business logic, not infrastructure

**Error Preference (Compile-Time)**:

- ✅ **"Maximum developer safety"**: Explicit requirement prioritizes compile-time error detection
- ✅ **IDE support requirement**: IntelliSense must show only available methods
- ✅ **Prevent capability bugs**: Using vector methods on non-vector providers should be impossible

### Type-Safe Factories vs Runtime Gating

| Factor                  | Our Situation                              | Favors              |
| ----------------------- | ------------------------------------------ | ------------------- |
| Team size               | Multiple contributors, varying expertise   | Type-Safe Factories |
| Command complexity      | Complex business logic with fallbacks      | Type-Safe Factories |
| Error preference        | Compile-time safety explicitly prioritized | Type-Safe Factories |
| Architecture preference | Developer guardrails over simplicity       | Type-Safe Factories |

**Colleague's Recommendation**: _"For a CLI with multiple contributors, go with type-safe factories. The compile-time safety prevents entire classes of bugs, and the factory complexity is one-time cost vs ongoing runtime checking discipline."_

## Alternatives Considered

### Alternative 1: Runtime Capability Gating

```typescript
// Single provider class with runtime checking
class PersistenceManager {
  requiresVector() {
    if (!this.capabilities.vectorStorage) throw new Error("pgvector required");
  }

  getVectorStorage() {
    this.requiresVector(); // Runtime check every time
    return this.vectorStorage;
  }
}
```

**Rejected because**:

- Requires discipline from all command developers to check capabilities
- No compile-time safety - capability mismatches found at runtime
- IDE cannot provide appropriate method suggestions
- Ongoing burden on every command developer vs one-time factory complexity

### Alternative 2: Discriminated Unions

```typescript
type PersistenceProvider =
  | {
      type: "postgres-vector";
      vectorStorage: true;
      getVectorStorage: (dim: number) => VectorStorage;
    }
  | { type: "postgres-base"; vectorStorage: false /* no vector methods */ };
```

**Rejected because**:

- Combinatorial explosion as capabilities grow (2^n combinations)
- Complex type definitions that become unwieldy
- Class hierarchy provides better extensibility

### Alternative 3: Global Eager Initialization

```typescript
// Initialize at CLI startup for all commands
await PersistenceService.initialize();
```

**Rejected because**:

- Wastes database connections for non-database commands
- Slower startup for commands like `minsky --help`
- Same lazy initialization benefit applies to both CLI and MCP modes

## Benefits

### Developer Experience

- **Compile-time error prevention**: Cannot call vector methods on non-vector providers
- **IDE integration**: IntelliSense only shows available methods for specific provider types
- **Clear testing**: Mock providers injected via context, no global state management
- **Type inference**: Full parameter typing from Zod schemas maintained

### Operational Benefits

- **Environment adaptation**: Same code works in dev (no pgvector) and prod (with pgvector)
- **Graceful degradation**: Commands implement fallback strategies appropriate to their domain
- **Performance optimization**: Database connections only for commands that need them
- **Clear error messages**: Factory provides actionable error context when capabilities missing

### Architectural Benefits

- **Separation of concerns**: Infrastructure (dispatcher) vs business logic (commands)
- **Scalable capability model**: Class hierarchy scales linearly with new capabilities
- **Unified CLI/MCP**: Same architecture works for both interface modes
- **Single-flight initialization**: Prevents concurrent initialization races

## Implementation Notes

### For New Engineers

**When creating database commands**:

1. Extend `DatabaseCommand<TParams, TResult>` with proper type parameters
2. Define Zod parameter schema and let TypeScript infer parameter types
3. Use `context.provider` for database access (never call singletons directly)
4. Implement capability checking with `instanceof` for type-safe method access
5. Consider fallback strategies appropriate to your command's domain

**Testing database commands**:

```typescript
test("command works with mock provider", async () => {
  const mockProvider = createMockProvider();
  const context: DatabaseCommandContext = { provider: mockProvider, interface: "test" };

  const command = new YourCommand();
  const result = await command.execute({ param: "value" }, context);

  // No global state pollution - clean and isolated
});
```

### Architecture Invariants

1. **Only dispatcher touches `PersistenceService`**: Commands never call singleton directly
2. **Provider type determines method availability**: Use `instanceof` for capability checking
3. **Context provides guaranteed dependencies**: Database commands always receive initialized provider
4. **Capabilities immutable per process**: No runtime capability changes needed
5. **Commands own fallback strategies**: No central requirement coordination needed

## Future Considerations

### Adding New Capabilities

To add a new capability (e.g., full-text search):

1. Add capability flag to `PersistenceCapabilities` interface
2. Create extended provider class that implements capability-specific interface
3. Update factory to detect capability and return appropriate provider class
4. Commands can check capability with `instanceof` and implement fallbacks

### Performance Monitoring

Monitor initialization overhead for non-database commands to ensure lazy initialization provides expected benefits.

### Capability Evolution

If runtime capability changes become needed (unlikely for CLI), consider capability refresh mechanisms, but maintain type-safe provider return types.

## References

- [Domain-Driven Design](https://martinfowler.com/tags/domain%20driven%20design.html) - Interface segregation principles
- [TypeScript Handbook - Type Guards](https://www.typescriptlang.org/docs/handbook/advanced-types.html) - Runtime type narrowing
- [Factory Pattern](https://refactoring.guru/design-patterns/factory-method) - Object creation with runtime logic

---

_This ADR documents the persistence provider architecture decision made during the sessiondb deprecation work (task mt#528) and incorporates insights from architectural consultation with experienced colleagues._
