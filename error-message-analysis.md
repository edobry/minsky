# Error Message Analysis - Task 169

## Overview
Analysis of error message patterns in the Minsky codebase to identify duplication and opportunities for templating.

## Current Error Infrastructure

### Base Error System
- **Base Class**: `MinskyError` extends `Error` with cause chaining
- **Location**: `src/errors/base-errors.ts`
- **Specialized Classes**: ValidationError, ResourceNotFoundError, ServiceUnavailableError, FileSystemError, ConfigurationError, GitOperationError

### Error Handler
- **Location**: `src/adapters/cli/utils/error-handler.ts`
- **Features**: Type-specific formatting, debug mode support, structured/human mode handling

## Identified Error Message Patterns

### 1. Session Not Found Pattern
**Locations**: Multiple files (git.ts, session.ts, etc.)
**Pattern**: Verbose multi-line messages with emojis and step-by-step guidance
**Example**:
```
🔍 Session "${sessionName}" Not Found

The session you're trying to create a PR for doesn't exist.

💡 What you can do:

📋 List all available sessions:
   minsky sessions list
...
```

### 2. Missing Required Information Pattern
**Location**: git.ts (lines 554-579)
**Pattern**: Multi-section error with alternatives and examples
**Example**:
```
🚫 Cannot create PR - missing required information

You need to specify one of these options...
```

### 3. Basic Error Messages
**Pattern**: Simple `throw new Error("message")` or `throw new MinskyError("message")`
**Examples**:
- "Session record is required"
- "Repository URL is required for cloning"
- "Failed to extract commit hash from git output"

### 4. Command Execution Errors
**Pattern**: Complex error handling with context and cleanup
**Example**: Git merge conflicts, command failures

## Duplication Issues

### 1. Session Not Found Messages
- Multiple variations of "Session not found" across different files
- Similar structure but slightly different wording and suggestions
- Common elements: emoji usage, step-by-step guidance, command examples

### 2. Error Context Pattern
**Repeated Pattern**:
```typescript
error: error instanceof Error ? error.message : String(error)
```
This pattern appears 40+ times across the codebase.

### 3. Git Command Error Handling
- Similar patterns for git command failures
- Repeated logging structure
- Similar cleanup and error formatting

## Common Error Message Components

### 1. Emoji Prefixes
- 🚫 for blocking errors
- 🔍 for "not found" errors  
- 💡 for suggestions
- 📋 for listing commands
- 🆕 for "create new" suggestions
- 📁 for file/directory operations

### 2. Structure Elements
- **Problem Statement**: Clear description of what went wrong
- **Explanation**: Why the error occurred
- **Solutions Section**: "💡 What you can do:" or "💡 How to fix this:"
- **Command Examples**: Formatted code blocks with specific commands
- **Alternative Actions**: Multiple approaches to resolve the issue
- **Help References**: "Need help? Run: command --help"

### 3. Context Information
- Current directory
- Session/task identifiers
- File paths
- Command parameters

## Opportunities for Templating

### 1. Resource Not Found Template
- Session not found
- Task not found  
- File not found
- Repository not found

### 2. Command Guidance Template
- Alternative commands
- Step-by-step instructions
- Example usage

### 3. Context Information Template
- Debug information formatting
- Error cause chaining
- Environment context

### 4. Validation Error Template
- Parameter validation
- Configuration validation
- Input format validation

## Next Steps

1. **Design Error Message Template System**
   - Create reusable templates for common patterns
   - Support context-aware customization
   - Maintain emoji and formatting consistency

2. **Extract Common Components**
   - Error message builders
   - Context formatters
   - Command suggestion generators

3. **Refactor Existing Messages**
   - Replace duplicated patterns with templates
   - Ensure consistent tone and formatting
   - Maintain backward compatibility

4. **Create Testing Infrastructure**
   - Test error message generation
   - Verify context-aware customization
   - Validate user experience consistency 
