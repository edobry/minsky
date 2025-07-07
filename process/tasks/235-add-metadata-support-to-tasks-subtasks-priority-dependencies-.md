# Task Metadata Architecture Research and Design

## Status

BACKLOG

## Priority

HIGH

## Description

Research and design the architectural foundation for task metadata systems including subtasks, priority, dependencies, and other extended task properties. This task focuses on architectural decision-making and provides the foundation for subsequent implementation tasks. The research will analyze how metadata interacts with different task backends and recommend the optimal architectural approach.

## Scope

**This task is RESEARCH AND ARCHITECTURE ONLY** - no implementation. Implementation will be handled by subsequent tasks based on the architectural decisions made here.

## Requirements

### 1. Research and Analysis

#### 1.1 Task Metadata Survey

- [ ] Research common task metadata fields across different project management systems
- [ ] Identify core metadata categories:
  - **Structural**: subtasks, parent tasks, dependencies, blockers
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

- [ ] **Primary Source of Truth**: Should Minsky's primary source of truth be:
  - External systems (GitHub Issues, Jira, etc.) with Minsky as a client?
  - Internal Minsky storage with external systems as optional integrations?
  - Hybrid approach with different sources for different use cases?
- [ ] **Control vs Integration**: Analyze tradeoffs between:
  - Full control over task data and metadata (internal storage)
  - Leveraging existing external systems and their ecosystems
  - User lock-in implications and migration complexity
- [ ] **Future Direction Alignment**: How does each approach align with planned features:
  - Task #246: Basic Parent-Child Relationships
  - Task #247: Task Hierarchy System
  - Task #248: AI-powered task decomposition

#### 2.2 Metadata Storage Philosophy

- [ ] **Metadata Location**: Explore different approaches to metadata storage:
  - **In-band**: Metadata stored within task files (YAML frontmatter, JSON fields)
  - **Out-of-band**: Metadata stored separately from task content
  - **Hybrid**: Core metadata in-band, extended metadata out-of-band
- [ ] **Ownership and Authority**: Who owns different types of metadata:
  - User-managed metadata (priority, tags, custom fields)
  - System-managed metadata (creation dates, relationships)
  - External-system metadata (GitHub labels, Jira story points)
- [ ] **Synchronization Complexity**: Analyze complexity of keeping metadata in sync:
  - Between Minsky and external systems
  - Between different storage locations within Minsky
  - Conflict resolution strategies

#### 2.3 User Workflow Analysis

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

#### 2.4 User Requirements History Architecture

- [ ] **Original Intent Preservation**: Design system for preserving user's original requirements:
  - Capture initial user prompts and requests that led to task creation
  - Track evolution of requirements through iterative user refinement
  - Maintain user's language and intent WITHOUT AI enhancement
  - Structure accumulated requirements in information-preserving format
- [ ] **Requirements Evolution Tracking**: Model how user requirements change over time:
  - Example flow: "track bookmarks" → "store in database" → "include page downloads"
  - Result: "Create a system that downloads websites when bookmarked by a user and stores them in a database"
  - Preserve chronological evolution while maintaining current consolidated view
- [ ] **Storage Location Analysis**: Evaluate where to store user requirements history:
  - **YAML frontmatter**: Structured, version-controlled, part of task file
  - **Database metadata**: Separate storage, queryable, complex versioning
  - **Markdown section**: Human-readable, part of task content
  - **Separate requirements file**: Dedicated space, structured format
- [ ] **Separation from AI-Enhanced Specs**: Design clear boundaries:
  - User requirements (original intent, no AI enhancement)
  - Task specification (AI-enhanced, detailed implementation plan)
  - Relationship and synchronization between the two
- [ ] **User Workflow Integration**: Design how requirements history fits into task creation:
  - Capture during initial task creation
  - Update through iterative refinement sessions
  - Display for context during task review/updates
  - Export/import for task replication or migration

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

#### 3.1 Approach 1: Backend Capabilities System

- [ ] Design a capabilities registry system
- [ ] Model how features are enabled/disabled based on backend capabilities
- [ ] Design graceful degradation for unsupported features
- [ ] Consider API design for capability-aware operations

#### 3.2 Approach 2: SQL Database Simulation Layer

- [ ] Design a metadata storage layer using SQL database
- [ ] Model relationship between core task data and extended metadata
- [ ] Design synchronization mechanisms between backends and metadata DB
- [ ] Consider data consistency and conflict resolution

#### 3.3 Approach 3: Feature Disabling per Backend

- [ ] Design feature flags and conditional UI/API behavior
- [ ] Model user experience when features are unavailable
- [ ] Consider migration paths when switching backends

#### 3.4 Approach 4: Minsky-Centric with External Sync

- [ ] Design Minsky as the primary system with external sync capabilities
- [ ] Model how external systems become "views" or "integrations" of Minsky data
- [ ] Design conflict resolution when external systems are modified directly
- [ ] Consider implications for user adoption and migration

#### 3.5 Approach 5: Federated Metadata Architecture

- [ ] Design distributed metadata system where different sources own different aspects
- [ ] Model metadata ownership and authority boundaries
- [ ] Design query and aggregation mechanisms across multiple sources
- [ ] Consider consistency and conflict resolution strategies

#### 3.6 Hybrid Approaches

- [ ] Explore combinations of the above approaches
- [ ] Design fallback mechanisms and progressive enhancement
- [ ] Consider backend-specific optimizations

### 4. Strategic Considerations

#### 4.1 Minsky Design Philosophy

- [ ] **Core Mission Alignment**: How does metadata architecture support Minsky's mission:
  - AI-powered task management and decomposition
  - Workflow automation and optimization
  - Cross-tool integration and orchestration
- [ ] **Future Capability Requirements**: What does the metadata system need to support:
  - Advanced AI features (task analysis, recommendation, automation)
  - Complex workflow orchestration
  - Multi-repository and multi-project management
  - Integration with development tools and CI/CD

#### 4.2 User Adoption Strategy

- [ ] **Migration Path**: How do users transition to metadata-enhanced Minsky:
  - From current Minsky usage patterns
  - From external project management tools
  - Incremental adoption vs. all-or-nothing
- [ ] **Value Proposition**: What compelling benefits justify complexity:
  - Unique capabilities not available elsewhere
  - Superior user experience despite additional complexity
  - Clear ROI for different user types

#### 4.3 Technical Debt and Maintenance

- [ ] **Long-term Sustainability**: Evaluate approaches for:
  - Maintenance burden of complex sync mechanisms
  - Evolution and schema migration strategies
  - Testing complexity for multi-backend scenarios
- [ ] **Developer Experience**: Impact on Minsky development:
  - Complexity of adding new features
  - Debugging and troubleshooting challenges
  - Third-party integration maintenance

### 5. Architectural Decision

#### 5.1 Tradeoff Analysis

- [ ] Analyze implementation complexity for each approach
- [ ] Consider maintenance overhead and performance implications
- [ ] Evaluate extensibility and future backend integration requirements
- [ ] Assess migration complexity between approaches

#### 5.2 Recommendation

- [ ] Select recommended architectural approach with detailed rationale
- [ ] Document architectural principles and constraints
- [ ] Create implementation guidelines for subsequent tasks

### 6. Implementation Planning

#### 6.1 Implementation Roadmap

- [ ] Create phased implementation plan based on chosen architecture
- [ ] Define clear interfaces between research and implementation phases
- [ ] Identify implementation tasks and their dependencies
- [ ] Establish success criteria for each implementation phase

#### 6.2 Risk Assessment

- [ ] Identify technical and project risks
- [ ] Define mitigation strategies
- [ ] Plan fallback options if chosen approach proves problematic

## Success Criteria

### 1. Comprehensive Analysis Document

- [ ] Complete research document covering all major project management systems
- [ ] Backend capability matrix with detailed feature comparison
- [ ] Clear identification of core vs. extended metadata categories

### 2. Architectural Decision

- [ ] **Clear architectural recommendation with detailed rationale**
- [ ] **Comprehensive tradeoff analysis with scoring matrix**
- [ ] **Architectural principles and implementation guidelines**
- [ ] **Detailed implementation roadmap with phases and dependencies**

### 3. Foundation for Implementation

- [ ] **Clear interfaces defined for implementation tasks**
- [ ] **Success criteria established for each implementation phase**
- [ ] **Risk assessment and mitigation strategies documented**

### 4. Strategic Clarity

- [ ] **Clear answer to source of truth question**: Internal vs. external primary storage
- [ ] **Metadata storage philosophy decision**: In-band vs. out-of-band vs. hybrid
- [ ] **User workflow clarity**: Simplified mental models and predictable behavior
- [ ] **Minsky design philosophy alignment**: How metadata supports AI-powered features

### 5. User Experience Foundation

- [ ] **Workflow confusion elimination**: Clear answers to "where is my data" questions
- [ ] **Adoption strategy**: Clear migration paths from current state
- [ ] **Value proposition**: Compelling benefits that justify any added complexity

## Dependencies

- Understanding of current task backend architecture
- Access to various project management systems for research
- Stakeholder input on priority metadata fields
- Technical review from architecture team
- **Analysis of planned AI-powered features (Tasks #246-248)**
- **User workflow research and feedback**
- **Minsky mission and design philosophy documentation**

## Deliverables

1. **Task Metadata Research Report** - comprehensive analysis of existing systems
2. **Backend Capability Matrix** - detailed comparison of backend capabilities
3. **Architectural Decision Document** - chosen approach with rationale
4. **Implementation Roadmap** - phased plan for subsequent implementation tasks
5. **Risk Assessment Report** - identified risks and mitigation strategies
6. **User Workflow Analysis** - mapping of user scenarios and confusion points
7. **Minsky Design Philosophy Alignment Document** - how metadata supports core mission
8. **Source of Truth Decision Document** - clear stance on internal vs. external primary storage
9. **User Requirements History Architecture** - design for preserving original user intent and prompt evolution

## Related Implementation Tasks

The following tasks will implement the architecture decisions made in this task:

- **Task #246**: Implement Basic Task Parent-Child Relationships
- **Task #247**: Implement Task Hierarchy System (Parent-Child Relationships)
- **Task #248**: Add AI-powered task decomposition and analysis

**These implementation tasks MUST wait for the architectural decisions from this task before proceeding.**

## Key Questions to Answer

This task must provide clear answers to the following strategic questions:

1. **What is Minsky's primary source of truth for tasks?**

   - Internal storage with external sync, or external systems with Minsky as client?

2. **How do we handle metadata that external systems don't support?**

   - Disable features, simulate with additional storage, or hybrid approach?

3. **What user workflows do we prioritize?**

   - Pure Minsky users, GitHub integration users, or multi-tool users?

4. **How do we eliminate user confusion about where data lives?**

   - Clear mental models and predictable behavior patterns

5. **How does metadata architecture support AI-powered features?**

   - Task decomposition, analysis, and automation capabilities

6. **Should we continue with markdown + YAML frontmatter?**

   - Or evolve to more structured storage approaches?

7. **How do we balance control vs. integration?**

   - Full control over data vs. leveraging existing ecosystems

8. **How do we preserve and structure user requirements history?**

   - Where to store original user prompts vs. AI-enhanced specifications?
   - How to track evolution of user requirements through iterative refinement?
   - What format best preserves user intent without AI enhancement?

## Implementation Constraints

- **No implementation in this task** - architecture and research only
- **Must support planned AI features** - architecture must enable Tasks #246-248
- **Must address user workflow confusion** - clear mental models required
- **Must provide clear source of truth decision** - no ambiguity allowed
- **Must consider long-term maintenance** - sustainable architecture required
