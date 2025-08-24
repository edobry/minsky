# Extract generic similarity search service with pluggable backends and fallback chain

## Context

## Summary

Extract a domain-agnostic similarity search service that supports pluggable backends (embeddings+vector, AI completion, lexical) and a fixed fallback chain used only on backend unavailability. This reduces reimplementation across tasks, rules, and future domains. Additionally, consolidate redundant rule search commands by deprecating `context suggest-rules` in favor of a unified `rules search` interface.

## Scope

- Define `SimilaritySearchService` with a common request/response shape
- Backends: embeddings+vector (primary), AI completion (secondary), lexical (tertiary)
- Fixed fallback order: embeddings → ai → lexical. Fallback activates only if a higher-priority backend is unavailable (misconfig/outage/explicitly disabled), not based on score or recall.
- Minimal domain resolvers to plug domains (tasks, rules) into the generic service: id mapping, candidate listing, content extraction
- Shared utilities for normalization and de-duplication within a backend result set (no cross-backend mixing)
- Consolidate redundant rule search commands: deprecate `context suggest-rules` in favor of enhanced `rules search`

## Phases

- Phase 1: Define shared interfaces and response schema; implement embeddings backend; introduce lexical backend (simple token-based).
- Phase 2: Implement AI backend as a thin adapter over existing AI completion infra (config-gated availability). Keep the fixed fallback chain.
- Phase 3: Wire additional domains as needed.

## Relationships

- Builds on: md#253 embeddings infra (tasks) and new rules embeddings task
- Enables: Reuse across domains without duplicating logic; consistent behavior

## Acceptance Criteria

- `SimilaritySearchService` with at least embeddings and lexical backends; AI backend scaffolded but optional.
- Fixed fallback order (embeddings → ai → lexical) with fallback based solely on unavailability of higher-priority backends.
- Demonstrated use from tasks similarity and rules suggestion with minimal glue (domain resolvers).
- Documentation and examples; CLI progress/output remains identical across domains.
- `context suggest-rules` command is deprecated/removed; `rules search` is enhanced with limit/threshold options and serves as the single rule search interface.

## Requirements

- Do not change public entry points: keep `TaskSimilarityService`/`RuleSimilarityService` as stable APIs; integrate the new core underneath.
- No cross-backend result mixing; return results from the first available backend only.
- No threshold configuration initially; return top-k sorted by backend's native score. Allow tiny internal floors to drop invalid/NaN scores.
- Provide naming updates: use `LexicalSimilarityBackend` (not "keyword").
- Prepare for future reranking (md#446) by leaving a no-op post-processor hook in the core, but add no config or code for reranking yet.
- **Command Consolidation**: Deprecate `context suggest-rules` command since it's redundant with `rules search` after both use the same similarity search service. Enhance `rules search` with useful options from suggest-rules (`--limit`, `--threshold`) while maintaining backward compatibility.

## Solution

- Core: `SimilaritySearchService` orchestrates a list of `SimilarityBackend`s in fixed priority order (embeddings → ai → lexical). It calls the first backend that reports availability and returns its top-k results. If a backend throws during `search`, it is treated as unavailable and the chain proceeds.
- Backends:
  - `EmbeddingsSimilarityBackend`: wraps `EmbeddingService` + `VectorStorage` from existing infra.
  - `AISimilarityBackend`: thin adapter over existing AI completion infra; initially reports unavailable unless explicitly enabled in future work.
  - `LexicalSimilarityBackend`: simple token-based similarity over normalized content via domain resolvers.
- Domain resolvers:
  - `TaskSimilarityResolvers` and `RuleSimilarityResolvers` provide `getById`, `listCandidateIds`, and `getContent` to the core.
- Public services:
  - Re-implement `TaskSimilarityService`/`RuleSimilarityService` to construct resolvers and backends, then delegate to the core service.

## Notes

- Future: md#446 (Morph reranking) can plug into the core's post-processor hook without API changes.
