# Minsky Context Management Module

## Purpose

The Context Management Module provides **AI context replication** capabilities for Minsky, enabling the generation of comprehensive context that matches what AI systems like Cursor provide. This allows for environment-agnostic AI collaboration by recreating the full context structure that AI assistants rely on.

## Core Design Goal

**REPLICATE, DON'T AVOID DUPLICATION**: The primary goal is to generate context that exactly matches the structure and content provided by AI systems like Cursor, not to avoid duplication. This ensures consistent AI collaboration regardless of the environment.

## Key Constraints & Design Decisions

### 1. **Replication Over Efficiency**
- **Constraint**: Must match Cursor's context structure exactly
- **Decision**: Include all sections that Cursor provides, even if they seem redundant
- **Example**: Environment component replicates OS/Shell/Workspace info that Cursor already shows
- **Rationale**: Consistency in AI context is more important than avoiding duplication

### 2. **Template System Integration**
- **Constraint**: Must use existing Minsky infrastructure properly
- **Decision**: Leverage `CommandGeneratorService` and `getParameterDocumentation()` for tool schemas
- **Anti-pattern**: Custom schema generation that bypasses existing systems
- **Benefit**: Professional, maintainable output using proven template system

### 3. **Session-Aware Context**
- **Constraint**: Context must reflect current Minsky session state
- **Decision**: Include session metadata and task information when in active session
- **Implementation**: Session context includes task metadata automatically (every session has associated task)
- **Scope**: Uses CURRENT session (e.g., `task-md#082`) when detected

### 4. **Modular Component Architecture**
- **Constraint**: Each context section must be independently testable
- **Decision**: Split into `gatherInputs()` (async) and `render()` (pure) phases
- **Benefit**: Testable pure functions with mockable input gathering
- **Registry**: Central component registry with dependency resolution

## Architecture Overview

```
Context Generation Pipeline:
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Component       │    │ Input Gathering  │    │ Pure Rendering  │
│ Selection       │───▶│ (Async)          │───▶│ (Template-based)│
│                 │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
   User specified          Live data from            Formatted
   or defaults            services/filesystem        context text
```

## Component Categories

### Core Replication Components
These components replicate sections that Cursor provides:

1. **Environment**: OS, Shell, Workspace Path (matches Cursor's environment section)
2. **Workspace Rules**: Project-specific behavioral rules 
3. **System Instructions**: Core AI behavior guidelines
4. **Tool Schemas**: Available tools and parameters (using template system)

### Instruction Components  
Static instruction sections that guide AI behavior:

5. **Communication**: Markdown formatting guidelines
6. **Tool Calling Rules**: Tool usage best practices
7. **Maximize Parallel Tool Calls**: Parallel execution optimization
8. **Maximize Context Understanding**: Context exploration guidelines
9. **Making Code Changes**: Code implementation guidelines
10. **Code Citation Format**: Code citation requirements
11. **Task Management**: Todo system and task tracking

### Minsky-Specific Enhancements
Components that add value beyond what Cursor provides:

12. **Project Context**: Live git status and repository info
13. **Session Context**: Current session state with task metadata

## Default Component Order

The default component order matches Cursor's structure:

```typescript
[
  "environment",                     // OS, shell, workspace (replicates Cursor)
  "workspace-rules",                 // Project rules
  "system-instructions",             // AI behavior
  "communication",                   // Formatting rules
  "tool-calling-rules",             // Tool usage
  "maximize-parallel-tool-calls",   // Parallel optimization
  "maximize-context-understanding", // Context exploration
  "making-code-changes",            // Code implementation
  "code-citation-format",           // Citation format
  "task-management",                // Todo tracking
  "tool-schemas",                   // Available tools
  "project-context",                // Git status
  "session-context",                // Session + task metadata
]
```

## Key Implementation Patterns

### 1. **Component Interface**
```typescript
interface ContextComponent {
  id: string;
  name: string;
  description: string;
  dependencies?: string[];
  gatherInputs: (context: ComponentInput) => Promise<ComponentInputs>;
  render: (inputs: ComponentInputs, context: ComponentInput) => ComponentOutput;
}
```

### 2. **Template System Usage**
```typescript
// CORRECT: Use existing infrastructure
const commandGenerator = new CommandGeneratorService(config);
const documentation = commandGenerator.getParameterDocumentation(commandId);

// WRONG: Custom schema generation
const customSchema = manuallyBuildSchema(command);
```

### 3. **Session Detection**
```typescript
// Current session context is automatically detected
const isInSession = isSessionWorkspace(workspacePath);
const sessionContext = await getCurrentSessionContext(workspacePath);
// Uses current session: task-md#082
```

## Critical Lessons Learned

### 1. **Replication vs. Duplication**
- **Initial Mistake**: Tried to avoid "duplicating" Cursor's environment section
- **Correction**: Goal is REPLICATION - include all sections for consistency
- **Learning**: AI context consistency trumps avoiding duplication

### 2. **Template System Integration**
- **Initial Mistake**: Built custom tool schema generation
- **Correction**: Use existing `CommandGeneratorService` and `getParameterDocumentation()`
- **Learning**: Leverage existing infrastructure instead of reinventing

### 3. **Session/Task Relationship**
- **Initial Approach**: Separate session and task components
- **Refined Approach**: Include task metadata in session context (every session has associated task)
- **Learning**: Simplify architecture based on domain constraints

### 4. **Format Matching**
- **Initial Issue**: XML format with numeric tool names ("0", "1", "2")
- **Correction**: JSON format by default with proper command IDs
- **Learning**: Format details matter for exact replication

## Testing Strategy

### Component Testing
Each component should be tested in isolation:

```typescript
// Test input gathering
const inputs = await component.gatherInputs(mockContext);
expect(inputs).toMatchSnapshot();

// Test pure rendering
const output = component.render(mockInputs, mockContext);
expect(output.content).toContain("expected content");
```

### Integration Testing
Full context generation should be tested:

```typescript
// Test complete pipeline
const context = await generateContext(defaultComponents);
expect(context.sections).toHaveLength(13);
expect(context.totalLines).toBeGreaterThan(800);
```

### Format Validation
Output format should match expectations:

```typescript
// Verify JSON structure for tool schemas
const toolSchemas = parseToolSchemas(context);
expect(toolSchemas).toHaveProperty("mcp_minsky-server_tasks_list");
```

## Configuration

### Format Options
- **Default**: JSON format (matches Cursor)
- **Alternative**: XML format (via `--prompt "xml"`)

### Component Selection
- **Default**: All 13 components
- **Custom**: `--components "workspace-rules,tool-schemas"`

### Model Targeting
Context can be optimized for specific AI models while maintaining core structure.

## Future Considerations

1. **Performance**: Input gathering optimization for shared dependencies
2. **Caching**: Cache expensive operations (git status, rule parsing)
3. **Extensibility**: Plugin system for custom components
4. **Validation**: Schema validation for generated context
5. **Metrics**: Token counting and context size optimization

## Provider API Integration

### Model-Tokenizer Mapping
The context module now includes comprehensive **Provider API Integration** for accurate model-specific tokenization:

#### **Enhanced AI Model Interface**
```typescript
export interface AIModel {
  // ... existing fields
  tokenizer?: TokenizerInfo;  // NEW: Provider-specific tokenizer metadata
}

export interface TokenizerInfo {
  encoding: string;           // e.g., "o200k_base", "cl100k_base", "claude-3"
  library: "gpt-tokenizer" | "tiktoken" | "anthropic" | "google" | "custom";
  source: "api" | "fallback" | "config";
  config?: Record<string, any>;
}
```

#### **Model Fetcher Enhancements**
- **OpenAI Fetcher**: Precise mapping for GPT-4o (`o200k_base`) vs GPT-4 (`cl100k_base`) vs legacy models (`p50k_base`)
- **Anthropic Fetcher**: Claude model detection with fallback tokenization
- **Pattern-Based Detection**: Automatic model family recognition

#### **Tokenization Integration**
The context module leverages the existing comprehensive tokenization infrastructure:

- **DefaultTokenizerRegistry**: Model-aware tokenizer selection
- **DefaultTokenizationService**: High-performance token counting with caching
- **Multiple Libraries**: Support for `gpt-tokenizer`, `tiktoken`, `anthropic`, and `google` tokenizers

#### **Context Analysis Benefits**
With Provider API Integration, context analysis now provides:

- **Accurate Token Counts**: Model-specific tokenization (GPT-4o vs Claude vs Gemini)
- **Intelligent Model Selection**: Automatic appropriate tokenizer per target model
- **Performance Optimization**: Cached tokenizer instances and pattern-based detection

#### **Inspection Commands**
You can now inspect tokenizer information using:

```bash
# View all models with tokenizer metadata
minsky ai models list --provider openai --format json

# Refresh model cache to include latest tokenizer mappings
minsky ai models refresh --provider openai

# Generate context with model-aware analysis
minsky context generate --analyze --target-model gpt-4o
```

## Dependencies

- **Template System**: `src/domain/rules/template-system.ts`
- **Command Generator**: `src/domain/rules/command-generator.ts`
- **Session Management**: `src/domain/session/`
- **Git Operations**: `src/domain/git/`
- **Rules Management**: `src/domain/rules/`
- **AI Model Management**: `src/domain/ai/model-cache/`
- **Tokenization Services**: `src/domain/ai/tokenization/`

## CLI Usage

```bash
# Generate full context (default components)
minsky context generate

# Generate specific components
minsky context generate --components "environment,tool-schemas"

# Generate with XML format
minsky context generate --prompt "xml format"

# Analyze context for debugging
minsky context analyze
```

This module represents a critical capability for Minsky's AI-first architecture, enabling consistent AI collaboration across different environments by replicating the context structure that AI assistants expect.