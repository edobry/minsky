# Extract generic similarity search service with pluggable backends and fallback chain

## Context

## Summary

Extract a domain-agnostic similarity search service that supports pluggable backends (embeddings+vector, AI completion, keyword) and a configurable fallback chain. This reduces reimplementation across tasks, rules, and future domains.

## Scope

- Define `SimilaritySearchService` with a common request/response shape
- Backends: embeddings+vector (primary), AI completion (secondary), keyword (tertiary)
- Configurable fallback order and thresholds
- Minimal adapters to plug domains (tasks, rules) into the generic service: id mapping, content extraction
- Shared utilities for normalization, de-duplication, and scoring

## Phases

- Phase 1: Define shared interfaces and response schema; implement embeddings backend
- Phase 2: Implement keyword backend; add fallback chain
- Phase 3: Add optional AI backend behind config only (no default use for rules)

## Relationships

- Builds on: md#253 embeddings infra (tasks) and new rules embeddings task
- Enables: Reuse across domains without duplicating logic; consistent behavior

## Acceptance Criteria

- `SimilaritySearchService` with at least embeddings and keyword backends
- Config switches to set fallback chain per domain
- Demonstrated use from tasks similarity and rules suggestion with minimal glue
- Documentation and examples
- Ensure tasks and rules embeddings commands share the SAME CLI progress/output logic (start, per-item line, final summary), avoiding divergence

## Requirements

## Solution

## Notes
