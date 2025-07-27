# Create AI Provider Model Data Fetching System

## Context

Implement a system to automatically fetch current model information from AI provider APIs and store it in the configuration system.

## Background

Currently, the AI configuration service has hard-coded capability maps for providers like OpenAI, Anthropic, Google, etc. This means:

1. **Static Model Lists**: The `models: []` arrays in provider configs are empty by default
2. **Hard-coded Capabilities**: Provider capabilities are statically defined in code:

```typescript
const capabilityMap = {
  openai: [
    { name: "reasoning", supported: true, maxTokens: 128000 },
    { name: "tool-calling", supported: true },
    // ... hard-coded values
  ],
  // ...
}
```

3. **No Live Updates**: No mechanism to fetch current model availability, pricing, or capabilities from provider APIs

## Requirements

1. **Provider API Integration**
   - OpenAI Models API: `GET /v1/models`
   - Anthropic: Static model list (no public API)
   - Google Vertex AI: Models API
   - Add other providers as needed

2. **Data Storage**
   - Store fetched model data in structured format (JSON files)
   - Update configuration schemas to reference live data
   - Cache model data with TTL for performance

3. **CLI Commands**
   - `minsky ai models refresh` - Fetch latest model data
   - `minsky ai models list [provider]` - Show available models
   - `minsky ai providers list` - Show configured providers

4. **Model Information Storage**
   - Model IDs and names
   - Context windows and max output tokens
   - Pricing information (input/output costs)
   - Supported capabilities (tool calling, vision, etc.)
   - Model status (available, deprecated, etc.)

5. **Integration with Task #160**
   - Provide dynamic model lists to the AI completion service
   - Replace hard-coded capability maps with live data
   - Enable automatic model discovery

## Implementation Approach

1. **Create Provider Model Fetchers**
   ```typescript
   interface ModelFetcher {
     fetchModels(): Promise<ProviderModel[]>;
     getCapabilities(modelId: string): ModelCapabilities;
   }
   ```

2. **Storage Structure**
   ```
   ~/.config/minsky/
   ├── provider-models/
   │   ├── openai-models.json
   │   ├── anthropic-models.json
   │   └── google-models.json
   ```

3. **CLI Integration**
   - Add `minsky ai` command with model management subcommands
   - Integrate with existing configuration system

## Benefits for Task #160

- **Dynamic Model Support**: Automatically discover new models as providers release them
- **Accurate Capabilities**: Real-time capability information instead of hard-coded assumptions
- **Cost Optimization**: Access to current pricing for intelligent model selection
- **Better UX**: Users can see available models without guessing

## Acceptance Criteria

- [ ] Fetch and store model data from major providers
- [ ] CLI commands for model management
- [ ] Integration with configuration system
- [ ] Caching with configurable TTL
- [ ] Error handling for API failures
- [ ] Documentation for adding new providers

## Requirements

## Solution

## Notes
