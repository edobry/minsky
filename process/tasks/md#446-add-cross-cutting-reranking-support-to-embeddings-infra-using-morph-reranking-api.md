# Add cross-cutting reranking support to embeddings infra using Morph reranking API

## Context

## Summary
Introduce generic reranking support to the embeddings infrastructure using Morph's reranking API. This should be a cross-cutting facility that can be used by tasks similarity, rules suggestion, and future domains.

## Scope
- Add a reranking provider abstraction (e.g., `RerankingService` interface)
- Implement Morph reranking provider and config schema (API key, model, topK)
- Wire reranking as an optional post-processing step after vector search
- Provide shared utilities to format items for reranking
- Add flags/config to toggle reranking and set limits

## Phases
- Phase 1: Define interfaces and configuration; implement Morph provider
- Phase 2: Integrate reranking into tasks similarity flow behind a flag
- Phase 3: Integrate reranking into rules embedding search behind a flag

## Relationships
- Depends on: embeddings infra already in place (md#253 for tasks, new rules embeddings task)
- Complements: md#182 (rule suggestion), new rules embeddings task

## Acceptance Criteria
- Reusable `RerankingService` interface and Morph implementation
- Config-driven enablement and parameters
- Demonstrated integration in at least one flow (tasks similarity) behind a flag
- Documentation on enabling and tuning reranking

## Requirements

## Solution

## Notes
