# Implement Template-Based Rules Generation System

## Status

IN-PROGRESS

## Priority

MEDIUM

## Current Implementation Status

### ✅ COMPLETED PHASES (Major Progress)

**Template System Infrastructure**: Complete and fully functional

#### ✅ Phase 1: Investigation and Architecture (COMPLETED)
- ✅ Analyzed existing rules for CLI command patterns
- ✅ Created comprehensive CLI-to-MCP command mapping via CommandGeneratorService
- ✅ Extracted rule generation logic from init domain to rules domain
- ✅ Identified and implemented template variable system

#### ✅ Phase 2: Rules Domain Enhancement (COMPLETED)
- ✅ Moved rule generation logic to `src/domain/rules/rule-template-service.ts`
- ✅ Created `RuleTemplateService` class with template registry and management
- ✅ Implemented template literal evaluation system with helpers
- ✅ Added configuration-driven content generation
- ✅ Created template composition patterns

#### ✅ Phase 3: Template Conversion (COMPLETED)
- ✅ Created 8 comprehensive workflow templates:
  - `minsky-workflow` - Basic workflow template
  - `minsky-workflow-orchestrator` - High-level workflow overview  
  - `task-implementation-workflow` - Complete task implementation process
  - `minsky-session-management` - Session creation and management
  - `task-status-protocol` - Status management procedures
  - `pr-preparation-workflow` - PR creation and management
  - `index` - Rules navigation and overview
  - `mcp-usage` - MCP protocol guidelines

#### ✅ Phase 4: Rules Generation Command (COMPLETED)
- ✅ Implemented `minsky rules generate` command with all options
- ✅ Added interface preference configuration (CLI/MCP/hybrid)
- ✅ Implemented rule selection, filtering, dry-run, overwrite options
- ✅ Added comprehensive error handling and validation
- ✅ Created 18-test comprehensive test suite (all passing)

#### ✅ Phase 5: Init Command Integration (COMPLETED)
- ✅ Updated init command to use template system
- ✅ Configured rule generation based on init parameters
- ✅ Maintained backward compatibility
- ✅ Init now generates 7 core workflow rules from templates

### ✅ CORE FUNCTIONALITY ACHIEVED

**Dynamic CLI/MCP Command Generation**: Fully working
- ✅ **CLI Mode**: Generates `minsky tasks list [options]` syntax
- ✅ **MCP Mode**: Generates `<invoke name="mcp_minsky-server_tasks_list">` XML format  
- ✅ **Hybrid Mode**: Selects appropriate format based on configuration
- ✅ **Template Helpers**: Conditional sections, command conversion, parameter docs

### ⚠️ REMAINING WORK (Minor Issues)

#### ⚠️ Template Formatting Cleanup (IN-PROGRESS)
**Current Issue**: Some templates generate malformed markdown

1. **Double Code Blocks** ❌
   - Some templates still generate nested ```bash blocks
   - Example: `\`\`\`bash\n\`\`\`bash\ncommand\n\`\`\`\n\`\`\``
   - Root cause: `helpers.codeBlock()` used inside existing code blocks

2. **Specific Fixes Needed** ❌
   - ❌ Fix remaining MCP usage template examples
   - ❌ Remove incorrect `helpers.codeBlock()` calls from templates
   - ❌ Verify all templates generate clean markdown without nesting issues

#### ⚠️ Final Validation (PENDING)
1. **Complete End-to-End Testing** ❌
   - ❌ Test full init workflow with all 7 generated rules
   - ❌ Verify generated rules work properly in cursor/AI environments
   - ❌ Validate rule functionality matches original static rules

2. **Cleanup and Documentation** ❌  
   - ❌ Remove deprecated static rule generation functions
   - ❌ Update documentation to reflect template-based generation
   - ❌ Add troubleshooting guide for template issues

### 🎯 SUCCESS CRITERIA STATUS

- ✅ **Template system infrastructure complete and robust**
- ✅ **Rules conditionally reference CLI commands or MCP tools based on configuration**
- ✅ **`minsky rules generate` command successfully generates and installs rules**
- ✅ **Init command integrates with template system maintaining backward compatibility**
- ⚠️ **Generated rules maintain effectiveness** (needs validation testing)
- ✅ **Template system supports all current rule types and metadata**
- ✅ **Comprehensive test coverage for template generation** (18/18 tests passing)
- ❌ **Clean template formatting** (double code blocks issue)

## Description

# Task #296: Implement Template-Based Rules Generation System

## Context

Currently, Minsky rules are static `.mdc` files with hardcoded CLI command references. The `init` command generates rules using static content functions in `src/domain/init.ts`, and there's no way to conditionally reference CLI commands vs MCP tool calls based on project configuration. This limits the flexibility of rules and prevents optimal integration with different interface types (CLI vs MCP).

As the MCP ecosystem grows and rules become more sophisticated, we need a templating system that can:
1. Generate rules dynamically based on project configuration
2. Conditionally reference CLI commands or MCP tool calls
3. Support template variables and dynamic content generation
4. Maintain the existing `.mdc` format for compatibility

## Requirements

### 1. Investigation and Current State Analysis

- **Analyze existing rules content**: Identify all CLI command references in current `.cursor/rules/*.mdc` files
- **Map CLI to MCP equivalents**: Document the mapping between CLI commands and MCP tool calls
- **Inventory rule generation logic**: Catalog all rule content generation in `src/domain/init.ts`
- **Assess templating needs**: Identify what content needs to be templated vs static

### 2. Template System Architecture

- **Template literal approach**: Use JavaScript template literals for dynamic content generation
- **Conditional interface references**: Support `${cli ? 'minsky tasks list' : 'tasks.list'}` patterns
- **Configuration-driven generation**: Generate rules based on project configuration (MCP enabled, interface preference, etc.)
- **Template validation**: Ensure generated rules have valid YAML frontmatter and content

### 3. Extract Rules Logic to Rules Domain

- **Move rule content functions**: Extract `getMinskyRuleContent()`, `getRulesIndexContent()`, `getMCPRuleContent()` from `src/domain/init.ts` to `src/domain/rules.ts`
- **Create rule template registry**: Implement a system to register and manage rule templates
- **Template composition**: Support composing complex rules from smaller template pieces
- **Metadata templating**: Support templating in rule frontmatter (descriptions, globs, etc.)

### 4. Template Definitions and Conversion

Convert existing static rules to templates with patterns like:

#### CLI Command References
```typescript
// Before (static)
content: "Run `minsky tasks list --json` to see all tasks"

// After (templated)
content: `Run \`${interfaceConfig.cli ? 'minsky tasks list --json' : 'Use the tasks.list MCP tool'}\` to see all tasks`
```

#### Configuration-Driven Content
```typescript
// MCP-specific sections
content: `${interfaceConfig.mcpEnabled ? `
## MCP Integration
Use MCP tools for programmatic access:
- \`tasks.list\` - List all tasks
- \`tasks.get\` - Get task details
` : ''}`
```

#### Complex Interface Mappings
```typescript
const commandRef = (cliCmd: string, mcpTool: string, description: string) =>
  interfaceConfig.preferMcp
    ? `Use MCP tool \`${mcpTool}\` to ${description}`
    : `Run \`${cliCmd}\` to ${description}`;
```

### 5. Rules Generation Command Implementation

Implement `minsky rules generate` command with options:

```bash
# Generate and install default rule set
minsky rules generate

# Generate with specific interface preference
minsky rules generate --interface cli
minsky rules generate --interface mcp
minsky rules generate --interface hybrid

# Generate specific rules only
minsky rules generate --rules minsky-workflow,session-management

# Generate to specific location
minsky rules generate --output /path/to/rules/dir

# Force overwrite existing rules
minsky rules generate --force

# Dry run to see what would be generated
minsky rules generate --dry-run
```

### 6. Interface Configuration System

Create configuration system to drive rule generation:

```typescript
interface RuleGenerationConfig {
  interface: 'cli' | 'mcp' | 'hybrid';
  mcpEnabled: boolean;
  mcpTransport: 'stdio' | 'http';
  preferMcp: boolean;
  ruleFormat: 'cursor' | 'generic';
  outputDir?: string;
  selectedRules?: string[];
}
```

### 7. Template Categories and Examples

#### Core Workflow Rules
- **minsky-workflow-orchestrator**: Template task and session management workflows
- **minsky-cli-usage**: Conditional CLI vs MCP command references
- **task-implementation-workflow**: Template task status and implementation commands
- **session-first-workflow**: Template session creation and navigation commands

#### Command Reference Rules
- **minsky-session-management**: Template session commands
- **task-status-protocol**: Template task status commands
- **pr-preparation-workflow**: Template PR and git commands

#### Integration Rules
- **mcp-usage**: Dynamically generated based on MCP configuration
- **rules-management**: Template rule management workflows

### 8. Integration with Init Command

Update init command to use new templating system:

```typescript
// Replace static rule generation
await createFileIfNotExists(ruleFilePath, getMinskyRuleContent(), overwrite, fileSystem);

// With templated rule generation
const ruleConfig: RuleGenerationConfig = {
  interface: mcp?.enabled ? 'hybrid' : 'cli',
  mcpEnabled: mcp?.enabled ?? false,
  mcpTransport: mcp?.transport ?? 'stdio',
  preferMcp: false, // Default to CLI for familiarity
  ruleFormat,
};

await ruleService.generateAndInstallRules(ruleConfig, { overwrite });
```

## Implementation Plan

### Phase 1: Investigation and Architecture (Priority: High)

1. **Current State Analysis**
   - [ ] Analyze all current rules for CLI command patterns
   - [ ] Create mapping of CLI commands to MCP tool equivalents
   - [ ] Document rule generation logic currently in init domain
   - [ ] Identify template variable needs for each rule

2. **Template System Design**
   - [ ] Design template literal architecture for rules
   - [ ] Create interfaces for rule generation configuration
   - [ ] Design template registry and composition system
   - [ ] Plan conditional content generation patterns

### Phase 2: Rules Domain Enhancement (Priority: High)

1. **Extract Init Logic**
   - [ ] Move `getMinskyRuleContent()`, `getRulesIndexContent()`, `getMCPRuleContent()` to rules domain
   - [ ] Create `RuleTemplateService` class in rules domain
   - [ ] Implement template registry and management
   - [ ] Add rule generation configuration interfaces

2. **Template Infrastructure**
   - [ ] Implement template literal evaluation system
   - [ ] Create template validation utilities
   - [ ] Add configuration-driven content generation
   - [ ] Implement template composition patterns

### Phase 3: Template Conversion (Priority: Medium)

1. **Core Rule Templates**
   - [ ] Convert minsky-workflow-orchestrator to template
   - [ ] Convert minsky-cli-usage to template with CLI/MCP conditionals
   - [ ] Convert session management rules to templates
   - [ ] Convert task management rules to templates

2. **Command Reference Templates**
   - [ ] Create CLI command to MCP tool mapping utilities
   - [ ] Template all workflow rules with command references
   - [ ] Add interface preference logic to command references
   - [ ] Validate generated content maintains rule effectiveness

### Phase 4: Rules Generation Command (Priority: Medium)

1. **Core Command Implementation**
   - [ ] Implement `minsky rules generate` command
   - [ ] Add configuration options for interface preference
   - [ ] Support rule selection and filtering
   - [ ] Implement dry-run and force options

2. **Integration and Testing**
   - [ ] Add output directory and format options
   - [ ] Implement comprehensive error handling
   - [ ] Create template validation and testing
   - [ ] Add logging and progress feedback

### Phase 5: Init Command Integration (Priority: Low)

1. **Update Init Command**
   - [ ] Replace static rule generation with template system
   - [ ] Configure rule generation based on init parameters
   - [ ] Maintain backward compatibility with existing functionality
   - [ ] Update tests for new rule generation approach

2. **Documentation and Examples**
   - [ ] Update README with rules generation documentation
   - [ ] Create examples of template usage and customization
   - [ ] Document CLI vs MCP interface implications
   - [ ] Add troubleshooting guide for rule generation

## Technical Considerations

### Template System Design

1. **Template Literals with Function Helpers**
   ```typescript
   const templateHelpers = {
     command: (cli: string, mcp: string, desc: string) =>
       config.preferMcp ? `MCP tool \`${mcp}\`` : `CLI command \`${cli}\``,

     codeBlock: (cli: string, mcp: string) =>
       config.preferMcp ?
         `// Use MCP tool\n${mcp}` :
         `# Use CLI command\n${cli}`,
   };
   ```

2. **Configuration Injection**
   ```typescript
   const generateRule = (template: string, config: RuleGenerationConfig) => {
     return new Function('config', 'helpers', `return \`${template}\`;`)(config, templateHelpers);
   };
   ```

### CLI to MCP Mapping Strategy

Create comprehensive mapping of command patterns:

```typescript
const commandMappings = {
  'minsky tasks list --json': 'tasks.list',
  'minsky tasks get #${id} --json': 'tasks.get with taskId parameter',
  'minsky tasks status get #${id}': 'tasks.status.get with taskId parameter',
  'minsky session start --task ${id}': 'session.start with task parameter',
  'minsky session list --json': 'session.list',
} as const;
```

### Rule Generation Pipeline

1. **Template Loading**: Load rule templates from registry
2. **Configuration Application**: Apply generation config to templates
3. **Content Generation**: Execute template literals with helpers
4. **Validation**: Validate generated YAML frontmatter and content
5. **Installation**: Write generated rules to target directory

### Error Handling and Validation

- Template syntax validation before generation
- Generated content validation (YAML frontmatter, markdown structure)
- Configuration validation (valid interface types, rule selections)
- File system error handling (permissions, conflicts)

## Success Criteria

- [x] **All existing rule content can be generated via template system** ✅
  - 8 comprehensive templates covering all core workflows
  - Template system handles YAML frontmatter and markdown content generation
- [x] **Rules can conditionally reference CLI commands or MCP tools based on configuration** ✅
  - CLI mode: `minsky tasks list [options]`
  - MCP mode: `<invoke name="mcp_minsky-server_tasks_list">`
  - Hybrid mode with intelligent selection
- [x] **`minsky rules generate` command successfully generates and installs rules** ✅
  - Full CLI implementation with all options (interface, rules, dry-run, overwrite, etc.)
  - Comprehensive error handling and validation
- [x] **Init command integrates with new template system maintaining backward compatibility** ✅
  - Init now generates 7 core workflow rules from templates
  - Maintains all existing functionality while using template system
- [ ] **Generated rules maintain the same effectiveness as current static rules** ⚠️
  - Template functionality works, but needs end-to-end validation testing
  - Minor formatting issues need cleanup (double code blocks)
- [x] **Template system supports all current rule types and metadata** ✅
  - Full YAML frontmatter support (name, description, tags, globs, etc.)
  - Flexible content generation with helper functions
- [x] **Comprehensive test coverage for template generation and rule installation** ✅
  - 18/18 tests passing covering all functionality
  - Template registration, generation, configuration presets, file operations
- [ ] **Documentation clearly explains template system and generation options** ❌
  - Implementation complete but documentation needs updating
  - Need troubleshooting guide for template formatting issues

## Future Enhancements

1. **User-Defined Templates**: Allow users to create custom rule templates
2. **Template Marketplace**: Share rule templates between projects
3. **Dynamic Template Loading**: Load templates from external sources
4. **Template Versioning**: Version control for rule templates
5. **Advanced Conditionals**: More sophisticated conditional logic in templates
6. **Template Debugging**: Tools for debugging template generation issues

## Dependencies

- Existing rules domain (`src/domain/rules.ts`)
- Current init command logic (`src/domain/init.ts`)
- MCP configuration system
- CLI command structure and shared adapter layer
- Template literal evaluation and validation utilities

## Related Tasks

- Task #295: Add MCP Client Registration Functionality (complementary MCP features)
- Task #048: Establish a Rule Library System (foundational rule management)
- Task #057: Implement TypeScript-based Rule Authoring System (related templating concepts)
- Task #098: Create Shared Adapter Layer for CLI and MCP Interfaces (interface abstraction)
- Task #260: Implement Prompt Templates for AI Interaction (related templating concepts)

This task represents a significant evolution of the rules system, moving from static files to a dynamic, configuration-driven template system that can adapt to different interface preferences and project configurations.


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
