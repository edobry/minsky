# Pull Request for branch `task#002`

## Modified Files (Changes compared to merge-base with main)
- M     .cursor/rules/minsky-workflow.mdc
- M     src/domain/session.ts

## Changes
- Added `repoPath` field to `SessionRecord` interface to store session repository paths
- Updated `SessionDB` to store and manage repository paths for sessions
- Added migration logic to compute repo paths for existing sessions
- Updated `getSessionWorkdir` to use stored repo path if available
- Updated minsky-workflow rule to require immediate pushes after commits
  - Added warning at the top of the file
  - Added explicit instructions in Implementation Process section
  - Added example commands for pushing changes 
