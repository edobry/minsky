# Add MCP tool for sessiondb querying

## Context

Create a new MCP tool that allows agents to query the session database directly. This would enable agents to:

- Query session information and metadata
- Retrieve session status and history
- Access session-related data for decision making
- Perform read-only operations on the sessiondb

The tool should follow the existing MCP patterns in the codebase and provide a safe, read-only interface to session data. This would complement the existing session management tools by allowing agents to inspect and analyze session state without requiring file system access to the session workspace.

Key requirements:

- Read-only access to sessiondb
- Consistent with existing MCP tool patterns
- Proper error handling and validation
- Documentation for usage patterns

## Requirements

## Solution

## Notes
