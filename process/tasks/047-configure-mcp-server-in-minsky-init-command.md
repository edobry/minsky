# Task #047: Configure MCP Server in Minsky Init Command

## Context

Minsky has added MCP (Model Context Protocol) support in task #034, allowing AI agents to interact with Minsky commands programmatically. However, the `minsky init` command currently doesn't configure the MCP server as part of project setup. Adding MCP server configuration to the init process would ensure projects are immediately ready for AI agent integration, improving developer experience and streamlining workflow automation.

## Requirements

1. **Enhance Init Command Options**

   - Add a new option to the `minsky init` command to configure MCP server settings
   - Allow users to enable/disable MCP server setup during initialization (default: enabled)
   - Support configuration of MCP transport type (stdio, SSE, HTTP streaming)
   - Allow setting of default port and host for network transports

2. **MCP Configuration Generation**

   - Create a standardized MCP configuration file during initialization
   - Include transport settings, authentication options, and tool permissions
   - Support both development and production configuration templates

3. **Documentation and Examples**

   - Update `minsky init` help text to explain MCP configuration options
   - Add examples showing how to initialize with different MCP settings
   - Include guidance on securing MCP for production use

4. **MCP Rule Integration**
   - Create a new rule (`mcp-usage.mdc`) explaining MCP best practices
   - Update existing rules to reference MCP capabilities where relevant
   - Ensure rule content is consistent across both cursor and generic formats

## Implementation Steps

1. [ ] Update the command interface in `src/commands/init/index.ts`:

   - [ ] Add `--mcp <boolean>` flag to enable/disable MCP configuration
   - [ ] Add `--mcp-transport <type>` option (stdio, sse, http-stream)
   - [ ] Add `--mcp-port <port>` and `--mcp-host <host>` options
   - [ ] Update help text to document new options

2. [ ] Enhance domain logic in `src/domain/init.ts`:

   - [ ] Add MCP configuration generation function
   - [ ] Create template for MCP config file
   - [ ] Add logic to write config file to appropriate location
   - [ ] Update `initializeProject` to handle MCP configuration

3. [ ] Create MCP usage rule template:

   - [ ] Draft content for `mcp-usage.mdc`
   - [ ] Include examples of connecting to and using MCP
   - [ ] Add security best practices

4. [ ] Update interactive prompts in the init command:

   - [ ] Add MCP configuration options to interactive mode
   - [ ] Provide sensible defaults and clear descriptions
   - [ ] Handle validation for port numbers and transport types

5. [ ] Add tests:

   - [ ] Test MCP configuration generation
   - [ ] Test CLI options and interactive prompts
   - [ ] Test with both enabled and disabled MCP
   - [ ] Test config file placement and content

6. [ ] Update documentation:
   - [ ] Update README.md with MCP init information
   - [ ] Update CHANGELOG.md
   - [ ] Update README-MCP.md with init information

## Verification

The implementation will be considered complete when:

- [ ] Running `minsky init` with default options creates MCP configuration
- [ ] Running `minsky init --mcp false` skips MCP configuration
- [ ] The MCP configuration file is written to the correct location
- [ ] The configuration file contains valid settings matching provided options
- [ ] The `mcp-usage.mdc` rule is generated when appropriate
- [ ] All interactive prompts work correctly and validate input
- [ ] All tests pass, including new tests for MCP configuration
- [ ] Documentation is updated to reflect the changes

## Related Tasks

- Related to task #034 (Add MCP Support to Minsky)
- Related to task #033 (Enhance Init Command with Additional Rules)
