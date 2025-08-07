# Explore alternative task entry methods and reference resolution

## Context

Currently, users interact with tasks through explicit commands with specific task ID formats. This task explores alternative, more intuitive ways for users to enter and reference tasks, reducing friction in task management workflows. The goal is to make task interaction more natural and flexible while maintaining system consistency.

## Current Task Entry Methods Analysis

### Existing Commands Available:
✅ **Core Task Commands:**
- `minsky tasks create` - Create tasks with title/description
- `minsky tasks list` - List tasks with filtering
- `minsky tasks get <task-id>` - Get specific task details
- `minsky tasks status set/get` - Status management
- `minsky tasks spec` - Get task specifications

✅ **Task ID Formats Supported:**
- Qualified IDs: `md#123`, `gh#456`, `json#789`
- Legacy formats: `123`, `task#123`, `#123` (auto-migrate to `md#123`)

✅ **Session Integration:**
- `minsky session start --task <task-id>` - Start session for task
- `minsky session get --task <task-id>` - Get session by task

### Current Limitations:
❌ **Rigid Reference Patterns:**
- Users must know exact task IDs or use exact title matches
- No fuzzy search or partial matching for task discovery
- No natural language task references ("the authentication bug")

❌ **Manual Task Discovery:**
- Users must explicitly list tasks to find relevant ones
- No semantic search across task descriptions
- No suggestion system for related/similar tasks

❌ **Context-Unaware Entry:**
- No awareness of current working context (session, branch, recent tasks)
- No intelligent task suggestion based on recent activity
- No implicit task creation from natural descriptions

## Requirements

### Phase 1: Enhanced Task Reference Resolution
1. **Fuzzy Task ID Resolution**
   - Allow partial task ID matches (`"4" → "md#400"` if unique)
   - Support approximate matching with confirmation
   - Handle ambiguous matches with multiple options

2. **Natural Language Task References**
   - Support descriptive references ("the auth task", "session bug")
   - Implement keyword-based task discovery
   - Allow references by partial title matching

3. **Context-Aware Task Resolution**
   - Consider current session context for task suggestions
   - Prioritize recently accessed/modified tasks
   - Support relative references ("previous task", "current session task")

### Phase 2: Intelligent Task Discovery
1. **Smart Task Search**
   - Semantic search across task titles and descriptions
   - Support for synonym and related term matching
   - Integration with existing `minsky tasks list` filtering

2. **Task Suggestion System**
   - Suggest related tasks when viewing/working on a task
   - Recommend tasks based on current git branch/session
   - Show similar or dependent tasks automatically

3. **Interactive Task Selection**
   - Fuzzy finder interface for task selection
   - Type-ahead search with real-time filtering
   - Multi-criteria matching (status, backend, keywords)

### Phase 3: Alternative Entry Methods
1. **Natural Language Task Creation**
   - Parse intent from free-form descriptions
   - Extract title, priority, and category from natural language
   - Auto-suggest task templates based on description

2. **Context-Driven Task Creation**
   - Create tasks from git commit messages or branch names
   - Extract tasks from code comments (TODO, FIXME markers)
   - Generate tasks from error logs or issue reports

3. **Voice/Mobile Interface Preparation**
   - Design API endpoints for voice-driven task entry
   - Support for dictated task descriptions
   - Mobile-friendly task creation workflows

### Phase 4: Advanced Reference Patterns
1. **Hierarchical Task References**
   - Support for subtask references (`md#400.1`, `md#400/design`)
   - Parent-child task navigation
   - Dependency-aware task resolution

2. **Cross-Backend Intelligence**
   - Smart backend selection based on context
   - Automatic GitHub issue linking for relevant tasks
   - Backend-specific optimization for task entry

## Solution Approach

### 1. Task Reference Resolver Service
Create a central service that handles all task reference resolution:

```typescript
interface TaskReferenceResolver {
  resolve(userInput: string, context?: TaskContext): Promise<TaskResolution>;
  suggest(partialInput: string, context?: TaskContext): Promise<TaskSuggestion[]>;
  createFromDescription(description: string, context?: TaskContext): Promise<TaskCreationPreview>;
}

interface TaskResolution {
  matches: TaskMatch[];
  confidence: number;
  requiresConfirmation: boolean;
}

interface TaskContext {
  currentSession?: string;
  currentBranch?: string;
  recentTasks?: string[];
  workingDirectory?: string;
}
```

### 2. Enhanced CLI Integration
Extend existing commands to support alternative entry methods:

```bash
# Current: Explicit task ID required
minsky tasks get md#400

# Enhanced: Multiple resolution strategies
minsky tasks get "400"                    # Fuzzy ID matching
minsky tasks get "alternative entry"      # Title matching
minsky tasks get "the auth task"          # Natural language
minsky tasks get --interactive            # Fuzzy finder interface
minsky tasks get --recent 3               # Recent task selection
```

### 3. Smart Task Creation Workflows
```bash
# Current: Explicit title/description
minsky tasks create --title "Fix bug" --description "..."

# Enhanced: Natural language parsing
minsky tasks create "Fix the authentication bug in session handling"
minsky tasks create --from-commit HEAD~1  # Extract from git commit
minsky tasks create --from-todo src/     # Find TODO comments
minsky tasks create --interactive         # Guided creation wizard
```

### 4. MCP Tool Integration
Extend MCP tools to support enhanced task operations:
- `tasks.resolve` - Resolve natural language task references
- `tasks.suggest` - Get task suggestions based on context
- `tasks.create_smart` - Create tasks from natural descriptions
- `tasks.find_similar` - Find related tasks

## Implementation Plan

### Sprint 1: Core Reference Resolution
- [ ] Implement fuzzy task ID matching
- [ ] Add partial title matching
- [ ] Create task suggestion service
- [ ] Update CLI commands with resolution support

### Sprint 2: Natural Language Processing
- [ ] Implement keyword-based task search
- [ ] Add semantic similarity matching
- [ ] Create natural language task creation parser
- [ ] Add context-aware suggestions

### Sprint 3: Enhanced UX
- [ ] Implement interactive task selection
- [ ] Add fuzzy finder interface
- [ ] Create guided task creation wizard
- [ ] Add voice interface preparation

### Sprint 4: Advanced Features
- [ ] Implement cross-backend intelligence
- [ ] Add automatic task extraction (git, comments)
- [ ] Create mobile API endpoints
- [ ] Add hierarchical task references

## Success Metrics

1. **Reduced Task Discovery Time**
   - 50% reduction in time to find relevant tasks
   - 80% success rate for natural language task references
   - 90% user satisfaction with task suggestion relevance

2. **Increased Task Creation Efficiency**
   - 30% faster task creation with natural language
   - 70% reduction in task creation steps
   - 60% improvement in task description quality

3. **Enhanced User Experience**
   - 90% preference for enhanced reference methods over explicit IDs
   - 80% adoption rate of new entry methods
   - 50% reduction in support requests for task management

## Integration Points

### Existing Systems
- **Task Service**: Extend with resolver and suggestion capabilities
- **MCP Server**: Add new tools for enhanced task operations
- **CLI Bridge**: Update command parsing for natural language
- **Multi-Backend System**: Leverage for intelligent backend selection

### Future Enhancements
- **AI Integration**: Use LLM for task description parsing and suggestion
- **Session Workflows**: Enhanced task-session integration
- **Mobile Interface**: Foundation for mobile/voice task management
- **Analytics**: Track task discovery and creation patterns

## Notes

This exploration should maintain backward compatibility with existing task ID formats while adding layers of intelligence and flexibility. The goal is to reduce cognitive load on users while preserving the precision and consistency of the current system.

Key areas to investigate:
1. How users currently describe tasks when creating them
2. Common patterns in task discovery workflows
3. Opportunities for context-aware task suggestions
4. Integration points with existing MCP and CLI infrastructure

The solution should feel like a natural evolution of current capabilities rather than a replacement.
