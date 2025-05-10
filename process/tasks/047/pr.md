# Pull Request for branch `task#047`

## Summary

This PR enhances the `minsky init` command to configure the Model Context Protocol (MCP) server during project initialization. This ensures that projects are immediately ready for AI agent integration, improving developer experience and streamlining workflow automation.

## Key Changes

- **Enhanced Init Command Options**: Added new MCP-related options to the `minsky init` command:
  - `--mcp <boolean>` to enable/disable MCP configuration (default: enabled)
  - `--mcp-transport <type>` to set transport type (stdio, sse, httpStream)
  - `--mcp-port <port>` to set port for network transports
  - `--mcp-host <host>` to set host for network transports

- **MCP Configuration Generation**: 
  - Created standardized MCP configuration file (`.cursor/mcp.json`) during initialization
  - Implemented support for different transport types with appropriate configuration options
  - Added interactive prompts for MCP configuration when options are not provided

- **MCP Usage Documentation**:
  - Created `mcp-usage.mdc` rule with comprehensive documentation on MCP usage
  - Added examples for connecting to and using MCP
  - Included security best practices for various transport types

- **Comprehensive Testing**:
  - Added tests for MCP configuration generation
  - Added tests for CLI options and interactive prompts
  - Tested various configuration scenarios (enabled/disabled, different transports)

## Technical Implementation

- Updated `InitializeProjectOptions` interface to include MCP configuration options
- Added MCP configuration template functions to generate appropriate JSON content
- Implemented validation for port numbers and transport types
- Used native JSON formatting to ensure consistent output
- Ensured the MCP rule is created in the appropriate location based on rule format

## Commits
7050f86c task#047: Configure MCP Server in Minsky Init Command

## Modified Files (Changes compared to merge-base with main)
- CHANGELOG.md
- process/tasks/047-configure-mcp-server-in-minsky-init-command.md
- src/commands/init/index.test.ts
- src/commands/init/index.ts
- src/domain/init.test.ts
- src/domain/init.ts

## Stats
```
CHANGELOG.md                                       |   7 +
...-configure-mcp-server-in-minsky-init-command.md |  84 +++++---
src/commands/init/index.test.ts                    | 237 +++++++++++++++++++++
src/commands/init/index.ts                         | 102 ++++++++-
src/domain/init.test.ts                            | 180 ++++++++++++++++
src/domain/init.ts                                 | 165 ++++++++++++++
6 files changed, 737 insertions(+), 38 deletions(-)
``` 
