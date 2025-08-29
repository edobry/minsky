### Task Dependencies (MVP)

- Storage: `task_relationships` (uuid id, from_task_id, to_task_id)
- Relationship: single type (depends) — A depends on B
- IDs: qualified IDs (e.g., `md#123`, `db#200`) to support multi-backend
- No timestamps in MVP; can be added later if needed

#### CLI

- `minsky tasks deps add <task> <depends-on>`
- `minsky tasks deps rm <task> <depends-on>`
- `minsky tasks deps list <task>`

#### MCP Tools

- `tasks.relationships.add { fromTaskId, toTaskId }`
- `tasks.relationships.remove { fromTaskId, toTaskId }`
- `tasks.relationships.list { taskId, direction: "deps" | "dependents" }`

#### Notes

- Self-edges are rejected; duplicates are idempotent
- Future: add `type` column/enum for richer relationships
