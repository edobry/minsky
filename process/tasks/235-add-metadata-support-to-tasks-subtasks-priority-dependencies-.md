---
user_requirements: "Add the notion of 'original task spec/prompt' - what the human originally said when getting AI to generate a full task spec. Should be a formatted/structured information-preserving summary of accumulated prompts over time, NOT enhanced past what the user originally said. Should be separate from the AI-enhanced full specification. Consider storage in YAML frontmatter, database metadata, or other metadata system."
---

# Task Metadata Architecture Research and Design

## Status

BACKLOG

## Priority

HIGH

## Description

Research and design the architectural foundation for task metadata systems including subtasks, priority, dependencies, and other extended task properties. This task focuses on architectural decision-making and provides the foundation for subsequent implementation tasks. The research will analyze how metadata interacts with different task backends and recommend the optimal architectural approach.

**DIRECTIONAL DECISION**: Minsky will implement a task metadata database to store complex relationships, dependencies, provenance, and metadata not supported by task backends. However, the architecture must be sophisticated enough to allow users to continue using their preferred backend interfaces (GitHub Issues UI, markdown editors, etc.) for metadata that backends natively support. This task will focus on designing a hybrid approach that respects backend capabilities and user workflow preferences while providing unified advanced capabilities.

## Scope

**This task is RESEARCH AND ARCHITECTURE ONLY** - no implementation. Implementation will be handled by subsequent tasks based on the architectural decisions made here.

**PRIMARY FOCUS**: Design a sophisticated metadata architecture that balances:

- Backend-native metadata (users can continue using familiar interfaces)
- Metadata database for advanced capabilities (complex relationships, AI features)
- Seamless synchronization and conflict resolution between systems
- Unified query and operation interfaces across all backends

## Requirements

### 1. Research and Analysis

#### 1.1 Task Metadata Survey

- [ ] Research common task metadata fields across different project management systems
- [ ] Identify core metadata categories:
  - **Structural**: subtasks, parent tasks, dependencies, blockers, tactical subtasks/todos
  - **Organizational**: priority, tags, categories, milestones
  - **Temporal**: due dates, estimates, time tracking
  - **Workflow**: assignees, reviewers, status transitions
  - **Contextual**: descriptions, attachments, comments, links
  - **Provenance**: original user requirements, prompt evolution history, user intent preservation

#### 1.2 Backend Capabilities Analysis

- [ ] Analyze existing task backends and their native capabilities:
  - **GitHub Issues**: labels, milestones, assignees, linked issues, projects
  - **Markdown Files**: limited to file content and frontmatter
  - **JSON Files**: flexible schema support
  - **Future backends**: Linear, Jira, Notion, etc.
- [ ] Document capability matrix showing what each backend supports natively
- [ ] Identify capability gaps and overlaps

### 2. Fundamental Architecture Questions

#### 2.1 Source of Truth Analysis

- [ ] **Primary Source of Truth**: With metadata database direction established, analyze:
  - Task content and specifications: Backend storage (markdown, GitHub Issues, etc.)
  - Task metadata and relationships: Metadata database storage
  - Hybrid scenarios: When content and metadata need tight coupling
- [ ] **Control vs Integration**: With metadata database approach:
  - Full control over task relationships and metadata
  - Leverage existing backend ecosystems for content and user workflows
  - Synchronization strategies between metadata database and backends
- [ ] **Future Direction Alignment**: How metadata database supports planned features:
  - Task #246: Basic Parent-Child Relationships
  - Task #247: Task Hierarchy System
  - Task #248: AI-powered task decomposition

#### 2.2 Metadata Database Architecture

- [ ] **Sophisticated Storage Split Design**: Define nuanced storage strategy:
  - **Backend-Preferred Metadata**: Priority, labels/tags, assignees, milestones (when backend supports and user prefers backend interface)
  - **Database-Only Metadata**: Complex relationships, dependencies, provenance, user requirements, AI-generated metadata
  - **Hybrid Metadata**: Fields that exist in both systems with sophisticated synchronization
  - **Fallback Metadata**: Backend-native fields that fall back to database when backend doesn't support
- [ ] **Backend Capability Matrix**: Detailed analysis of what each backend supports:
  - GitHub Issues: labels, milestones, assignees, linked issues, projects, comments
  - Markdown: YAML frontmatter fields, content-based metadata
  - JSON: Flexible schema support for any metadata
  - Database capabilities when backends lack support
- [ ] **User Interface Preservation**: Ensure users can continue using preferred interfaces:
  - GitHub Issues UI for GitHub-native metadata
  - Markdown editors for frontmatter and content
  - Minsky CLI/UI for database-only and advanced features
  - Unified querying across all storage locations

#### 2.3 Backend Integration Strategy

- [ ] **Bidirectional Synchronization**: Design sophisticated sync mechanisms:
  - Backend-to-database sync for user-modified metadata
  - Database-to-backend sync for Minsky-generated metadata
  - Conflict resolution when same metadata exists in both places
  - Performance optimization for sync operations
- [ ] **User Workflow Respect**: Maintain existing user workflows:
  - GitHub users continue using GitHub Issues interface
  - Markdown users continue editing files directly
  - CLI users get unified access to all metadata
  - No forced migration to Minsky-only interfaces
- [ ] **Capability-Aware Operations**: Design operations that respect backend capabilities:
  - Auto-fallback when backend doesn't support specific metadata
  - Graceful degradation for unsupported features
  - Clear indication of where metadata is stored and editable

#### 2.4 User Requirements History Architecture

- [ ] **Original Intent Preservation**: Design system for preserving user's consolidated requirements:
  - Capture and maintain current consolidated user requirements (not individual iterations)
  - Preserve user's language and intent WITHOUT AI enhancement
  - Structure in accessible, readable format (git handles evolution history automatically)
- [ ] **Storage Location Analysis**: With metadata database direction, evaluate storage options:
  - **Metadata Database**: Structured storage, queryable, separate from task content
  - **YAML frontmatter**: Simple field, version-controlled, part of task file
  - **Hybrid approach**: Core requirements in metadata DB, detailed specs in backend
- [ ] **Separation from AI-Enhanced Specs**: Design clear boundaries:
  - User requirements (consolidated original intent, no AI enhancement) → **Metadata Database**
  - Task specification (AI-enhanced, detailed implementation plan) → **Backend Storage**
  - Relationship and synchronization between the two
- [ ] **User Workflow Integration**: Design how consolidated requirements fit into task creation:
  - Capture during initial task creation
  - Update through iterative refinement sessions (replacing previous version)
  - Display for context during task review/updates
  - Export/import for task replication or migration

#### 2.5 User Workflow Analysis

- [ ] **Workflow Scenarios**: Map out different user workflows with sophisticated metadata:
  - **GitHub-Native Users**: Primarily use GitHub Issues UI, want Minsky enhancements
  - **Markdown-Native Users**: Edit files directly, want metadata in frontmatter when possible
  - **Hybrid Users**: Use both backend interfaces and Minsky CLI/UI
  - **Minsky-Primary Users**: Prefer Minsky interfaces but need backend compatibility
- [ ] **Interface Preference Mapping**: Understand where users want to edit metadata:
  - Simple metadata (priority, labels) → Backend interfaces when supported
  - Complex metadata (relationships, dependencies) → Minsky interfaces with database storage
  - Contextual metadata (comments, descriptions) → Backend interfaces
  - AI-generated metadata → Database with optional backend sync

#### 2.6 Current Architecture Evaluation

- [ ] **Markdown + YAML Frontmatter**: Evaluate current approach:
  - Strengths: Human-readable, version-controllable, flexible
  - Weaknesses: Limited metadata capabilities, parsing complexity
  - Scalability concerns for complex metadata
- [ ] **Task Specification Storage**: Analyze current task spec approach:
  - Separation of task metadata vs. task specification
  - Relationship between task files and spec files
  - Implications for metadata that affects both

### 3. Architectural Design

#### 3.1 Sophisticated Metadata Database Implementation (PRIMARY APPROACH)

- [ ] **Database Technology Selection**: Evaluate options considering sync requirements:
  - SQLite: Simple, file-based, good for single-user scenarios
  - PostgreSQL: Full-featured, better for complex sync scenarios
  - Embedded options: Better integration with sophisticated sync logic
- [ ] **Sophisticated Schema Design**: Database structure supporting hybrid approach:
  - Task entities with backend references and unique identification
  - Metadata tables with backend-capability awareness
  - Synchronization state tracking (last sync, conflict resolution)
  - Backend-specific metadata mappings and transformations
- [ ] **Backend Integration Layer**: Design sophisticated abstraction:
  - Capability-aware routing (backend vs. database storage)
  - Sophisticated synchronization engine
  - Conflict resolution and merge strategies
  - Performance optimization for hybrid queries

#### 3.2 Backend-Specific Sophisticated Integration

- [ ] **GitHub Issues**: Sophisticated integration preserving user workflows:
  - GitHub-native metadata (labels, milestones, assignees) stays in GitHub
  - Users continue using GitHub Issues UI for supported metadata
  - Advanced metadata (complex relationships) stored in database
  - Bidirectional sync with conflict resolution
- [ ] **Markdown Files**: Sophisticated YAML frontmatter integration:
  - Simple metadata in frontmatter (priority, tags, status)
  - Complex metadata in database with file references
  - Preserve direct file editing workflows
  - Sync between frontmatter and database for overlapping fields
- [ ] **JSON Files**: Enhanced hybrid storage:
  - Flexible schema for backend-supported metadata
  - Database for advanced relationships and AI features
  - Sophisticated sync for overlapping capabilities

#### 3.3 Hybrid Storage Strategy with User Interface Preservation

- [ ] **Field-Level Storage Intelligence**: Sophisticated storage decisions:
  - **Backend-Preferred**: Use backend when supported AND user prefers backend interface
  - **Database-Only**: Complex relationships, AI metadata, provenance
  - **Hybrid-Synchronized**: Fields that need to exist in both systems
  - **Capability-Based Fallback**: Backend when possible, database when not
- [ ] **Synchronization Architecture**: Sophisticated sync mechanisms:
  - Change detection and delta synchronization
  - Conflict resolution with user preference consideration
  - Performance optimization for large-scale sync operations
  - Offline operation support with eventual consistency

#### 3.4 Alternative Approaches (For Comparison)

- [ ] **Pure Backend Storage**: Analysis of storing all metadata in backends
- [ ] **Pure Metadata Database**: Analysis of storing everything in database
- [ ] **Simple Hybrid**: Basic split without sophisticated sync
- [ ] **Federated Metadata**: Distributed ownership model

### 4. Strategic Considerations

#### 4.1 Minsky Design Philosophy

- [ ] **Core Mission Alignment**: How sophisticated metadata architecture supports Minsky's mission:
  - AI-powered task management while preserving user workflows
  - Advanced capabilities without forcing interface changes
  - Seamless integration with existing tools and workflows
- [ ] **User Experience Preservation**: Maintain familiar interfaces:
  - GitHub users keep using GitHub Issues UI
  - Markdown users keep editing files directly
  - Advanced users get sophisticated Minsky capabilities
  - No forced migration to Minsky-only workflows

#### 4.2 User Adoption Strategy

- [ ] **Gradual Enhancement**: Sophisticated metadata introduction:
  - Start with advanced features not available in backends
  - Gradually sync simple metadata for unified access
  - Preserve all existing user workflows
  - Clear value proposition for each enhancement
- [ ] **Interface Choice Respect**: Allow users to choose their preferred interfaces:
  - Backend interfaces for backend-native metadata
  - Minsky interfaces for advanced metadata features
  - Unified querying across all storage locations
  - No lock-in to specific interface choices

#### 4.3 Technical Debt and Maintenance

- [ ] **Sophisticated Synchronization Maintenance**: Long-term considerations:
  - Sync mechanism reliability and performance
  - Conflict resolution strategy evolution
  - Backend API changes and compatibility
  - Database schema evolution with sync compatibility
- [ ] **User Interface Compatibility**: Ongoing maintenance:
  - Backend interface changes and adaptation
  - User workflow preservation across updates
  - Performance optimization for hybrid operations
  - Error handling and graceful degradation

### 5. Architectural Decision

#### 5.1 Tradeoff Analysis

- [ ] **Sophisticated Hybrid vs. Simple Split**: Compare approaches:
  - Implementation complexity vs. user experience preservation
  - Performance implications of sophisticated sync
  - Maintenance burden vs. user adoption benefits
- [ ] **Interface Preservation vs. Simplicity**: Evaluate tradeoffs:
  - User workflow preservation vs. architectural complexity
  - Backend compatibility vs. unified interface simplicity
  - Sync reliability vs. performance optimization

#### 5.2 Recommendation

- [ ] **Sophisticated Metadata Architecture**: Detailed design for hybrid approach
- [ ] **Storage Intelligence Specification**: Rules for sophisticated storage decisions
- [ ] **Backend Integration Strategy**: Comprehensive approach preserving user workflows
- [ ] **Implementation Guidelines**: Principles for sophisticated implementation

### 6. Implementation Planning

#### 6.1 Implementation Roadmap

- [ ] **Phase 1**: Basic metadata database with simple backend sync
- [ ] **Phase 2**: Sophisticated synchronization and conflict resolution
- [ ] **Phase 3**: Advanced metadata features with interface preservation
- [ ] **Phase 4**: Performance optimization and user workflow enhancement

#### 6.2 Risk Assessment

- [ ] **Synchronization Complexity Risks**: Sophisticated sync challenges
- [ ] **User Interface Compatibility Risks**: Preserving backend workflows
- [ ] **Performance Risks**: Hybrid storage and sync performance

## Success Criteria

### 1. Comprehensive Analysis Document

- [ ] Complete research document covering all major project management systems
- [ ] Backend capability matrix with detailed feature comparison
- [ ] Clear identification of core vs. extended metadata categories

### 2. Sophisticated Metadata Architecture

- [ ] **Sophisticated metadata database schema design** supporting hybrid approach
- [ ] **Storage intelligence specification** with capability-aware routing
- [ ] **Backend integration strategy** preserving user workflows and interfaces
- [ ] **Synchronization architecture** with conflict resolution and performance optimization

### 3. User Workflow Preservation

- [ ] **Interface preservation design** allowing users to continue using preferred backend interfaces
- [ ] **Capability-aware operations** with graceful degradation and fallback mechanisms
- [ ] **Bidirectional synchronization** maintaining consistency across systems
- [ ] **User choice respect** for metadata editing preferences

### 4. Foundation for Implementation

- [ ] **Clear interfaces defined** for sophisticated metadata database implementation
- [ ] **Success criteria established** for each implementation phase
- [ ] **Risk assessment and mitigation strategies** for sync complexity and interface compatibility
- [ ] **Migration strategy** preserving existing workflows during transition

### 5. Advanced Capabilities

- [ ] **Unified querying design** across all storage locations
- [ ] **AI-powered features enablement** through database-stored advanced metadata
- [ ] **Cross-backend operations** while maintaining backend-specific workflows
- [ ] **Performance optimization** for hybrid storage and sync operations

## Dependencies

- Understanding of current task backend architecture
- Access to various project management systems for research
- Stakeholder input on priority metadata fields
- Technical review from architecture team
- **Analysis of planned AI-powered features (Tasks #246-248)**
- **User workflow research and backend interface preferences**
- **Backend API analysis for synchronization capabilities**
- **Performance requirements for hybrid storage operations**

## Deliverables

1. **Task Metadata Research Report** - comprehensive analysis of existing systems
2. **Backend Capability Matrix** - detailed comparison of backend capabilities and user interfaces
3. **Sophisticated Metadata Architecture Document** - comprehensive design for hybrid approach
4. **Storage Intelligence Specification** - rules for capability-aware storage decisions
5. **Implementation Roadmap** - phased plan for sophisticated metadata implementation
6. **Risk Assessment Report** - sync complexity and interface compatibility risks
7. **User Workflow Preservation Analysis** - maintaining existing user interface preferences
8. **Backend Integration Strategy** - comprehensive approach for bidirectional synchronization
9. **User Requirements Architecture** - design for preserving consolidated original user intent

## Related Implementation Tasks

The following tasks will implement the sophisticated metadata architecture decisions made in this task:

- **Task #246**: Implement Basic Task Parent-Child Relationships
- **Task #247**: Implement Task Hierarchy System (Parent-Child Relationships)
- **Task #248**: Add AI-powered task decomposition and analysis

**These implementation tasks MUST wait for the sophisticated metadata architectural decisions from this task before proceeding.**

## Key Questions to Answer

This task must provide clear answers to the following strategic questions:

1. **What metadata should stay in backends vs. move to database?**

   - Rules for backend-preferred, database-only, and hybrid metadata

2. **How do we preserve user workflow preferences?**

   - Allowing continued use of GitHub Issues UI, markdown editors, etc.

3. **What synchronization strategy balances performance and consistency?**

   - Bidirectional sync, conflict resolution, and performance optimization

4. **How do we handle capability differences between backends?**

   - Graceful degradation, fallback mechanisms, and auto-routing

5. **What database technology supports sophisticated sync requirements?**

   - SQLite, PostgreSQL, or embedded options for complex synchronization

6. **How do we provide unified querying across hybrid storage?**

   - Abstraction layer for querying both backend and database metadata

7. **How do we migrate existing tasks while preserving workflows?**

   - Gradual migration strategy maintaining user interface preferences

8. **How do we preserve and structure consolidated user requirements?**

   - Metadata database storage while maintaining backend interface compatibility

9. **How do we optimize performance for hybrid storage operations?**

   - Query optimization, sync efficiency, and scaling considerations

10. **How do we handle conflicts between backend and database metadata?**
    - Conflict resolution strategies respecting user preferences and data authority

## Implementation Constraints

- **No implementation in this task** - architecture and research only
- **Must design for sophisticated hybrid approach** - balance backend preservation with database capabilities
- **Must preserve user workflows** - no forced migration to Minsky-only interfaces
- **Must support planned AI features** - architecture must enable Tasks #246-248
- **Must provide seamless user experience** - unified operations across hybrid storage
- **Must consider synchronization complexity** - sustainable sync architecture required
- **Must respect backend capabilities** - leverage existing backend strengths while adding database enhancements
