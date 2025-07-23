# Add AI completion backend with multi-provider support

**Status:** TODO
**Priority:** HIGH
**Category:** FEATURE
**Tags:** ai, backend, architecture, providers, integration

## Overview

Implement a general AI backend that supports multiple model providers (OpenAI, Anthropic, Google, OpenRouter, Ollama, etc.) with reasoning, tool use, and prompt caching capabilities. This backend will serve as the foundation for AI-powered features across Minsky including rules processing, context management, tools, and future agent implementation.

## **CORRECTED Status Assessment**

**❌ Previous Status Claims Were Incorrect**

The task spec previously claimed "Phase 1 Complete" but investigation reveals:

**✅ Actually Implemented:**
- Configuration system with AI provider support
- TypeScript interfaces and schemas (`src/domain/ai/types.ts`, `src/domain/ai/config-service.ts`)
- Environment variable mappings for provider API keys
- Hard-coded capability maps for providers (needs dynamic replacement)

**❌ NOT Implemented (claimed as "complete"):**
- `src/domain/ai/completion-service.ts` - **DOES NOT EXIST**
- Vercel AI SDK integration - **NOT IMPLEMENTED**
- `minsky ai` CLI command - **NOT IMPLEMENTED**
- Provider implementations (OpenAI, Anthropic, Google) - **NOT IMPLEMENTED**
- Unit tests - **NOT IMPLEMENTED**
- Error handling integration - **NOT IMPLEMENTED**

**Real Status:** This is essentially an unstarted task with only configuration scaffolding.

## **AI SDK Choice Confirmed: Vercel AI SDK**

After comprehensive research of alternatives (LiteLLM, llm-exe, direct SDKs, Simon Willison's llm, Mozilla's any-llm), **Vercel AI SDK is confirmed as the best choice** for Minsky:

### **Why Not Other Options?**

**LiteLLM:**
- High latency overhead and production stability issues
- Bug-prone at scale, no enterprise support/SLAs
- Mainly API proxying, lacks advanced features

**llm-exe:**
- Application framework for building LLM apps, not a multi-provider SDK
- Over-engineered for Minsky's simple completion needs
- Would add unnecessary abstraction layers

**Simon Willison's llm:**
- Python-based CLI tool, not a TypeScript SDK
- Different scope (command-line usage vs programmatic integration)

**Direct Provider SDKs:**
- Would require maintaining multiple SDK integrations
- Inconsistent APIs and response formats across providers

### **Why Vercel AI SDK is Optimal for Minsky:**

✅ **CLI-Focused Performance**: Lower latency than proxy approaches
✅ **TypeScript Native**: Excellent typing for Minsky's codebase
✅ **Multi-Provider Support**: 20+ providers with unified interface
✅ **No Web Dependencies**: Despite name, works perfectly for CLI/Node.js use
✅ **Active Maintenance**: Well-maintained by Vercel team
✅ **Tool Calling**: Unified function calling across providers
✅ **Streaming Support**: Important for future interactive CLI features
✅ **Direct Provider Communication**: No proxy/gateway servers required

## **Corrected Implementation Scope**

This implementation is for **Minsky's CLI-based AI agent collaboration tool**, not a web application.

### **Key Features for CLI Environment:**
- AI-powered task analysis and code generation
- Context-aware repository understanding
- Agent-to-agent communication via pull requests
- Command-line tool calling and automation
- Rule processing and workflow optimization

### **Non-Requirements (Previously Incorrect):**
- ❌ Web UI components or React integration
- ❌ Edge runtime optimization
- ❌ Browser-based deployment
- ❌ Real-time web streaming interfaces

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

- ✅ **Vercel AI SDK**: Primary abstraction layer (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`)
- ✅ **Existing configuration system**: `src/domain/configuration/`
- ✅ **Error handling patterns**: `src/errors/`
- ✅ **CLI framework**: `src/cli.ts`
- ⏳ **Provider API keys**: For testing and development

## Acceptance Criteria

### **Phase 1: Core Implementation**

- [ ] **Multi-provider completion service** using Vercel AI SDK
- [ ] **Provider support** for OpenAI, Anthropic, and Google
- [ ] **CLI command** `minsky ai` with chat and completion subcommands
- [ ] **Configuration integration** with existing Minsky config system
- [ ] **Error handling** following Minsky error patterns
- [ ] **Unit tests** with comprehensive provider mocking
- [ ] **TypeScript types** for all AI operations

### **Definition of Done**

- [ ] All tests pass including edge cases and error scenarios
- [ ] Code follows Minsky patterns and conventions
- [ ] CLI help documentation is complete and accurate
- [ ] Provider switching works seamlessly without code changes
- [ ] Error messages are user-friendly and actionable
- [ ] Performance benchmarks establish acceptable response times
- [ ] Integration with existing configuration system is seamless

### **Task #323 Integration**

- [ ] **Optional enhancement**: If Task #323 (provider model fetching) is completed, integrate dynamic model discovery
- [ ] **Fallback**: Use static model lists if dynamic fetching unavailable

---

**Estimated Effort:** Medium (2-3 weeks for Phase 1)
**Risk Level:** Low (proven technology, well-defined scope)
**Blocking Dependencies:** None identified
**Optional Enhancement:** Task #323 (dynamic model fetching)

**Immediate Next Actions:**
1. Create development session for task #160
2. Install Vercel AI SDK and provider packages
3. Implement `AICompletionService` with OpenAI provider
4. Add basic CLI command structure
5. Write comprehensive unit tests
