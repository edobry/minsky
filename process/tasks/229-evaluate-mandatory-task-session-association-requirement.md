# Evaluate mandatory task-session association requirement

## Status

BACKLOG

## Priority

MEDIUM

## Description

Strategic evaluation of whether to mandate that all sessions must be associated with tasks

## Objective
Analyze whether Minsky should require all sessions to be associated with tasks, considering current architecture, workflows, system design, and future direction.

## Key Investigation Areas

### 1. Current Code Architecture Analysis
- Review how sessions are currently created and managed
- Analyze the relationship between sessions and tasks in the codebase
- Identify current optional vs required associations
- Document existing session lifecycle patterns

### 2. Workflow Analysis
- Examine current Minsky workflows that use sessions
- Identify workflows that operate without explicit tasks
- Analyze the session-first vs task-first workflow patterns
- Document workflow friction points and benefits

### 3. System Design Implications
- Evaluate impact on the interface-agnostic architecture
- Consider database schema and storage implications
- Analyze backward compatibility requirements
- Assess impact on session persistence and recovery

### 4. UX Considerations
- Analyze user experience for mandatory task association
- Consider friction in quick/exploratory sessions
- Evaluate impact on different user personas and use cases
- Design alternative approaches for handling ad-hoc work

### 5. Future Direction Alignment
- Consider implications for remote sessions architecture
- Evaluate alignment with AI-focused workflow direction
- Analyze impact on session sharing and collaboration features
- Consider implications for session analytics and reporting

### 6. Implementation Considerations
- Identify required code changes and migration paths
- Analyze testing requirements and complexity
- Consider rollout strategy and feature flags
- Evaluate resource requirements and timeline

## Expected Deliverables

1. **Current State Analysis Report**
   - Documentation of existing session-task relationships
   - Workflow pattern analysis
   - Technical architecture review

2. **Strategic Recommendation**
   - Clear recommendation: mandate, make optional with defaults, or maintain status quo
   - Justification based on analysis findings
   - Risk assessment and mitigation strategies

3. **Implementation Plan** (if recommending mandate)
   - Technical changes required
   - Migration strategy for existing sessions
   - UX design for mandatory association
   - Testing and rollout approach

4. **Alternative Approaches**
   - Design options for different levels of association
   - Hybrid approaches that balance flexibility with structure
   - Configuration options for different deployment scenarios

## Success Criteria
- Comprehensive analysis of current state
- Clear strategic recommendation with solid justification
- Practical implementation approach if mandate is recommended
- Consideration of all stakeholder perspectives and use cases

## Implementation Plan

### Executive Summary

This document outlines the concrete implementation plan for introducing mandatory session-task association through a hybrid auto-creation approach. The plan follows a three-phase graduated adoption strategy that minimizes disruption while achieving the goal of structured session documentation and tracking.

### Phase 1: Add Auto-Creation Options (Weeks 1-4)

#### 1.1 Core CLI Changes

**Update Session Start Command**
```typescript
// src/commands/session/start.ts
interface SessionStartOptions {
  task?: string;
  description?: string;  // NEW: Auto-create task from description
  template?: string;     // NEW: Use predefined templates
  purpose?: string;      // NEW: Lightweight exploration marker
  notes?: string;        // NEW: Initial session notes
  repo?: string;
  // ... existing options
}
```

**New Template System**
```typescript
// src/domain/templates/session-templates.ts
export interface SessionTemplate {
  id: string;
  name: string;
  description: string;
  taskTemplate: {
    title: string;
    priority: Priority;
    tags: string[];
    initialDescription: string;
  };
}

export const BUILTIN_TEMPLATES: SessionTemplate[] = [
  {
    id: 'bugfix',
    name: 'Bug Fix',
    description: 'Fix a bug or issue',
    taskTemplate: {
      title: 'Fix: {{description}}',
      priority: 'HIGH',
      tags: ['bug', 'fix'],
      initialDescription: 'Bug fix session: {{description}}'
    }
  },
  {
    id: 'feature',
    name: 'Feature Development',
    description: 'Implement a new feature',
    taskTemplate: {
      title: 'Feature: {{description}}',
      priority: 'MEDIUM',
      tags: ['feature', 'enhancement'],
      initialDescription: 'Feature development: {{description}}'
    }
  },
  {
    id: 'exploration',
    name: 'Exploration',
    description: 'Exploratory work or investigation',
    taskTemplate: {
      title: 'Explore: {{description}}',
      priority: 'LOW',
      tags: ['exploration', 'research'],
      initialDescription: 'Exploration session: {{description}}'
    }
  }
];
```

#### 1.2 Task Auto-Creation Logic
```typescript
// src/domain/session/session-service.ts
async createSessionWithAutoTask(options: SessionStartOptions): Promise<SessionRecord> {
  let taskId: string;
  
  if (options.task) {
    // Explicit task association (existing behavior)
    taskId = options.task;
  } else if (options.description) {
    // Auto-create task from description
    const template = options.template ? 
      await this.templateService.getTemplate(options.template) : 
      BUILTIN_TEMPLATES.find(t => t.id === 'exploration');
    
    const autoTask = await this.taskService.createTask({
      title: template.taskTemplate.title.replace('{{description}}', options.description),
      description: template.taskTemplate.initialDescription.replace('{{description}}', options.description),
      priority: template.taskTemplate.priority,
      tags: template.taskTemplate.tags,
      status: 'BACKLOG',
      createdBy: 'session-auto-creation'
    });
    
    taskId = autoTask.id;
  } else {
    // Legacy: allow taskless with warnings
    console.warn('⚠️  Session created without task association');
    console.warn('💡 Consider using --description for better tracking');
    console.warn('   Example: minsky session start --description "Fix login bug" my-session');
  }
  
  return this.createSession({
    ...options,
    taskId
  });
}
```

#### 1.3 CLI UX Improvements
```typescript
// Enhanced help text and examples
const HELP_TEXT = `
Usage: minsky session start [options] [name]

Options:
  --task <id>           Associate with existing task
  --description <text>  Create new task with description
  --template <name>     Use predefined template (bugfix, feature, exploration)
  --purpose <text>      Lightweight purpose description
  --notes <text>        Initial session notes
  --repo <path>         Repository path

Examples:
  # Associate with existing task
  minsky session start --task 123

  # Auto-create task from description
  minsky session start --description "Fix login timeout issue" fix-login

  # Use template for structured task creation
  minsky session start --template bugfix --description "Login fails on mobile" mobile-login-fix

  # Lightweight exploration
  minsky session start --purpose "investigate auth performance" auth-perf
`;
```

#### 1.4 Testing Strategy
```typescript
// tests/session/auto-creation.test.ts
describe('Session Auto-Creation', () => {
  it('should create task from description', async () => {
    const session = await sessionService.createSessionWithAutoTask({
      name: 'test-session',
      description: 'Fix authentication bug'
    });
    
    expect(session.taskId).toBeDefined();
    const task = await taskService.getTask(session.taskId);
    expect(task.title).toContain('Fix authentication bug');
  });
  
  it('should use templates correctly', async () => {
    const session = await sessionService.createSessionWithAutoTask({
      name: 'test-session',
      description: 'Login fails',
      template: 'bugfix'
    });
    
    const task = await taskService.getTask(session.taskId);
    expect(task.tags).toContain('bug');
    expect(task.priority).toBe('HIGH');
  });
});
```

### Phase 2: Make Task Association Default (Weeks 5-8)

#### 2.1 CLI Behavior Changes
```typescript
// Update session start to require one of: --task, --description, --purpose
async validateSessionStartOptions(options: SessionStartOptions): Promise<void> {
  if (!options.task && !options.description && !options.purpose) {
    throw new Error(`
Session requires task association for proper tracking.
Please provide one of:
  --task <id>           Associate with existing task
  --description <text>  Create new task automatically
  --purpose <text>      Lightweight exploration purpose

Examples:
  minsky session start --task 123
  minsky session start --description "Fix login issue" my-session
  minsky session start --purpose "investigate performance" perf-test
`);
  }
}
```

#### 2.2 Migration Tools
```typescript
// src/commands/session/migrate.ts
export async function migrateTasklessSessionsCommand(options: MigrateOptions) {
  const tasklessSessions = await sessionService.getTasklessSessions();
  
  for (const session of tasklessSessions) {
    if (options.autoCreate) {
      // Auto-create exploration task
      const autoTask = await taskService.createTask({
        title: `Session: ${session.session}`,
        description: `Migration task for session ${session.session}`,
        priority: 'LOW',
        tags: ['migration', 'exploration'],
        status: 'BACKLOG'
      });
      
      await sessionService.updateSession(session.session, {
        taskId: autoTask.id
      });
    } else {
      // Interactive migration
      const taskId = await promptForTaskAssociation(session);
      await sessionService.updateSession(session.session, { taskId });
    }
  }
}
```

#### 2.3 Backward Compatibility
```typescript
// Provide escape hatch for edge cases
interface SessionStartOptions {
  // ... existing options
  force?: boolean;  // Allow taskless with explicit flag
}

// In validation
if (!hasTaskAssociation && !options.force) {
  throw new Error('Task association required. Use --force to override.');
}
```

### Phase 3: Full Integration (Weeks 9-12)

#### 3.1 Remove Taskless Support
- Remove `force` option and related code
- Update all documentation and examples
- Clean up migration utilities

#### 3.2 Advanced Features
```typescript
// Task clustering for related sessions
interface TaskCluster {
  id: string;
  name: string;
  description: string;
  parentTaskId?: string;
  childTasks: string[];
}

// AI integration for task suggestions
interface AITaskSuggestion {
  title: string;
  description: string;
  confidence: number;
  reasoning: string;
  suggestedTags: string[];
}
```

### Risk Mitigation

#### 3.1 Rollback Strategy
```typescript
// Feature flag for gradual rollout
interface SessionConfig {
  requireTaskAssociation: boolean;
  allowAutoCreation: boolean;
  warningOnly: boolean;
}

// Environment-based configuration
const config = {
  requireTaskAssociation: process.env.MINSKY_REQUIRE_TASKS === 'true',
  allowAutoCreation: process.env.MINSKY_ALLOW_AUTO_TASKS !== 'false',
  warningOnly: process.env.MINSKY_TASK_WARNING_ONLY === 'true'
};
```

#### 3.2 Monitoring and Metrics
```typescript
// Track adoption metrics
interface SessionMetrics {
  totalSessions: number;
  taskAssociatedSessions: number;
  autoCreatedTasks: number;
  templateUsage: Record<string, number>;
  migrationProgress: {
    totalTaskless: number;
    migrated: number;
    remaining: number;
  };
}
```

### Timeline and Resources

#### Week 1-2: Core Implementation
- Update CLI command structure
- Implement auto-creation logic
- Create basic templates

#### Week 3-4: Testing and Polish
- Comprehensive test suite
- UX refinements
- Documentation updates

#### Week 5-6: Default Behavior
- Make task association required
- Implement migration tools
- User communication

#### Week 7-8: Migration Support
- Monitor adoption
- Address edge cases
- Refine error messages

#### Week 9-10: Full Integration
- Remove escape hatches
- Advanced features
- Performance optimization

#### Week 11-12: Validation and Cleanup
- Final testing
- Documentation complete
- Rollout communication

### Success Metrics

#### Technical Metrics
- 100% of new sessions have task association
- Migration tool successfully processes existing sessions
- No regression in session creation performance
- Test coverage >95% for new functionality

#### User Experience Metrics
- <2% increase in session creation time
- <10% increase in support tickets during migration
- User satisfaction maintains current levels
- No critical workflow disruptions reported

#### Business Metrics
- Improved work tracking visibility
- Enhanced project management reporting
- Better resource allocation data
- Increased team collaboration efficiency

### Communication Plan

#### Internal Team
- Engineering team briefing on implementation approach
- QA team testing protocols and scenarios
- DevOps team rollout and monitoring plans
- Product team user impact assessment

#### External Users
- Release notes with migration guide
- Blog post explaining benefits and changes
- Updated documentation with examples
- Support team training on new workflows

### Conclusion

This implementation plan provides a structured approach to introducing mandatory session-task association while minimizing disruption to existing workflows. The three-phase approach allows for gradual adoption, user feedback incorporation, and risk mitigation throughout the process.

The hybrid auto-creation approach addresses the core need for structured session documentation while maintaining the flexibility that users value in the current system.

## Requirements

### R1: Comprehensive Analysis
- Complete analysis of current session-task relationship patterns
- Document all existing workflows and their session usage
- Identify gaps in current tracking and documentation capabilities
- Analyze impact on different user personas (developers, AI agents, teams)

### R2: Strategic Recommendation
- Provide clear recommendation on session-task association requirement
- Justify decision with evidence from architectural, workflow, and UX analysis
- Include risk assessment and mitigation strategies
- Consider future system evolution (remote sessions, AI integration)

### R3: Implementation Plan
- Define specific technical changes required
- Create migration strategy for existing sessions
- Specify UX design for new session creation flows
- Include testing approach and rollout strategy

### R4: Documentation and Collaboration Solution
- Address core need for structured session documentation
- Provide mechanism for context sharing across sessions
- Enable collaborative note-taking and work tracking
- Ensure solution scales with team collaboration needs

### R5: Backward Compatibility
- Maintain existing workflows during transition
- Provide clear migration path for existing sessions
- Minimize disruption to established user patterns
- Include rollback strategy if needed

## Success Criteria

### SC1: Complete Analysis (✓ Completed)
- All current session creation patterns documented
- All workflow use cases analyzed and categorized
- Technical architecture implications fully understood
- User experience impacts clearly identified

### SC2: Evidence-Based Recommendation (✓ Completed)
- Clear recommendation with solid justification
- Risk assessment completed with mitigation strategies
- Future direction alignment confirmed
- Stakeholder impact analysis included

### SC3: Practical Implementation Plan (✓ Completed)
- Specific code changes identified and scoped
- Migration strategy defined with concrete steps
- UX mockups or specifications created
- Testing approach documented with success metrics

### SC4: Validation and Consensus (Pending)
- Technical approach validated through proof-of-concept
- Key stakeholders consulted and aligned
- Implementation complexity assessed and confirmed feasible
- Timeline and resource requirements finalized

### SC5: Documentation Complete (Pending)
- All analysis findings properly documented
- Implementation plan ready for engineering team
- User-facing documentation updated
- Rollout communication plan prepared
