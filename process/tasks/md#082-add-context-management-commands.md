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
   - **Code Reuse**: ✅ Components leverage existing Minsky services (`ModularRulesService`, `GitService`, `SessionProvider`)

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

### ✅ COMPLETED (Phase 1 & 2A - Split Architecture + Core Components)

1. **Split-Architecture Context Component System**

   - ✅ **Split Architecture**: Async `gatherInputs()` + pure `render()` functions
   - ✅ Component interfaces and types (`ComponentInput`, `ComponentOutput`, `ContextComponent`)
   - ✅ Registry system with dependency resolution (`DefaultContextComponentRegistry`)
   - ✅ **6 Working Components**: All demonstrate different implementation patterns
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

### 📋 REMAINING WORK (Phase 2B - Component Implementation)

1. **Additional Context Components** (6 remaining out of 12 total)

   - ✅ `EnvironmentComponent` - **COMPLETED**: System environment and workspace info
   - ✅ `TaskContextComponent` - **COMPLETED**: Current task and user query
   - ✅ `WorkspaceRulesComponent` - **COMPLETED**: Leverages existing `ModularRulesService`
   - ✅ `ProjectContextComponent` - **COMPLETED**: Git status and repository state via `GitService`
   - ✅ `SystemInstructionsComponent` - **COMPLETED**: AI behavior guidelines with context adaptation
   - ✅ `SessionContextComponent` - **COMPLETED**: Session state and workspace isolation via `SessionProvider`
   - `ToolSchemasComponent` - **HYBRID**: Dynamic tool discovery + templates
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

## ✅ MAJOR MILESTONE: 6 Context Components Working (50% Complete!)

### **Completed Components with Implementation Patterns:**

1. **🌍 EnvironmentComponent** - **Bespoke Pattern**
   - System environment (OS, shell, Node version)
   - Workspace path information

2. **📋 TaskContextComponent** - **Bespoke Pattern**
   - Current task details and status
   - User query context and adaptation

3. **📚 WorkspaceRulesComponent** - **Code Reuse Pattern**
   - Leverages existing `ModularRulesService`
   - Rule filtering based on user prompts
   - Rule categorization and organization

4. **🏗️ ProjectContextComponent** - **Code Reuse Pattern**
   - Git status via existing `GitService`
   - Branch information and change summaries
   - Repository state and file modifications

5. **🎯 SystemInstructionsComponent** - **Template-Based Pattern**
   - AI behavior guidelines and principles
   - Context-specific adaptations (security, testing, performance)
   - Dynamic instruction generation based on user prompts

6. **🔄 SessionContextComponent** - **Code Reuse Pattern**
   - Session state via existing `SessionProvider`
   - Task integration and workspace isolation
   - Session metadata and workflow context

### **Proven Architecture Benefits:**

- ✅ **Split Architecture**: All 6 components follow async input gathering + pure rendering
- ✅ **Implementation Flexibility**: Demonstrates bespoke, code reuse, and template-based patterns
- ✅ **Context Adaptation**: Components adapt to user prompts ("security", "testing", etc.)
- ✅ **Error Resilience**: Components handle missing data gracefully
- ✅ **Service Integration**: Seamless integration with existing Minsky infrastructure

## Code Reuse Opportunities Identified

### **Existing Minsky Code Successfully Leveraged**

1. ✅ **Rule Management**: `ModularRulesService` for workspace rules discovery (WorkspaceRulesComponent)
2. ✅ **Git Status**: `GitService.getStatus()` and `getCurrentBranch()` for project context (ProjectContextComponent)
3. ✅ **Session Management**: `SessionProvider` and session utilities for session context (SessionContextComponent)
4. **Rule Suggestions**: `gatherContextHints()` from suggest-rules command (future integration)
5. **Template System**: Existing rule template infrastructure for structured components (SystemInstructionsComponent)

### **Component Implementation Strategy Validation**

- ✅ **Bespoke Functions**: Environment, TaskContext (dynamic data) - **WORKING**
- ✅ **Template-Based**: SystemInstructions (structured content with adaptation) - **WORKING** 
- ✅ **Code Reuse**: WorkspaceRules, ProjectContext, SessionContext (leverage existing services) - **WORKING**
- **Hybrid**: ToolSchemas, ConversationHistory (dynamic data + template formatting) - **PENDING**

## Dependencies

- **Task 160**: ✅ AI completion backend (COMPLETED - provides model metadata)
- **Task 182**: ✅ AI-Powered Rule Suggestion (COMPLETED - foundation ready for integration)
- **Task 390**: ✅ AI telemetry/verbose output (AVAILABLE for tokenization error reporting)
- **Package Dependencies**: ✅ `gpt-tokenizer` and `tiktoken` installed

## Split Architecture Implementation Details

### **Architectural Decision: Split Components for Maximum Testability**

✅ **IMPLEMENTED AND PROVEN**: Each component now has:

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

### **Benefits Achieved and Proven**

1. ✅ **Easy Testing**: Pure render functions can be tested with mock inputs
2. ✅ **Progressive Optimization**: Shared input patterns identified (user prompt, workspace path)
3. ✅ **Maximum Flexibility**: Each component gathers exactly what it needs
4. ✅ **Code Reuse**: Components successfully leverage existing Minsky services
5. ✅ **Backwards Compatibility**: Legacy `generate()` method works perfectly
6. ✅ **Error Resilience**: Components handle failures gracefully with detailed reporting

### **Validated Shared Input Optimization Potential**

Identified **proven shared input patterns** for future optimization:
- ✅ **User Prompt**: Successfully used by `TaskContextComponent`, `WorkspaceRulesComponent`, and `SystemInstructionsComponent`
- ✅ **Workspace Path**: Used by all components that need file system access
- ✅ **Target Model**: Used for tokenization across components

**Optimization ready**: Extract shared input gathering when remaining components show more patterns.

## Context Component Analysis from Cursor

Based on analysis of Cursor's actual AI context construction, we identified these modular components:

### **Core Context Components - Progress Status**

1. ✅ **Environment Component** - System environment and workspace info (COMPLETED)
2. ✅ **Task Context Component** - Current task and user query (COMPLETED)  
3. ✅ **Workspace Rules Component** - Project-specific behavioral rules (COMPLETED)
4. ✅ **System Instructions Component** - Core AI behavior guidelines (COMPLETED)
5. ✅ **Project Context Component** - Current project state and structure (COMPLETED)
6. ✅ **Session Context Component** - Current user session state (COMPLETED)
7. **Tool Schemas Component** - Available tools and parameters (PENDING)
8. **Conversation History Component** - Previous interactions (PENDING)
9. **File Content Component** - Relevant file contents (PENDING)
10. **Dependency Context Component** - Project dependencies (PENDING)
11. **Test Context Component** - Testing framework state (PENDING)
12. **Error Context Component** - Current errors and diagnostics (PENDING)

## Architecture Insights

### **Split Architecture Validation** ✅ PROVEN

✅ **CONFIRMED WITH 6 WORKING COMPONENTS**: Split architecture provides excellent benefits:
- **Input gathering** successfully optimized for component-specific needs
- **Render functions** are pure and easily testable
- **Component-specific logic** avoids over-engineering while enabling code reuse
- **Excellent foundation** demonstrated for remaining components

### **Shared Input Analysis** ✅ VALIDATED

**User prompt** is a proven shared input optimization opportunity:
- ✅ Used by `TaskContextComponent` for context display
- ✅ Used by `WorkspaceRulesComponent` for rule filtering  
- ✅ Used by `SystemInstructionsComponent` for context-specific adaptations
- Future components will likely use it for customization

### **Dependency Resolution** ✅ CONFIRMED

- Most components are actually **independent** (validated with 6 components)
- Complex dependencies are rare in real AI context
- Current dependency system works but confirmed over-engineered for the use case

### **ComponentOutput Design** ✅ WORKING

- Currently text-only (appropriate for AI context)
- Could be simplified from object to string return
- Metadata useful for debugging but not core functionality

## Verification

### ✅ Completed Verification

- [x] **Split Architecture**: Async input gathering + pure rendering working with 6 components
- [x] **Modular Component System**: Registry, types, and 6 working components
- [x] **Context Generation**: CLI command generating context with component selection
- [x] **JSON Output**: Separate array elements for each component section
- [x] **Local Tokenization**: Basic libraries integrated and functional
- [x] **User Customization**: Prompt parameter for context adaptation (proven with multiple components)
- [x] **Error Handling**: Graceful degradation with detailed error reporting
- [x] **Code Reuse**: Multiple components leverage existing Minsky services
- [x] **Backwards Compatibility**: Legacy methods preserved and working
- [x] **Implementation Patterns**: Bespoke, template-based, and code reuse patterns all validated

### 📋 Remaining Verification

- [ ] **Simplified Tokenizer Selection**: Decision tree implementation
- [ ] **Remaining Components**: 6 additional components implemented
- [ ] **Unit Tests**: Tests for pure render functions
- [ ] **Enhanced Code Reuse**: ToolSchemas component with dynamic discovery
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

### **Component Implementation Patterns** ✅ VALIDATED

- ✅ **Environment/Session/Project**: Bespoke functions for dynamic data - **WORKING**
- ✅ **System Instructions**: Template-based for structured static content - **WORKING**
- ✅ **Workspace Rules/Project Context**: Reuse existing Minsky services and APIs - **WORKING**
- **Tools/History**: Hybrid approach combining dynamic data with templates - **NEXT**

### **Testing Strategy** ✅ ENABLED

✅ **Enabled by Split Architecture**:
- **Pure render functions**: Easy to test with mock inputs
- **Input gathering**: Can be tested separately with integration tests
- **Error scenarios**: Test components failing gracefully

## Use Cases Enabled

### ✅ Currently Working (Validated with 6 Components)

- **Local Token Prediction**: "How many tokens will this context consume?"
- **Component Testing**: "Does my environment component generate correct output?"
- **Context Customization**: "Generate context focused on testing and error handling"
- **Format Flexibility**: "Give me context as JSON for programmatic use"
- **Code Reuse**: "Leverage existing workspace rules for context generation"
- **Session Awareness**: "Show me context appropriate for my current session"
- **Project Integration**: "Include current git status and project state"

### 📋 Planned

- **Cost Analysis**: "Which elements consume the most tokens?"
- **Context Debugging**: "Why isn't my rule being applied?"
- **Optimization**: "How can I reduce context size?"
- **Cross-Model Analysis**: "How do token counts differ between GPT-4 and Claude?"
- **Visual Analysis**: "Show me a breakdown of my context composition"

## Example Usage

```bash
# Generate context with specific components and user customization
minsky context generate --prompt "focus on testing and error handling" --components workspace-rules,task-context,system-instructions --format json

# Generate comprehensive context with all working components
minsky context generate --components environment,task-context,workspace-rules,project-context,system-instructions,session-context --format text

# Analyze token usage
minsky context analyze --model gpt-4o

# Test component rendering (ready for implementation)
bun test src/domain/context/components/
```

## Relationship with Task 182

Task 082 focuses on **analysis** ("What's in my context and how much does it cost?") while Task 182 focuses on **selection** ("What rules should I load for this task?").

The modular context component system provides the foundation for both:

- **Task 082**: Context analysis and visualization
- **Task 182**: Rule suggestion and intelligent context construction
- **Future Integration**: Task-aware context generation in Minsky workflow

## Next Steps

1. **Implement Remaining Components**: 6 components using validated split architecture pattern
   - Priority: `ToolSchemasComponent` (dynamic tool discovery)
   - Then: `ErrorContextComponent` (live linter data)
   - Then: `FileContentComponent`, `DependencyContextComponent`, `TestContextComponent`, `ConversationHistoryComponent`

2. **Create Unit Tests**: Test pure render functions with mock inputs (foundation ready)

3. **Optimize Shared Inputs**: Extract common patterns (user prompt, workspace path identified)

4. **Simplify Tokenizer Selection**: Replace priority system with decision tree

5. **Add Context Visualization**: CLI-based charts and visual indicators