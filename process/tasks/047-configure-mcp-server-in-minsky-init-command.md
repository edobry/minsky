# Configure MCP Server in Minsky Init Command

## Context

Minsky has added MCP (Model Context Protocol) support in task #034, allowing AI agents to interact with Minsky commands programmatically. However, the `minsky init` command currently doesn't configure the MCP server as part of project setup. Adding MCP server configuration to the init process would ensure projects are immediately ready for AI agent integration, improving developer experience and streamlining workflow automation.

## Requirements

1. **Enhance Init Command Options**

   - Add a new option to the `minsky init` command to configure MCP server settings
   - Allow users to enable/disable MCP server setup during initialization (default: enabled)
   - Support configuration of MCP transport type (stdio, SSE, HTTP streaming)
   - Allow setting of default port and host for network transports
   - Support adding MCP configuration to existing projects without reinitializing

2. **MCP Configuration Generation**

   - Create a standardized MCP configuration file during initialization
   - Include transport settings, authentication options, and tool permissions
   - Support both development and production configuration templates
   - Allow overwriting existing configuration files when needed

3. **Documentation and Examples**

   - Update `minsky init` help text to explain MCP configuration options
   - Add examples showing how to initialize with different MCP settings
   - Include guidance on securing MCP for production use

4. **MCP Rule Integration**
   - Create a new rule (`mcp-usage.mdc`) explaining MCP best practices
   - Update existing rules to reference MCP capabilities where relevant
   - Ensure rule content is consistent across both cursor and generic formats

## Implementation Steps

1. [x] Update the command interface in `src/commands/init/index.ts`:

   - [x] Add `--mcp <boolean>` flag to enable/disable MCP configuration
   - [x] Add `--mcp-transport <type>` option (stdio, sse, http-stream)
   - [x] Add `--mcp-port <port>` and `--mcp-host <host>` options
   - [x] Add `--mcp-only` option to configure MCP in existing projects
   - [x] Add `--overwrite` option to update existing config files
   - [x] Update help text to document new options

2. [x] Enhance domain logic in `src/domain/init.ts`:

   - [x] Add MCP configuration generation function
   - [x] Create template for MCP config file
   - [x] Add logic to write config file to appropriate location
   - [x] Update `initializeProject` to handle MCP configuration
   - [x] Add support for MCP-only initialization mode
   - [x] Add option to overwrite existing files

3. [x] Create MCP usage rule template:

   - [x] Draft content for `mcp-usage.mdc`
   - [x] Include examples of connecting to and using MCP
   - [x] Add security best practices

4. [x] Update interactive prompts in the init command:

   - [x] Add MCP configuration options to interactive mode
   - [x] Provide sensible defaults and clear descriptions
   - [x] Handle validation for port numbers and transport types
   - [x] Adjust prompts for MCP-only mode

5. [x] Add tests:

   - [x] Test MCP configuration generation
   - [x] Test CLI options and interactive prompts
   - [x] Test with both enabled and disabled MCP
   - [x] Test config file placement and content
   - [x] Test MCP-only mode functionality
   - [x] Test overwrite option functionality

6. [x] Update documentation:
   - [x] Update README.md with MCP init information
   - [x] Update CHANGELOG.md
   - [x] Update README-MCP.md with init information

## Work Log

- 2024-05-19: Created implementation plan for MCP configuration in init command
- 2024-05-19: Updated InitializeProjectOptions interface in src/domain/init.ts to include MCP options
- 2024-05-19: Implemented MCP configuration generation function and template
- 2024-05-19: Added support for different transport types (stdio, SSE, HTTP streaming)
- 2024-05-19: Created MCP usage rule template with examples and security best practices
- 2024-05-19: Added MCP configuration options to the init command
- 2024-05-19: Implemented interactive prompts for MCP configuration settings
- 2024-05-19: Added validation for port numbers and transport types
- 2024-05-19: Added domain-level tests for MCP configuration generation
- 2024-05-19: Added tests for CLI options and interactive prompts
- 2024-05-19: Updated CHANGELOG.md with MCP configuration features
- 2024-05-20: Added MCP-only mode to add MCP configuration to existing projects
- 2024-05-20: Added overwrite option to update existing configuration files
- 2024-05-20: Added tests for MCP-only mode and overwrite functionality
- 2024-05-20: Updated documentation with new MCP configuration options

## Verification

The implementation will be considered complete when:

- [x] Running `minsky init` with default options creates MCP configuration
- [x] Running `minsky init --mcp false` skips MCP configuration
- [x] The MCP configuration file is written to the correct location
- [x] The configuration file contains valid settings matching provided options
- [x] The `mcp-usage.mdc` rule is generated when appropriate
- [x] All interactive prompts work correctly and validate input
- [x] The `--mcp-only` option correctly adds MCP to existing projects without affecting other files
- [x] The `--overwrite` option allows updating existing configuration files
- [x] All tests pass, including new tests for MCP configuration
- [x] Documentation is updated to reflect the changes

## Related Tasks

- Related to task #034 (Add MCP Support to Minsky)
- Related to task #033 (Enhance Init Command with Additional Rules)
