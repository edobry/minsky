# Add Context Analysis and Visualization Commands

## Context

Modern AI assistants construct context dynamically for each request, combining rules, code, conversation history, and other elements. Currently, there's no way to analyze or visualize this context composition, making it difficult to understand token usage, optimize prompts, or debug context-related issues.

Understanding context utilization is crucial for:

- **Cost optimization** - knowing how tokens are distributed across different elements
- **Performance tuning** - identifying inefficient context patterns
- **Debugging** - understanding why certain rules or code aren't being considered
- **Context awareness** - helping users understand what information is available to AI assistants

## Goals

1. Provide visibility into context composition and token usage
2. Enable analysis of context efficiency and optimization opportunities
3. Support debugging of context-related issues
4. Help users understand how their context is constructed and utilized

## Requirements

1. **Context Analysis**

   - `minsky context analyze` - Analyze current context composition and provide metrics
     - Show total token usage and breakdown by category (rules, code, open files, etc.)
     - Identify potential optimization opportunities
     - Display context window utilization percentage
     - Show which elements consume the most tokens
     - Support different model tokenization (leveraging task 160's model metadata)

2. **Context Visualization**

   - `minsky context visualize` - Generate visual representation of context usage
     - Command-line based charts showing context distribution
     - Token usage breakdown with visual indicators
     - Optional structured output formats (JSON, CSV) for further analysis
     - Interactive display showing which elements are included/excluded

## Dependencies

- **Task 160**: AI completion backend (required - provides model metadata and tokenization capabilities)
- **Task 182**: AI-Powered Rule Suggestion (complementary - provides rule selection while this task provides analysis)

## Implementation Steps

1. [ ] **Research and Design**

   - [ ] Research context analysis approaches and visualization techniques
   - [ ] Design data structures for representing context elements and their metadata
   - [ ] Design the command interface and output formats
   - [ ] Research CLI visualization libraries and techniques

2. [ ] **Core Context Analysis Engine**

   - [ ] Implement context discovery logic (identify current rules, open files, etc.)
   - [ ] Integrate with task 160's tokenization capabilities for accurate token counting
   - [ ] Create context categorization system (rules, code, conversation, etc.)
   - [ ] Build analysis algorithms for context breakdown and optimization suggestions

3. [ ] **Command Implementation**

   - [ ] Implement `context analyze` command with detailed metrics
   - [ ] Implement `context visualize` command with CLI-based charts
   - [ ] Add support for different output formats (human-readable, JSON, CSV)
   - [ ] Implement interactive features for exploring context composition

4. [ ] **Testing and Validation**

   - [ ] Create unit tests for context analysis logic
   - [ ] Test with various context sizes and compositions
   - [ ] Validate token counting accuracy across different models
   - [ ] Performance testing for large context analysis

5. [ ] **Documentation and Examples**
   - [ ] Add command documentation with usage examples
   - [ ] Create guides for interpreting context analysis results
   - [ ] Document best practices for context optimization

## Verification

- [ ] Context analysis accurately identifies and categorizes all context elements
- [ ] Token counting is accurate across different model types (leveraging task 160)
- [ ] Context visualization provides clear, actionable insights
- [ ] Commands work correctly in both main and session workspaces
- [ ] Analysis performance is acceptable for interactive use
- [ ] Output formats (human-readable, JSON, CSV) work correctly
- [ ] Context optimization suggestions are relevant and helpful

## Technical Considerations

- **Token Counting Accuracy**: Leverage task 160's model metadata and tokenization capabilities for accurate token counting across different models
- **Performance**: Context analysis should be efficient and not significantly impact workflow, especially for large contexts
- **CLI Visualization**: Research effective CLI-based visualization techniques for context distribution and token usage
- **Context Discovery**: Implement robust logic to identify all relevant context elements (rules, files, conversation, etc.)
- **Extensibility**: Design the analysis framework to accommodate new context types and analysis methods
- **Output Formats**: Support both human-readable displays and structured output for programmatic use

## Use Cases

This task enables scenarios like:

- **Cost Analysis**: "Which elements are consuming the most tokens in my context?"
- **Context Debugging**: "Why isn't my rule being applied? Is it even loaded?"
- **Optimization**: "How can I reduce context size while maintaining effectiveness?"
- **Understanding**: "What exactly is being sent to the AI assistant?"

## Relationship with Task 182

Task 082 focuses on **analysis** ("What's in my context and how much does it cost?") while Task 182 focuses on **selection** ("What rules should I load for this task?"). Together they provide comprehensive context understanding and optimization capabilities.
