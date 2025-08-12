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

1. **Local Tokenization System**

   - **Multi-Library Support**: Integrate multiple tokenization libraries for comprehensive model coverage

     - [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer): Fastest JavaScript BPE tokenizer for OpenAI models (GPT-4o, o1, o3, GPT-4, etc.)
     - [`tiktoken`](https://github.com/dqbd/tiktoken): JavaScript port of OpenAI's tiktoken library
     - Extensible architecture to add more tokenization libraries as needed

   - **Model-Specific Tokenizer Detection**: Automatically determine appropriate tokenizer for each model

     - Query provider APIs for tokenizer information during model metadata fetching
     - Extend AI provider configuration to specify custom tokenizer mappings
     - Fallback logic when tokenizer information is unavailable

   - **Tokenizer Selection Logic**: Intelligent tokenizer library selection per model
     - Priority-based selection (e.g., gpt-tokenizer for OpenAI models, tiktoken for fallback)
     - Configuration overrides for custom tokenizer preferences
     - Performance-optimized caching of tokenizer instances

2. **Context Analysis**

   - `minsky context analyze` - Analyze current context composition and provide metrics
     - Show total token usage and breakdown by category (rules, code, open files, etc.)
     - **Local token prediction** without requiring API calls
     - Identify potential optimization opportunities
     - Display context window utilization percentage
     - Show which elements consume the most tokens
     - **Model-specific tokenization** using appropriate local tokenizers
     - **Cross-model comparison** showing token differences between models

3. **Context Visualization**

   - `minsky context visualize` - Generate visual representation of context usage
     - Command-line based charts showing context distribution
     - Token usage breakdown with visual indicators
     - Optional structured output formats (JSON, CSV) for further analysis
     - Interactive display showing which elements are included/excluded
     - **Tokenizer-specific breakdowns** showing differences between tokenization methods

## Dependencies

- **Task 160**: AI completion backend (required - provides model metadata and enhanced tokenization capabilities)
- **Task 182**: AI-Powered Rule Suggestion (complementary - provides rule selection while this task provides analysis)
- **Task 390**: AI telemetry/verbose output (surface tokenization failures/discrepancies without blocking)
- **New Dependencies**:
  - `gpt-tokenizer` package: Fast JavaScript BPE tokenizer for OpenAI models
  - `tiktoken` package: JavaScript port of OpenAI's tiktoken library
  - Enhanced model metadata system with tokenizer information

## Implementation Steps

1. [ ] **Provider API Research (Tokenizer Metadata)**

   - [ ] Investigate OpenAI and Anthropic APIs for tokenizer metadata exposure
   - [ ] If APIs do not expose tokenizer info, research authoritative alternatives (official docs/specs) to derive model→tokenizer mappings
   - [ ] Define precedence order for sources (API > config > documented defaults)
   - [ ] Document findings and gaps for future provider coverage (Google, Morph, etc.)

2. [ ] **Tokenization Infrastructure Setup**

   - [ ] Install and integrate tokenization libraries (`gpt-tokenizer`, `tiktoken`)
   - [ ] Design tokenizer abstraction layer with unified interface
   - [ ] Create tokenizer registry and selection logic
   - [ ] Implement tokenizer caching

3. [ ] **Enhanced Model Metadata System**

   - [ ] Extend AI provider model fetchers to query tokenizer information from APIs
   - [ ] Add tokenizer fields to `AIModel` interface and `CachedProviderModel`
   - [ ] Update model fetchers (OpenAI, Anthropic, Google, Morph) with tokenizer detection
   - [ ] Implement fallback tokenizer mapping for models without API tokenizer data
   - [ ] Validate tokenizer mappings during offline cache hydration (reuse model cache cadence)

4. [ ] **AI Provider Configuration Extensions**

   - [ ] Extend AI provider config schema to support custom tokenizer mappings
   - [ ] Add configuration options for tokenizer library preferences (per-model overrides; global provider-agnostic settings not required)
   - [ ] Implement tokenizer override mechanisms in provider configs
   - [ ] Create validation for tokenizer configuration entries

5. [ ] **Core Context Analysis Engine**

   - [ ] Implement context discovery logic (identify current rules, open files, etc.)
   - [ ] Create local tokenization service using integrated libraries
   - [ ] Build model-specific token counting with appropriate tokenizers
   - [ ] Create context categorization system (rules, code, conversation, etc.)
   - [ ] Implement cross-model token comparison algorithms
   - [ ] Build analysis algorithms for context breakdown and optimization suggestions

6. [ ] **Command Implementation**

   - [ ] Implement `context analyze` command with local tokenization
   - [ ] Add model selection and tokenizer specification options
   - [ ] Implement `context visualize` command with tokenizer-specific breakdowns
   - [ ] Add support for different output formats (human-readable, JSON, CSV)
   - [ ] Implement interactive features for exploring context composition
   - [ ] Add tokenizer comparison and debugging features

7. [ ] **Testing and Validation**

   - [ ] Create unit tests for tokenization infrastructure
   - [ ] Test tokenizer behavior against reference implementations
   - [ ] Test with various context sizes and compositions across models
   - [ ] Validate token counting behavior across different tokenizers (no requirement to match provider-reported tokens)
   - [ ] Integration tests with enhanced model metadata system

8. [ ] **Documentation and Examples**
   - [ ] Add command documentation with tokenization examples
   - [ ] Create guides for interpreting context analysis results
   - [ ] Document tokenizer configuration and customization
   - [ ] Document best practices for context optimization
   - [ ] Add troubleshooting guide for tokenization issues

## Verification

- [ ] **Tokenization Infrastructure**

  - [ ] Multiple tokenization libraries integrate successfully (`gpt-tokenizer`, `tiktoken`)
  - [ ] Tokenizer selection logic works correctly for supported models (prefer `gpt-tokenizer` for OpenAI; fallback to `tiktoken`), with per-model overrides
  - [ ] Telemetry reports tokenization failures or unavailability without blocking execution
  - [ ] Configuration overrides work for custom per-model tokenizer mappings

- [ ] **Enhanced Model Metadata**

  - [ ] Model fetchers detect and store tokenizer information from APIs (OpenAI/Anthropic first)
  - [ ] Fallback tokenizer mappings work when API data is unavailable
  - [ ] Tokenizer mappings validated during offline cache hydration

- [ ] **Context Analysis**
  - [ ] Context analysis accurately identifies and categorizes all context elements
  - [ ] Local token counting functions across different model types and tokenizers
  - [ ] Context visualization provides clear, actionable insights
  - [ ] Commands work correctly in both main and session workspaces
  - [ ] Output formats (human-readable, JSON, CSV) work correctly
  - [ ] Context optimization suggestions are relevant and helpful

## Technical Considerations

- **Local Tokenization Architecture**: Design flexible tokenizer abstraction that supports multiple libraries

  - Unified interface for different tokenization implementations
  - Performance-optimized tokenizer instance caching
  - Memory-efficient handling of large text inputs
  - Error handling for unsupported models or tokenization failures

- **Tokenizer Selection Strategy**: Implement intelligent tokenizer detection and selection

  - Priority-based selection (prefer `gpt-tokenizer` for OpenAI models due to performance)
  - Model-specific mappings with fallback logic
  - Configuration override capabilities for custom use cases
  - Validation to ensure selected tokenizer matches model requirements

- **Provider API Integration**: Extend model fetching to include tokenizer metadata (OpenAI, Anthropic first)

  - Query provider APIs for official tokenizer information when available
  - Store tokenizer specifications in cached model data
  - Handle API limitations or missing tokenizer data gracefully
  - Update model cache when tokenizer information becomes available

- **Configuration System Extensions**: Enhance AI provider configuration for tokenization

  - Schema extensions for tokenizer mappings and preferences
  - Validation of tokenizer configuration entries
  - Environment variable support for tokenizer library selection
  - Backward compatibility with existing configurations

- **Performance Optimization**: Deferred. Performance work is out of scope for now.

- **Accuracy and Validation**: Practical correctness and observability

  - No requirement to match provider API token counts
  - Emit telemetry when tokenization fails; continue execution
  - Document known limitations or edge cases and recommended overrides

- **CLI Visualization**: Research effective CLI-based visualization techniques for context distribution and token usage
- **Context Discovery**: Implement robust logic to identify all relevant context elements (rules, files, conversation, etc.)
- **Extensibility**: Design the analysis framework to accommodate new tokenization libraries and analysis methods
- **Output Formats**: Support both human-readable displays and structured output for programmatic use

## Use Cases

This enhanced task enables scenarios like:

- **Local Cost Prediction**: "How many tokens will this context consume before sending to the API?"
- **Tokenizer Debugging**: "Is my local token count consistent for my content?"
- **Cost Analysis**: "Which elements are consuming the most tokens in my context?"
- **Context Debugging**: "Why isn't my rule being applied? Is it even loaded?"
- **Optimization**: "How can I reduce context size while maintaining effectiveness?"
- **Understanding**: "What exactly is being sent to the AI assistant?"

Deferred to Task #162 (Eval Framework):

- Cross-model analysis and tokenization comparison
- Token mismatch evaluation strategies and scoring

## Architecture Design

### Tokenization Infrastructure

**Tokenizer Abstraction Layer**:

```typescript
interface LocalTokenizer {
  id: string;
  name: string;
  supportedModels: string[];
  encode(text: string, model?: string): number[];
  decode(tokens: number[], model?: string): string;
  countTokens(text: string, model?: string): number;
}
```

**Tokenizer Registry**:

```typescript
interface TokenizerRegistry {
  register(tokenizer: LocalTokenizer): void;
  getForModel(modelId: string): LocalTokenizer | null;
  listAvailable(): LocalTokenizer[];
  setPreference(modelId: string, tokenizerId: string): void;
}
```

### Enhanced Model Metadata

**Extended AIModel Interface**:

```typescript
interface AIModel {
  // ... existing fields ...
  tokenizer?: {
    id: string; // e.g., "cl100k_base", "o200k_base"
    type: string; // e.g., "bpe", "sentencepiece"
    source: "api" | "config" | "fallback";
    library?: string; // preferred library: "gpt-tokenizer" | "tiktoken"
  };
}
```

**Provider Configuration Extensions**:

```yaml
ai:
  providers:
    openai:
      # ... existing config ...
      tokenization:
        defaultLibrary: "gpt-tokenizer" # preferred library
        modelOverrides:
          "gpt-4o":
            tokenizer: "o200k_base"
            library: "gpt-tokenizer"
          "gpt-3.5-turbo":
            tokenizer: "cl100k_base"
            library: "tiktoken"
        fallbackTokenizer: "cl100k_base"
```

### Command Interface Design

**Enhanced Commands**:

```bash
# Basic context analysis with local tokenization
minsky context analyze --model gpt-4o

# Cross-model comparison
minsky context analyze --compare-models gpt-4o,claude-3-5-sonnet

# Tokenizer-specific analysis
minsky context analyze --tokenizer gpt-tokenizer --model gpt-4o

# Debug tokenization accuracy
minsky context analyze --validate-tokenization --model gpt-4o
```

## Relationship with Task 182

Task 082 focuses on **analysis** ("What's in my context and how much does it cost?") while Task 182 focuses on **selection** ("What rules should I load for this task?"). Together they provide comprehensive context understanding and optimization capabilities.

The enhanced tokenization features in Task 082 will also benefit Task 182 by enabling local token counting for rule selection optimization.
