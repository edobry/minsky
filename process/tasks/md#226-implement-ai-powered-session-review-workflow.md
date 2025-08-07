# Implement AI-Powered Session Review Workflow

## Problem Statement

While the domain layer contains a `sessionReviewFromParams` function that gathers PR review information (task spec, PR description, diff stats, full diff), this functionality is not available through the CLI and lacks AI-powered analysis capabilities. We need to complete the implementation and extend it with AI-powered review, comment, and approval workflows.

## Context

**Current State:**

- ✅ **Domain layer**: `sessionReviewFromParams` function exists and is tested
- ✅ **AI backend**: Multi-provider AI completion system is implemented (`src/domain/ai/`)
- ✅ **Session approve**: Working approval/merge workflow exists
- ❌ **CLI integration**: Session review command not registered in CLI adapters
- ❌ **AI integration**: No connection between review data gathering and AI analysis
- ❌ **Review workflow**: No structured review → comment → approve process

**Architecture Foundation:**

- Existing AI backend supports OpenAI, Anthropic, Google, Cohere, Mistral
- AI backend includes tool calling, reasoning models, prompt caching
- Configuration system handles API keys, provider selection, model preferences
- Session workflow architecture supports isolated workspaces and git integration

## Goals

1. **Complete CLI Integration**: Register `session review` command in CLI adapters
2. **Add AI-Powered Analysis**: Integrate with AI backend to provide intelligent code review
3. **Implement Review Actions**: Add related commands (comment, approve, reject) with AI assistance
4. **Design Review Workflow**: Create a structured review process that fits Minsky's architecture
5. **Maintain Flexibility**: Support both AI-assisted and traditional review workflows

## Detailed Requirements

### 1. Complete CLI Integration

**1.1 Register Session Review Command**

- Add `sessionReviewFromParams` import to shared command registry
- Create parameter definitions for session review command
- Register `session.review` command in `registerSessionCommands()`
- Add CLI customizations for argument handling and output formatting
- Ensure consistent parameter patterns with other session commands

**1.2 Command Interface**

```bash
# Basic review (existing functionality)
minsky session review [session-name]
minsky session review --task 123

# New AI-powered options
minsky session review --ai                    # AI analysis of the changes
minsky session review --ai --model gpt-4o     # Specific model selection
minsky session review --ai --focus security   # Focus areas: security, performance, style, logic
minsky session review --ai --detailed         # Detailed line-by-line analysis
```

### 2. AI-Powered Review Integration

**2.1 Review Analysis Service**
Create `src/domain/ai/review-service.ts` that:

- Takes session review data (task spec, PR description, diff) as input
- Sends structured prompts to AI models via existing AI backend
- Returns structured review feedback with confidence scores
- Supports different review focus areas (security, performance, style, logic, testing)
- Handles large diffs with chunking strategies for token limits

**2.2 Review Prompt Templates**
Create configurable prompt templates in `src/domain/ai/prompts/`:

- `code-review-base.md`: Core review prompt structure
- `security-focus.md`: Security-specific review criteria
- `performance-focus.md`: Performance optimization focus
- `style-focus.md`: Code style and maintainability
- `testing-focus.md`: Test coverage and quality analysis

**2.3 AI Review Response Schema**

```typescript
interface AIReviewResult {
  overall: {
    score: number; // 1-10 confidence in code quality
    summary: string; // High-level assessment
    recommendation: "approve" | "request-changes" | "comment";
  };
  sections: {
    security?: ReviewSection;
    performance?: ReviewSection;
    style?: ReviewSection;
    logic?: ReviewSection;
    testing?: ReviewSection;
  };
  fileReviews: FileReview[];
  suggestions: Suggestion[];
}
```

### 3. Extended Review Commands

**3.1 Session Review Actions**
Add new session subcommands:

```bash
# AI-powered review and immediate action
minsky session review --ai --approve-if-passing    # Auto-approve if AI gives high score
minsky session review --ai --comment               # Add AI review as PR comment
minsky session review --ai --reject-if-failing     # Auto-reject if AI finds critical issues

# Human-AI collaborative workflow
minsky session comment --ai "Review the error handling in api.ts"
minsky session comment --ai --file "src/api.ts" "Check this function for edge cases"
minsky session approve --ai-verified               # Require AI approval before human approval
```

**3.2 Review Storage and Tracking**

- Store AI review results in session metadata or dedicated review files
- Track review history and iterations
- Support review diff comparison between iterations
- Integration with task status updates

### 4. Advanced Workflow Features

**4.1 Multi-Model Review**

- Support running review with multiple AI models for consensus
- Compare results across providers (OpenAI vs Anthropic vs Google)
- Confidence scoring based on model agreement
- Fallback strategies when primary model fails

**4.2 Contextual Review Enhancement**

- Include project-specific context (coding standards, architecture docs)
- Reference related task specifications and requirements
- Consider historical patterns from previous reviews in the codebase
- Integration with existing Minsky rules and configuration

**4.3 Review Templates and Customization**

- Project-specific review criteria configuration
- Custom prompt templates per repository
- Integration with existing Minsky configuration system
- User/team preferences for review focus and strictness

## Technical Implementation

### Phase 1: CLI Integration (Foundation)

1. **Complete existing functionality**:
   - Add missing imports to shared command registry
   - Register `session.review` command with proper parameter handling
   - Add CLI output formatting for human-readable review display
   - Test basic review functionality works via CLI

### Phase 2: AI Backend Integration (Core)

1. **Create AI Review Service**:

   - `AIReviewService` class that wraps existing AI completion backend
   - Prompt template system for different review types
   - Response parsing and validation for structured review results
   - Error handling and fallback strategies

2. **Extend Session Review Domain**:
   - Add optional AI analysis to `sessionReviewFromParams`
   - New `sessionReviewWithAI` function that combines data gathering + AI analysis
   - Support for different AI models and review focus areas
   - Integration with existing configuration system for AI provider settings

### Phase 3: Extended Commands (Enhancement)

1. **Review Action Commands**:

   - `session comment --ai`: AI-generated PR comments
   - `session approve --ai-verified`: AI-assisted approval workflow
   - `session reject --ai`: AI-assisted rejection with detailed feedback

2. **Advanced Features**:
   - Multi-model consensus review
   - Review result storage and history
   - Integration with task status management
   - Custom review templates and configuration

## Architecture Integration Points

### 1. AI Backend Dependencies

- **Requires**: Existing AI completion backend (`src/domain/ai/`)
- **Uses**: Provider abstraction, model selection, prompt caching
- **Extends**: Configuration system for review-specific settings

### 2. Session Workflow Integration

- **Builds on**: Existing `sessionReviewFromParams` function
- **Integrates with**: Session approve/merge workflow
- **Maintains**: Session isolation and workspace patterns

### 3. Task Management Integration

- **Updates**: Task status based on review results
- **References**: Task specifications for contextual review
- **Tracks**: Review history and approval progression

## Configuration Schema

```yaml
# Repository config (.minsky/config.yaml)
ai:
  review:
    default_model: "gpt-4o"
    focus_areas: ["security", "performance", "style"]
    auto_approve_threshold: 8.5
    require_ai_approval: false
    prompt_templates:
      security: "path/to/security-review.md"
      performance: "path/to/performance-review.md"

# User config (~/.config/minsky/config.yaml)
ai:
  review:
    preferred_provider: "anthropic"
    detailed_analysis: true
    include_line_comments: true
```

## Success Criteria

### Functional Requirements

- [ ] `minsky session review` command works via CLI with existing functionality
- [ ] `minsky session review --ai` provides intelligent code analysis using AI backend
- [ ] AI review results are structured, actionable, and properly formatted
- [ ] Review workflow integrates seamlessly with existing session approve process
- [ ] All new commands follow established Minsky patterns and conventions

### Quality Requirements

- [ ] AI review prompts produce consistent, high-quality analysis
- [ ] Large diff handling works within AI model token limits
- [ ] Error handling gracefully manages AI API failures and fallbacks
- [ ] Configuration system allows project and user customization
- [ ] Performance is acceptable for typical PR sizes (<100 files, <10k lines)

### Integration Requirements

- [ ] No breaking changes to existing session workflow
- [ ] Maintains session isolation and workspace patterns
- [ ] Proper integration with task status management
- [ ] Compatible with all supported AI providers in backend
- [ ] Follows existing authentication and configuration patterns

## Missing Information / Ambiguity Resolution Required

### 1. Review Workflow Integration

**Question**: How should AI review integrate with existing human approval workflows?
**Options**:

- A) AI review is purely informational, human still makes final decisions
- B) AI can auto-approve/reject based on configurable thresholds
- C) Hybrid: AI provides recommendation, human confirms with context
  **Resolution Needed**: Project stakeholder decision on automation level

### 2. Review Result Storage

**Question**: Where should AI review results be stored and tracked?
**Options**:

- A) Session metadata files (ephemeral, per-session)
- B) Task management system (permanent, task-linked)
- C) Dedicated review database/files (persistent, queryable)
- D) Git commit/PR comments (visible, version-controlled)
  **Resolution Needed**: Data persistence and querying requirements

### 3. Multi-Model Consensus Strategy

**Question**: How should multiple AI model results be reconciled?
**Options**:

- A) Simple majority vote on approve/reject recommendation
- B) Weighted scoring based on model confidence and historical accuracy
- C) Show all results, let human decide
- D) Use primary model with others as validation/fallback
  **Resolution Needed**: Consensus algorithm and UX design

### 4. Large Diff Handling

**Question**: How should reviews handle diffs that exceed AI model token limits?
**Options**:

- A) Chunk by files and review separately, aggregate results
- B) Intelligent diff summarization before sending to AI
- C) Focus on changed lines with limited context
- D) Require human pre-filtering of files to review
  **Resolution Needed**: Technical strategy for token limit management

### 5. Team vs Individual Usage

**Question**: How does this work in team environments with multiple reviewers?
**Options**:

- A) Individual AI reviews per developer, no coordination
- B) Shared AI review results visible to whole team
- C) AI review as additional "team member" with explicit approval status
- D) Team lead controls AI review settings and thresholds
  **Resolution Needed**: Team workflow and permission model

### 6. Cost and Rate Limiting

**Question**: How should AI review costs and API rate limits be managed?
**Options**:

- A) Per-user API key quotas and cost tracking
- B) Organization-level AI usage budgets and controls
- C) Automatic fallback to cheaper models when limits approached
- D) Review size limits to control costs (max files/lines)
  **Resolution Needed**: Cost management and organizational policies

### 7. Review Quality Feedback Loop

**Question**: How should the system learn and improve review quality over time?
**Options**:

- A) Collect human feedback on AI review accuracy and adjust prompts
- B) Track correlation between AI recommendations and human decisions
- C) A/B testing of different prompt templates and models
- D) No automatic learning, manual prompt template updates
  **Resolution Needed**: Feedback collection and improvement strategy

## Dependencies and Prerequisites

### Required Completions

- [ ] **AI Backend**: Verify multi-provider AI completion system is fully functional
- [ ] **Configuration System**: Ensure AI provider configuration is working correctly
- [ ] **Session Review Domain**: Confirm `sessionReviewFromParams` works with all edge cases

### Integration Points

- [ ] **Task Management**: Confirm task status update APIs are stable
- [ ] **Git Workflow**: Ensure session approve/merge workflow is solid foundation
- [ ] **Error Handling**: Verify error types and patterns are consistent

## Risk Assessment

### High Risk

- **AI Quality Variability**: AI review quality may be inconsistent across different code types
- **Token Limit Issues**: Large diffs may not fit within AI model context windows
- **Cost Escalation**: Frequent AI reviews could result in high API costs

### Medium Risk

- **Configuration Complexity**: Many options may overwhelm users
- **Workflow Disruption**: Changes to review process may affect team productivity
- **Provider Reliability**: AI API outages could block review workflow

### Low Risk

- **CLI Integration**: Well-established patterns exist for command registration
- **Session Architecture**: Existing session patterns provide solid foundation
- **Backward Compatibility**: Can be implemented without breaking existing functionality

## Notes

This task builds significantly on existing Minsky architecture and should integrate smoothly with established patterns. The AI backend infrastructure is already in place, making the primary work about connecting data gathering with AI analysis and extending the command interface.

The success of this implementation will depend heavily on prompt engineering quality and handling edge cases like very large diffs or AI model failures. A phased approach allows for learning and iteration on the AI integration before adding advanced workflow features.
