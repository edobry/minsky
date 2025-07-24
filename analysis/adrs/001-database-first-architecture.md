# ADR-001: Multi-Backend Architecture Strategy

## Status
Proposed

## Context

Minsky's task management system faces an architectural decision between:

1. **In-tree backends**: Store task metadata as files (markdown/JSON) within git repositories
2. **Database backends**: Use traditional databases (SQLite/PostgreSQL) for task storage

Initial analysis revealed significant tradeoffs:

**In-Tree Benefits**:
- Automatic backup via git
- Zero-friction onboarding (just clone)
- No external dependencies
- Version history included

**In-Tree Costs**:
- Special workspace complexity (445+ lines)
- Poor performance (100-1000x slower)
- Limited cross-repository support
- Blocks advanced features

**Database Benefits**:
- Excellent performance
- Enables AI features and task graphs
- Real-time collaboration
- Proven scalability

**Database Costs**:
- Setup friction
- Backup responsibility
- External dependencies

## Decision

**Adopt a multi-backend strategy that acknowledges legitimate use cases for both approaches, rather than forcing a single architectural choice.**

### Specific Decisions:

1. **Maintain In-Tree Support**: Keep markdown/JSON backends for users who prioritize backup simplicity and zero-setup
2. **Add Database Options**: Provide SQLite and hosted database backends for performance and features  
3. **Clear Use Case Guidance**: Document when each backend is appropriate
4. **Voluntary Migration**: Provide upgrade paths but don't force migration

## Backend Strategy

### In-Tree Backend (Markdown/JSON)
**Best For**:
- Solo developers
- Single repository projects
- <100 tasks
- Backup/onboarding priority over performance

**Implementation**:
- Optimize special workspace performance
- Better error recovery
- Clear limitation documentation

### SQLite Backend  
**Best For**:
- Performance-sensitive solo work
- Large task volumes
- Local development with manual backup

**Implementation**:
- Embedded database
- File-based storage
- Migration tools from in-tree

### Hosted Database Backend
**Best For**:
- Team collaboration
- Multi-repository workflows
- AI-powered features
- Real-time updates

**Implementation**:
- Supabase integration
- PostgreSQL compatibility
- Professional features

## Rationale

### 1. User Choice Over Architectural Purity
Different users have different priorities. Rather than optimizing for one use case, provide excellent options for each.

### 2. Acknowledge Real Benefits
In-tree backends provide genuine value for backup and onboarding that database approaches struggle to replicate.

### 3. Performance Where It Matters
Users who need performance can get it via database backends without forcing everyone to accept setup complexity.

### 4. Feature Progression
Advanced features (AI, graphs) require database capabilities, but basic task management works fine with in-tree.

## Consequences

### Positive
- ✅ Respects user priorities and context
- ✅ Preserves backup/onboarding benefits
- ✅ Enables performance improvements
- ✅ Supports team collaboration
- ✅ Clear upgrade paths

### Negative
- ❌ Multiple codepaths to maintain
- ❌ Feature matrix complexity
- ❌ User education burden
- ❌ Testing complexity

### Mitigation
- Clear documentation of tradeoffs
- Automated testing across backends
- Feature parity where possible
- Migration tooling for upgrades

## Implementation

1. **Backend Framework**: Create abstraction layer supporting multiple backends
2. **Performance Optimization**: Improve special workspace efficiency
3. **Database Integration**: Add SQLite and hosted options
4. **Feature Matrix**: Document which features work with which backends
5. **Migration Tools**: Voluntary upgrade utilities

## Success Criteria

- Users can choose backend based on their priorities
- Performance improvements for those who need them
- Maintained backup/onboarding simplicity for those who value it
- Clear upgrade paths when needs change
- No forced migrations

## References

- Task #325: Task Backend Architecture Analysis
- Analysis: Architectural Tradeoffs (Revised)
- Analysis: Cross-Repository Challenges