# Create AI Provider Model Data Fetching System

## Context

Implement a system to automatically fetch current model information from AI provider APIs and cache it locally for use by the AI completion service.

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
};
```

3. **No Live Updates**: No mechanism to fetch current model availability, pricing, or capabilities from provider APIs

**Important**: The model data should be treated as **cache** (dynamic, refreshable data) rather than **configuration** (user settings). Configuration contains provider credentials and preferences, while cache contains the actual available models and their capabilities.

## Requirements

1. **Provider API Integration**

   - OpenAI Models API: `GET /v1/models`
   - Anthropic: Static model list (no public API)
   - Google Vertex AI: Models API
   - Add other providers as needed

2. **Data Caching**

   - Store fetched model data in cache directory (separate from configuration)
   - Implement TTL-based cache invalidation and refresh
   - Cache model data independently from user configuration

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

2. **Cache Structure**

   ```
   ~/.cache/minsky/
   ├── models/
   │   ├── openai-models.json
   │   ├── anthropic-models.json
   │   ├── google-models.json
   │   └── .cache-metadata.json  # TTL and refresh timestamps
   ```

3. **CLI Integration**
   - Add `minsky ai` command with model management subcommands
   - Cache operates independently from user configuration
   - Configuration defines providers/credentials, cache stores available models

## Benefits for Task #160

- **Dynamic Model Support**: Automatically discover new models as providers release them
- **Accurate Capabilities**: Real-time capability information instead of hard-coded assumptions
- **Cost Optimization**: Access to current pricing for intelligent model selection
- **Better UX**: Users can see available models without guessing

## Acceptance Criteria

- [ ] Fetch and cache model data from major providers
- [ ] CLI commands for model cache management
- [ ] Clear separation between user configuration and model cache
- [ ] TTL-based cache invalidation and automatic refresh
- [ ] Error handling for API failures and stale cache scenarios
- [ ] Documentation for adding new providers and cache behavior

## Requirements

## Solution

## Notes
