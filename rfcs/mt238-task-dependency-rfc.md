### RFC: Task Dependencies and Subtask Relationships (mt#238)

Status: Draft

Context: Based on mt#439 (DB backend), mt#443 (multi-backend TaskService), and goals in mt#258, mt#284, mt#327, mt#442.

1. Goals

- Represent parent-child and general dependencies
- Support multiple backends via qualified IDs (md#/gh#/db#/minsky#)
- Enable routing/planning (mt#442) on a graph model
- Remain backward compatible; optional fields; safe migrations

2. Options Considered

A. Add columns to tasks

- parent_task_id (text, nullable)
- dependencies (text[] or jsonb array of task IDs)
- dependency_type (enum) – problematic if per-edge varies

Pros: simple, fewer joins
Cons: poor normalization; hard to represent multiple dependency types per edge; awkward for cross-backend links; prone to update races; limited extension (weights, notes)

B. Separate task_relationships table (recommended)

- id (uuid)
- from_task_id (text) – qualified ID (e.g., md#123)
- to_task_id (text) – qualified ID
- relationship_type (enum): parent, blocks, blocked-by, relates-to, duplicates, supersedes, depends-on, optional, enhances
- metadata (jsonb): weight, rationale, created_by, created_via (AI/human), order, notes
- created_at/updated_at
- unique constraint to prevent duplicate edges

Pros: normalized; supports multiple relationship types; captures cross-backend edges via qualified IDs; extensible metadata; enables graph queries and routing; future-proof for mt#442
Cons: extra joins; migration overhead; need integrity checks to prevent cycles for parent

C. Minimal parent pointer + relationship table later

- Add tasks.parent_task_id for immediate subtasks UX; later add relationships for general deps
  Pros: quick UX; cheap to query hierarchy
  Cons: dual sources of truth; later consolidation needed

3. Recommended Design

- Implement option B now; do not add columns to tasks
- Use qualified IDs in edges to remain backend-agnostic per mt#443
- Enforce parent-child via relationship_type
