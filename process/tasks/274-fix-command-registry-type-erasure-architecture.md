# Fix Command Registry Type Erasure Architecture

## Status

BACKLOG

## Priority

MEDIUM

## Description

The SharedCommand interface intentionally erases types 'for easier use in bridge implementations' which forces type casting throughout the codebase. The system converts properly typed command definitions to 'any' types, then requires type casting at every usage point. This architectural decision should be reversed to enable proper type safety with generic command definitions that preserve type information through the entire execution chain.

## Requirements

### Core Type Safety Architecture
- [ ] **Reverse type erasure in SharedCommand interface**: Enable generic command definitions that preserve type information through the entire execution chain
- [ ] **Eliminate command registry type casting**: Remove `as any` casts introduced by current type erasure architecture
- [ ] **Implement proper generic command types**: Design type-safe command registry that maintains type information from definition to execution

### Schema-Based Type Safety Extensions (from Task #271)
The following type safety improvements should be implemented alongside the command registry fixes:

- [ ] **Complete git.ts patterns**: Apply schema validation to remaining git.ts error patterns
- [ ] **Domain file enhancement**: Extend schema validation to other domain files beyond task backends
- [ ] **Storage validation**: Add schema validation to storage backend operations
- [ ] **Testing enhancement**: Add more comprehensive schema validation tests
- [ ] **ESLint Rules**: Add rules to prevent new unsafe cast introduction
- [ ] **Documentation**: Update development guidelines for schema-based patterns
- [ ] **Training**: Share schema-based patterns with development team

## Success Criteria

### Type Safety Metrics
- [ ] **Zero `as any` casts in command registry**: Complete elimination of type erasure-induced casting
- [ ] **Full type inference**: Command definitions maintain type information through entire execution chain
- [ ] **Schema validation coverage**: All JSON parsing and external API boundaries use proper Zod validation
- [ ] **ESLint compliance**: New rules prevent regression to unsafe type casting patterns

### Architecture Quality
- [ ] **Generic command interface**: SharedCommand interface preserves type information for all command types
- [ ] **Type-safe execution chain**: Commands maintain proper types from CLI/MCP input to domain execution
- [ ] **Runtime validation**: Schema-based validation provides safety at all external boundaries
- [ ] **Developer experience**: Full IDE support with autocompletion and type checking throughout

## Related Work

**Completed in Task #271:**
- ✅ Phase 1: Mechanical conversion of 3,757 `as any` → `as unknown` (88% automation)
- ✅ Phase 2: Schema-based validation for JsonFileTaskBackend, GitHubIssuesTaskBackend, and CLI error handling
- ✅ Infrastructure: Comprehensive Zod schemas for storage, errors, and runtime validation

**Architectural Foundation:**
The work in this task builds on the type safety infrastructure established in Task #271, extending it to eliminate the root cause of type erasure in the command registry architecture.
