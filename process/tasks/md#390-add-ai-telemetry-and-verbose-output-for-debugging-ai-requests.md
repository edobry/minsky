# Add AI telemetry and verbose output for debugging AI requests

## Context

Add a `--verbose` or `--telemetry` flag to AI-powered commands that displays detailed metadata about AI requests including token usage, timing, and reasoning traces.

## Context

Currently AI-powered commands like `minsky context suggest-rules` provide no visibility into:

- Number of AI requests made
- Token usage (input/output/total)
- Inference timing from AI providers
- Context size sent to AI
- Reasoning traces or internal processing
- Provider-specific metadata

This makes it difficult to debug AI behavior, optimize prompts, or understand costs.

## Requirements

### Core Functionality

1. **Verbose Flag**: Add `--verbose` or `--telemetry` flag to AI commands
2. **Metadata Collection**: Capture AI provider response metadata
3. **Detailed Output**: Display telemetry at end of command output
4. **Provider Agnostic**: Work across OpenAI, Anthropic, Google, etc.

### Telemetry Data to Capture

- **Request Count**: Number of AI API calls made
- **Token Usage**: Input tokens, output tokens, total tokens
- **Timing**: Total inference time, API latency
- **Context Size**: Characters/tokens sent in prompt
- **Model Info**: Provider, model name, parameters used
- **Reasoning Traces**: If available from provider
- **Error Info**: Failed requests, retry attempts

### Implementation Approach

1. **AICompletionService Enhancement**:
   - Return telemetry metadata alongside responses
   - Standardize metadata format across providers
2. **Command Integration**:
   - Add verbose flag to suggest-rules and other AI commands
   - Accumulate telemetry during execution
   - Display formatted summary at end
3. **Provider-Specific Collection**:
   - Extract metadata from Vercel AI SDK responses
   - Handle different metadata formats per provider

4. **Optional AI Resilience Integration** (reference: md#420)
   - When available, surface retry attempts, backoff timings, and error classifications from the AI Resilience module
   - Do not require adoption; if resilience is not in use, show basic error/attempt counts only
   - Include circuit-breaker state in verbose output when available (provider, state, failures, nextAttemptTime)

5. **Sanitized Request/Response Shape Logging**
   - Optionally print a summarized, sanitized request/response shape (provider, model, prompt/edit-pattern length, marker counts)
   - Do not log raw secrets or full prompts; respect configuration for redaction

### Output Format Example

```
🔍 Rule suggestions for: "how do i write tests"
[... normal output ...]

📊 AI Telemetry (--verbose):
   Requests: 1 total, 0 failed
   Tokens: 2,847 input + 342 output = 3,189 total
   Timing: 1,247ms inference, 156ms network
   Model: openai/gpt-4o (temp: 0.3)
   Context: 69 rules analyzed, 12.4KB prompt
   Cost: ~$0.024 estimated
```

### Benefits

- **Debugging**: Understand why AI suggestions are poor/good
- **Optimization**: Identify expensive prompts or slow providers
- **Monitoring**: Track token usage and costs
- **Transparency**: Show users what's happening under the hood

## Acceptance Criteria

- [ ] Verbose flag added to AI commands
- [ ] Telemetry collection from AI providers
- [ ] Formatted telemetry output
- [ ] Provider-agnostic metadata handling
- [ ] Documentation and examples

## Requirements

## Solution

## Notes
