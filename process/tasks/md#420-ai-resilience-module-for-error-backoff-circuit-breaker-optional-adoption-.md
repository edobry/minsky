# AI Resilience module for error/backoff/circuit breaker (optional adoption)

## Context

Create a reusable, provider-agnostic AI resilience module that centralizes error parsing, retry/backoff strategies, and circuit breaker logic. Initial delivery is an optional value-add (no mandated adoption).\n\nScope:\n- Unify existing pieces (EnhancedAICompletionService, IntelligentRetryService, enhanced error types) behind a small composable interface (e.g., aiResilience.wrap(operation, context)).\n- Configurable policies per provider (rate limits, transient server errors, network errors).\n- Emit structured retry attempt logs (attempt, delay, classification) and expose circuit-breaker state hooks.\n- Provide migration guide and examples; do not change existing call sites by default.\n- Add thorough unit tests (simulated 429/5xx/network), and a small integration harness that can be mocked.\n- (Optional follow-up) CLI status endpoint for provider/circuit-breaker health.\n\nAcceptance Criteria:\n- A documented module with typed APIs and examples\n- Config-driven behavior with sane defaults\n- Unit tests verifying backoff and error classification\n- Integration tests validating graceful opt-in usage\n- No breaking changes or mandated adoption in this task

## Requirements

## Solution

## Notes
