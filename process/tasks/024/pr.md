# fix(#024): Fix session dir command logic and add task ID support

## Summary

This PR implements task #024, fixing the `session dir` command logic to correctly handle both legacy and new session repository paths. It also adds the `--task` option to allow users to find session directories by their associated task ID.

## Motivation & Context

The `session dir` command was incorrectly handling session repository paths, especially with the new per-repo directory structure introduced in task #002. Additionally, users needed a way to lookup session directories by task ID, similar to functionality provided by the `session get` command.

## Design/Approach

The implementation leverages the existing `SessionDB.getRepoPath` method to handle path resolution, removing the local implementation that had incorrect logic. This ensures consistent path handling across the application. The `--task` option logic is implemented similarly to other commands that support this option.

## Key Changes

- Removed the local `getSessionRepoPath` function in favor of using `SessionDB.getRepoPath`
- Added `--task <taskId>` option to support retrieving session directories by task ID
- Improved error handling for various scenarios (non-existent sessions, non-existent tasks, conflicting options)
- Added comprehensive tests for all functionality, including:
  - Legacy path structure support
  - New sessions subdirectory structure
  - Task ID lookup
  - Error scenarios
- Standardized code style by using double quotes consistently

## Code Examples

Before:

<pre><code class="language-typescript">
// Previous local implementation with incorrect path logic
const workdir = getSessionRepoPath(session);

function getSessionRepoPath(session: SessionRecord): string {
  return join(getGitDir(), session.repoName, session.session);
}
</code></pre>

After:

<pre><code class="language-typescript">
// Using SessionDB's built-in method for correct path resolution
const workdir = await db.getRepoPath(session);
</code></pre>

## Breaking Changes

None. All changes maintain backward compatibility with existing command usage patterns.

## Testing

- Added tests for the legacy path structure to verify backward compatibility
- Added tests for the new sessions subdirectory structure
- Added tests for task ID lookup functionality
- Added tests for various error scenarios:
  - Non-existent sessions
  - Non-existent task IDs
  - Both session and task ID provided
  - Neither session nor task ID provided
- All tests pass successfully

## Verification

All requirements from the task specification have been met:

- The command correctly identifies and returns session directories in both legacy and new formats
- The command handles non-existent sessions with clear error messages
- The command supports finding sessions by task ID using the `--task` option
- Task IDs are properly normalized (both `000` and `#000` formats work)
- Backward compatibility is maintained with existing usage patterns
