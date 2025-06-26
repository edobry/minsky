# Add AI completion backend with multi-provider support

**Status:** IN-PROGRESS
**Priority:** HIGH
**Category:** FEATURE
**Tags:** ai, backend, architecture, providers, integration

## Overview

Implement a general AI backend that supports multiple model providers (OpenAI, Anthropic, OpenRouter, LiteLLM, Ollama, etc.) with reasoning, tool use, and prompt caching capabilities. This backend will serve as the foundation for AI-powered features across Minsky including rules processing, context management, tools, and future agent implementation.

## Progress Status

### ✅ Completed (Phase 1)

- [x] **Basic provider abstraction layer** with clean interfaces
- [x] **Configuration system integration** using existing Minsky patterns
- [x] **Vercel AI SDK integration** for provider abstraction
- [x] **Core service implementation** (`AICompletionService`, `AIConfigurationService`)
- [x] **Type-safe interfaces** with comprehensive TypeScript types
- [x] **Initial OpenAI, Anthropic, Google support** with basic models
- [x] **Tool calling capability** through AI SDK
- [x] **Streaming support** for real-time completions
- [x] **Error handling** with custom AI error types
- [x] **Usage tracking and cost calculation** basics
- [x] **Unit tests foundation** with mock providers
- [x] **CLI integration** with `minsky ai` command

### 🔄 In Progress (Phase 2)

- [ ] **Expand model support** to latest/best models from each provider
- [ ] **Add OpenRouter support** for unified API access to multiple models
- [ ] **Add LiteLLM support** for proxy-based multi-provider access
- [ ] **Add Ollama support** for local model execution
- [ ] **Add OpenAI-compatible providers** (Together, Perplexity, etc.)
- [ ] **Enhanced configuration management** with provider-specific options
- [ ] **Comprehensive integration tests** with real API calls

## Requirements

### Core Functionality

- Support for multiple AI model providers:
  - **Major Providers**: OpenAI, Anthropic, Google, Cohere, Mistral
  - **Aggregator Providers**: OpenRouter (unified API for 200+ models)
  - **Proxy Providers**: LiteLLM (proxy for 100+ providers)
  - **Local Providers**: Ollama (local model execution)
  - **OpenAI-Compatible**: Together, Perplexity, Groq, etc.
- Focus on **latest and most capable models**:
  - **OpenAI**: GPT-4o, GPT-4o-mini, o1-preview, o1-mini (reasoning)
  - **Anthropic**: Claude 3.5 Sonnet, Claude 3.5 Haiku (with caching)
  - **Google**: Gemini 1.5 Pro, Gemini 1.5 Flash
  - **Local**: Llama 3.3, Qwen 2.5, DeepSeek, etc. via Ollama
  - **Via OpenRouter**: Access to Grok, Command R+, and 200+ other models
- Support for advanced capabilities:
  - Reasoning capabilities (o1 series, Claude thinking, etc.)
  - Tool/function calling across providers
  - Prompt caching (Anthropic, some others)
  - Structured outputs and JSON mode
  - Multi-modal inputs (text, images, documents)
- Transparent provider swapping through abstraction layer
- Extensible architecture for adding new providers

### Enhanced Provider Support

#### OpenRouter Integration

- Unified API access to 200+ models from different providers
- Single API key for multiple model access
- Cost optimization through model selection
- Access to latest models often before direct provider APIs

#### LiteLLM Integration

- Proxy-based access to 100+ providers
- Consistent OpenAI-style interface
- Load balancing between providers
- Fallback mechanisms for provider failures

#### Ollama Integration

- Local model execution for privacy/cost
- Support for popular open models (Llama, Qwen, etc.)
- No API key required
- Offline capability

#### OpenAI-Compatible Providers

- Generic OpenAI-compatible interface
- Support for Together, Perplexity, Groq, etc.
- Custom base URLs and authentication

### Technical Implementation

- **✅ Completed**: Basic Vercel AI SDK integration with provider abstraction
- **🔄 In Progress**: Extend to support latest models and additional providers
- **Configuration Enhancement**: Support for provider-specific features and settings
- **Security**: Enhanced API token management with provider-specific auth
- **Error Handling**: Improved error handling with provider-specific error mapping
- **Performance**: Enhanced rate limiting, caching, and cost optimization
- **Observability**: Detailed logging and usage analytics

### Model Coverage Enhancement

Current model support is limited to older models. Need to expand to:

#### OpenAI

- **Current**: gpt-4o, o1-preview (limited)
- **Add**: gpt-4o-mini, o1-mini, latest model variants
- **Reasoning**: Full o1 series support with proper reasoning detection

#### Anthropic

- **Current**: claude-3-5-sonnet-20241022 (one variant)
- **Add**: claude-3-5-haiku, latest Sonnet variants
- **Features**: Full prompt caching utilization

#### Google

- **Current**: gemini-1.5-pro (basic)
- **Add**: gemini-1.5-flash, latest variants, proper vision support

#### New Providers

- **OpenRouter**: Access to Grok, Command R+, and 200+ models
- **LiteLLM**: Proxy access to providers not directly supported
- **Ollama**: Local models like Llama 3.3, Qwen 2.5, DeepSeek
- **OpenAI-Compatible**: Together, Perplexity, Groq, etc.

## Architecture Considerations

### ✅ Current Architecture

- Domain-oriented design in `src/domain/ai/`
- Provider abstraction through Vercel AI SDK
- Configuration integration with existing Minsky patterns
- Type-safe interfaces with comprehensive schemas

### 🔄 Architecture Enhancements

#### Provider Registry Pattern

```typescript
interface ProviderRegistry {
  registerProvider(provider: AIProvider): void;
  getProvider(name: string): AIProvider | null;
  listProviders(): string[];
  getCapabilities(provider: string): AICapability[];
}
```

#### Enhanced Configuration Schema

```typescript
interface AIConfig {
  defaultProvider: string;
  providers: {
    openai: OpenAIConfig;
    anthropic: AnthropicConfig;
    google: GoogleConfig;
    openrouter: OpenRouterConfig;
    litellm: LiteLLMConfig;
    ollama: OllamaConfig;
    custom: CustomProviderConfig[];
  };
  features: {
    promptCaching: boolean;
    toolCalling: boolean;
    streaming: boolean;
    multiModal: boolean;
  };
  rateLimiting: RateLimitConfig;
  costOptimization: CostConfig;
}

interface OpenRouterConfig {
  apiKey: string;
  baseURL?: string;
  preferredModels: string[];
  fallbackStrategy: "cheapest" | "fastest" | "best";
}

interface OllamaConfig {
  baseURL: string; // Default: http://localhost:11434
  models: string[]; // Available local models
  pullOnDemand: boolean;
}
```

## Research Tasks

### ✅ Completed Research

- **Vercel AI SDK**: Selected as primary abstraction layer
- **Initial provider patterns**: Established with OpenAI, Anthropic, Google

### 🔄 Additional Research Needed

#### OpenRouter Integration

- API patterns and authentication
- Model selection and pricing optimization
- Rate limiting and error handling specifics
- Integration with Vercel AI SDK

#### LiteLLM Integration

- Proxy deployment patterns
- Provider fallback mechanisms
- Configuration management
- Performance characteristics

#### Ollama Integration

- Local deployment and management
- Model pulling and updating
- Performance optimization
- Integration with cloud providers

## Acceptance Criteria

### ✅ Phase 1 Complete

- [x] Multi-provider AI backend implemented with clean abstraction layer
- [x] Configuration system integration for API tokens and provider selection
- [x] Support for OpenAI, Anthropic, and Google as initial providers
- [x] Basic tool calling/function execution capability implemented
- [x] Comprehensive error handling and logging integrated with Minsky patterns
- [x] Type-safe interfaces using Zod schemas throughout
- [x] Unit tests for core functionality implemented

### 🔄 Phase 2 In Progress

- [ ] **Latest model support** for all major providers (GPT-4o-mini, Claude 3.5 Haiku, etc.)
- [ ] **OpenRouter integration** with access to 200+ models
- [ ] **LiteLLM integration** for proxy-based multi-provider access
- [ ] **Ollama integration** for local model execution
- [ ] **OpenAI-compatible provider support** (Together, Perplexity, Groq)
- [ ] **Enhanced configuration management** with provider-specific features
- [ ] **Advanced capabilities** (prompt caching, structured outputs, multi-modal)
- [ ] **Cost optimization features** (model selection, usage tracking)
- [ ] **Comprehensive integration tests** with real provider APIs
- [ ] **Performance optimizations** (caching, rate limiting, batching)
- [ ] **Documentation for all providers** including setup guides

### 🎯 Phase 3 Future

- [ ] **Advanced reasoning support** with provider-specific optimizations
- [ ] **Multi-modal capabilities** (vision, audio, documents)
- [ ] **Agent framework integration** for complex multi-step tasks
- [ ] **Fine-tuning support** where available
- [ ] **Custom model support** and deployment patterns

## Implementation Notes

### ✅ Phase 1: Foundation (COMPLETE)

- Basic provider abstraction and configuration ✅
- OpenAI integration with modern models ✅
- Error handling and logging foundation ✅
- CLI integration with `minsky ai` command ✅

### 🔄 Phase 2: Enhanced Provider Support (IN PROGRESS)

- OpenRouter integration for unified model access
- LiteLLM proxy integration
- Ollama local model support
- OpenAI-compatible provider framework
- Latest model support across all providers
- Advanced configuration options

### 🎯 Phase 3: Advanced Features (PLANNED)

- Multi-modal inputs (images, documents)
- Advanced reasoning optimizations
- Cost optimization and model selection
- Performance enhancements (batching, caching)
- Integration with existing Minsky features

## Current Implementation Status

### Files Implemented

- `src/domain/ai/types.ts` - Comprehensive type definitions ✅
- `src/domain/ai/completion-service.ts` - Core completion service ✅
- `src/domain/ai/config-service.ts` - Configuration management ✅
- `src/domain/ai/index.ts` - Domain exports ✅
- `src/domain/ai/completion-service.test.ts` - Unit tests ✅
- `src/commands/ai/index.ts` - CLI command ✅
- `src/cli.ts` - CLI integration ✅

### Known Issues to Address

1. **Limited model coverage** - Need latest models from each provider
2. **Missing provider support** - OpenRouter, LiteLLM, Ollama not implemented
3. **Basic configuration** - Need provider-specific feature configuration
4. **Integration testing** - Need tests with real API calls
5. **Cost optimization** - Need intelligent model selection features

## Dependencies

- ✅ Vercel AI SDK for provider abstraction
- ✅ Existing Minsky configuration system
- ✅ Error handling patterns from `src/errors/`
- ✅ Zod for schema validation
- 🔄 Provider-specific SDKs as needed
- 🔄 OpenRouter API integration
- 🔄 LiteLLM proxy setup
- 🔄 Ollama local deployment

## Testing Strategy

### ✅ Implemented

- Unit tests for core services with mock providers
- Basic error handling scenarios
- Configuration validation tests

### 🔄 In Progress

- Integration tests with real provider APIs
- Provider-specific capability testing
- Cost calculation accuracy tests
- Performance and rate limiting tests

### 🎯 Planned

- End-to-end workflow testing
- Multi-provider fallback testing
- Local model performance testing
- Cost optimization validation

---

**Estimated Effort:** Large (4-6 weeks total, Phase 1 complete)
**Risk Level:** Medium (external API dependencies, multiple providers)
**Blocking:** None currently identified

**Next Steps:**

1. Expand model support to latest offerings from each provider
2. Implement OpenRouter integration for unified model access
3. Add LiteLLM support for proxy-based multi-provider access
4. Implement Ollama support for local model execution
5. Add OpenAI-compatible provider framework
6. Enhance configuration management for provider-specific features
