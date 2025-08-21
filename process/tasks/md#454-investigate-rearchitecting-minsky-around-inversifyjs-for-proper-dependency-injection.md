# Task md#454: Investigate rearchitecting Minsky around InversifyJS for proper dependency injection

## Background

Currently Minsky uses async factory functions to handle dependency injection for services that require async initialization (like database connections). This works but has some drawbacks:
- Developers must remember to use async factories vs constructors
- No standardized DI container
- Manual dependency management

## Objective

Research and evaluate migrating Minsky to use InversifyJS as a proper IoC/DI framework.

## Research Areas

1. **InversifyJS Evaluation**
   - Async dependency support
   - Decorator requirements and TypeScript config impact
   - Bundle size and performance implications
   - Integration with existing CLI architecture

2. **Migration Strategy**
   - Incremental migration path from current factories
   - Backward compatibility considerations
   - Impact on existing TaskBackend implementations
   - CLI command registration changes needed

3. **Benefits Analysis**
   - Developer experience improvements
   - Code maintainability gains
   - Testing improvements (mocking, etc.)
   - Long-term architectural benefits

4. **Alternative Frameworks**
   - TSyringe comparison (Microsoft's solution)
   - TypeDI evaluation
   - Custom minimal container option

## Deliverables

- Technical analysis document
- Proof-of-concept implementation for one service
- Migration plan with phases
- Decision recommendation with trade-offs

## Success Criteria

- Clear understanding of InversifyJS fit for Minsky
- Working PoC demonstrating async dependency injection
- Actionable migration plan if recommended
