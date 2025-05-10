# Pull Request for branch `task#047`

## Summary

This PR enhances the `minsky init` command to configure the Model Context Protocol (MCP) server during project initialization. This ensures that projects are immediately ready for AI agent integration, improving developer experience and streamlining workflow automation. The PR also adds support for configuring MCP in existing projects without reinitializing them.

## Key Changes

- **Enhanced Init Command Options**: Added new MCP-related options to the `minsky init` command:
  - `--mcp <boolean>` to enable/disable MCP configuration (default: enabled)
  - `--mcp-transport <type>` to set transport type (stdio, sse, httpStream)
  - `--mcp-port <port>` to set port for network transports
  - `--mcp-host <host>` to set host for network transports
  - `--mcp-only` to add MCP configuration to existing projects without recreating other files
  - `--overwrite` to update existing configuration files

- **MCP Configuration Generation**: 
  - Created standardized MCP configuration file (`.cursor/mcp.json`) during initialization
  - Implemented support for different transport types with appropriate configuration options
  - Added interactive prompts for MCP configuration when options are not provided
  - Added support for adding MCP to existing projects without affecting other project files

- **MCP Usage Documentation**:
  - Created `mcp-usage.mdc` rule with comprehensive documentation on MCP usage
  - Added examples for connecting to and using MCP
  - Included security best practices for various transport types

- **Comprehensive Testing**:
  - Added tests for MCP configuration generation
  - Added tests for CLI options and interactive prompts
  - Tested various configuration scenarios (enabled/disabled, different transports)
  - Added tests for MCP-only mode and overwrite functionality

## Technical Implementation

- Updated `InitializeProjectOptions` interface to include MCP configuration options
- Added MCP configuration template functions to generate appropriate JSON content
- Implemented validation for port numbers and transport types
- Used native JSON formatting to ensure consistent output
- Ensured the MCP rule is created in the appropriate location based on rule format
- Added `mcpOnly` and `overwrite` options to control file creation behavior
- Modified the `createFileIfNotExists` function to optionally overwrite existing files
- Added specialized interactive prompts for MCP-only mode

## Commits
7050f86c task#047: Configure MCP Server in Minsky Init Command
(additional commit for MCP-only and overwrite functionality)

## Modified Files (Changes compared to merge-base with main)
- CHANGELOG.md
- process/tasks/047-configure-mcp-server-in-minsky-init-command.md
- src/commands/init/index.test.ts
- src/commands/init/index.ts
- src/domain/init.test.ts
- src/domain/init.ts
- process/tasks/047/pr.md

## Stats
```
CHANGELOG.md                                       |   9 +
...-configure-mcp-server-in-minsky-init-command.md |  110 ++++++---
process/tasks/047/pr.md                            |   21 +-
src/commands/init/index.test.ts                    |  297 +++++++++++++++++++++
src/commands/init/index.ts                         |  122 +++++++++-
src/domain/init.test.ts                            |  270 ++++++++++++++++++
src/domain/init.ts                                 |  190 +++++++++++++
7 files changed, 969 insertions(+), 50 deletions(-)
``` 
