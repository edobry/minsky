# feat(#289): Implement Template-Based Rules Generation System

## Summary

This PR implements a comprehensive template-based rules generation system that enables dynamic rule creation based on project configuration and interface preferences (CLI, MCP, or hybrid). The system successfully replaces static rule generation with intelligent templates that adapt to different usage scenarios.

## Changes

### Added

- **RuleTemplateService**: Core service for template management and rule generation
- **Template System**: Dynamic content generation with configurable interface support
- **Command Generator**: Converts shared commands to appropriate CLI or MCP XML syntax
- **8 Complete Rule Templates**: All core Minsky workflow patterns implemented
  - minsky-workflow-orchestrator ✅
  - task-implementation-workflow ✅
  - minsky-session-management ✅
  - task-status-protocol ✅
  - pr-preparation-workflow ✅
  - minsky-workflow, index, mcp-usage ✅
- **`minsky rules generate` CLI command**: Full-featured rule generation with multiple options
- **Template Context System**: Helpers for command references, code blocks, and conditional content
- **Configuration Presets**: CLI, MCP, and hybrid generation modes
- **Comprehensive Documentation**: Complete user guide with examples for all interface modes

### Fixed

- **Template Generation**: Resolved session command registration conflicts
- **CLI Integration**: Fixed command registration issues preventing `rules generate` from appearing
- **Session Commands**: Re-enabled session commands while maintaining CLI stability
- **Linting Issues**: Resolved duplicate function declarations and import conflicts

### Verified

- **CLI Mode**: Generates `minsky tasks list [--all <value>] [--status <value>]...`
- **MCP Mode**: Generates `<function_calls><invoke name="mcp_minsky-server_tasks_list">...`
- **Hybrid Mode**: Optimized CLI syntax for human readability
- **End-to-End Functionality**: Template generation produces ✅ Success status
- **All Interface Modes**: Tested and working correctly

## Testing

- ✅ Template system generates rules successfully in all modes
- ✅ CLI integration shows `generate` command in help
- ✅ Generated rules contain correct dynamic command syntax
- ✅ MCP mode produces valid XML function calls
- ✅ All 8 templates load and generate without errors
- ✅ Session commands properly registered without conflicts

## Success Criteria Achievement

- ✅ **Template system replaces static rule generation** - 8 templates implemented and working
- ✅ **Rules conditionally reference CLI commands or MCP tools** - Verified in all modes
- ✅ **`minsky rules generate` command works** - Fully functional with ✅ Success
- ✅ **Generated rules maintain effectiveness** - All core workflow rules templated
- ✅ **Init command integration** - Working with template system
- ✅ **All rule types supported** - Demonstrated with diverse templates
- ✅ **Comprehensive test coverage** - Complete with verified output

## Documentation

- **Template System User Guide**: Complete guide for using and creating templates
- **Interface Mode Examples**: CLI, MCP, and hybrid usage patterns
- **Troubleshooting Guide**: Common issues and solutions
- **Custom Template Creation**: Developer guide for extending the system

## Migration Impact

- **Backward Compatible**: Existing static rules continue to work
- **Opt-in Migration**: Projects can adopt templates incrementally
- **Rule Library Foundation**: Prepares for future rule ecosystem improvements

## Follow-up Work

Created Task #330 for rule categorization and redundancy analysis to optimize the broader rule ecosystem.

## Verification Commands

```bash
# Test template generation
minsky rules generate --interface=cli --dry-run

# Verify CLI commands in generated rules
minsky rules generate --interface=cli --rules=minsky-workflow-orchestrator

# Test MCP mode
minsky rules generate --interface=mcp --rules=minsky-workflow-orchestrator

# Check available templates
minsky rules list --tag template
```

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Template generation works in all modes
- [x] CLI integration functional
- [x] Documentation complete
- [x] Changelog updated
- [x] Follow-up task created (Task #330)
