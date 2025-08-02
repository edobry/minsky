# Add AI-Powered Rule Suggestion MVP

**Status:** TODO
**Priority:** MEDIUM
**Category:** FEATURE
**Tags:** ai, context, rules, suggestion, mvp

## Overview

Implement a minimal viable product (MVP) for AI-powered rule suggestion that uses natural language queries to recommend relevant rules based on user intent. This task focuses on core functionality with basic output formatting.

## Context

When working with AI assistants, having the right rules loaded in context is crucial for following project conventions and workflows. Currently, users must manually determine which rules are relevant for their current task. This command automates that selection process using AI to analyze user intent and match it with relevant rule descriptions.

**Performance Requirement**: Since this feature will be used on EVERY action, low latency is critical. Traditional approaches that send all rule descriptions to LLM completion models may be too slow for interactive use.

## Objectives

1. **Core Command Implementation**: Build `minsky context suggest-rules <query>` with basic functionality
2. **Fast Retrieval Integration**: Explore embedding-based similarity search and reranking for low-latency responses
3. **Basic AI Integration**: Use simple prompts to match queries with rule descriptions (fallback approach)
4. **Essential Output**: Provide rule recommendations with basic explanations
5. **Foundation for Enhancement**: Create extensible architecture for future improvements

## Requirements

### Core Functionality

1. **Command Interface**

   - Implement `minsky context suggest-rules <query>` command
   - Accept natural language queries describing intended actions or tasks
   - Support both quoted strings and space-separated queries
   - Basic `--json` output option

2. **Retrieval Integration (Primary Approach)**

   - **Reuse Task #250 Infrastructure**: Leverage the same embedding and reranking services built for session-aware code search
   - **Shared Provider Abstraction**: Use the same API provider abstraction layer for embeddings and reranking
   - **Rule Embedding**: Extend the existing embedding service to handle rule content/descriptions
   - **Shared Similarity Search**: Reuse the same vector similarity search utilities
   - **Shared Reranking**: Apply the same neural reranking service for improved relevance
   - **Shared Caching**: Extend the existing embedding cache system for rule content

3. **AI Integration (Fallback Approach)**

   - Send user query along with all available rule descriptions to AI model
   - Use simple prompt to get rule recommendations
   - Focus on rule descriptions only (not full rule content) for efficiency
   - Return list of suggested rule IDs

4. **Rule Integration**

   - Work with existing rule management system from task 029
   - Support both Cursor and generic rule formats
   - Read rule descriptions from current workspace (main or session)
   - Basic error handling for missing or malformed rules

5. **Basic Output**
   - Default: Simple list of suggested rules with brief explanations
   - JSON: Basic structured output with rule IDs and names

### Technical Requirements

- **Primary Dependencies**:
  - Task #250 (Session-aware code search with fast retrieval APIs) for embedding infrastructure
  - Task #160 (AI completion backend) for fallback approach
- **Model Selection**:
  - Primary: Use embedding and reranking APIs from fast retrieval providers
  - Fallback: Use configured AI provider from existing backend
- **Error Handling**: Graceful fallback from embedding approach to AI completion when services unavailable
- **Performance**: Ultra-fast responses for every-action usage (< 500ms target, < 1 second maximum)
- **Embedding Strategy**: Determine optimal approach - rule content vs. descriptions vs. hybrid

## Implementation Steps

1. [ ] **Command Structure Setup**

   - [ ] Create `src/commands/context/suggest-rules.ts`
   - [ ] Add command to CLI routing
   - [ ] Implement basic argument parsing

2. [ ] **Embedding-Based Retrieval (Primary Approach)**

   - [ ] **Extend Task #250 Services**: Reuse existing embedding and reranking infrastructure from session-aware code search
   - [ ] **Rule Embedding Strategy**: Configure existing embedding service for rule content/descriptions
   - [ ] **Rule Content Integration**: Extend existing embedding generation to include rule documents
   - [ ] **Reuse Similarity Search**: Configure existing vector similarity search for rule queries
   - [ ] **Reuse Reranking Service**: Apply existing neural reranking service to rule results
   - [ ] **Extend Caching System**: Configure existing embedding cache for rule content

3. [ ] **AI Integration (Fallback Approach)**

   - [ ] Design simple prompt for rule suggestion
   - [ ] Integrate with AICompletionService from task 160
   - [ ] Implement fallback logic when embedding approach fails

4. [ ] **Rule Analysis Logic**

   - [ ] Create domain service in `src/domain/context/rule-suggestion.ts`
   - [ ] Extract rule content/descriptions from existing rule system
   - [ ] **Reuse Provider Abstractions**: Leverage existing embedding/reranking provider interfaces from Task #250
   - [ ] **Extend Search Services**: Configure existing search utilities for rule content
   - [ ] Implement graceful fallback between embedding and AI completion approaches

5. [ ] **Performance Optimization**

   - [ ] Configure existing services for sub-second response time requirements
   - [ ] **Extend Cache Warming**: Add rule-specific strategies to existing embedding cache
   - [ ] **Reuse Optimization**: Apply existing performance optimizations to rule suggestion calls
   - [ ] **Extend Monitoring**: Add rule suggestion metrics to existing performance monitoring

6. [ ] **Basic Output**

   - [ ] Implement human-readable output
   - [ ] Add simple JSON output support

7. [ ] **Testing**

   - [ ] Unit tests for core logic
   - [ ] Performance tests for latency requirements
   - [ ] Integration tests for both approaches
   - [ ] Manual testing with common scenarios

8. [ ] **Documentation**
   - [ ] Add command help text
   - [ ] Create basic usage examples
   - [ ] Document performance characteristics

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
- [ ] **Primary**: Embedding-based retrieval produces fast, relevant rule suggestions
- [ ] **Fallback**: AI completion integration works when embedding approach fails
- [ ] Basic human-readable and JSON output formats supported
- [ ] Command works in both main and session workspaces
- [ ] Graceful fallback between embedding and AI completion approaches
- [ ] Unit tests for core functionality and both retrieval approaches
- [ ] Performance tests validating sub-second response times
- [ ] Basic documentation and examples provided
- [ ] **Performance**: Ultra-fast responses suitable for every-action usage (< 500ms target, < 1 second maximum)

## Dependencies

- **Task #250**: Session-aware code search with fast retrieval APIs (required - provides embedding and reranking infrastructure)
- **Task #160**: AI completion backend (required - provides fallback AI model integration)
- **Task #029**: Rules command system (optional - for rule management integration)

## Technical Considerations

- **Shared Infrastructure**: Reuse all embedding/reranking services from Task #250 to avoid duplication
- **Service Extension**: Configure existing services for rule content rather than building new ones
- **Token Efficiency**: Rule descriptions only, not full content, to minimize AI costs
- **Unified Monitoring**: Extend existing performance monitoring to include rule suggestions
- **Error Handling**: Ensure graceful fallback when AI services are unavailable

## Future Enhancement

See Task 202 for advanced features including:

- Evaluation integration with Task 162
- Confidence scoring and advanced output formatting
- Model optimization based on performance and cost
- A/B testing and prompt improvements

---

## 🔄 REVISED IMPLEMENTATION PLAN (Post-Architecture Analysis)

### Critical Issues Identified

1. **Dependency Mismatch**: Task 250 (embedding infrastructure) is still in BACKLOG but listed as "required" dependency
2. **Architecture Evolution**: Task 160 (AI backend) is now complete with advanced capabilities we can leverage
3. **Command Overlap**: Task 082 (context commands) overlaps with this task's scope

### Revised Strategy: AI-First Implementation

**Approach**: Make AI completion the primary approach using Task 160's full capabilities

#### Phase 1: Enhanced AI-Based Implementation (IMMEDIATE)

**Key Changes**:
- **Structured Output**: Use Vercel AI SDK's structured output for reliable JSON responses
- **Sophisticated Prompting**: Leverage rule metadata (descriptions, tags, globs) for better matching
- **Multi-Provider Optimization**: Use different models for different query types
- **Context Enhancement**: Include workspace context (files, commits, project type)

**Enhanced Service Interface**:
```typescript
interface RuleSuggestionRequest {
  query: string;
  workspaceRules: Rule[];
  contextHints: {
    currentFiles?: string[];
    recentCommits?: string[];
    projectType?: string;
  };
}

interface RuleSuggestionResponse {
  suggestions: Array<{
    ruleId: string;
    relevanceScore: number;
    reasoning: string;
    confidenceLevel: 'high' | 'medium' | 'low';
  }>;
  queryAnalysis: {
    intent: string;
    keywords: string[];
    suggestedCategories: string[];
  };
}
```

#### Phase 2: Context Command Coordination (PARALLEL)

**Integration with Task 082**:
```bash
minsky context suggest-rules <query>  # This task (182)
minsky context analyze              # Task 082 (future)
minsky context visualize           # Task 082 (future)
```

**Shared Infrastructure**: Rule loading, context discovery, output formatting

#### Phase 3: Future Enhancement (POST-TASK 250)

**When Task 250 is available**:
- Add embedding-based pre-filtering for large rule sets
- Use reranking to improve AI suggestion quality
- Implement hybrid scoring (embedding similarity + AI reasoning)
- Maintain AI completion as reliable fallback

### Updated Implementation Steps

1. **Enhanced Domain Service** (`src/domain/context/rule-suggestion.ts`)
   - Leverage `AICompletionService` with structured output
   - Advanced rule metadata analysis and context gathering
   - Multi-model optimization for different query patterns

2. **Coordinated Command Structure** (`src/commands/context/`)
   - Create unified context command with suggest-rules subcommand
   - Design for future integration with Task 082 commands
   - Shared context utilities and formatting

3. **Performance Optimization**
   - Rule metadata caching with file system watching
   - AI response caching with query similarity detection
   - Target <500ms response time through intelligent caching

### Updated Dependencies

- **✅ Task 160**: AI completion backend (COMPLETE - ready for integration)
- **🔄 Task 250**: Fast retrieval APIs (FUTURE ENHANCEMENT - not blocking)
- **🤝 Task 082**: Context commands (COORDINATION REQUIRED)
- **🔮 Task 302**: MCP resources (FUTURE INTEGRATION OPPORTUNITY)

### Risk Assessment

**Low Risk**: AI backend integration, rule system integration, command structure
**Medium Risk**: Performance requirements, AI prompt engineering, Task 082 coordination
**Previously High Risk (Now Mitigated)**: Dependency on Task 250 (moved to future enhancement)

### Success Criteria (Updated)

- [x] AI completion backend available (Task 160 complete)
- [ ] `minsky context suggest-rules <query>` command with enhanced AI-based suggestions
- [ ] Structured output with relevance scoring and reasoning
- [ ] Performance <500ms target through intelligent caching
- [ ] Context command structure ready for Task 082 integration
- [ ] Extensible architecture for future embedding integration

---

**Original Estimated Effort:** Small-Medium (1-2 weeks)
**Revised Estimated Effort:** Small-Medium (1-2 weeks, but more robust implementation)
**Original Risk Level:** Low (basic implementation with proven technologies)
**Revised Risk Level:** Low-Medium (enhanced implementation, coordination with Task 082)
**Original Blocking:** Task 160 (AI completion backend)
**Revised Blocking:** None (Task 160 complete, Task 250 moved to future enhancement)
