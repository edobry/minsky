# Pull Request for branch `097`

## Commits
59c8dae5 docs(#097): Update CHANGELOG.md with task details
d264e807 test(#097): Add tests for option descriptions consistency
2cd2bff2 refactor(#097): Update MCP rules adapter to use centralized descriptions
3ae2f6e4 refactor(#097): Update MCP git adapter to use centralized descriptions
e47072ac refactor(#097): Update MCP session adapter to use centralized descriptions
82ae0943 refactor(#097): Update MCP tasks adapter to use centralized descriptions
0554e91c refactor(#097): Update shared CLI options to use centralized descriptions
1f59ed39 feat(#097): Add centralized option descriptions module


## Modified Files (Showing changes from merge-base with main)
CHANGELOG.md
src/adapters/cli/utils/shared-options.ts
src/adapters/mcp/git.ts
src/adapters/mcp/rules.ts
src/adapters/mcp/session.ts
src/adapters/mcp/tasks.ts
src/utils/__tests__/option-descriptions.test.ts
src/utils/option-descriptions.ts


## Stats
CHANGELOG.md                                    |  11 ++
 src/adapters/cli/utils/shared-options.ts        |  26 ++--
 src/adapters/mcp/git.ts                         |  42 ++++--
 src/adapters/mcp/rules.ts                       |  50 ++++---
 src/adapters/mcp/session.ts                     |  31 +++--
 src/adapters/mcp/tasks.ts                       |  27 ++--
 src/utils/__tests__/option-descriptions.test.ts |  42 ++++++
 src/utils/option-descriptions.ts                | 174 ++++++++++++++++++++++++
 8 files changed, 342 insertions(+), 61 deletions(-)
## Uncommitted changes in working directory
M	process/tasks.md
M	process/tasks/097/pr.md


