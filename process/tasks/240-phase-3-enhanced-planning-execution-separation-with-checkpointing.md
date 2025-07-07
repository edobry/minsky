# Phase 3: Enhanced Planning/Execution Separation with Checkpointing

## Status

TODO

## Priority

MEDIUM

## Parent Task

Part of [Task #237: Implement Hierarchical Task System with Subtasks and Dependencies](process/tasks/237-implement-hierarchical-task-system-with-subtasks-and-dependencies.md)

## Summary

Implement task types (planning vs execution), execution checkpointing, and fractal planning/execution/review cycles. This phase transforms Minsky into a sophisticated planning and execution orchestration system.

## Context & Dependencies

### Prerequisites

- **Task #238 (Phase 1)**: Hierarchical subtask support provides foundation
- **Task #239 (Phase 2)**: Dependency system enables workflow orchestration
- **Task #175**: AI-powered task management provides intelligent planning assistance
- **Session management**: Existing session system provides execution boundaries

### Building on Previous Phases

- Leverages hierarchical task structure for fractal planning
- Uses dependency system for workflow checkpointing
- Extends session management for planning vs execution contexts
- Builds on AI integration for automated planning assistance

## Vision: Fractal Planning/Execution/Review

### Concept Overview

```
Project Level:
├─ Planning Phase (Task Type: PLANNING)
│  ├─ Requirements Analysis (PLANNING)
│  ├─ Architecture Design (PLANNING)
│  └─ Implementation Plan (PLANNING)
├─ Execution Phase (Task Type: EXECUTION)
│  ├─ Phase 1 Implementation (EXECUTION)
│  │  ├─ Planning: Phase 1 breakdown (PLANNING)
│  │  ├─ Execution: Phase 1 coding (EXECUTION)
│  │  └─ Review: Phase 1 validation (REVIEW)
│  └─ Phase 2 Implementation (EXECUTION)
└─ Review Phase (Task Type: REVIEW)
   ├─ Testing Review (REVIEW)
   ├─ Performance Review (REVIEW)
   └─ Project Retrospective (REVIEW)
```

## Requirements

### 1. Task Type System

#### 1.1 Extend TaskData with Task Types

```typescript
enum TaskType {
  PLANNING = "planning", // Planning and design activities
  EXECUTION = "execution", // Implementation and development work
  REVIEW = "review", // Evaluation, testing, and retrospective
  RESEARCH = "research", // Investigation and learning activities
  COORDINATION = "coordination", // Cross-team and administrative tasks
}

interface TaskData {
  // ... existing fields from Phases 1 & 2

  // Task classification
  taskType?: TaskType;

  // Execution context
  executionContext?: {
    // Checkpointing information
    checkpoints?: Checkpoint[];
    currentCheckpoint?: string;
    canRollback?: boolean;

    // Planning relationships
    planningTaskId?: string; // Associated planning task
    reviewTaskId?: string; // Associated review task

    // Execution metadata
    estimatedEffort?: Duration;
    actualEffort?: Duration;
    complexityLevel?: "XS" | "S" | "M" | "L" | "XL";
    confidenceLevel?: number; // 0-100% confidence in approach
  };

  metadata?: {
    // ... existing metadata

    // Planning-specific metadata
    planningDepth?: number; // How detailed the planning is
    planningCompletion?: number; // % of planning completed

    // Execution-specific metadata
    implementationApproach?: string;
    riskFactors?: string[];

    // Review-specific metadata
    reviewCriteria?: string[];
    successMetrics?: string[];
  };
}

interface Checkpoint {
  id: string;
  name: string;
  description: string;
  timestamp: string;
  state: CheckpointState;
  rollbackPossible: boolean;
  metadata?: Record<string, any>;
}

interface CheckpointState {
  // File system state
  filesChanged?: string[];
  gitCommit?: string;

  // Task state
  taskProgress?: Record<string, any>;
  subtaskStatuses?: Record<string, TaskStatus>;

  // Session state
  sessionData?: Record<string, any>;
  environmentVars?: Record<string, string>;
}

type Duration = string; // '2h', '3d', '1w', etc.
```

#### 1.2 Task Type Validation and Rules

- **Planning tasks** can have execution and review subtasks
- **Execution tasks** require associated planning tasks (optional but recommended)
- **Review tasks** typically depend on execution tasks
- **Research tasks** can inform planning tasks
- **Coordination tasks** can span multiple types

### 2. Session Management Enhancement

#### 2.1 Session Type Support

```typescript
enum SessionType {
  PLANNING = "planning", // For planning and design work
  EXECUTION = "execution", // For implementation work
  REVIEW = "review", // For testing and evaluation
  MIXED = "mixed", // General-purpose sessions
}

interface SessionData {
  // ... existing session fields

  sessionType?: SessionType;
  associatedTaskTypes?: TaskType[];

  // Checkpointing support
  checkpointingEnabled?: boolean;
  autoCheckpointInterval?: Duration;
  checkpointPolicy?: CheckpointPolicy;
}

interface CheckpointPolicy {
  autoCreate: boolean;
  interval?: Duration;
  triggers?: CheckpointTrigger[];
  retention?: {
    maxCheckpoints?: number;
    maxAge?: Duration;
  };
}

enum CheckpointTrigger {
  TIME_INTERVAL = "time_interval",
  TASK_COMPLETION = "task_completion",
  MAJOR_CHANGE = "major_change",
  BEFORE_RISKY_OPERATION = "before_risky_operation",
  MANUAL = "manual",
}
```

#### 2.2 Enhanced Session Commands

```bash
# Create type-specific sessions
minsky session start --task #001 --type planning
minsky session start --task #002 --type execution --enable-checkpointing
minsky session start --task #003 --type review

# Session with automatic checkpointing
minsky session start --task #004 --checkpoint-interval 30m

# Checkpoint management
minsky session checkpoint create "Before major refactor"
minsky session checkpoint list
minsky session checkpoint restore <checkpoint-id>
minsky session checkpoint cleanup --older-than 7d
```

### 3. AI-Powered Planning Enhancement

#### 3.1 Intelligent Planning Assistance

```bash
# Generate implementation plan from requirements
minsky tasks plan <planning-task-id> [--depth deep|shallow] [--create-tasks]

# Analyze task complexity and suggest decomposition
minsky tasks analyze-complexity <task-id> --suggest-breakdown

# Generate execution strategy
minsky tasks generate-strategy <planning-task-id> --output-format markdown|tasks

# Plan review and validation
minsky tasks validate-plan <planning-task-id> --check-dependencies --estimate-effort
```

#### 3.2 Context-Aware AI Planning

- AI understands task types and provides type-appropriate guidance
- Planning tasks get architectural and design assistance
- Execution tasks get implementation strategy and technical guidance
- Review tasks get testing strategies and validation approaches

### 4. Workflow Orchestration

#### 4.1 Planning → Execution → Review Cycles

```typescript
interface WorkflowCycle {
  id: string;
  name: string;
  phases: WorkflowPhase[];
  currentPhase: string;
  metadata?: Record<string, any>;
}

interface WorkflowPhase {
  type: TaskType;
  taskIds: string[];
  status: "pending" | "active" | "completed" | "skipped";
  entryConditions?: Condition[];
  exitConditions?: Condition[];
}

interface Condition {
  type: "task_status" | "dependency_met" | "time_elapsed" | "manual_approval";
  criteria: any;
}
```

#### 4.2 Automated Workflow Transitions

```bash
# Define workflow cycles
minsky workflow create "Feature Development" --phases planning,execution,review

# Start workflow cycle
minsky workflow start <workflow-id> --root-task <task-id>

# Monitor workflow progress
minsky workflow status <workflow-id>

# Transition between phases
minsky workflow transition <workflow-id> --to execution --reason "Planning completed"
```

### 5. Enhanced CLI Commands

#### 5.1 Task Type Management

```bash
# Create tasks with specific types
minsky tasks create --type planning --title "Design API Architecture"
minsky tasks create --type execution --title "Implement API" --planning-task #001

# Convert existing tasks to specific types
minsky tasks set-type <task-id> execution --planning-task <planning-id>

# List tasks by type
minsky tasks list --type planning [--status TODO]
minsky tasks list --type execution --ready-to-start

# Show task relationships
minsky tasks show-cycle <task-id>  # Shows planning → execution → review cycle
```

#### 5.2 Checkpointing Commands

```bash
# Manual checkpoint creation
minsky checkpoint create --name "Before database migration" --description "..."

# List available checkpoints
minsky checkpoint list [--session <session>] [--task <task-id>]

# Restore from checkpoint
minsky checkpoint restore <checkpoint-id> [--preview] [--force]

# Checkpoint comparison
minsky checkpoint diff <checkpoint1> <checkpoint2>

# Cleanup old checkpoints
minsky checkpoint prune --older-than 7d [--dry-run]
```

### 6. Planning Intelligence Features

#### 6.1 Multi-Level Planning Support

```bash
# Create detailed planning hierarchy
minsky tasks plan <task-id> --create-hierarchy --depth 3

# Example generated structure:
# #001: Implement User Authentication [PLANNING]
#   ├─ #002: Design Authentication Flow [PLANNING]
#   │   ├─ #003: Research OAuth 2.0 Options [RESEARCH]
#   │   ├─ #004: Design User Registration Flow [PLANNING]
#   │   └─ #005: Design Login/Logout Flow [PLANNING]
#   ├─ #006: Implement Authentication Backend [EXECUTION]
#   │   ├─ #007: Set up OAuth Provider [EXECUTION]
#   │   ├─ #008: Implement User Model [EXECUTION]
#   │   └─ #009: Create Authentication Middleware [EXECUTION]
#   └─ #010: Test Authentication System [REVIEW]
#       ├─ #011: Unit Tests for Auth Components [REVIEW]
#       ├─ #012: Integration Tests [REVIEW]
#       └─ #013: Security Review [REVIEW]
```

#### 6.2 Complexity Analysis and Effort Estimation

```bash
# Analyze task complexity with AI
minsky tasks analyze-complexity <task-id>
# Output:
# Task: #001 Implement User Authentication
# Complexity: L (Large)
# Estimated Effort: 12-16 hours
# Risk Factors:
#   - Security considerations require careful implementation
#   - OAuth integration adds external dependency complexity
#   - Cross-browser compatibility testing needed
#
# Recommended Breakdown:
#   - Planning: 2-3 hours (Research + Design)
#   - Execution: 8-10 hours (Implementation)
#   - Review: 2-3 hours (Testing + Security Review)

# Batch complexity analysis
minsky tasks analyze-complexity --all --status TODO --type execution
```

### 7. Checkpoint System Architecture

#### 7.1 Checkpoint Storage Strategy

- **Git-based checkpoints**: Leverage Git commits for code state
- **Session data snapshots**: Capture session-specific state
- **Task progress snapshots**: Record task and subtask completion state
- **Configuration snapshots**: Save environment and tool configurations

#### 7.2 Rollback Capabilities

```bash
# Safe rollback with preview
minsky checkpoint restore <id> --preview
# Shows what files/state would be changed

# Selective rollback
minsky checkpoint restore <id> --files-only  # Only restore file changes
minsky checkpoint restore <id> --task-state-only  # Only restore task progress

# Rollback with conflict resolution
minsky checkpoint restore <id> --resolve-conflicts interactive
```

## Implementation Plan

### Step 1: Core Task Type System (Week 1)

- [ ] Extend TaskData interface with task types
- [ ] Implement task type validation and rules
- [ ] Add task type management functions
- [ ] Create comprehensive unit tests

### Step 2: Session Enhancement (Week 1-2)

- [ ] Extend session system with session types
- [ ] Add checkpointing infrastructure
- [ ] Implement checkpoint creation and restoration
- [ ] Add session-type specific behaviors

### Step 3: AI Planning Integration (Week 2)

- [ ] Enhance AI prompts for type-aware planning
- [ ] Implement complexity analysis features
- [ ] Add intelligent task decomposition
- [ ] Create planning validation tools

### Step 4: CLI Command Extensions (Week 2-3)

- [ ] Implement task type management commands
- [ ] Add checkpointing commands
- [ ] Create workflow orchestration commands
- [ ] Update existing commands with type awareness

### Step 5: Workflow Orchestration (Week 3)

- [ ] Implement workflow cycle management
- [ ] Add automated workflow transitions
- [ ] Create workflow monitoring tools
- [ ] Build workflow templates

### Step 6: Testing & Polish (Week 3-4)

- [ ] Comprehensive testing of all features
- [ ] Performance testing with complex workflows
- [ ] Documentation and user guides
- [ ] Integration testing with previous phases

## Success Criteria

### Functional Requirements

- [ ] Users can create and manage different task types (planning, execution, review)
- [ ] Session checkpointing enables safe rollback and state recovery
- [ ] AI provides intelligent planning assistance with complexity analysis
- [ ] Workflow orchestration supports multi-phase project cycles
- [ ] Fractal planning enables nested planning/execution/review cycles

### Technical Requirements

- [ ] Checkpoint system is efficient and reliable
- [ ] Task type system integrates seamlessly with hierarchy and dependencies
- [ ] AI planning features provide valuable and actionable insights
- [ ] All features maintain backward compatibility

### User Experience Requirements

- [ ] Clear workflow guidance for different project phases
- [ ] Intuitive commands for task type and checkpoint management
- [ ] Helpful AI assistance for planning complex tasks
- [ ] Smooth transitions between planning, execution, and review phases

## Advanced Features

### 1. Automated Planning Workflows

- AI-driven task decomposition based on complexity analysis
- Automated creation of planning → execution → review cycles
- Intelligent dependency suggestion based on task types
- Context-aware effort estimation

### 2. Execution Monitoring

- Real-time progress tracking during execution phases
- Automated checkpoint creation at significant milestones
- Risk detection and early warning systems
- Performance metrics collection

### 3. Review and Retrospective Tools

- Automated review task generation
- Performance analysis and improvement suggestions
- Learning capture from completed cycles
- Best practice identification and documentation

## Integration with External Tools

### Development Environment Integration

- IDE checkpointing integration
- Build system state capture
- Database migration checkpointing
- Container state management

### Project Management Integration

- Export workflows to external PM tools
- Import requirements and convert to planning tasks
- Sync task status with external systems
- Generate reports for stakeholders

## Risk Mitigation

### Complexity Management

- **Feature Creep**: Focus on core workflow patterns first
- **User Overwhelm**: Provide simple defaults and progressive disclosure
- **Performance**: Efficient checkpoint storage and retrieval

### Data Safety

- **Checkpoint Reliability**: Comprehensive testing of restore operations
- **State Consistency**: Validation of checkpoint integrity
- **Conflict Resolution**: Robust handling of checkpoint conflicts

## Future Enhancements

### Phase 4 Preparation

- Data model supports custom visualization requirements
- Workflow system provides foundation for advanced orchestration
- AI integration enables sophisticated project intelligence

### Long-term Vision

- Machine learning from user workflow patterns
- Predictive project planning and risk assessment
- Automated workflow optimization
- Integration with team collaboration tools

## Estimated Effort

**12-16 hours** across 4-5 weeks with iterative development and extensive testing

This phase represents a significant transformation of Minsky from a task management tool into a sophisticated planning and execution orchestration system, while maintaining the simplicity and elegance that makes Minsky powerful.
