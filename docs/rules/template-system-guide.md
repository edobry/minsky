# Minsky Template System User Guide

The Minsky template system enables dynamic rule generation that adapts to your project configuration, automatically generating CLI commands or MCP tool calls based on your interface preference.

## Quick Start

### Generate Rules for Your Project

```bash
# Generate all rules for CLI usage
minsky rules generate --interface=cli

# Generate all rules for MCP usage  
minsky rules generate --interface=mcp

# Generate specific rules only
minsky rules generate --rules=minsky-workflow-orchestrator,task-status-protocol --interface=cli

# Preview what would be generated (dry run)
minsky rules generate --interface=cli --dry-run
```

### Available Templates

The system includes 8 core templates:

1. **minsky-workflow-orchestrator** - Main workflow entry point
2. **task-implementation-workflow** - Step-by-step task implementation
3. **minsky-session-management** - Session creation and management
4. **task-status-protocol** - Task status checking and updates
5. **pr-preparation-workflow** - PR creation and submission
6. **minsky-workflow** - Basic workflow concepts
7. **index** - Rule system overview
8. **mcp-usage** - MCP-specific usage patterns

## Interface Modes

### CLI Mode (`--interface=cli`)

Generates rules with CLI command syntax:

```bash
minsky tasks list [--all <value>] [--status <value>] [--filter <value>]
minsky session start [--name <value>] [--task <value>] [--description <value>]
```

**Use when:**
- Working directly with Minsky CLI
- Creating documentation for human users
- Terminal-based workflows

### MCP Mode (`--interface=mcp`)

Generates rules with MCP tool call syntax:

```xml
<function_calls>
<invoke name="mcp_minsky-server_tasks_list">
<parameter name="all">optional all value</parameter>
<parameter name="status">optional status value</parameter>
</invoke>
</function_calls>
```

**Use when:**
- Working with AI agents via MCP
- Integration with Claude, Cursor, or other AI tools
- Programmatic access to Minsky functionality

### Hybrid Mode (`--interface=hybrid`)

Generates rules optimized for mixed usage (defaults to CLI for readability):

```bash
minsky tasks list [--all <value>] [--status <value>]
```

**Use when:**
- Supporting both human users and AI agents
- Documentation that needs to be readable but MCP-compatible
- Development environments with mixed access patterns

## Command Options

### Basic Options

```bash
--interface <mode>     # cli, mcp, or hybrid (required)
--rules <list>         # Comma-separated list of specific templates
--output-dir <path>    # Custom output directory (default: .cursor/rules)
--dry-run             # Preview generation without creating files
--overwrite           # Overwrite existing rule files
```

### Advanced Options

```bash
--format <format>      # Rule format: cursor or openai (default: cursor)
--prefer-mcp          # In hybrid mode, prefer MCP over CLI commands
--mcp-transport <type> # MCP transport: stdio or http (default: stdio)
```

## Examples

### Development Workflow

```bash
# 1. Check available templates
minsky rules list --tag template

# 2. Generate core workflow rules for CLI
minsky rules generate --interface=cli --rules=minsky-workflow-orchestrator,task-implementation-workflow

# 3. Preview MCP version
minsky rules generate --interface=mcp --dry-run

# 4. Generate full rule set for production
minsky rules generate --interface=hybrid --overwrite
```

### AI Agent Setup

```bash
# Generate MCP-optimized rules for AI agents
minsky rules generate --interface=mcp --prefer-mcp --output-dir=.cursor/rules/mcp

# Generate hybrid rules for mixed human/AI teams
minsky rules generate --interface=hybrid --prefer-mcp
```

## Creating Custom Templates

Templates are defined in `src/domain/rules/default-templates.ts`:

```typescript
const MY_CUSTOM_TEMPLATE: RuleTemplate = {
  id: "my-custom-template",
  name: "My Custom Template",
  description: "Custom rule for specific workflow",
  tags: ["custom", "workflow"],
  generateContent: (context) => {
    const { helpers } = context;
    
    return `# My Custom Rule
    
Use ${helpers.command("tasks.list")} to list tasks.
Use ${helpers.command("session.start")} to start sessions.`;
  },
  generateMeta: (context) => ({
    name: "My Custom Template",
    description: "Custom rule for specific workflow",
    tags: ["custom", "workflow"],
  }),
};
```

### Template Context

Templates receive a context object with:

- `helpers.command(commandId)` - Generates appropriate command syntax
- `config.interface` - Current interface mode (cli/mcp/hybrid)
- `config.preferMcp` - Whether to prefer MCP in hybrid mode
- `config.mcpTransport` - MCP transport method

## Integration with Init Command

The `minsky init` command automatically uses the template system:

```bash
# Generates rules based on project configuration
minsky init --interface=cli    # CLI-optimized rules
minsky init --interface=mcp    # MCP-optimized rules
minsky init --mcp             # Equivalent to --interface=mcp
```

## Troubleshooting

### Common Issues

**Templates not loading:**
```bash
# Check if templates are available
minsky rules list --tag template
```

**Generation fails:**
```bash
# Use dry-run to debug
minsky rules generate --dry-run --interface=cli
```

**Wrong command syntax:**
```bash
# Verify interface mode
minsky rules generate --interface=mcp --rules=minsky-workflow-orchestrator --dry-run
```

### Debug Mode

Enable debug logging for detailed output:

```bash
export DEBUG=minsky:rules
minsky rules generate --interface=cli
```

## Best Practices

1. **Use appropriate interface mode** for your workflow
2. **Generate specific rules** rather than all rules when possible
3. **Use dry-run** to preview before generating
4. **Keep templates focused** on specific workflows
5. **Test both CLI and MCP modes** for custom templates

## Advanced Usage

### Custom Output Directories

```bash
# Generate rules for different environments
minsky rules generate --interface=cli --output-dir=.cursor/rules/dev
minsky rules generate --interface=mcp --output-dir=.cursor/rules/prod
```

### Rule Validation

```bash
# Validate generated rules
minsky rules generate --dry-run | grep -E "(minsky|function_calls)"
```

### Template Development

```bash
# Test template changes
minsky rules generate --rules=my-template --dry-run --interface=cli
minsky rules generate --rules=my-template --dry-run --interface=mcp
```

## Migration from Static Rules

To migrate from static rules to templates:

1. Identify CLI commands in existing rules
2. Replace with `${helpers.command("command.id")}` syntax
3. Test generation in all interface modes
4. Update rule references to use generated versions

---

For more information, see:
- [Rule System Architecture](../architecture/interface-agnostic-commands.md)
- [MCP Integration Guide](../mcp-integration.md)
- [Contributing Guidelines](../../CONTRIBUTING.md)
