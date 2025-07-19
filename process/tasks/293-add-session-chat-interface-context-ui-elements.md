# Add Session Chat Interface Context UI Elements

## Status

BACKLOG

## Priority

MEDIUM

## Description

Add UI elements to the session chat interface that provide context to supervisors (human or AI) including: 1) the task being worked on, 2) current status/phase, 3) last supervisor message, 4) high-level conversation summary, 5) session stats (length, changes made, etc.). Implementation could be via MCP tool, custom GUI interface, or other mechanism.

## Context

When working in Minsky sessions, supervisors (both human and AI) often need contextual information about the current session state to make informed decisions and provide effective guidance. Currently, this context is scattered across different systems and requires manual lookup of task details, session information, and conversation history.

A unified context interface would significantly improve the supervision experience by providing immediate access to key session information without requiring separate queries or tool calls.

## Related Tasks

- **Task #252 (Task Management UI System)**: Shares potential GUI components and chat interface architecture
- **Task #251 (Mobile/Voice Interface)**: Could benefit from shared context display components
- **Task #158 (Session-Aware Tools)**: Provides foundation for session-aware context gathering

## Objectives

1. **Provide Real-Time Session Context**: Create UI elements that display current session state and progress
2. **Improve Supervisor Efficiency**: Reduce time needed to gather context before making decisions
3. **Support Multiple Implementation Paths**: Design flexible architecture that works across different interfaces
4. **Enable Informed Decision Making**: Provide comprehensive session overview for better guidance
5. **Create Reusable Components**: Build context components that can be shared across different interfaces

## Requirements

### Core Context Elements

#### 1. Current Task Information
- **Task ID and Title**: Display the primary task being worked on
- **Task Status**: Show current task status (TODO, IN-PROGRESS, etc.)
- **Task Description**: Brief summary or first few lines of task specification
- **Task Dependencies**: Show related/dependent tasks if applicable
- **Progress Indicators**: Visual indication of task completion percentage or phase

#### 2. Session Status and Phase Information
- **Session Name**: Current session identifier
- **Session Phase**: Current phase of work (research, implementation, testing, etc.)
- **Time Tracking**: Session start time, duration, time since last activity
- **Branch Information**: Current git branch and any pending changes
- **Session Type**: Whether this is a main workspace or session workspace

#### 3. Last Supervisor Message Context
- **Message Timestamp**: When the last supervisor intervention occurred
- **Message Preview**: First few lines of the last supervisor message
- **Action Items**: Any specific instructions or requests from supervisor
- **Response Status**: Whether supervisor input has been addressed

#### 4. Conversation Summary
- **High-Level Progress**: What has been accomplished in this session
- **Current Focus**: What the agent is currently working on
- **Recent Decisions**: Key technical decisions made recently
- **Blockers/Issues**: Any problems encountered that may need supervisor attention
- **Next Steps**: Planned immediate actions

#### 5. Session Statistics
- **Message Count**: Total messages in conversation
- **Code Changes**: Number of files modified, lines added/removed
- **Commands Executed**: Count of terminal commands, tool calls
- **Time Metrics**: Active time, idle time, time per phase
- **Error Rate**: Number of errors or failed attempts
- **Tool Usage**: Most frequently used tools/commands

### Implementation Approaches

#### Option 1: MCP Tool-Based Context Provider

**Pros**:
- Easy to implement with existing MCP infrastructure
- Works across any MCP-compatible interface
- Can be called on-demand by supervisors

**Cons**:
- Not always visible, requires explicit tool call
- Limited visual formatting options

**Implementation**:
```typescript
// New MCP tool: mcp_minsky-server_session_context
interface SessionContextParams {
  session?: string;
  workspace?: string;
  includeStats?: boolean;
  includeHistory?: boolean;
}

interface SessionContextResult {
  task: TaskContextInfo;
  session: SessionStatusInfo;
  lastSupervisorMessage: MessageContextInfo;
  summary: ConversationSummaryInfo;
  stats: SessionStatsInfo;
}
```

#### Option 2: Custom GUI Integration

**Pros**:
- Rich visual presentation with charts, graphs, colors
- Always visible context panel
- Interactive elements for drilling down

**Cons**:
- Requires GUI implementation (Task #252)
- Platform-specific implementation needed

**Implementation**:
- Integrate with Task #252's GUI system
- Create dedicated context sidebar or overlay
- Support real-time updates as session progresses

#### Option 3: Terminal-Based Context Display

**Pros**:
- Works in any terminal environment
- Lightweight and fast
- Integrates with existing CLI tools

**Cons**:
- Limited visual formatting
- May interfere with normal terminal usage

**Implementation**:
- Command-line tool: `minsky session context --watch`
- Status bar integration (if terminal supports)
- Periodic context summaries in chat

#### Option 4: Hybrid Approach

**Pros**:
- Best of all worlds, works across different environments
- User choice in how to access context

**Cons**:
- More complex to implement and maintain

**Implementation**:
- Core context gathering service
- Multiple interface adapters (MCP, GUI, CLI)
- Unified data model across all interfaces

### Technical Architecture

#### Context Data Model

```typescript
interface SessionContext {
  timestamp: Date;
  session: {
    id: string;
    name: string;
    workspace: string;
    status: SessionStatus;
    startTime: Date;
    duration: number;
    branch: string;
    hasUncommittedChanges: boolean;
  };
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    description: string;
    progress: number;
    phase: string;
    dependencies: string[];
  };
  supervisor: {
    lastMessageTime: Date;
    lastMessagePreview: string;
    pendingActionItems: string[];
    responseStatus: 'pending' | 'addressed' | 'in-progress';
  };
  conversation: {
    summary: string;
    currentFocus: string;
    recentDecisions: string[];
    blockers: string[];
    nextSteps: string[];
  };
  stats: {
    messageCount: number;
    filesModified: number;
    linesAdded: number;
    linesRemoved: number;
    commandsExecuted: number;
    errorsEncountered: number;
    toolUsage: Record<string, number>;
    timeMetrics: {
      activeTime: number;
      idleTime: number;
      timeInPhase: Record<string, number>;
    };
  };
}
```

#### Context Gathering Service

```typescript
interface ContextGatheringService {
  gatherSessionContext(sessionId?: string): Promise<SessionContext>;
  watchSessionContext(callback: (context: SessionContext) => void): void;
  generateConversationSummary(messages: Message[]): Promise<string>;
  detectCurrentPhase(recentActivity: Activity[]): string;
  calculateSessionStats(session: Session): SessionStats;
}
```

### UI/UX Considerations

#### Visual Design Principles
- **Non-Intrusive**: Context should enhance, not interfere with workflow
- **Scannable**: Key information should be quickly identifiable
- **Hierarchical**: Most important information should be prominently displayed
- **Actionable**: Context should enable quick actions (jump to task, view details)

#### Responsive Design
- **Collapsible Sections**: Allow hiding/showing different context areas
- **Customizable Layout**: Users can choose which elements to display
- **Mobile-Friendly**: Design works on smaller screens (Task #251 integration)

#### Real-Time Updates
- **Live Statistics**: Update metrics as work progresses
- **Change Indicators**: Highlight when context elements change
- **Refresh Controls**: Allow manual refresh of context data

## Implementation Phases

### Phase 1: Core Context Gathering Infrastructure
- [ ] Design and implement SessionContext data model
- [ ] Create ContextGatheringService with basic functionality
- [ ] Implement task context gathering (integrate with existing task system)
- [ ] Implement session status gathering (integrate with session management)
- [ ] Add basic conversation analysis for summaries

### Phase 2: MCP Tool Implementation
- [ ] Create `mcp_minsky-server_session_context` tool
- [ ] Implement parameter validation and error handling
- [ ] Add formatting options for different output styles
- [ ] Create comprehensive tests for MCP tool
- [ ] Update MCP documentation with new tool

### Phase 3: Statistics and Analytics
- [ ] Implement session statistics tracking
- [ ] Add file change monitoring
- [ ] Create command execution tracking
- [ ] Implement time tracking for different phases
- [ ] Add error rate monitoring

### Phase 4: Enhanced Context Features
- [ ] Add supervisor message tracking and analysis
- [ ] Implement intelligent conversation summarization
- [ ] Create phase detection algorithms
- [ ] Add blocker and next-step identification
- [ ] Implement context change notifications

### Phase 5: Alternative Interface Implementation
- [ ] Choose between GUI, CLI, or hybrid approach based on Task #252 progress
- [ ] Implement chosen interface(s)
- [ ] Add real-time update capabilities
- [ ] Create interactive elements for context exploration
- [ ] Integrate with existing Minsky interfaces

### Phase 6: Integration and Polish
- [ ] Integrate with Task #251 (mobile/voice interface) if applicable
- [ ] Add customization options for different user preferences
- [ ] Implement caching for performance optimization
- [ ] Create comprehensive documentation and examples
- [ ] Add end-to-end testing scenarios

## Success Criteria

### Functional Requirements
- [ ] All five core context elements are accurately gathered and displayed
- [ ] Context information updates in real-time as session progresses
- [ ] Multiple supervisors can access context without interference
- [ ] Context gathering works across different session types and workspaces
- [ ] Performance impact on session operations is minimal

### User Experience Requirements
- [ ] Context is immediately accessible without complex setup
- [ ] Information is presented in a clear, scannable format
- [ ] Users can customize which context elements are displayed
- [ ] Context helps supervisors make faster, more informed decisions
- [ ] Interface works consistently across different environments

### Technical Requirements
- [ ] Context gathering service is robust and handles edge cases
- [ ] Data model supports future extensions and integrations
- [ ] Implementation follows Minsky's architectural patterns
- [ ] Code is well-tested with comprehensive coverage
- [ ] Documentation enables easy maintenance and extension

### Integration Requirements
- [ ] Works seamlessly with existing Minsky session management
- [ ] Integrates properly with task management system
- [ ] Compatible with future GUI development (Task #252)
- [ ] Supports mobile/voice interface integration (Task #251)
- [ ] Provides foundation for future context-aware features

## Estimated Effort

**Large** - This involves designing new data models, implementing context gathering across multiple systems, creating user interfaces, and ensuring robust integration with existing Minsky components.

## Dependencies

- Existing session management system
- Task management system
- MCP server infrastructure
- May depend on Task #252 (GUI system) for visual interface implementation

## Definition of Done

- [ ] SessionContext data model is implemented and well-tested
- [ ] ContextGatheringService provides accurate context information
- [ ] At least one interface (MCP tool) is fully implemented and documented
- [ ] Context updates in real-time as sessions progress
- [ ] Integration tests verify context accuracy across different scenarios
- [ ] Documentation enables supervisors to effectively use context features
- [ ] Performance benchmarks show minimal impact on session operations
