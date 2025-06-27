# Add AI-Powered Rule Suggestion for Context Construction

**Status:** TODO
**Priority:** MEDIUM
**Category:** FEATURE
**Tags:** ai, context, rules, suggestion

## Overview

Implement an AI-powered rule suggestion command that intelligently selects relevant rules based on user intent or upcoming actions. This feature uses natural language queries to help construct optimal context by identifying which rules should be loaded for specific tasks.

## Context

When working with AI assistants, having the right rules loaded in context is crucial for following project conventions and workflows. Currently, users must manually determine which rules are relevant for their current task. This command automates that selection process using AI to analyze user intent and match it with relevant rule descriptions.

## Objectives

1. **Intelligent Rule Selection**: Use AI to analyze user queries and identify relevant rules from available rule descriptions
2. **Context Construction Aid**: Help users quickly identify which rules should be loaded for specific tasks or workflows
3. **Practical Immediate Value**: Provide a focused, easy-to-use tool for day-to-day development work
4. **Foundation for Advanced Features**: Create a base for future AI-powered context optimization capabilities

## Requirements

### Core Functionality

1. **Command Interface**

   - Implement `minsky context suggest-rules <query>` command
   - Accept natural language queries describing intended actions or tasks
   - Support both quoted strings and space-separated queries
   - Provide `--json` output option for structured results

2. **AI-Powered Analysis**

   - Send user query along with all available rule descriptions to AI model
   - Use structured output to get consistent rule recommendations
   - Focus on rule descriptions only (not full rule content) for efficiency
   - Return list of suggested rule IDs with confidence indicators

3. **Rule Integration**

   - Work with existing rule management system from task 029
   - Support both Cursor and generic rule formats
   - Read rule descriptions from current workspace (main or session)
   - Handle cases where rules don't exist or have malformed descriptions

4. **Output Formats**
   - Default: Human-readable list of suggested rules with brief explanations
   - JSON: Structured output with rule IDs, names, descriptions, and confidence scores
   - Optional: Rule content preview or quick loading commands

### AI Integration

- **Dependency**: Requires task 160 (AI completion backend) to be completed
- **Model Selection**: Use configured AI provider from existing backend
- **Prompt Engineering**: Design effective prompts for rule matching and relevance scoring
- **Error Handling**: Graceful fallback when AI services are unavailable

### Quality and Performance

- **Relevance**: AI should identify genuinely relevant rules, not just keyword matches
- **Consistency**: Similar queries should produce similar suggestions
- **Speed**: Responses should be fast enough for interactive use
- **Cost Awareness**: Use efficient prompting to minimize token usage

## Implementation Steps

1. [ ] **Command Structure Setup**

   - [ ] Create `src/commands/context/suggest-rules.ts`
   - [ ] Add command to CLI routing in `src/commands/context/index.ts`
   - [ ] Implement argument parsing and validation

2. [ ] **AI Integration**

   - [ ] Design prompts for rule suggestion with structured output
   - [ ] Integrate with AICompletionService from task 160
   - [ ] Implement retry logic and error handling
   - [ ] Add configuration options for model selection

3. [ ] **Rule Analysis Logic**

   - [ ] Create domain service in `src/domain/context/rule-suggestion.ts`
   - [ ] Implement rule description extraction from existing rule system
   - [ ] Build AI prompt construction with rule descriptions
   - [ ] Parse and validate AI responses

4. [ ] **Output Formatting**

   - [ ] Implement human-readable output formatter
   - [ ] Add JSON output support with structured schema
   - [ ] Include confidence scores and explanations
   - [ ] Add options for different verbosity levels

5. [ ] **Testing and Validation**

   - [ ] Unit tests for core logic and AI integration
   - [ ] Integration tests with real AI providers
   - [ ] Test cases covering various query types and edge cases
   - [ ] Manual testing with realistic scenarios

6. [ ] **Documentation and Examples**
   - [ ] Add command documentation and help text
   - [ ] Create usage examples for common scenarios
   - [ ] Document AI prompt design and tuning process

## Evaluation Integration

**Connection to Task 162**: This feature provides an excellent test case for the AI evaluation framework:

- **Rule Selection Accuracy**: Measure whether suggested rules are actually relevant to the given task
- **Consistency Testing**: Ensure similar queries produce similar suggestions across runs
- **Quality Metrics**: Track user satisfaction and rule utility for different query types
- **Performance Evaluation**: Compare different models and prompt strategies

The evaluation framework can help optimize:

- Prompt engineering for better rule matching
- Model selection for different query complexity levels
- Cost-performance trade-offs for various use cases

## Future Directional Work

**AI Model Optimization Integration**: Potential future enhancement to integrate with task 160's model metadata and pricing, plus task 162's evaluation framework for programmatic model selection optimization.

The system could automatically determine the best model for rule suggestion tasks by analyzing:

- Evaluation performance scores for rule selection accuracy
- Real-time pricing data from the AI backend
- Context size requirements and model capabilities
- Quality-cost trade-offs for different use cases

This could enable features like:

- Automatic model selection based on performance/cost optimization
- A/B testing different models for rule suggestion quality
- Cost-aware rule selection (using cheaper models for simple queries, better models for complex ones)
- Performance monitoring and model recommendation updates

_Note: This integration represents potential future work that could be extracted into a separate task focused on AI model optimization and selection._

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

- [ ] `minsky context suggest-rules <query>` command implemented and working
- [ ] AI integration produces relevant rule suggestions based on user queries
- [ ] Both human-readable and JSON output formats supported
- [ ] Command works in both main and session workspaces
- [ ] Graceful error handling for AI service failures
- [ ] Comprehensive test coverage including real AI provider integration
- [ ] Documentation and examples provided
- [ ] Performance is suitable for interactive use (< 5 seconds typical response)

## Dependencies

- **Task 160**: AI completion backend (required - provides AI model integration)
- **Task 029**: Rules command system (optional - for rule management integration)
- **Task 162**: AI evaluation framework (complementary - provides testing capabilities)

## Technical Considerations

- **Token Efficiency**: Rule descriptions only, not full content, to minimize AI costs
- **Caching**: Consider caching rule descriptions to avoid repeated file reads
- **Extensibility**: Design for future enhancements like confidence tuning and result filtering
- **Configuration**: Allow users to configure AI model preferences for rule suggestion
- **Privacy**: Ensure user queries are handled appropriately with respect to AI service privacy policies

---

**Estimated Effort:** Medium (2-3 weeks)
**Risk Level:** Low-Medium (depends on AI service reliability)
**Blocking:** Task 160 (AI completion backend)
