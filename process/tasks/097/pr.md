# Pull Request for branch `097`

## Commits
5e37d6c4 test: add tests for option descriptions and param schemas modules
f7a13771 fix: recreate option-descriptions.ts and fix MCP rules adapter types
43a208ca docs(#097): Update PR description with recent changes
733c0b7a docs(#097): Update CHANGELOG with parameter schemas details
05583ae3 refactor(#097): Add parameter schemas utility for further reducing duplication in zod schemas
d0a274f1 docs(#097): Add PR description
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
process/tasks/097/pr.md
src/adapters/cli/utils/shared-options.ts
src/adapters/mcp/git.ts
src/adapters/mcp/rules.ts
src/adapters/mcp/session.ts
src/adapters/mcp/tasks.ts
src/utils/__tests__/option-descriptions.test.ts
src/utils/__tests__/param-schemas.test.ts
src/utils/option-descriptions.ts
src/utils/param-schemas.ts


## Stats
CHANGELOG.md                                    |  14 ++
 process/tasks/097/pr.md                         |  87 +++++-----
 src/adapters/cli/utils/shared-options.ts        |  26 ++-
 src/adapters/mcp/git.ts                         |  42 +++--
 src/adapters/mcp/rules.ts                       | 222 ++++++++++++++++--------
 src/adapters/mcp/session.ts                     |  31 ++--
 src/adapters/mcp/tasks.ts                       |  27 ++-
 src/utils/__tests__/option-descriptions.test.ts |  98 +++++++++++
 src/utils/__tests__/param-schemas.test.ts       |  85 +++++++++
 src/utils/option-descriptions.ts                | 170 ++++++++++++++++++
 src/utils/param-schemas.ts                      | 170 ++++++++++++++++++
 11 files changed, 813 insertions(+), 159 deletions(-)
## Uncommitted changes in working directory
M	bun.lock
M	package.json
M	process/tasks.md
M	process/tasks/097/pr.md


