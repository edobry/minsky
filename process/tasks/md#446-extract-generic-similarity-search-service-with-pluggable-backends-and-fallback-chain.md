# Add cross-cutting reranking support to embeddings infra using Morph reranking API

## Context

## Summary
Introduce a reranking layer (Morph reranking API) that operates across all embedding-based searches (tasks, rules, future domains). This is a cross-cutting enhancement applied after initial vector retrieval.

## Scope
- Integrate Morph reranking API as an optional second-stage reranker
- Pluggable into existing embeddings flows without changing storage
- Config flags to enable/disable reranking per command/domain
- Preserve existing scores; attach reranked order and reranker scores

## Phases
- Phase 1: Implement reranker client and wire into tasks similarity search
- Phase 2: Wire into rules embeddings search (`context suggest-rules`)
- Phase 3: Expose CLI flags (`--rerank`, `--rerank-top-k`) and document behavior

## Relationships
- Builds on embeddings infra from md#253 and rules embeddings from md#445
- Complements md#447 (generic similarity service) but is independently useful

## Acceptance Criteria
- Reranking can be toggled on/off; defaults OFF
- Works for both tasks and rules commands
- Clear CLI output indicating when reranking is applied
- Tests and docs included

## Requirements

## Solution

## Notes
