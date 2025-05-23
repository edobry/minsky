# Pull Request for branch `task#124`

## Commits

8e8bc150 task(#124): Implement repository path parameter for MCP server
1d7bd975 task(#124): Refine implementation plan to use ProjectContext concept
fbc2be87 task(#124): Update task specification with implementation plan

## Modified Files (Showing changes from merge-base with main)

CHANGELOG.md
README-MCP.md
process/tasks/124-add-repository-path-parameter-to-mcp-server.md
src/adapters/mcp/tasks.ts
src/commands/mcp/index.ts
src/mcp/command-mapper.test.ts
src/mcp/command-mapper.ts
src/mcp/server.test.ts
src/mcp/server.ts
src/types/project.test.ts
src/types/project.ts

## Stats

CHANGELOG.md | 11 ++
README-MCP.md | 50 +++++++
...-add-repository-path-parameter-to-mcp-server.md | 142 ++++++++++++++++---
src/adapters/mcp/tasks.ts | 41 ++++++
src/commands/mcp/index.ts | 41 +++++-
src/mcp/command-mapper.test.ts | 150 +++++++++++++++++++++
src/mcp/command-mapper.ts | 88 +++++++++++-
src/mcp/server.test.ts | 121 +++++++++++++++++
src/mcp/server.ts | 38 +++++-
src/types/project.test.ts | 130 ++++++++++++++++++
src/types/project.ts | 70 ++++++++++
11 files changed, 857 insertions(+), 25 deletions(-)

## Uncommitted changes in working directory

process/tasks/124/pr.md

Task #124 status updated: TODO → IN-REVIEW
