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

**DIRECTIONAL DECISION**: Minsky will implement a task metadata database to store relationships, dependencies, provenance, and other metadata, while task specifications and content may remain in existing backends (markdown, GitHub Issues, etc.). This task will focus on defining the optimal split between metadata database storage and backend storage.

## Scope

**This task is RESEARCH AND ARCHITECTURE ONLY** - no implementation. Implementation will be handled by subsequent tasks based on the architectural decisions made here.

**PRIMARY FOCUS**: Design the metadata database architecture and determine what should be stored in the metadata database vs. task backends.

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

- [ ] **Storage Split Design**: Define what goes where:
  - **Metadata Database**: relationships, dependencies, priority, tags, provenance, user requirements
  - **Backend Storage**: task specifications, descriptions, status, comments, backend-specific data
  - **Hybrid/Synchronized**: fields that need to exist in both systems
- [ ] **Database Schema Design**: Core metadata database structure:
  - Task entities and unique identification
  - Relationship tables (parent-child, dependencies, blocking)
  - Metadata tables (priority, tags, categories, estimates)
  - Provenance tables (user requirements, creation history)
  - Backend references and synchronization metadata
- [ ] **Backend Integration Strategy**: How metadata database connects to backends:
  - Unique task identification across backends
  - Synchronization mechanisms and conflict resolution
  - Backend-agnostic metadata operations
  - Performance considerations for cross-system queries

#### 2.3 User Requirements History Architecture

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

#### 2.4 User Workflow Analysis

- [ ] **Workflow Scenarios**: Map out different user workflows:
  - **Pure Minsky**: Users who want to work entirely within Minsky
  - **GitHub Integration**: Users who primarily use GitHub but want Minsky enhancements
  - **Multi-tool**: Users who work across multiple project management tools
  - **Team Collaboration**: Teams with mixed tool preferences
- [ ] **Workflow Confusion Points**: Identify areas of potential confusion:
  - Where is the "real" task data?
  - How do changes propagate between systems?
  - What happens when systems are out of sync?
  - How do users know which system to update?
- [ ] **Workflow Simplification**: Design principles for reducing complexity:
  - Clear mental models for users
  - Predictable behavior across different backends
  - Minimal cognitive overhead for common operations

#### 2.5 Current Architecture Evaluation

- [ ] **Markdown + YAML Frontmatter**: Evaluate current approach:
  - Strengths: Human-readable, version-controllable, flexible
  - Weaknesses: Limited metadata capabilities, parsing complexity
  - Scalability concerns for complex metadata
- [ ] **Task Specification Storage**: Analyze current task spec approach:
  - Separation of task metadata vs. task specification
  - Relationship between task files and spec files
  - Implications for metadata that affects both

### 3. Architectural Design

#### 3.1 Metadata Database Implementation (PRIMARY APPROACH)

- [ ] **Database Technology Selection**: Evaluate options:
  - SQLite: Simple, file-based, good for single-user scenarios
  - PostgreSQL: Full-featured, good for team scenarios
  - Embedded options: Better integration with Minsky
- [ ] **Schema Design**: Core metadata database structure:
  - Task entities and unique identification
  - Relationship tables (parent-child, dependencies, blocking)
  - Metadata tables (priority, tags, categories, estimates)
  - Provenance tables (user requirements, creation history)
  - Backend synchronization tables
- [ ] **Backend Integration Layer**: Design abstraction for backend operations:
  - Task content operations delegated to backends
  - Metadata operations handled by metadata database
  - Synchronization and consistency management
  - Performance optimization for common queries

#### 3.2 Backend-Specific Adaptations

- [ ] **Markdown Files**: How to integrate with metadata database:
  - Minimal frontmatter for backend compatibility
  - Metadata database as primary source for relationships
  - File-based task identification and synchronization
- [ ] **GitHub Issues**: Integration with metadata database:
  - GitHub issue ID as primary key
  - Metadata database augments GitHub's native capabilities
  - Synchronization of overlapping fields (labels, milestones)
- [ ] **JSON Files**: Enhanced integration:
  - Metadata database for relationships and complex metadata
  - JSON files for task content and simple metadata
  - Hybrid storage optimization

#### 3.3 Hybrid Storage Strategy

- [ ] **Field-Level Storage Decisions**: Define storage location for each metadata type:
  - **Metadata DB Only**: relationships, dependencies, user requirements
  - **Backend Only**: task content, descriptions, backend-specific data
  - **Synchronized**: status, priority, tags (stored in both with sync)
- [ ] **Consistency Management**: Ensure data consistency between systems:
  - Conflict resolution strategies
  - Synchronization triggers and schedules
  - Offline operation support

#### 3.4 Alternative Approaches (For Comparison)

- [ ] **Pure Backend Storage**: Analysis of storing all metadata in backends
- [ ] **Pure Metadata Database**: Analysis of storing everything in metadata database
- [ ] **Federated Metadata Architecture**: Distributed ownership model

### 4. Strategic Considerations

#### 4.1 Minsky Design Philosophy

- [ ] **Core Mission Alignment**: How metadata database supports Minsky's mission:
  - AI-powered task management and decomposition
  - Workflow automation and optimization
  - Cross-tool integration and orchestration
- [ ] **Metadata Database Advantages**: Unique capabilities enabled:
  - Complex relationship queries across all backends
  - Advanced AI features (task analysis, recommendation, automation)
  - Cross-repository and cross-project management
  - Unified metadata operations regardless of backend

#### 4.2 User Adoption Strategy

- [ ] **Migration Path**: How metadata database introduction affects users:
  - Gradual metadata database adoption
  - Backwards compatibility with current workflows
  - Clear benefits that justify additional complexity
- [ ] **Value Proposition**: Compelling benefits of metadata database:
  - Advanced relationship management
  - AI-powered task analysis and decomposition
  - Cross-backend task operations
  - Enhanced search and filtering capabilities

#### 4.3 Technical Debt and Maintenance

- [ ] **Metadata Database Maintenance**: Long-term considerations:
  - Database schema evolution and migration
  - Performance optimization for large task sets
  - Backup and recovery strategies
- [ ] **Backend Synchronization**: Ongoing maintenance:
  - Synchronization mechanism reliability
  - Error handling and recovery
  - Performance impact of dual-storage approach

### 5. Architectural Decision

#### 5.1 Tradeoff Analysis

- [ ] **Metadata Database vs. Pure Backend**: Compare approaches:
  - Implementation complexity and maintenance overhead
  - Performance implications of dual storage
  - Flexibility and extensibility benefits
- [ ] **Storage Split Optimization**: Evaluate different split strategies:
  - Minimize synchronization complexity
  - Maximize backend compatibility
  - Optimize for common operations

#### 5.2 Recommendation

- [ ] **Metadata Database Architecture**: Detailed design for metadata database approach
- [ ] **Storage Split Specification**: Clear rules for what goes where
- [ ] **Backend Integration Strategy**: Comprehensive approach for backend compatibility
- [ ] **Implementation Guidelines**: Principles for subsequent implementation tasks

### 6. Implementation Planning

#### 6.1 Implementation Roadmap

- [ ] **Phase 1**: Metadata database foundation and core schema
- [ ] **Phase 2**: Backend integration layer and synchronization
- [ ] **Phase 3**: Advanced metadata features and AI integration
- [ ] **Phase 4**: Performance optimization and scaling

#### 6.2 Risk Assessment

- [ ] **Technical Risks**: Metadata database-specific challenges
- [ ] **Migration Risks**: Transitioning existing tasks to metadata database
- [ ] **Performance Risks**: Dual-storage query performance

## Success Criteria

### 1. Comprehensive Analysis Document

- [ ] Complete research document covering all major project management systems
- [ ] Backend capability matrix with detailed feature comparison
- [ ] Clear identification of core vs. extended metadata categories

### 2. Metadata Database Architecture

- [ ] **Detailed metadata database schema design**
- [ ] **Clear storage split specification** (what goes in metadata DB vs. backends)
- [ ] **Backend integration strategy** with synchronization mechanisms
- [ ] **Performance optimization guidelines** for dual-storage queries

### 3. Strategic Clarity

- [ ] **Clear metadata database implementation plan** with technology selection
- [ ] **Storage split philosophy** with clear rules for field-level decisions
- [ ] **User workflow integration** for metadata database operations
- [ ] **Minsky design philosophy alignment** with metadata database advantages

### 4. Foundation for Implementation

- [ ] **Clear interfaces defined** for metadata database implementation tasks
- [ ] **Success criteria established** for each implementation phase
- [ ] **Risk assessment and mitigation strategies** for metadata database approach
- [ ] **Migration strategy** from current architecture to metadata database

### 5. User Experience Foundation

- [ ] **Workflow confusion elimination** with clear metadata database mental models
- [ ] **Adoption strategy** for gradual metadata database introduction
- [ ] **Value proposition** demonstrating compelling benefits of metadata database

## Dependencies

- Understanding of current task backend architecture
- Access to various project management systems for research
- Stakeholder input on priority metadata fields
- Technical review from architecture team
- **Analysis of planned AI-powered features (Tasks #246-248)**
- **User workflow research and feedback**
- **Minsky mission and design philosophy documentation**
- **Database technology evaluation and selection criteria**

## Deliverables

1. **Task Metadata Research Report** - comprehensive analysis of existing systems
2. **Backend Capability Matrix** - detailed comparison of backend capabilities
3. **Metadata Database Architecture Document** - comprehensive design for metadata database approach
4. **Storage Split Specification** - clear rules for metadata database vs. backend storage
5. **Implementation Roadmap** - phased plan for metadata database implementation
6. **Risk Assessment Report** - metadata database-specific risks and mitigation strategies
7. **User Workflow Analysis** - mapping of user scenarios with metadata database
8. **Backend Integration Strategy** - comprehensive approach for backend synchronization
9. **User Requirements Architecture** - design for preserving consolidated original user intent

## Related Implementation Tasks

The following tasks will implement the metadata database architecture decisions made in this task:

- **Task #246**: Implement Basic Task Parent-Child Relationships
- **Task #247**: Implement Task Hierarchy System (Parent-Child Relationships)
- **Task #248**: Add AI-powered task decomposition and analysis

**These implementation tasks MUST wait for the metadata database architectural decisions from this task before proceeding.**

## Key Questions to Answer

This task must provide clear answers to the following strategic questions:

1. **What is the optimal metadata database technology?**

   - SQLite, PostgreSQL, or embedded options for different use cases?

2. **What belongs in the metadata database vs. task backends?**

   - Clear field-level storage decisions and synchronization strategies

3. **How do we handle backend synchronization?**

   - Conflict resolution, consistency management, and performance optimization

4. **What user workflows do we prioritize with metadata database?**

   - Pure Minsky users, backend integration users, or hybrid workflows?

5. **How does metadata database support AI-powered features?**

   - Task decomposition, analysis, and automation capabilities

6. **Where do we store consolidated user requirements?**

   - Metadata database, backend storage, or hybrid approach?

7. **How do we migrate existing tasks to metadata database?**

   - Gradual migration strategy and backwards compatibility

8. **How do we preserve and structure consolidated user requirements?**

   - Where to store consolidated user requirements vs. AI-enhanced specifications?
   - What format best preserves user intent without AI enhancement?
   - How to integrate into task creation and refinement workflow?

9. **How do we optimize metadata database performance?**
   - Query optimization, indexing strategies, and scaling considerations

## Implementation Constraints

- **No implementation in this task** - architecture and research only
- **Must design for metadata database** - primary architectural direction established
- **Must support planned AI features** - architecture must enable Tasks #246-248
- **Must address user workflow clarity** - clear mental models for metadata database
- **Must provide clear storage split decisions** - no ambiguity about what goes where
- **Must consider long-term maintenance** - sustainable metadata database architecture
