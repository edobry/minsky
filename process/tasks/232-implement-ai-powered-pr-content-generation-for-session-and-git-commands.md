# Implement AI-Powered PR Content Generation for Session and Git Commands

## Description

Add AI-powered automatic generation of PR titles and descriptions using the AI provider system, integrating with existing git prepare-pr methods and session pr workflow. This task focuses on implementing intelligent content generation while leveraging existing PR preparation infrastructure.

## Context and Background

Following the completion of task #203 (improving session pr command output format), the next logical step is to enhance the content generation capabilities. Currently, session pr and git commands accept user-provided titles and descriptions, but there's no automatic generation of meaningful PR content from the actual changes and context.

Task #010 previously outlined similar goals but was marked as obsolete due to architectural changes. This task takes a fresh approach that aligns with the current session-first workflow and AI provider system.

## Analysis of Existing Commands

### Current Git Commands

1. **`git pr`** (now `git summary` per task #025)

   - **Purpose**: Generates PR description markdown from commit history
   - **Current Behavior**: Creates detailed markdown with commits, files, and stats
   - **Role in Workflow**: Provides human-readable summary of changes
   - **Integration Point**: Could be enhanced to generate AI-summarized descriptions

2. **`git prepare-pr`** (via `preparePr`/`preparePrFromParams`)

   - **Purpose**: Creates PR branch with prepared merge commit
   - **Current Behavior**:
     - Creates PR branch from base branch
     - Merges feature branch with --no-ff
     - Accepts user-provided title/body
   - **Role in Workflow**: Prepares clean PR branch for review and merging
   - **Integration Point**: Natural place to generate AI content if not provided

3. **`git approve`** (via `mergePr`)
   - **Purpose**: Fast-forward merges approved PR
   - **Current Behavior**: Merges PR branch into base branch
   - **Role in Workflow**: Finalizes PR integration
   - **Integration Point**: Could update task status or generate merge summaries

### Current Session Commands

1. **`session pr`** (via `sessionPrFromParams`)

   - **Purpose**: Creates PR branch for session work
   - **Current Behavior**: Calls `preparePrFromParams` with session context
   - **Role in Workflow**: Session-specific PR creation
   - **Integration Point**: Primary target for AI-generated content

2. **`session start`**
   - **Purpose**: Creates new session workspace
   - **Current Behavior**: Sets up session directory and branch
   - **Role in Workflow**: Initializes session context
   - **Integration Point**: Could set up AI context for later PR generation

## AI Provider System Integration

### Current AI Infrastructure

The project already has an AI provider system that should be leveraged:

1. **Configuration**: AI providers configured via `config/` files
2. **Interfaces**: Standardized AI service interfaces
3. **Error Handling**: Robust error handling for AI service failures

### Context Construction Strategy

The AI system should use existing methods to gather comprehensive context:

1. **`git pr` Method Context**:

   ```typescript
   // Leverage existing git.prWithDependencies for rich context
   const prContext = await git.prWithDependencies(options, deps);
   // prContext.markdown contains:
   // - Commit history with messages
   // - File changes and statistics
   // - Comprehensive diff information
   ```

2. **Session Context**:

   ```typescript
   // Use session information for additional context
   const sessionContext = {
     taskId: session.taskId,
     taskSpec: await loadTaskSpec(session.taskId),
     sessionName: session.session,
     repoName: session.repoName,
   };
   ```

3. **Task Specification Context**:
   ```typescript
   // Include task specification for goal-oriented generation
   const taskContext = {
     title: taskSpec.title,
     description: taskSpec.description,
     requirements: taskSpec.requirements,
     successCriteria: taskSpec.successCriteria,
   };
   ```

## Requirements

### 1. AI-Powered Title Generation

- **Scope**: Automatic generation of PR titles in conventional commits format
- **Input Context**:
  - Commit messages and history
  - File changes and statistics
  - Task specification (if available)
  - Session context
- **Output Format**: `<type>(<scope>): <description>`
  - Types: feat, fix, docs, style, refactor, test, chore
  - Scope: Determined from task, file changes, or commits
  - Description: Concise, descriptive summary
- **Fallback**: Use existing commit message or generic title if AI fails

### 2. AI-Powered Description Generation

- **Scope**: Automatic generation of comprehensive PR descriptions
- **Input Context**:
  - Full commit history and messages
  - File changes, additions, deletions
  - Task specification content
  - Session metadata
- **Output Format**: Structured markdown with:
  - Summary section
  - Changes section (Added, Changed, Fixed)
  - Implementation details
  - Testing information
  - Task reference links
- **Fallback**: Use existing git pr markdown output if AI fails

### 3. Integration Points

#### A. Session PR Command Enhancement

- **Command**: `minsky session pr`
- **New Options**:
  - `--ai-title`: Generate AI-powered title (default: false)
  - `--ai-body`: Generate AI-powered description (default: false)
  - `--ai-auto`: Generate both title and body automatically (default: false)
- **Behavior**:
  - When AI flags are enabled, generate content automatically
  - Allow user-provided content to override AI content
  - Provide clear feedback about AI-generated vs user-provided content

#### B. Git Commands Enhancement

- **Commands**: `git prepare-pr`, `git summary`
- **New Options**:
  - `--ai-enhance`: Use AI to enhance commit-based descriptions
  - `--ai-summarize`: Generate AI-powered summary instead of raw commit list
- **Behavior**:
  - Enhance existing functionality with AI capabilities
  - Maintain backward compatibility with existing workflows

### 4. AI Service Integration

#### A. Provider Configuration

- **Use existing AI provider system**
- **Configuration**: Extend existing config files with PR-specific settings
- **Models**: Support for different AI models (GPT, Claude, etc.)
- **Rate Limiting**: Implement appropriate rate limiting and error handling

#### B. Prompt Engineering

- **Title Generation Prompt**:
  - Focus on conventional commits format
  - Include context about file changes and task goals
  - Emphasize conciseness and clarity
- **Description Generation Prompt**:
  - Structure output as markdown with clear sections
  - Include implementation details and testing information
  - Reference task specifications when available
  - Maintain professional tone and technical accuracy

### 5. Error Handling and Fallbacks

- **AI Service Failures**:
  - Graceful degradation to existing functionality
  - Clear error messages explaining AI service unavailability
  - Retry mechanisms with exponential backoff
- **Content Quality**:
  - Validation of AI-generated content
  - Fallback to existing methods if AI content is invalid
  - User review and editing capabilities

### 6. User Experience

- **Feedback**: Clear indication when AI-generated content is used
- **Customization**: Allow users to configure AI behavior and preferences
- **Review**: Provide mechanisms for users to review and modify AI content
- **Performance**: Efficient AI calls that don't significantly slow down workflows

## Implementation Strategy

### Phase 1: Foundation (Core AI Integration)

1. **AI Service Integration**: Connect to existing AI provider system
2. **Context Gathering**: Implement functions to gather comprehensive context
3. **Prompt Development**: Create and test AI prompts for title/description generation
4. **Basic Integration**: Add AI capabilities to `preparePrFromParams`

### Phase 2: Command Enhancement

1. **Session PR Enhancement**: Add AI options to session pr command
2. **Git Command Enhancement**: Add AI options to git commands
3. **CLI Integration**: Update command-line interfaces and help text
4. **Error Handling**: Implement robust error handling and fallbacks

### Phase 3: Optimization and Polish

1. **Performance Optimization**: Optimize AI calls and caching
2. **User Experience**: Improve feedback and customization options
3. **Testing**: Comprehensive testing of AI integration
4. **Documentation**: Update documentation and workflow guides

## Technical Considerations

### Context Size Management

- **Token Limits**: Manage AI context size to stay within token limits
- **Context Prioritization**: Prioritize most relevant context when truncating
- **Chunking Strategy**: Break large contexts into digestible chunks

### Caching Strategy

- **AI Response Caching**: Cache AI responses for identical contexts
- **Context Caching**: Cache expensive context gathering operations
- **Invalidation**: Implement appropriate cache invalidation strategies

### Privacy and Security

- **Data Handling**: Ensure sensitive information is not sent to AI services
- **Configuration**: Allow users to opt-out of AI features
- **Local Processing**: Consider local AI options for sensitive environments

## Integration with Existing Workflows

### Session-First Workflow

- **Seamless Integration**: AI features should enhance, not complicate existing workflows
- **Task Association**: AI should understand task context and goals
- **Status Updates**: AI-generated PRs should properly update task status

### Git Workflow Integration

- **Branch Management**: Work with existing branch naming and management
- **Merge Strategies**: Compatible with existing merge strategies
- **Conflict Resolution**: Handle merge conflicts appropriately

## Success Criteria

### Functional Requirements

- [ ] AI can generate conventional commit format PR titles from context
- [ ] AI can generate structured PR descriptions with relevant sections
- [ ] AI integration works seamlessly with existing `preparePrFromParams` method
- [ ] Session pr command accepts AI generation options
- [ ] Git commands support AI enhancement options
- [ ] Proper error handling and fallbacks are implemented

### Quality Requirements

- [ ] AI-generated titles follow conventional commits format consistently
- [ ] AI-generated descriptions are technically accurate and relevant
- [ ] AI integration doesn't significantly slow down existing workflows
- [ ] User feedback indicates AI content is helpful and appropriate
- [ ] All existing functionality remains intact and compatible

### Integration Requirements

- [ ] AI features integrate with existing AI provider system
- [ ] Configuration is consistent with existing project patterns
- [ ] Error handling follows existing project error handling patterns
- [ ] CLI interfaces are consistent with existing command patterns
- [ ] Documentation is updated to reflect new capabilities

## Testing Strategy

### Unit Testing

- [ ] AI service integration components
- [ ] Context gathering functions
- [ ] Prompt generation and validation
- [ ] Error handling and fallback mechanisms

### Integration Testing

- [ ] End-to-end session pr workflow with AI
- [ ] Git command AI enhancement workflows
- [ ] AI service failure scenarios
- [ ] Context size and token limit handling

### User Acceptance Testing

- [ ] AI-generated content quality assessment
- [ ] User workflow integration testing
- [ ] Performance impact evaluation
- [ ] Error scenario user experience testing

## Future Enhancements

### Advanced AI Features

- **Multi-turn Conversations**: Allow users to refine AI-generated content
- **Learning from Feedback**: Improve AI responses based on user feedback
- **Custom Templates**: Allow users to customize AI output templates
- **Integration with Code Review**: AI-powered code review suggestions

### Workflow Enhancements

- **Automated PR Reviews**: AI-powered PR review suggestions
- **Release Note Generation**: AI-powered release notes from PR history
- **Task Completion Detection**: AI-powered task completion verification

## Dependencies

### Internal Dependencies

- AI provider system (existing)
- Git service layer (`preparePrFromParams`, `prWithDependencies`)
- Session management system
- Task management system
- Configuration system

### External Dependencies

- AI service APIs (OpenAI, Anthropic, etc.)
- Git repository access
- File system access for context gathering

## Risks and Mitigation

### Technical Risks

- **AI Service Reliability**: Mitigate with robust fallbacks and error handling
- **Context Size Limitations**: Mitigate with intelligent context prioritization
- **Performance Impact**: Mitigate with caching and optimization strategies

### User Experience Risks

- **AI Content Quality**: Mitigate with validation and user review mechanisms
- **Workflow Disruption**: Mitigate with careful integration and testing
- **Learning Curve**: Mitigate with clear documentation and gradual rollout

### Security Risks

- **Data Privacy**: Mitigate with local processing options and user controls
- **API Key Management**: Mitigate with secure configuration management
- **Sensitive Information Leakage**: Mitigate with content filtering and validation

## Verification

### Manual Testing

- [ ] Generate PR title and description for various session types
- [ ] Test AI fallback behavior when services are unavailable
- [ ] Verify integration with existing git and session workflows
- [ ] Test user experience with AI-generated content

### Automated Testing

- [ ] Unit tests for all AI integration components
- [ ] Integration tests for end-to-end workflows
- [ ] Performance tests for AI service calls
- [ ] Error handling tests for various failure scenarios

### User Validation

- [ ] AI-generated content is relevant and accurate
- [ ] User workflow is improved, not hindered
- [ ] Performance impact is acceptable
- [ ] Error handling provides clear guidance

## Notes

- This task builds upon the output formatting improvements from task #203
- Focus on leveraging existing infrastructure rather than rebuilding
- Maintain backward compatibility with existing workflows
- Consider privacy and security implications of AI integration
- Plan for gradual rollout and user adoption
- Document AI capabilities and limitations clearly

## References

- Task #203: Improve Session PR Command Output and Body Generation
- Task #010: Enhance Git PR Command (obsolete but contains relevant context)
- Task #025: Add Git Approve Command (session workflow context)
- Existing AI provider system documentation
- Conventional commits specification
- Git prepare-pr implementation in `src/domain/git.ts`
