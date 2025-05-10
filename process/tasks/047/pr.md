# feat(#047): Configure MCP Server in Minsky Init Command

## Summary
This PR enhances the `minsky init` command to configure the Model Context Protocol (MCP) server during project initialization and adds support for configuring MCP in existing projects. These changes ensure projects are immediately ready for AI agent integration, improving developer experience and streamlining workflow automation.

## Motivation & Context
Previously, Minsky projects had to be manually configured to work with the MCP server, requiring users to create the appropriate configuration files by hand. This process was error-prone and created friction for users wanting to integrate AI assistants with their Minsky workflow. Task #047 addresses this by automating MCP configuration as part of the project initialization process and providing options to add MCP to existing projects.

## Design/Approach
We implemented MCP configuration as an integrated part of the `minsky init` command, with options to:
1. Configure MCP during normal project initialization (default behavior)
2. Configure only MCP in existing projects (via new `--mcp-only` flag)
3. Update existing configurations (via new `--overwrite` flag)

For transport configuration, we support three options:
- stdio transport (default, most secure, local machine only)
- SSE transport (for network access)
- HTTP Stream transport (for network access)

Network transports include additional configuration options for port and host settings.

## Key Changes

### CLI Enhancements
- Added new MCP-related options to the `minsky init` command:
  - `--mcp <boolean>` to enable/disable MCP configuration (default: enabled)
  - `--mcp-transport <type>` to set transport type (stdio, sse, httpStream)
  - `--mcp-port <port>` to set port for network transports
  - `--mcp-host <host>` to set host for network transports
  - `--mcp-only` to add MCP configuration to existing projects without recreating other files
  - `--overwrite` to update existing configuration files

### Configuration Generation
- Created standardized MCP configuration file (`.cursor/mcp.json`) during initialization
- Implemented support for different transport types with appropriate configuration options
- Added interactive prompts for MCP configuration when options are not provided
- Added support for adding MCP to existing projects without affecting other project files

### Documentation
- Created `mcp-usage.mdc` rule with comprehensive documentation on MCP usage
- Added examples for connecting to and using MCP
- Included security best practices for various transport types

## Technical Implementation
- Updated `InitializeProjectOptions` interface to include MCP configuration options
- Added MCP configuration template functions to generate appropriate JSON content
- Implemented validation for port numbers and transport types
- Used native JSON formatting to ensure consistent output
- Ensured the MCP rule is created in the appropriate location based on rule format
- Added `mcpOnly` and `overwrite` options to control file creation behavior
- Modified the `createFileIfNotExists` function to optionally overwrite existing files
- Added specialized interactive prompts for MCP-only mode

## Testing
- Created comprehensive test coverage for all new functionality:
  - Tests for MCP configuration generation with all transport types
  - Tests for CLI options and interactive prompts
  - Tests for MCP-only mode functionality
  - Tests for overwrite option functionality
- All tests pass successfully in the test suite

## Commits
- 7050f86c task#047: Configure MCP Server in Minsky Init Command
- c1c9067a task#047: Add support for configuring MCP in existing projects

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
