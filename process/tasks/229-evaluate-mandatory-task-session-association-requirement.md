# Task #229: Evaluate mandatory task-session association requirement

## Status

IN-PROGRESS

## Priority

HIGH

## Description

Strategic evaluation of whether to mandate that all sessions must be associated with tasks, with focus on documentation, collaboration, and the `--description` auto-creation approach.

## Updated Objective

Based on investigation findings, evaluate the `--description` auto-creation approach for achieving mandatory task-session associations while addressing documentation and collaboration requirements.

## Investigation Results

### ✅ Current Code Architecture Analysis (COMPLETED)

- **Sessions support optional task association** - `taskId` field is nullable in SessionRecord
- **Two creation modes exist**: explicit task association (`--task 123`) and named sessions (`session-name`)
- **System designed for flexibility** - validates either name OR task is provided
- **Session lifecycle** - can outlive tasks, be created before tasks, span multiple tasks

### ✅ Workflow Analysis (COMPLETED)

- **Sessions can be created without tasks** - Used for exploration, debugging, maintenance
- **Task-first workflow recommended** but session-first workflow supported
- **Friction points identified**: separate task creation, potential for orphaned work
- **Benefits of current flexibility**: supports exploratory work, quick fixes, AI experimentation

### ✅ System Design Implications (COMPLETED)

- **Interface-agnostic architecture** - supports multiple backends (local, remote, GitHub)
- **Database schema impact** - would require migration, backward compatibility handling
- **Remote sessions consideration** - mandatory tasks could help resource tracking but limit dynamic scaling

### ✅ UX Considerations (COMPLETED)

- **User friction identified**: overhead for quick experiments, premature formalization pressure
- **Documentation gap discovered**: sessions lack structured place for notes, context sharing
- **Collaboration need**: team members need session context and purpose visibility

### ✅ Future Direction Alignment (COMPLETED)

- **Remote sessions** - benefit from task association for resource management
- **AI-focused workflows** - need structured documentation but also experimentation flexibility
- **Team collaboration** - requires session context and shared workspace

## Strategic Recommendation: `--description` Auto-Creation Approach

### Core Insight

The key requirement is **structured documentation and collaboration space**, not necessarily formal task management. Tasks provide this structure, and auto-creation eliminates friction.

### Recommended Solution

```bash
# New session start with auto-created task (no session name needed)
minsky session start --description "Fix authentication bug in login flow"
# Creates task and uses task ID as session name (like --task behavior)

# Existing explicit task association unchanged
minsky session start --task 123
```

**Benefits:**

- ✅ **Solves documentation requirement** - every session gets structured task space
- ✅ **Reduces friction** - single command creates session + task
- ✅ **Enables collaboration** - team members can see session purpose and progress
- ✅ **Mandatory association** - no more taskless sessions, simpler codebase

### Implementation Plan

#### Core Implementation

- [ ] Add `--description` parameter to session start command
- [ ] Implement auto-creation of tasks from description
- [ ] Use task ID as session name when using `--description` (like existing `--task` behavior)
- [ ] Make task association mandatory - require either `--task` or `--description`
- [ ] Create migration script for existing taskless sessions:
  - [ ] Examine each taskless session for unmerged work
  - [ ] Output warnings for sessions with unmerged changes (manual inspection required)
  - [ ] Auto-delete sessions with no unmerged work
- [ ] Remove all code that handles taskless sessions

### Technical Implementation

#### Core Files to Modify

- `src/schemas/session.ts` - Add `description` parameter, make task association required
- `src/adapters/shared/commands/session.ts` - Update command parameters
- `src/adapters/cli/cli-command-factory.ts` - Add CLI customizations
- `src/domain/session.ts` - Implement auto-creation logic, remove taskless session support
- `src/domain/tasks.ts` - Add auto-creation function

#### Key Functions

```typescript
// Auto-create task from description
async function createTaskFromDescription(description: string): Promise<Task>;

// Updated session start with mandatory task association
async function startSessionFromParams(params: {
  task?: string;
  description?: string;
  // other existing params
}): Promise<Session>;
```

#### Implementation Steps

- [ ] Add `description` parameter to session start command
- [ ] Implement task auto-creation from description
- [ ] Use task ID as session name when using `--description` (like existing `--task` behavior)
- [ ] Make task association mandatory - require either `--task` or `--description`
- [ ] Create migration script for existing taskless sessions:
  - [ ] Examine each taskless session for unmerged work
  - [ ] Output warnings for sessions with unmerged changes (manual inspection required)
  - [ ] Auto-delete sessions with no unmerged work
- [ ] Remove all code that handles taskless sessions

### Alternative Approaches Considered

1. **Strict Mandatory Association** - Too much friction, blocks exploration
2. **Status Quo** - Doesn't solve documentation/collaboration needs
3. **Optional with Warnings** - Insufficient for collaboration requirements
4. **Configuration-Based** - Too complex, inconsistent experience

## Success Criteria (UPDATED)

### Investigation Phase ✅ COMPLETED

- [x] Comprehensive analysis of current architecture and workflows
- [x] Clear identification of documentation and collaboration requirements
- [x] Evaluation of `--description` auto-creation approach
- [x] Risk assessment and mitigation strategies

### Implementation Phase

- [ ] Successful implementation of `--description` auto-creation
- [ ] 100% session-task association (mandatory requirement)
- [ ] Removal of all taskless session code
- [ ] Simplified session start command

## Conclusion

**Strong recommendation for the `--description` auto-creation approach** with mandatory task association. This solves the core documentation and collaboration requirements while simplifying the codebase by removing all taskless session support.
