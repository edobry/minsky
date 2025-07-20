# Implementation Plan: Template-Based Rules Generation System (Task #289)

## 🎯 Senior Engineering Analysis

This task will transform Minsky's static rule generation into a sophisticated dynamic templating system. This is a significant architectural enhancement that moves us from static rule files to configuration-driven, interface-aware rule generation.

## 📊 Current State Analysis (COMPLETED)

### Existing Rule Generation
- **Location**: `src/domain/init.ts` - static content functions
- **Functions**: 
  - `getMinskyRuleContent()` - 226 lines of static workflow content
  - `getRulesIndexContent()` - 383 lines of static index content  
  - `getMCPRuleContent()` - 8 lines of static MCP usage content
  - `getMCPConfigContent()` - MCP configuration generation

### CLI Command Patterns Found
- `minsky tasks list --json` → `tasks.list`
- `minsky tasks get '#XXX' --json` → `tasks.get`
- `minsky tasks status get '#XXX'` → `tasks.status.get`
- `minsky session start --task XXX` → `session.start`
- `minsky session dir task#XXX` → `session.dir`
- `minsky session list --json` → `session.list`
- `minsky git pr` → `session.pr`
- Plus many more embedded in 60+ rule files

### Available MCP Tools (DISCOVERED)
- **Tasks**: `tasks.list`, `tasks.get`, `tasks.create`, `tasks.delete`, `tasks.status.get`, `tasks.status.set`, `tasks.spec`
- **Sessions**: `session.list`, `session.get`, `session.start`, `session.delete`, `session.dir`, `session.update`, `session.approve`, `session.pr`, `session.inspect`
- **Rules**: `rules.list`, `rules.get`, `rules.create`, `rules.update`, `rules.search`
- **Git**: Hidden from MCP (uses session commands instead)
- **Other**: `init`, `debug.*` tools

### Existing Rules Domain
- **Strong Foundation**: `src/domain/rules.ts` already has sophisticated `RuleService`
- **Capabilities**: List, get, create, update, search rules with frontmatter parsing
- **Formats**: Supports both cursor (`.cursor/rules`) and generic (`.ai/rules`)
- **Architecture**: Ready for extension, not replacement

## 🏗️ Implementation Strategy

### Phase 1: CLI-to-MCP Mapping System ✅ STARTING
1. Create comprehensive command mapping registry
2. Extract all CLI references from existing rules
3. Design template helper functions
4. Create interface configuration types

### Phase 2: Template Infrastructure 
1. Extend `RuleService` with template generation
2. Design template evaluation system with conditionals
3. Create template registry and composition system
4. Build configuration-driven content generation

### Phase 3: Extract Init Logic to Rules Domain
1. Move static rule functions from `init.ts` to rules domain
2. Create template-based replacements
3. Update init command to use template system
4. Maintain backward compatibility

### Phase 4: Template Conversion
1. Convert key workflow rules to templates
2. Template all CLI command references
3. Add interface preference conditionals
4. Validate generated content quality

### Phase 5: Rules Generate Command
1. Implement `minsky rules generate` command
2. Add configuration options (interface, output, selection)
3. Integrate with existing CLI infrastructure
4. Add comprehensive error handling

### Phase 6: Testing & Validation
1. Unit tests for template system
2. Integration tests for rule generation
3. MCP environment validation
4. Backward compatibility verification

## 🔧 Technical Architecture

### Template System Design
```typescript
interface RuleGenerationConfig {
  interface: 'cli' | 'mcp' | 'hybrid';
  mcpEnabled: boolean;
  mcpTransport: 'stdio' | 'sse' | 'httpStream';
  preferMcp: boolean;
  ruleFormat: 'cursor' | 'generic';
  outputDir?: string;
  selectedRules?: string[];
}

const templateHelpers = {
  command: (cli: string, mcp: string, desc: string) =>
    config.preferMcp ? `MCP tool \`${mcp}\`` : `CLI command \`${cli}\``,
  
  codeBlock: (cli: string, mcp: string) =>
    config.preferMcp ? `// Use MCP tool\n${mcp}` : `# Use CLI command\n${cli}`,
    
  conditionalSection: (content: string, condition: boolean) =>
    condition ? content : ''
};
```

### Command Mapping Registry
```typescript
const CLI_TO_MCP_MAPPINGS = {
  'minsky tasks list --json': 'tasks.list',
  'minsky tasks get #${id} --json': 'tasks.get with taskId parameter',
  'minsky tasks status get #${id}': 'tasks.status.get with taskId parameter',
  'minsky session start --task ${id}': 'session.start with task parameter',
  'minsky session list --json': 'session.list',
  'minsky session dir task#${id}': 'session.dir with session parameter',
  'minsky session pr': 'session.pr',
  // ... comprehensive mapping
} as const;
```

## 🚀 Implementation Priorities

### High Priority (Phase 1-3)
- CLI-to-MCP mapping system ⭐
- Template infrastructure ⭐
- Rules domain enhancement ⭐

### Medium Priority (Phase 4-5) 
- Template conversion
- Generate command implementation

### Low Priority (Phase 6)
- Comprehensive testing
- Documentation updates

## 🎯 Success Criteria

### Functional Requirements
- [ ] All existing rule content can be generated via templates
- [ ] Rules conditionally reference CLI or MCP based on configuration
- [ ] `minsky rules generate` command works with all options
- [ ] Init command integrates seamlessly with template system
- [ ] Generated rules maintain equivalent effectiveness

### Quality Requirements
- [ ] Templates validated in MCP environment (Cursor)
- [ ] No mechanical/broken conversions
- [ ] Backward compatibility maintained
- [ ] Comprehensive test coverage

### Integration Requirements
- [ ] Template system ready for Task #290 integration
- [ ] .mdc format compatibility maintained
- [ ] CLI and MCP interfaces both supported
- [ ] Performance acceptable for init operations

## 🔄 Task #290 Integration Point

Once this template system is complete, **Task #290 becomes mostly obsolete** because:

1. **Mapping Work Included**: CLI-to-MCP mappings created here
2. **Better Approach**: Templates generate both CLI and MCP versions dynamically
3. **Superior Solution**: Configuration-driven rather than static conversion

Task #290 would be reduced to:
- Testing MCP-only rule generation
- Validating template output quality
- Documentation of MCP usage patterns

## 📋 Next Steps

**Phase 1 Implementation Starting**: Create CLI-to-MCP mapping system and begin template infrastructure design.

This represents a major architectural evolution that will significantly improve Minsky's flexibility and integration capabilities. 
