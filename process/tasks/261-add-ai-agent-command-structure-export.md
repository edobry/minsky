# Add AI Agent Command Structure Export

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Add AI Agent Command Structure Export

## Context

AI agents working with the Minsky CLI currently need to discover command structure by running `--help` commands or making educated guesses about available options. This creates inefficiencies and potential errors when the AI needs to understand how to use specific commands.

Following the pattern established in Task #253 (task similarity) and Task #254 (commit similarity), this task implements both targeted command discovery through similarity search and comprehensive command structure export, providing AI agents with efficient ways to work with the CLI.

## Dependencies

1. **Task #179**: Builds on the embeddings/RAG investigation for embedding technology and architecture
2. **Task #253**: Shares embedding infrastructure and similarity search patterns
3. **Task #254**: Follows established embedding architecture patterns
4. **Task #160**: Requires AI completion backend for embedding generation

## Objectives

1. **Primary: Implement semantic command discovery** using natural language queries and similarity search
2. **Secondary: Create comprehensive command structure export** for documentation and tooling
3. **Design AI-friendly interfaces** that minimize context pollution while providing targeted information
4. **Follow established embedding patterns** from Tasks #253, #254, and #179
5. **Ensure maintainability** so the output stays current with CLI changes

## Core Features

### 1. Command Similarity Search (Primary Interface)

**`minsky ai find-command <query>`**

- **Natural Language Queries**: "create a new task", "list tasks by status", "start a session"
- **Targeted Responses**: Return only relevant command syntax with options and examples
- **Ranked Results**: Most relevant commands with similarity scores
- **Context-Aware**: Consider current session, task, or workflow context
- **Minimal Context Pollution**: Only essential information returned

**Example Usage:**

```bash
# AI agent wants to create a task
$ minsky ai find-command "create a new task with title and description"

# Returns targeted response:
Command: minsky tasks create
Description: Create a new task with title and description
Usage: minsky tasks create --title "Title" --description "Description"
Options:
  --title <string>: Task title (required)
  --description <string>: Task description
  --description-path <file>: Read description from file
Examples:
  minsky tasks create --title "Fix bug" --description "Fix login issue"
  minsky tasks create --title "Feature" --description-path task.md
```

### 2. Comprehensive Structure Export (Secondary Interface)

**`minsky ai structure [options]`**

- **Format Options**:
  - `--format json` (default): JSON structure for programmatic consumption
  - `--format yaml`: YAML format for human readability
  - `--format markdown`: Markdown documentation format
- **Complete Command Information**: All commands, options, arguments, and examples
- **Documentation Generation**: Suitable for external tools and documentation
- **Programmatic Access**: Full API for tooling and automation

**Example Output Structure:**

```json
{
  "version": "1.0.0",
  "commands": {
    "tasks": {
      "description": "Task management commands",
      "subcommands": {
        "create": {
          "description": "Create a new task",
          "arguments": [...],
          "options": [...],
          "examples": [...]
        }
      }
    }
  }
}
```

## Technical Implementation

### Phase 1: Similarity Search Infrastructure

1. **Command Embeddings:**

   - Extract command descriptions, usage patterns, and help text
   - Generate embeddings for command semantics and functionality
   - Include common usage patterns and user intents

2. **Similarity Search:**

   - Use same embedding infrastructure as Tasks #253 and #254
   - Implement cosine similarity search for command discovery
   - Return ranked results with relevance scores

3. **Context Enhancement:**
   - Consider current session context for command relevance
   - Include task and workflow context in similarity scoring
   - Learn from usage patterns to improve recommendations

### Phase 2: Comprehensive Export System

1. **Command Metadata Extraction:**

   - Use existing command registration system to extract metadata
   - Work with both CLI and MCP adapters
   - Support all current command structures (tasks, git, config, etc.)

2. **Multi-Format Output:**

   - Implement JSON, YAML, and Markdown formatters
   - Ensure consistent output across all formats
   - Add format validation and error handling

3. **Integration Requirements:**
   - Handle dynamic command discovery
   - Support incremental updates when commands change
   - Maintain backwards compatibility

## Use Cases

### 1. AI Agent Command Discovery (Primary)

```bash
# Targeted command discovery
minsky ai find-command "create task with title and description"
minsky ai find-command "list tasks by status"
minsky ai find-command "start a work session"
minsky ai find-command "commit changes and create PR"
```

### 2. Documentation and Tooling (Secondary)

```bash
# Generate comprehensive documentation
minsky ai structure --format markdown > docs/cli-reference.md

# Export for external tools
minsky ai structure --format json > tools/cli-schema.json

# Human-readable reference
minsky ai structure --format yaml
```

## Benefits of Hybrid Approach

### Similarity Search Benefits:

1. **Targeted Information**: Only returns relevant commands
2. **Context Efficiency**: Minimal context pollution (40-60% reduction estimated)
3. **Natural Language**: AI agents can query in natural language
4. **Scalable**: Works well as command set grows
5. **Consistent Pattern**: Follows established embedding architecture

### Structure Export Benefits:

1. **Complete Information**: All commands available at once
2. **Documentation Generation**: Suitable for external documentation
3. **Tooling Support**: Full API for automation and integration
4. **Offline Analysis**: Complete information for batch processing

## Workflow Comparison

**Current State** (AI Agent discovering commands):

```bash
# AI needs to create a task
1. minsky tasks --help              # 20+ lines of output
2. minsky tasks create --help       # 15+ lines of output
3. Parse through all options
4. Finally: minsky tasks create --title "..." --description "..."
```

**Proposed Workflow** (Similarity Search):

```bash
# AI needs to create a task
1. minsky ai find-command "create task with title and description"
2. Gets targeted response with exact syntax needed
3. Uses command directly
```

## Implementation Phases

### Phase 1: Core Similarity Search

1. [ ] Set up embedding infrastructure building on Task #179
2. [ ] Implement command metadata extraction and embedding generation
3. [ ] Create basic similarity search API and CLI interface
4. [ ] Add `minsky ai find-command` command with natural language queries

### Phase 2: Enhanced Search Features

1. [ ] Add context-aware search based on current session/task
2. [ ] Implement result ranking and filtering
3. [ ] Add learning from usage patterns
4. [ ] Optimize search performance and caching

### Phase 3: Structure Export System

1. [ ] Implement comprehensive command metadata extraction
2. [ ] Create JSON output formatter
3. [ ] Add YAML and Markdown output formats
4. [ ] Add `minsky ai structure` command with format options

### Phase 4: Integration and Polish

1. [ ] Integration with existing command registration system
2. [ ] Performance optimization and caching
3. [ ] Documentation and examples
4. [ ] Testing and validation

## Requirements

### Core Functionality

- [ ] Generate embeddings for command descriptions and usage patterns
- [ ] Implement cosine similarity search with configurable thresholds
- [ ] `minsky ai find-command <query>` returns targeted command syntax
- [ ] `minsky ai structure` exports comprehensive command information
- [ ] Support for multiple output formats (JSON, YAML, Markdown)

### Performance and Scalability

- [ ] Efficient similarity search for 50+ commands
- [ ] Incremental updates when commands change
- [ ] Caching of frequent similarity searches
- [ ] Fast response times (<500ms for similarity search)

### Integration

- [ ] Works with existing command registration system
- [ ] Supports both CLI and MCP adapters
- [ ] Context-aware search based on current session
- [ ] Consistent behavior across different command types

## Success Criteria

### Primary Success (Similarity Search)

- [ ] AI agents can discover commands using natural language queries
- [ ] Targeted responses reduce context pollution by 40-60%
- [ ] Search results are relevant and actionable
- [ ] Context-aware results improve with usage

### Secondary Success (Structure Export)

- [ ] Complete command information available in multiple formats
- [ ] Documentation generation works correctly
- [ ] External tools can integrate using JSON export
- [ ] Output stays current with CLI changes

### Overall Success

- [ ] AI agents prefer similarity search over --help commands
- [ ] Development workflow efficiency improves
- [ ] Integration with existing embedding infrastructure is seamless
- [ ] Maintenance overhead is minimal
