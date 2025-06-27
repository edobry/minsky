# Add AI-Powered Rule Suggestion MVP

**Status:** TODO
**Priority:** MEDIUM
**Category:** FEATURE
**Tags:** ai, context, rules, suggestion, mvp

## Overview

Implement a minimal viable product (MVP) for AI-powered rule suggestion that uses natural language queries to recommend relevant rules based on user intent. This task focuses on core functionality with basic output formatting.

## Context

When working with AI assistants, having the right rules loaded in context is crucial for following project conventions and workflows. Currently, users must manually determine which rules are relevant for their current task. This command automates that selection process using AI to analyze user intent and match it with relevant rule descriptions.

## Objectives

1. **Core Command Implementation**: Build `minsky context suggest-rules <query>` with basic functionality
2. **Basic AI Integration**: Use simple prompts to match queries with rule descriptions
3. **Essential Output**: Provide rule recommendations with basic explanations
4. **Foundation for Enhancement**: Create extensible architecture for future improvements

## Requirements

### Core Functionality

1. **Command Interface**

   - Implement `minsky context suggest-rules <query>` command
   - Accept natural language queries describing intended actions or tasks
   - Support both quoted strings and space-separated queries
   - Basic `--json` output option

2. **AI Integration**

   - Send user query along with all available rule descriptions to AI model
   - Use simple prompt to get rule recommendations
   - Focus on rule descriptions only (not full rule content) for efficiency
   - Return list of suggested rule IDs

3. **Rule Integration**

   - Work with existing rule management system from task 029
   - Support both Cursor and generic rule formats
   - Read rule descriptions from current workspace (main or session)
   - Basic error handling for missing or malformed rules

4. **Basic Output**
   - Default: Simple list of suggested rules with brief explanations
   - JSON: Basic structured output with rule IDs and names

### Technical Requirements

- **Dependency**: Requires task 160 (AI completion backend) to be completed
- **Model Selection**: Use configured AI provider from existing backend
- **Error Handling**: Graceful fallback when AI services are unavailable
- **Performance**: Responses should be fast enough for interactive use (< 5 seconds)

## Implementation Steps

1. [ ] **Command Structure Setup**

   - [ ] Create `src/commands/context/suggest-rules.ts`
   - [ ] Add command to CLI routing
   - [ ] Implement basic argument parsing

2. [ ] **Basic AI Integration**

   - [ ] Design simple prompt for rule suggestion
   - [ ] Integrate with AICompletionService from task 160
   - [ ] Implement basic error handling

3. [ ] **Rule Analysis Logic**

   - [ ] Create domain service in `src/domain/context/rule-suggestion.ts`
   - [ ] Extract rule descriptions from existing rule system
   - [ ] Build AI prompt with rule descriptions
   - [ ] Parse AI responses

4. [ ] **Basic Output**

   - [ ] Implement human-readable output
   - [ ] Add simple JSON output support

5. [ ] **Testing**

   - [ ] Unit tests for core logic
   - [ ] Basic integration tests
   - [ ] Manual testing with common scenarios

6. [ ] **Documentation**
   - [ ] Add command help text
   - [ ] Create basic usage examples

## Examples

```bash
# Basic usage
minsky context suggest-rules "I'm going to refactor the task management system"

# JSON output
minsky context suggest-rules "implementing new CLI commands" --json

# Complex query
minsky context suggest-rules "fixing bugs in session management with proper testing"
```

Expected output might include rules like:

- `command-organization` (for CLI structure)
- `domain-oriented-modules` (for code organization)
- `test-driven-bugfix` (for bug fixing approach)
- `session-first-workflow` (for session-related work)

## Acceptance Criteria

- [ ] `minsky context suggest-rules <query>` command implemented with basic functionality
- [ ] AI integration produces rule suggestions based on user queries
- [ ] Basic human-readable and JSON output formats supported
- [ ] Command works in both main and session workspaces
- [ ] Basic error handling for AI service failures
- [ ] Unit tests for core functionality
- [ ] Basic documentation and examples provided
- [ ] Performance is suitable for interactive use (< 5 seconds typical response)

## Dependencies

- **Task 160**: AI completion backend (required - provides AI model integration)
- **Task 029**: Rules command system (optional - for rule management integration)

## Technical Considerations

- **Token Efficiency**: Rule descriptions only, not full content, to minimize AI costs
- **Extensibility**: Design architecture to allow future enhancements
- **Error Handling**: Ensure graceful fallback when AI services are unavailable

## Future Enhancement

See Task 183 for advanced features including:

- Evaluation integration with Task 162
- Confidence scoring and advanced output formatting
- Model optimization based on performance and cost
- A/B testing and prompt improvements

---

**Estimated Effort:** Small-Medium (1-2 weeks)
**Risk Level:** Low (basic implementation with proven technologies)
**Blocking:** Task 160 (AI completion backend)
