# Pull Request for branch `task#027`

## Commits
1d69d88 task#027: Implement auto-detection of session context in session commands
e8c1e7b task#027: Update task documentation and changelog
855e4f0 task#027: Add Standard Session Navigation Pattern section to minsky-workflow rule


## Modified Files (Changes compared to merge-base with main)
.cursor/rules/minsky-workflow.mdc
CHANGELOG.md
process/tasks/027-autodetect-session-in-commands.md
process/tasks/027/pr.md
src/commands/session/cd.test.ts
src/commands/session/cd.ts
src/commands/session/get.test.ts
src/commands/session/get.ts
src/domain/workspace.test.ts
src/domain/workspace.ts
test-session-detection.ts


## Stats
 .cursor/rules/minsky-workflow.mdc                  |  17 +++
 CHANGELOG.md                                       |   1 +
 .../tasks/027-autodetect-session-in-commands.md    |  57 +++++-----
 process/tasks/027/pr.md                            |  17 +++
 src/commands/session/cd.test.ts                    |  21 ++++
 src/commands/session/cd.ts                         |  21 +++-
 src/commands/session/get.test.ts                   |  40 +++++++
 src/commands/session/get.ts                        | 122 ++++++++++++++-------
 src/domain/workspace.test.ts                       |  34 +++++-
 src/domain/workspace.ts                            |  21 ++++
 test-session-detection.ts                          |  84 ++++++++++++++
 11 files changed, 367 insertions(+), 68 deletions(-)

