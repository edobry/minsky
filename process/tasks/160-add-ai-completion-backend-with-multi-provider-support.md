# Add AI completion backend with multi-provider support

**Status:** TODO
**Priority:** HIGH
**Category:** FEATURE
**Tags:** ai, backend, architecture, providers, integration

## Overview

Implement a general AI backend that supports multiple model providers (OpenAI, Anthropic, OpenRouter, LiteLLM, Ollama, etc.) with reasoning, tool use, and prompt caching capabilities. This backend will serve as the foundation for AI-powered features across Minsky including rules processing, context management, tools, and future agent implementation.

## **CORRECTED Status Assessment**

**❌ Previous Status Claims Were Incorrect**

The task spec previously claimed "Phase 1 Complete" but investigation reveals:

**✅ Actually Implemented:**

- Configuration system with AI provider support
- TypeScript interfaces and schemas (`src/domain/ai/types.ts`, `src/domain/ai/config-service.ts`)
- Environment variable mappings for provider API keys

**❌ NOT Implemented (claimed as "complete"):**

- `src/domain/ai/completion-service.ts` - **DOES NOT EXIST**
- Vercel AI SDK integration - **NOT IMPLEMENTED**
- `minsky ai` CLI command - **NOT IMPLEMENTED**
- Provider implementations (OpenAI, Anthropic, Google) - **NOT IMPLEMENTED**
- Unit tests - **NOT IMPLEMENTED**
- Error handling integration - **NOT IMPLEMENTED**

**Real Status:** This is essentially an unstarted task with only configuration scaffolding.

## **AI SDK Choice Confirmed: Vercel AI SDK**

After researching alternatives (LiteLLM, direct SDKs, LangChain, AI Gateways), **Vercel AI SDK remains the best choice** for Minsky:

### **Why Not LiteLLM?**

- **High latency overhead**: Benchmarks show significant performance degradation
- **Production concerns**: Bug-prone at scale, no enterprise support/SLAs
- **Limited functionality**: Mainly API proxying, lacks advanced features
- **Deployment complexity**: Difficult to operationalize in enterprise environments

### **Why Vercel AI SDK?**

- **Performance**: Lower latency than LiteLLM proxy approaches
- **Developer Experience**: Excellent TypeScript support, React integration
- **Active Development**: Regular updates, good documentation
- **Multi-modal Ready**: Built-in support for text, images, structured outputs
- **Streaming Optimized**: Perfect for real-time UI interactions
- **Tool Calling**: Native support for function calling across providers

## Requirements

### **Phase 1: Core Foundation (ACTUAL FIRST PHASE)**

**Primary Goal:** Build the missing core implementation

1. **Install and Configure Vercel AI SDK**

   ```bash
   bun add ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
   ```

2. **Implement Core Service**

   - Create `src/domain/ai/completion-service.ts`
   - Integrate with existing configuration system
   - Basic provider abstraction (OpenAI, Anthropic, Google)

3. **CLI Command Implementation**

   - Create `src/commands/ai/index.ts`
   - Implement `minsky ai chat` and `minsky ai complete` commands
   - Model listing and provider switching

4. **Error Handling & Logging**

   - Integrate with Minsky's error system (`src/errors/`)
   - Provider-specific error mapping
   - Request/response logging

5. **Unit Tests**
   - Mock provider implementations
   - Configuration validation tests
   - Error handling scenarios

### **Phase 2: Enhanced Features (Future)**

- **Latest Model Support**: GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro
- **OpenRouter Integration**: Access to 200+ models via unified API
- **Local Model Support**: Ollama integration for privacy/cost
- **Advanced Features**: Structured outputs, prompt caching, multi-modal
- **Streaming Optimization**: Real-time response handling
- **Cost Tracking**: Token usage and spend monitoring

### **Phase 3: Production Features (Future)**

- **Caching Layer**: Response caching with TTL
- **Rate Limiting**: Provider-specific limits
- **Fallback Mechanisms**: Automatic provider switching on failure
- **Fine-tuning Support**: Custom model integration
- **Agent Framework**: Multi-step tool calling workflows

## Architecture

### **Confirmed Architecture Decisions**

```typescript
// Core service interface
interface AICompletionService {
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
  stream(request: AICompletionRequest): AsyncIterable<AICompletionResponse>;
  getAvailableModels(provider?: string): Promise<AIModel[]>;
  validateConfiguration(): Promise<ValidationResult>;
}

// Provider abstraction using Vercel AI SDK
interface ProviderAdapter {
  getModel(modelId: string): LanguageModel;
  listModels(): Promise<AIModel[]>;
  validateConfig(): Promise<boolean>;
}
```

### **Integration Points**

- **Configuration**: Extends existing `src/domain/configuration/` system
- **CLI**: Integrates with `src/cli.ts` command structure
- **Error Handling**: Uses `src/errors/` patterns
- **Logging**: Leverages `src/utils/logger`
- **Testing**: Follows `src/utils/test-utils/` patterns

## Implementation Plan

### **Immediate Next Steps**

1. **Create Session for Task #160**

   ```bash
   minsky session start --task 160 --description "Implement AI completion backend"
   ```

2. **Install Dependencies**

   ```bash
   bun add ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
   ```

3. **Implement Core Service**

   - Start with basic OpenAI provider
   - Add streaming support
   - Integrate with configuration system

4. **Add CLI Command**

   - Basic `minsky ai chat` functionality
   - Provider selection and model listing

5. **Write Tests**
   - Mock provider implementations
   - Basic completion scenarios

### **Success Criteria for Phase 1**

- [ ] **Working completion service** that can call OpenAI, Anthropic, Google
- [ ] **CLI command** `minsky ai chat` functional with provider switching
- [ ] **Configuration integration** using existing Minsky config patterns
- [ ] **Error handling** following Minsky error patterns
- [ ] **Unit tests** with >80% coverage for core functionality
- [ ] **Documentation** for basic usage and configuration

## Dependencies

- ✅ **Vercel AI SDK**: Primary abstraction layer
- ✅ **Existing configuration system**: `src/domain/configuration/`
- ✅ **Error handling patterns**: `src/errors/`
- ✅ **CLI framework**: `src/cli.ts` structure
- ⏳ **Provider API keys**: For testing and development

## Acceptance Criteria

### **Phase 1 (Actual Implementation)**

- [ ] Multi-provider AI backend with clean abstraction layer
- [ ] Configuration system integration for API tokens and provider selection
- [ ] Support for OpenAI, Anthropic, and Google as initial providers
- [ ] Basic CLI integration with `minsky ai` command
- [ ] Comprehensive error handling integrated with Minsky patterns
- [ ] Type-safe interfaces using Zod schemas throughout
- [ ] Unit tests for core functionality

### **Definition of Done**

- [ ] All tests pass
- [ ] Code follows Minsky patterns and conventions
- [ ] Documentation updated
- [ ] CLI help text is comprehensive
- [ ] Provider switching works without code changes
- [ ] Error messages are user-friendly
- [ ] Performance is acceptable (baseline measurements taken)

---

**Estimated Effort:** Medium (2-3 weeks for Phase 1)
**Risk Level:** Low (well-defined scope, proven technology)
**Blocking:** None identified

**Next Actions:**

1. Create session for task #160
2. Install Vercel AI SDK and provider packages
3. Implement basic `AICompletionService` with OpenAI provider
4. Add CLI command structure
5. Write unit tests for core functionality
