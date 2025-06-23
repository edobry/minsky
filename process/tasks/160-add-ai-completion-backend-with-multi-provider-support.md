# Add AI completion backend with multi-provider support

**Status:** TO-DO
**Priority:** HIGH
**Category:** FEATURE
**Tags:** ai, backend, architecture, providers, integration

## Overview

Implement a general AI backend that supports multiple model providers (OpenAI, Anthropic, etc.) with reasoning, tool use, and prompt caching capabilities. This backend will serve as the foundation for AI-powered features across Minsky including rules processing, context management, tools, and future agent implementation.

## Requirements

### Core Functionality

- Support for multiple AI model providers (OpenAI, Anthropic, etc.)
- Focus on models that support:
  - Reasoning capabilities (e.g., OpenAI o1, Claude 3.5 Sonnet)
  - Tool/function calling
  - Prompt caching (where available, e.g., Anthropic Claude)
- Transparent provider swapping through abstraction layer
- Extensible architecture for adding new providers

### Technical Implementation

- **Research & Evaluation**: Investigate and evaluate AI interaction libraries that:
  - Abstract away low-level provider API details
  - Provide unified interface across providers
  - Support modern AI features (tool use, reasoning, caching)
  - Examples to consider: LangChain, LlamaIndex, Vercel AI SDK, OpenAI SDKs, Anthropic SDKs, etc.
- **Configuration Integration**: Integration with existing Minsky configuration system
- **Security**: Secure API token management through config
- **Error Handling**: Comprehensive error handling and fallback mechanisms
- **Performance**: Rate limiting and usage monitoring
- **Observability**: Logging and debugging capabilities

### Integration Points

- Configuration system for provider selection and API keys
- Error handling that integrates with Minsky's error handling patterns
- Logging that follows Minsky's logging conventions
- Type-safe interfaces and schemas using Zod
- Support for both synchronous and asynchronous operations

### Future Use Cases (not initial scope)

This backend will eventually power:

- Rules processing and validation
- Context analysis and summarization
- Tool recommendation and automation
- Full agent implementation with reasoning
- Interactive AI assistance within Minsky CLI
- Automated task management and optimization

### Initial Implementation Strategy

1. **Provider Abstraction**: Start with basic provider abstraction layer
2. **Initial Providers**: Implement OpenAI and Anthropic as initial providers
3. **Core Features**: Focus on text completion and basic tool calling
4. **Configuration**: Establish configuration patterns and API key management
5. **Foundation**: Create extensible foundation for future features
6. **Testing**: Comprehensive testing strategy with mock providers

## Architecture Considerations

### Domain-Oriented Design

- Place core AI domain logic in `src/domain/ai/`
- Create adapters for different providers in `src/adapters/ai/`
- Keep configuration in `src/domain/configuration/`
- Follow existing Minsky architectural patterns

### Interface Design

```typescript
interface AIBackend {
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
  completeWithTools(
    prompt: string,
    tools: Tool[],
    options?: ToolCompletionOptions
  ): Promise<ToolCompletionResult>;
  // Other methods...
}

interface AIProvider {
  name: string;
  capabilities: ProviderCapabilities;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  // Provider-specific methods...
}
```

### Configuration Schema

```typescript
interface AIConfig {
  defaultProvider: string;
  providers: {
    openai: {
      apiKey: string;
      model: string;
      endpoint?: string;
    };
    anthropic: {
      apiKey: string;
      model: string;
      endpoint?: string;
    };
  };
  rateLimiting: RateLimitConfig;
  caching: CacheConfig;
}
```

## Research Tasks

### AI Library Evaluation

Research and compare the following libraries:

1. **Vercel AI SDK**: Modern, TypeScript-first, provider-agnostic
2. **LangChain**: Comprehensive but complex, good for agents
3. **LlamaIndex**: Focus on retrieval and knowledge management
4. **Direct SDKs**: OpenAI SDK, Anthropic SDK for maximum control
5. **Other options**: Ollama support, local models, etc.

Evaluation criteria:

- TypeScript support and type safety
- Provider abstraction quality
- Tool/function calling support
- Prompt caching support
- Bundle size and performance
- Documentation and community
- Maintenance and updates

### Model Research

Identify specific models to target:

- **OpenAI**: GPT-4, GPT-4 Turbo, o1 series (reasoning)
- **Anthropic**: Claude 3.5 Sonnet, Claude 3.5 Haiku (with caching)
- **Future providers**: Google Gemini, local models, etc.

## Acceptance Criteria

- [ ] **Multi-provider AI backend implemented** with clean abstraction layer
- [ ] **Configuration system integration** for API tokens and provider selection
- [ ] **Support for at least OpenAI and Anthropic** as initial providers
- [ ] **Basic tool calling/function execution** capability implemented
- [ ] **Comprehensive error handling** and logging integrated with Minsky patterns
- [ ] **Type-safe interfaces** using Zod schemas throughout
- [ ] **Documentation for adding new providers** including examples
- [ ] **Unit tests for core functionality** with >90% coverage
- [ ] **Integration tests with actual provider APIs** (using test/mock credentials)
- [ ] **Performance considerations** including rate limiting and caching where applicable
- [ ] **Security review** of API key handling and storage

## Implementation Notes

### Phase 1: Foundation

- Basic provider abstraction and configuration
- OpenAI integration with simple text completion
- Error handling and logging foundation

### Phase 2: Enhanced Features

- Anthropic integration with prompt caching
- Tool calling support across providers
- Advanced configuration options

### Phase 3: Future Expansion

- Additional providers (Google, local models)
- Advanced features (streaming, embeddings)
- Integration with existing Minsky features

## Dependencies

- Existing Minsky configuration system
- Error handling patterns from `src/errors/`
- Logging utilities from `src/utils/logger`
- Zod for schema validation

## Testing Strategy

### Unit Tests

- Provider abstraction layer
- Configuration management
- Error handling scenarios
- Tool calling functionality

### Integration Tests

- Real provider API interactions (with test keys)
- Configuration loading and validation
- Error recovery and fallback scenarios

### Mock Strategy

- Mock providers for isolated testing
- Configurable responses for different scenarios
- Performance testing with controlled responses

---

**Estimated Effort:** Medium-Large (2-3 weeks)
**Risk Level:** Medium (external API dependencies)
**Blocking:** None currently identified
