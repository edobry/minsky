# ADR-001: Adopt Database-First Architecture for Task Backend

## Status
Proposed

## Context

Minsky's task management system currently faces a fundamental architectural decision between two approaches:

1. **In-tree backends**: Store task metadata as files (markdown/JSON) within git repositories
2. **Database backends**: Use traditional databases (SQLite/PostgreSQL) for task storage

The current implementation attempts to support in-tree backends through a complex "special workspace" mechanism that has proven problematic:

- **Complexity**: 445+ lines of git synchronization code with file-based locking
- **Performance**: 100-1000x slower than database operations
- **Scalability**: Breaks down with multiple repositories
- **Features**: Prevents implementation of AI decomposition and task graphs

Analysis reveals that the in-tree approach essentially reimplements a distributed database poorly on top of git, creating complexity without corresponding benefits.

## Decision

**Adopt a database-first architecture with SQLite as the default backend and PostgreSQL for team scenarios. Deprecate and remove in-tree backend support.**

### Specific Decisions:

1. **Default Backend**: SQLite embedded database
   - Zero external dependencies
   - Single file storage
   - Full feature support

2. **Team Backend**: PostgreSQL for advanced scenarios
   - Real-time collaboration
   - Advanced querying
   - Horizontal scaling

3. **Deprecation**: Remove in-tree backends
   - 6-month deprecation period
   - Automated migration tools
   - Clear communication

## Rationale

### 1. Performance
- Database operations are 100-1000x faster
- Enables real-time user experience
- Supports complex queries efficiently

### 2. Simplicity
- Eliminates special workspace complexity
- Standard database tools and patterns
- Clear mental model for users

### 3. Features
- Enables AI-powered task decomposition
- Supports visual task graphs
- Allows cross-repository relationships

### 4. Scalability
- Proven to billions of records
- Handles team collaboration
- Supports enterprise scale

### 5. Maintenance
- Reduces codebase complexity
- Standard operational procedures
- Mature ecosystem

## Consequences

### Positive
- ✅ Massive performance improvement
- ✅ Enables advanced features
- ✅ Simplifies architecture
- ✅ Better user experience
- ✅ Standard tooling
- ✅ Clear upgrade path

### Negative
- ❌ Breaking change for existing users
- ❌ Migration effort required
- ❌ Loss of "pure git" philosophy

### Neutral
- 🔄 Different backup strategies needed
- 🔄 New operational knowledge required
- 🔄 Changed testing approach

## Implementation

1. **Phase 1**: SQLite implementation (immediate)
2. **Phase 2**: PostgreSQL support (3 months)
3. **Phase 3**: In-tree deprecation (6 months)
4. **Phase 4**: Legacy code removal (12 months)

## References

- Task #325: Task Backend Architecture Analysis
- Analysis: Distributed Systems Perspective
- Analysis: Cross-Repository Challenges
- Analysis: Architectural Tradeoffs