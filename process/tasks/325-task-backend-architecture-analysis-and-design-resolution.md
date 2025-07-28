# Task Backend Architecture Analysis and Design Resolution

## Problem Statement

The current task system architecture faces a fundamental tension between supporting in-tree task metadata backends (markdown/json) and managing the resulting workflow complexity. The special workspace mechanism designed to support in-tree backends has proven complex, brittle, and possibly more trouble than it's worth. 

**CRITICAL INSIGHT**: Minsky is fundamentally an **AI-powered task management tool**, which requires hosted AI APIs and internet connectivity for core value delivery. This significantly changes the architectural constraints and priorities.

This task involves a comprehensive analysis of the architectural tradeoffs and philosophical considerations to resolve the core design questions around task backend architecture in the context of AI-first workflows.

## Core Architectural Conflict

### The Central Dilemma

Supporting in-tree task metadata backends (markdown/json files stored in the repository) requires complex synchronization mechanisms, currently implemented through the "special workspace" workflow. This creates several layers of complexity:

1. **Synchronization Complexity**: Task management operations must happen on `main` for in-tree backends, requiring careful coordination
2. **Special Workspace Overhead**: The current approach requires maintaining a separate workspace and complex synchronization logic
3. **AI Feature Limitations**: In-tree backends prevent efficient vector storage, real-time collaboration, and advanced AI features
4. **Performance Bottlenecks**: Git operations are too slow for AI-powered workflows requiring rapid iterations

### AI-First Architectural Requirements

Minsky's core value proposition requires:
- **Vector Storage**: For semantic task search and AI embeddings
- **Real-time Operations**: For collaborative AI task decomposition
- **Fast Queries**: For complex task relationship analysis
- **Concurrent Access**: For team collaboration on AI-generated content
- **Internet Connectivity**: For hosted AI API access (OpenAI, Anthropic, etc.)

### Philosophical vs Practical Considerations

The in-tree approach offers philosophical elegance:
- **Dependency-free**: No external infrastructure required
- **Git-native**: Task state follows git history naturally
- **Self-contained**: Everything needed is in the repository

However, AI-first requirements demand database capabilities:
- **Vector operations**: Semantic search and embeddings
- **Real-time updates**: Collaborative AI workflows
- **Performance**: Sub-second operations for AI features
- **Team coordination**: Shared AI insights and recommendations

## Key Architectural Questions (Revised)

### 1. Backend Strategy for AI-First Architecture

**SQLite-First vs Hosted-First**
- Should we default to SQLite for onboarding simplicity?
- When should users upgrade to hosted databases (PostgreSQL/Supabase)?
- How do we provide smooth migration paths?

### 2. AI Feature Requirements

**Local vs Hosted AI Capabilities**
- Which AI features work with SQLite backends?
- What requires hosted database capabilities?
- How do we handle offline scenarios (when AI APIs unavailable)?

### 3. Progressive Enhancement Strategy

**Onboarding vs Feature Completeness**
- How do we minimize setup friction while enabling full AI capabilities?
- What's the optimal upgrade path from SQLite to PostgreSQL?
- Should we build sync engines or focus on migration tools?

### 4. Team Collaboration Requirements

**Solo vs Team Workflows**
- How do team AI workflows differ from solo AI workflows?
- When do users need real-time collaboration features?
- How do we handle the transition from solo to team usage?

### 5. Migration and Sync Architecture

**Upgrade Path Complexity**
- Should we support bidirectional sync between SQLite and PostgreSQL?
- Is simple migration sufficient, or do users need hybrid modes?
- How do we handle schema evolution across backend types?

## Research Areas (Updated)

### 1. AI-First Backend Requirements

#### Vector Storage and Search
- SQLite vector extension capabilities vs PostgreSQL pgvector
- Semantic search performance requirements
- Embedding storage and retrieval patterns

#### Real-time Collaboration
- WebSocket requirements for AI-powered workflows
- Conflict resolution for AI-generated content
- Team coordination patterns for task decomposition

### 2. SQLite to PostgreSQL Migration

#### Upgrade Path Design
- Manual migration command implementation
- Data integrity validation strategies
- Schema compatibility between backends
- Rollback and recovery procedures

#### Sync Engine Feasibility
- Bidirectional sync complexity analysis
- Conflict resolution strategies
- Change tracking and log-based replication
- Performance implications of hybrid architecture

### 3. Progressive Enhancement Strategy

#### Onboarding Optimization
- Zero-config SQLite setup
- AI API key configuration flow
- First-time user experience design
- Feature discovery and upgrade prompts

#### Feature Matrix Documentation
- Which features work with each backend
- Performance characteristics comparison
- Team vs solo feature requirements
- Clear upgrade decision criteria

### 4. Hosted Database Integration

#### Service Provider Analysis
- Supabase vs alternatives for AI workflows
- Vector database specialized services
- Cost and performance characteristics
- Team management and authentication

#### Cloud SQLite Services
- Turso, Cloudflare D1, LiteFS evaluation
- Edge deployment capabilities
- Upgrade paths to traditional PostgreSQL
- Pricing and scaling characteristics

## Deliverables (Updated)

### 1. AI-First Architecture Analysis

A detailed document analyzing:
- **SQLite Capabilities**: What AI features work with local SQLite
- **PostgreSQL Requirements**: When hosted databases become necessary
- **Migration Strategies**: Simple vs complex upgrade paths
- **Performance Analysis**: Speed requirements for AI workflows
- **Recommendation**: Clear backend strategy for AI-first tool

### 2. Architectural Decision Records (ADRs)

Formal ADRs for key decisions:
- Backend strategy (SQLite-first with PostgreSQL upgrade)
- AI feature requirements and backend compatibility
- Migration vs sync approach decision
- Team collaboration architecture

### 3. Progressive Enhancement Design

Detailed user journeys for:
- Solo developer onboarding (SQLite + AI APIs)
- Team collaboration upgrade (PostgreSQL migration)
- AI feature enablement across backends
- Conflict resolution and data consistency

### 4. Implementation Roadmap

Phased approach to implementation:
- **Phase 1**: SQLite backend with AI feature support
- **Phase 2**: PostgreSQL migration tooling
- **Phase 3**: Advanced team collaboration features
- **Phase 4**: Optional sync engine (if user demand exists)

### 5. Backend Decision Framework

Clear guidance for users:
- When to use SQLite vs PostgreSQL
- How to evaluate upgrade timing
- Cost-benefit analysis of different approaches
- Team size and workflow considerations

## Success Criteria (Updated)

### 1. Onboarding Simplicity
- [ ] Zero-config startup with SQLite
- [ ] AI features work immediately after API key setup
- [ ] Clear upgrade path when team features needed
- [ ] No forced migrations or service dependencies

### 2. AI Feature Enablement
- [ ] Vector storage and semantic search in SQLite
- [ ] Real-time collaboration in PostgreSQL
- [ ] Performance meets AI workflow requirements
- [ ] Team AI features work seamlessly

### 3. Migration Excellence
- [ ] Smooth SQLite to PostgreSQL upgrade
- [ ] Data integrity preserved during migration
- [ ] Rollback capabilities if needed
- [ ] Clear communication of what changes

### 4. Performance Standards
- [ ] SQLite operations: <100ms for AI workflows
- [ ] PostgreSQL operations: <50ms for team features
- [ ] Migration time: <30 seconds for typical datasets
- [ ] No data loss during any transitions

## Constraints (Updated)

### Non-negotiable Requirements
- Must support AI-powered features as core value
- Must preserve data integrity during backend transitions
- Must work with major AI API providers (OpenAI, Anthropic)
- Must enable team collaboration for PostgreSQL backends

### Scope Boundaries
- **Primary focus**: AI-first architecture design
- **Secondary focus**: Smooth upgrade paths
- **Out of scope**: Offline-first optimization (AI requires internet)
- **Future consideration**: Advanced sync engines (if demand exists)

## Open Questions to Resolve (Updated)

1. **Should SQLite be the default for onboarding simplicity?**
2. **Which AI features truly require PostgreSQL vs work fine with SQLite?**
3. **Is simple migration sufficient, or do users need bidirectional sync?**
4. **How do we handle team onboarding - direct to PostgreSQL or SQLite first?**
5. **What's the cost-benefit of building sync engines vs focusing on migration?**
6. **How do we optimize for AI workflow performance across backends?**
7. **Should we recommend specific hosted services (Supabase) or stay generic?**
8. **How do we handle schema evolution as AI features expand?**
9. **What's the upgrade trigger - user choice or automatic recommendations?**
10. **How do we balance simplicity with full feature availability?**

## Related Context

### AI-First Architecture Implications
- Core features require vector storage and fast queries
- Real-time collaboration needed for team AI workflows  
- Internet connectivity assumed for AI API access
- Offline work is secondary concern for AI-powered tool

### Current Implementation
- Special workspace workflow for in-tree backends
- Session-to-task mapping via git branches
- Task status management complexity

### Future AI Features
- AI-powered task decomposition
- Semantic task relationship discovery
- Real-time collaborative task refinement
- Vector-based task search and insights

## Timeline

**Estimated Duration**: 2-3 weeks of focused analysis and design

### Week 1: AI Requirements and SQLite Analysis
- AI feature requirements deep dive
- SQLite capabilities for AI workflows
- Performance benchmarking

### Week 2: Migration Strategy and PostgreSQL Integration
- Migration tooling design
- PostgreSQL feature analysis
- Team collaboration requirements

### Week 3: Decision Making and Documentation
- Formal ADRs and recommendations
- Implementation roadmap
- User decision framework

## Conclusion

This task represents a critical architectural decision point for Minsky, now understood as an AI-first tool. The outcome will significantly impact the system's ability to deliver AI-powered value while maintaining excellent user experience. By thoroughly analyzing the AI requirements and designing smooth upgrade paths, we can chart a clear path forward that balances onboarding simplicity with advanced AI capabilities.