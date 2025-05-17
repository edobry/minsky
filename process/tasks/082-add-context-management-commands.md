# Task #082: Add Context Management Commands

## Context

Modern AI agents like those used in Minsky rely heavily on prompt engineering and context management. Currently, there's no way to analyze, visualize, or manipulate this context, making it difficult to debug issues or optimize prompts. Additionally, understanding context utilization across different LLM models is crucial for performance optimization and cost management.

The "salient rule loading" workflow (where rules are dynamically loaded based on relevance) requires tools to simulate and test this behavior. Engineers need visibility into how much context is being used and how effectively it's being managed.

## Requirements

1. **Model Awareness**

   - Create an abstraction layer for model information that can:
     - Identify which model is being used for a given session
     - Retrieve model specifications (context window size, token limits, capabilities)
     - Support both online API-based models and local inference models
     - Allow for model simulation/emulation for testing

2. **Context Analysis Commands**

   - `minsky context analyze` - Analyze the current context and provide metrics
     - Show total tokens used/available
     - Breakdown of context usage by category (rules, code, conversation history)
     - Identify potential optimization opportunities

3. **Context Visualization**

   - `minsky context visualize` - Generate a visual representation of context usage
     - Command-line based visualization for quick reference
     - Optional output to structured formats (JSON, CSV) for further analysis

4. **Rule Simulation**

   - `minsky context simulate-rules` - Test rule loading behavior
     - Allow specification of which rules to include
     - Show how rules would be loaded in a real scenario
     - Calculate token usage impact of different rule combinations

5. **Context Management**
   - `minsky context prune` - Optimize context by removing less relevant content
   - `minsky context prioritize` - Reorder context elements based on importance

## Implementation Steps

1. [ ] **Research and Design**

   - [ ] Research token counting libraries and approaches for different models
   - [ ] Design model abstraction layer that works with various LLM providers
   - [ ] Create data structures for representing context elements and their metadata
   - [ ] Design the command interface and options

2. [ ] **Model Awareness Implementation**

   - [ ] Create a ModelInfo interface and concrete implementations
   - [ ] Implement detection logic for identifying the active model
   - [ ] Build adapters for online vs. local models
   - [ ] Add model specification repository (context sizes, capabilities)

3. [ ] **Core Context Analysis**

   - [ ] Implement token counting functions for different model types
   - [ ] Create analysis algorithms for context breakdown
   - [ ] Develop recommendation engine for context optimization

4. [ ] **Command Implementation**

   - [ ] Implement `context analyze` command
   - [ ] Implement `context visualize` command
   - [ ] Implement `context simulate-rules` command
   - [ ] Implement `context prune` command
   - [ ] Implement `context prioritize` command

5. [ ] **Testing**

   - [ ] Create unit tests for token counting and analysis
   - [ ] Develop integration tests for model detection
   - [ ] Test with various rule combinations and context sizes
   - [ ] Performance testing for large contexts

6. [ ] **Documentation**
   - [ ] Add command documentation and examples
   - [ ] Create guides for context optimization
   - [ ] Document model specifications and limitations

## Verification

- [ ] Commands correctly identify and report on the model in use
- [ ] Token counting is accurate across different model types
- [ ] Rule simulation correctly predicts loading behavior
- [ ] Context analysis provides actionable insights
- [ ] Commands work in all supported environments (local and API-based)
- [ ] Performance meets requirements (specify metrics)

## Technical Considerations

- **Model Abstraction**: We'll need a flexible abstraction that works with different model providers and can be extended as new models emerge.
- **Token Counting**: Different models have different tokenization algorithms; we'll need to account for this.
- **Performance**: Context analysis should be efficient and not significantly impact workflow.
- **API Integration**: For online models, we'll need to integrate with provider APIs to get accurate model information.
- **Extensibility**: The system should be designed to accommodate future models and context management strategies.
