---
user_requirements: "Add the notion of 'original task spec/prompt' - what the human originally said when getting AI to generate a full task spec. Should be a formatted/structured information-preserving summary of accumulated prompts over time, NOT enhanced past what the user originally said. Should be separate from the AI-enhanced full specification. Consider storage in YAML frontmatter, database metadata, or other metadata system."
---

# Task Metadata Architecture Research and Design

## Status

**CLOSED** - Architecture decisions folded into Task #315

## Priority

HIGH

## Description

**✅ COMPLETED**: The architectural research and design work from this task has been integrated into Task #315: Implement Task Backend Capabilities System and Enhanced Metadata Support.

**Key Architectural Decisions Made and Integrated:**

1. **Hybrid Metadata Architecture**: Balance backend-native capabilities with metadata database for advanced features
2. **Core Metadata Categories**: Structural, Organizational, Temporal, Workflow, and Provenance metadata
3. **Storage Strategy**: Backend-preferred, Database-only, Hybrid-synchronized, and Capability-based fallback
4. **User Interface Preservation**: Continue using preferred backend interfaces while adding advanced capabilities
5. **Database Technology Selection**: SQLite for local, PostgreSQL for teams, JSON for all-in-repo

## Implementation Status

**✅ ARCHITECTURE COMPLETE** - All research and design decisions have been incorporated into Task #315.

**Next Steps:**
- **Task #315**: Implement the backend capabilities system and enhanced metadata support
- **Task #238**: Implement subtasks using the enhanced backend infrastructure  
- **Task #239**: Implement dependencies using the metadata relationship support

## Original Research Scope (Now Complete)

This task focused on research and architectural decision-making for task metadata systems including subtasks, priority, dependencies, and other extended task properties. The research analyzed how metadata interacts with different task backends and recommended the optimal architectural approach.

**DIRECTIONAL DECISION MADE**: Minsky implements a hybrid metadata architecture that respects backend capabilities while providing unified advanced capabilities through a metadata database system.

## Key Architectural Outputs (Integrated into Task #315)

### 1. ✅ Metadata Categories Defined
- **Structural**: subtasks, parent tasks, dependencies, blockers
- **Organizational**: priority, tags, categories, milestones  
- **Temporal**: due dates, estimates, time tracking
- **Workflow**: assignees, reviewers, status transitions
- **Provenance**: original user requirements, AI enhancements

### 2. ✅ Backend Capability Matrix
- **GitHub Issues**: labels, milestones, assignees, linked issues, projects
- **Markdown Files**: limited to file content and frontmatter
- **JSON Files**: flexible schema support
- **SQLite/PostgreSQL**: full metadata capabilities

### 3. ✅ Storage Strategy Defined
- **Backend-Preferred**: Use backend when supported AND user prefers interface
- **Database-Only**: Complex relationships, AI metadata, provenance
- **Hybrid-Synchronized**: Fields that exist in both systems
- **Capability-Based Fallback**: Backend when possible, database when not

### 4. ✅ User Workflow Preservation Strategy
- GitHub users continue using GitHub Issues UI
- Markdown users migrate to enhanced JSON backend
- Advanced users get sophisticated Minsky capabilities
- No forced migration to Minsky-only workflows

### 5. ✅ Database Technology Selection
- **SQLite**: Single-user scenarios, file-based
- **PostgreSQL**: Team scenarios, concurrent access
- **JSON**: All-in-repo, version controlled, zero dependencies

## Implementation Tasks Enabled

This architectural work enables the following implementation tasks:

- **✅ Task #315**: Implement Task Backend Capabilities System (IN PROGRESS)
- **Task #238**: Phase 1 - Basic Subtask Support (READY)
- **Task #239**: Phase 2 - Task Dependencies (READY)

## Success Criteria ✅ ACHIEVED

### 1. ✅ Comprehensive Analysis Completed
- Complete research across major project management systems
- Backend capability matrix with detailed feature comparison  
- Core vs. extended metadata categories identified

### 2. ✅ Hybrid Metadata Architecture Designed
- Sophisticated metadata database schema supporting hybrid approach
- Storage intelligence specification with capability-aware routing
- Backend integration strategy preserving user workflows
- Performance and synchronization considerations addressed

### 3. ✅ User Workflow Preservation Planned
- Interface preservation design allowing continued use of preferred backend interfaces
- Capability-aware operations with graceful degradation
- User choice respect for metadata editing preferences

### 4. ✅ Implementation Foundation Established
- Clear interfaces defined for metadata implementation
- Success criteria established for implementation phases
- Risk assessment and mitigation strategies documented
- Migration strategy preserving existing workflows

## Architecture Documentation

All architectural decisions, schemas, and implementation guidelines have been transferred to Task #315. This task is now complete and can be closed.

**Reference**: Task #315 contains the complete architectural specification and implementation plan based on this research.