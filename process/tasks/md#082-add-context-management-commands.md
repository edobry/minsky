# Add Context Management Commands for Environment-Agnostic AI Collaboration

## Context

Modern AI assistants construct context dynamically for each request, combining rules, code, conversation history, and other elements. Currently, there's no way to analyze or visualize this context composition, making it difficult to understand token usage, optimize prompts, or debug context-related issues.

Understanding context utilization is crucial for:

- **Cost optimization** - knowing how tokens are distributed across different elements
- **Performance tuning** - identifying inefficient context patterns
- **Debugging** - understanding why certain rules or code aren't being considered
- **Context awareness** - helping users understand what information is available to AI assistants

## Goals

1. Provide visibility into context composition and token usage
2. Enable analysis of context efficiency and optimization opportunities
3. Support debugging of context-related issues
4. Help users understand how their context is constructed and utilized
5. **NEW**: Create modular context component system for targeted AI context generation

## Requirements

1. **Split-Architecture Context Component System** ✅ COMPLETED

   - **Split Architecture**: ✅ Async input gathering + pure rendering functions
   - **Component Architecture**: ✅ Pure function-based components that generate specific context sections
   - **Registry System**: ✅ Central component registration with dependency resolution capabilities
   - **Type Safety**: ✅ Full TypeScript interfaces for components, inputs, and outputs
   - **Template Integration**: ✅ Ability to leverage existing template system for structured content
   - **Test Support**: ✅ Built-in test functions for each component (pure render functions easily testable)
   - **Flexible Input**: ✅ Rich context input system supporting environment, task, session, and project data
   - **Progressive Optimization**: ✅ Foundation for shared input extraction when patterns emerge
   - **Code Reuse**: ✅ Components leverage existing Minsky services (`ModularRulesService`, `GitService`)

2. **Context Generation Commands** ✅ COMPLETED

   - `minsky context generate` - ✅ Generate context using modular components for testing and development
     - **JSON and text output formats** ✅ with separate component sections
     - **Component selection** ✅ via command-line options
     - **User prompt customization** ✅ for context adaptation (`--prompt` parameter)
     - **Model targeting** ✅ for appropriate tokenization
     - **Template support** ✅ for consistent formatting
     - **Error handling** ✅ with detailed error reporting and graceful degradation

3. **Local Tokenization System** ⚠️ PARTIALLY IMPLEMENTED

   - **Multi-Library Support**: ✅ Integrated tokenization libraries

     - [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer): Fastest JavaScript BPE tokenizer for OpenAI models
     - [`tiktoken`](https://github.com/dqbd/tiktoken): JavaScript port of OpenAI's tiktoken library
     - **Abstraction layer**: ✅ `LocalTokenizer` interface with registry system

   - **Model-Specific Tokenizer Detection**: ⚠️ NEEDS SIMPLIFICATION
     - **Current**: Complex priority scoring system (over-engineered)
     - **Needed**: Simple decision tree based on model ID patterns
     - Query provider APIs for tokenizer information during model metadata fetching
     - Extend AI provider configuration to specify custom tokenizer mappings

4. **Context Analysis**

   - `minsky context analyze` - ✅ BASIC IMPLEMENTATION COMPLETED
     - **Local token prediction** ✅ using appropriate tokenizers
     - Show total token usage and breakdown by category
     - Display context window utilization percentage
     - **Model-specific tokenization** ✅ with local libraries
     - **Cross-model comparison** capabilities

5. **Context Visualization** - PENDING

   - `minsky context visualize` - Generate visual representation of context usage
     - Command-line based charts showing context distribution
     - Token usage breakdown with visual indicators
     - **Tokenizer-specific breakdowns** showing differences between tokenization methods

## Implementation Status

### ✅ COMPLETED (Phase 1 - Split Architecture Foundation)

1. **Split-Architecture Context Component System**

   - ✅ **Split Architecture**: Async `gatherInputs()` + pure `render()` functions
   - ✅ Component interfaces and types (`ComponentInput`, `ComponentOutput`, `ContextComponent`)
   - ✅ Registry system with dependency resolution (`DefaultContextComponentRegistry`)
   - ✅ **Working Components**: `EnvironmentComponent`, `TaskContextComponent`, `WorkspaceRulesComponent`
   - ✅ **Backwards Compatibility**: Legacy `generate()` method preserved
   - ✅ **Error Handling**: Graceful error handling with detailed reporting
   - ✅ Test infrastructure and component validation

2. **Context Generation Command**

   - ✅ `minsky context generate` command with full CLI interface
   - ✅ JSON output with separate component sections (array format)
   - ✅ Component selection and user prompt customization (`--prompt` parameter)
   - ✅ Template system integration hooks
   - ✅ **Error Recovery**: Components fail gracefully, show detailed error messages

3. **Tokenization Infrastructure**

   - ✅ Multi-library integration (`gpt-tokenizer`, `tiktoken`)
   - ✅ Tokenizer abstraction layer and registry
   - ✅ Basic model-specific tokenizer selection
   - ✅ Extended `AIModel` interface with tokenizer metadata

4. **Basic Context Analysis**
   - ✅ `minsky context analyze` command working
   - ✅ Local tokenization without API calls
   - ✅ Context categorization and token counting
   - ✅ Context window utilization calculations

### 🔄 IN PROGRESS

1. **Tokenizer Selection Simplification**
   - Replace complex priority scoring with simple decision tree
   - Implement: `if (modelId.startsWith('gpt-')) return 'gpt-tokenizer'`

### 📋 REMAINING WORK (Phase 2 - Component Implementation)

1. **Additional Context Components** (7 remaining)

   - ✅ `WorkspaceRulesComponent` - **COMPLETED**: Leverages existing `ModularRulesService`
   - `SystemInstructionsComponent` - **TEMPLATE**: Use existing template system
   - `ToolSchemasComponent` - **HYBRID**: Dynamic tool discovery + templates
   - `ProjectContextComponent` - **REUSE**: Existing git status logic from `GitService`
   - `SessionContextComponent` - **BESPOKE**: Session state and active files
   - `ConversationHistoryComponent` - **HYBRID**: Dynamic history + formatting
   - `FileContentComponent` - **BESPOKE**: Dynamic file reading with relevance
   - `ErrorContextComponent` - **BESPOKE**: Live linter/error data
   - `DependencyContextComponent` - **BESPOKE**: Package.json analysis
   - `TestContextComponent` - **BESPOKE**: Test framework state

2. **Enhanced Testing**

   - **Unit Tests**: Create tests for pure render functions (easily testable now!)
   - **Component Integration Tests**: Test async input gathering
   - **Error Scenario Testing**: Validate graceful error handling

3. **Context Visualization**

   - `minsky context visualize` command implementation
   - CLI-based charts and visual indicators
   - Interactive context exploration features

4. **Enhanced Analysis Features**
   - Cross-model token comparison
   - Context optimization suggestions
   - Performance metrics and caching

## Code Reuse Opportunities Identified

### **Existing Minsky Code to Leverage**

1. ✅ **Rule Management**: `ModularRulesService` for workspace rules discovery (IMPLEMENTED)
2. **Git Status**: `GitService.getStatus()` for project context
3. **Rule Suggestions**: `gatherContextHints()` from suggest-rules command
4. **Template System**: Existing rule template infrastructure for structured components
5. **Session Management**: Current session state APIs for session context

### **Component Implementation Strategy**

- ✅ **Bespoke Functions**: Dynamic data components (environment, session, files) 
- **Template-Based**: Static structured content (system instructions, rules)
- **Hybrid**: Dynamic data + template formatting (tools, conversation history)
- ✅ **Code Reuse**: Leverage existing services (rules, git, sessions)

## Dependencies

- **Task 160**: ✅ AI completion backend (COMPLETED - provides model metadata)
- **Task 182**: ✅ AI-Powered Rule Suggestion (COMPLETED - foundation ready for integration)
- **Task 390**: ✅ AI telemetry/verbose output (AVAILABLE for tokenization error reporting)
- **Package Dependencies**: ✅ `gpt-tokenizer` and `tiktoken` installed

## Split Architecture Implementation Details

### **Architectural Decision: Split Components for Maximum Testability**

✅ **IMPLEMENTED**: Each component now has:

```typescript
interface ContextComponent {
  // Phase 1: Async input gathering (component-specific, can be optimized later)
  gatherInputs: (context: ComponentInput) => Promise<ComponentInputs>;
  
  // Phase 2: Pure rendering using template system and gathered inputs
  render: (inputs: ComponentInputs, context: ComponentInput) => ComponentOutput;
  
  // Legacy method for backwards compatibility
  generate?: (input: ComponentInput) => Promise<ComponentOutput>;
}
```

### **Benefits Achieved**

1. ✅ **Easy Testing**: Pure render functions can be tested with mock inputs
2. ✅ **Progressive Optimization**: Shared input patterns can be extracted later
3. ✅ **Maximum Flexibility**: Each component gathers exactly what it needs
4. ✅ **Code Reuse**: Components leverage existing Minsky services
5. ✅ **Backwards Compatibility**: Legacy `generate()` method delegates to new architecture

### **Shared Input Optimization Potential**

Identified **shared input patterns** for future optimization:
- **User Prompt**: Used by `TaskContextComponent` and `WorkspaceRulesComponent`
- **Workspace Path**: Used by multiple components
- **Target Model**: Used for tokenization across components

**Future optimization path**: Extract shared input gathering when patterns emerge.

## Context Component Analysis from Cursor

Based on analysis of Cursor's actual AI context construction, we identified these modular components:

### **Core Context Components**

1. ✅ **Environment Component** - System environment and workspace info (COMPLETED)
2. ✅ **Task Context Component** - Current task and user query (COMPLETED)  
3. ✅ **Workspace Rules Component** - Project-specific behavioral rules (COMPLETED)
4. **System Instructions Component** - Core AI behavior guidelines
5. **Tool Schemas Component** - Available tools and parameters
6. **Project Context Component** - Current project state and structure
7. **Session Context Component** - Current user session state
8. **Conversation History Component** - Previous interactions
9. **File Content Component** - Relevant file contents
10. **Dependency Context Component** - Project dependencies
11. **Test Context Component** - Testing framework state
12. **Error Context Component** - Current errors and diagnostics

## Architecture Insights

### **Split Architecture Validation**

✅ **CONFIRMED**: Split architecture provides excellent benefits:
- **Input gathering** can be optimized later for shared patterns
- **Render functions** are pure and easily testable
- **Component-specific logic** avoids over-engineering
- **Excellent foundation** for remaining components

### **Shared Input Analysis**

**User prompt** is a perfect example of shared input optimization potential:
- Used by `TaskContextComponent` for context display
- Used by `WorkspaceRulesComponent` for rule filtering  
- Future components will likely use it for customization

### **Dependency Resolution**

- Most components are actually **independent**
- Complex dependencies are rare in real AI context
- Current dependency system works but may be over-engineered for the use case

### **ComponentOutput Design**

- Currently text-only (appropriate for AI context)
- Could be simplified from object to string return
- Metadata useful for debugging but not core functionality

## Verification

### ✅ Completed Verification

- [x] **Split Architecture**: Async input gathering + pure rendering working
- [x] **Modular Component System**: Registry, types, and 3 working components
- [x] **Context Generation**: CLI command generating context with component selection
- [x] **JSON Output**: Separate array elements for each component section
- [x] **Local Tokenization**: Basic libraries integrated and functional
- [x] **User Customization**: Prompt parameter for context adaptation
- [x] **Error Handling**: Graceful degradation with detailed error reporting
- [x] **Code Reuse**: WorkspaceRulesComponent leverages existing `ModularRulesService`
- [x] **Backwards Compatibility**: Legacy methods preserved

### 📋 Remaining Verification

- [ ] **Simplified Tokenizer Selection**: Decision tree implementation
- [ ] **Remaining Components**: 7 additional components implemented
- [ ] **Unit Tests**: Tests for pure render functions
- [ ] **Code Reuse Integration**: Leveraging more existing Minsky services
- [ ] **Context Visualization**: CLI-based visual representation
- [ ] **Cross-Model Analysis**: Token comparison across different models

## Technical Considerations

### **Tokenizer Selection Simplification**

Replace complex priority scoring with simple decision tree:

```typescript
function selectTokenizer(modelId: string): string {
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1-") || modelId.startsWith("o3-")) {
    return "gpt-tokenizer";
  }
  if (modelId.startsWith("claude-")) {
    return "tiktoken"; // or claude-specific when available
  }
  return "tiktoken"; // fallback
}
```

### **Component Implementation Patterns**

- ✅ **Environment/Session/Files**: Bespoke functions for dynamic data
- **Rules/Instructions**: Template-based for structured static content
- **Tools/History**: Hybrid approach combining dynamic data with templates
- ✅ **Git/Rules**: Reuse existing Minsky services and APIs

### **Testing Strategy**

✅ **Enabled by Split Architecture**:
- **Pure render functions**: Easy to test with mock inputs
- **Input gathering**: Can be tested separately with integration tests
- **Error scenarios**: Test components failing gracefully

## Use Cases Enabled

### ✅ Currently Working

- **Local Token Prediction**: "How many tokens will this context consume?"
- **Component Testing**: "Does my environment component generate correct output?"
- **Context Customization**: "Generate context focused on testing and error handling"
- **Format Flexibility**: "Give me context as JSON for programmatic use"
- **Code Reuse**: "Leverage existing workspace rules for context generation"

### 📋 Planned

- **Cost Analysis**: "Which elements consume the most tokens?"
- **Context Debugging**: "Why isn't my rule being applied?"
- **Optimization**: "How can I reduce context size?"
- **Cross-Model Analysis**: "How do token counts differ between GPT-4 and Claude?"
- **Visual Analysis**: "Show me a breakdown of my context composition"

## Example Usage

```bash
# Generate context with specific components and user customization
minsky context generate --prompt "focus on testing and error handling" --components workspace-rules,task-context --format json

# Analyze token usage
minsky context analyze --model gpt-4o

# Test component rendering (future)
bun test src/domain/context/components/
```

## Relationship with Task 182

Task 082 focuses on **analysis** ("What's in my context and how much does it cost?") while Task 182 focuses on **selection** ("What rules should I load for this task?").

The modular context component system provides the foundation for both:

- **Task 082**: Context analysis and visualization
- **Task 182**: Rule suggestion and intelligent context construction
- **Future Integration**: Task-aware context generation in Minsky workflow

## Next Steps

1. **Implement Remaining Components**: 7 components using split architecture pattern
2. **Create Unit Tests**: Test pure render functions with mock inputs
3. **Optimize Shared Inputs**: Extract common patterns when they emerge
4. **Simplify Tokenizer Selection**: Replace priority system with decision tree
5. **Add Context Visualization**: CLI-based charts and visual indicators