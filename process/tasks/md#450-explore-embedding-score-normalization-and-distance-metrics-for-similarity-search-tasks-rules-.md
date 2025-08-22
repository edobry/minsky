# Explore embedding score normalization and distance metrics for similarity search (tasks & rules)

## Context

## Summary

Evaluate and standardize how we represent similarity in CLI output and JSON across tasks and rules. Compare raw ANN distances (L2) vs cosine similarity, define threshold semantics, and consider switching index/operator classes accordingly. Deliver a configuration-driven, consistent scoring model with clear UX.

## Motivation

- Current flows display raw ANN distances (L2, lower=closer) without normalization; rules now do the same.
- Users may prefer a [0,1] similarity. Cosine often maps naturally (similarity ≈ 1 − distance when using cosine distance).
- We need consistent thresholds and display across domains, without regressing performance.

## Scope

- Survey pgvector operator classes and metrics:
  - L2: `vector_l2_ops`
  - Cosine: `vector_cosine_ops`
  - (Optionally IP: `vector_ip_ops`)
- Define scoring model options:
  - Raw distance (metric-specific) with threshold
  - Normalized similarity [0,1] with optional mapping (for L2 and cosine)
- Add configuration knobs:
  - `embeddings.metric`: `l2` | `cosine` (default keep current)
  - `embeddings.display`: `raw` | `normalized`
  - Default threshold per metric, overridable via CLI flag
- CLI/JSON output:
  - Show raw distance and, when enabled, normalized similarity
  - `--details` flag to include operator class, metric, and top-k scores
- Indexing & migrations:
  - If switching to cosine, ensure HNSW indexes use `vector_cosine_ops`
  - Provide safe ALTER/REINDEX strategy or rebuild guidance
- Testing & performance:
  - Validate identical result ordering under equivalent metric
  - Measure indexing/search latency impact and ANN quality

## Phases

- Phase 1: Display & config (no backend change)
  - Add optional normalized score computation in adapter layer (no index changes)
  - Add config/flags and output formatting
- Phase 2: Metric selection & indexing
  - Support configuring operator class; create proper HNSW index when metric=cosine
  - Provide migration guidance/utilities
- Phase 3: Unification & docs
  - Ensure tasks and rules share the same scoring UX
  - Document thresholds, examples, and trade-offs

## Acceptance Criteria

- Config supports metric and display mode; defaults preserve current behavior
- CLI/JSON show raw distances; optional normalized scores behind flag/config
- Cosine metric indexing supported (HNSW + `vector_cosine_ops`) without regressions
- Tests cover scoring display and metric selection for both domains
- Documentation updated with examples and recommendations

## Requirements

## Solution

## Notes
