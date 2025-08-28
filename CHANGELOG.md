## mt#238: Task Relationships MVP

- Added `task_relationships` table (uuid id, from_task_id, to_task_id), unique edge + indexes
- Implemented `TaskGraphService` with add/remove/list APIs and validation
- Exposed MCP tools: `tasks.relationships.add/remove/list`
- Added CLI wrappers: `tasks deps add|rm|list`
- Added unit tests; docs at docs/tasks-dependencies.md
