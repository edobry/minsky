# Phase 2 Search Tools Reverse Engineering Results

## Objective

Document exact behavior of Cursor's `grep_search`, `file_search`, and `codebase_search` tools to create accurate session-aware implementations with full compatibility.

---

# grep_search Tool Analysis

## Test Case 1: Basic Text Search (COMPLETED)

**Input Parameters:**

```json
{
  "query": "DatabaseConnection"
}
```

**Actual Cursor Output:**

```
File: file:///Users/edobry/Projects/minsky/test-verification/cursor-behavior-analysis.ts
Line 10: export class DatabaseConnection {

File: file:///Users/edobry/Projects/minsky/test-verification/cursor-behavior-analysis.ts
Line 10: export class DatabaseConnection {
```

**Key Findings:**

- Returns file:// URLs with absolute paths
- Shows line numbers with "Line X:" format
- **ISSUE**: Shows duplicate results (potential implementation detail)
- No context lines shown by default
- Searches across entire workspace by default

## Test Case 2: Regex Pattern Matching (COMPLETED)

**Input Parameters:**

```json
{
  "query": "async.*connect.*Promise"
}
```

**Actual Cursor Output:**

```
File: file:///Users/edobry/Projects/minsky/test-verification/cursor-behavior-analysis.ts
Line 24: async connect(maxRetries: number = 3): Promise<boolean> {
Line 40: private async performConnection(): Promise<void> {
Line 50: async disconnect(): Promise<void> {
```

**Key Findings:**

- Supports regex wildcards (.\*) properly
- Still shows duplicate file headers
- Line content is included in output
- Matches are identified correctly

## Test Case 3: OR Operator and Result Limits (COMPLETED)

**Input Parameters:**

```json
{
  "query": "TODO|FIXME|NOTE"
}
```

**Actual Cursor Output:**

```
[Multiple results across many files...]
NOTE: More results are available, but aren't shown here. If you need to, please refine the search query or restrict the scope.
```

**Key Findings:**

- Supports OR operator with pipe (|) syntax
- Has result limit with helpful message
- **CRITICAL**: "More results are available" message indicates 50+ match limit
- Provides guidance to "refine the search query or restrict the scope"

## Test Case 4: Case Sensitivity Testing (COMPLETED)

**Input Parameters:**

```json
{
  "query": "DATABASECONNECTION",
  "case_sensitive": true
}
```

**Actual Cursor Output:**

```
No matches found.
```

**Input Parameters:**

```json
{
  "query": "DATABASECONNECTION",
  "case_sensitive": false
}
```

**Actual Cursor Output:**

```
File: file:///Users/edobry/Projects/minsky/test-verification/phase1-tools-results.md
Line 17: "instructions": "Add a simple console.log statement at the end of the DatabaseConnection constructor",
[... many more results ...]
```

**Key Findings:**

- Case sensitivity parameter works correctly
- `case_sensitive: true` requires exact case match
- `case_sensitive: false` finds matches regardless of case
- Default behavior appears to be case-insensitive

## Test Case 5: Include/Exclude Pattern Testing (COMPLETED)

**Input Parameters:**

```json
{
  "query": "console\\.log",
  "include_pattern": "*.ts",
  "exclude_pattern": "test-verification/*"
}
```

**Actual Cursor Output:**

```
[Extensive results from TypeScript files, excluding test-verification directory]
```

**Key Findings:**

- Include/exclude patterns work with glob syntax
- Regex patterns in query work correctly (escaped dot)
- Patterns are applied to file paths, not content
- Exclude patterns effectively filter out unwanted directories

---

# file_search Tool Analysis

## Test Case 1: Basic File Search (COMPLETED)

**Input Parameters:**

```json
{
  "query": "session"
}
```

**Actual Cursor Output:**

```
/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136/src/adapters/mcp/session.ts
[... 9 more results ...]

NOTE: These are the first 10 results. There were 203 total results from the search.
```

**Key Findings:**

- Returns absolute file paths
- **CRITICAL**: Shows exactly 10 results maximum (first 10 results)
- Includes total result count ("203 total results")
- Results appear to be ranked by relevance/proximity
- Searches across entire workspace including session directories

## Test Case 2: Fuzzy Matching (COMPLETED)

**Input Parameters:**

```json
{
  "query": "cursr"
}
```

**Actual Cursor Output:**

```
/Users/edobry/Projects/minsky/test-verification/cursor-reverse-engineering-plan.md
/Users/edobry/Projects/minsky/docs/cursor-built-in-tools-analysis.md
[... 8 more results ...]

NOTE: These are the first 10 results. There were 209 total results from the search.
```

**Key Findings:**

- **EXCELLENT FUZZY MATCHING**: "cursr" matched "cursor" files effectively
- Ranking algorithm prioritizes closer matches
- Still maintains 10 result limit
- Fuzzy matching is quite tolerant of typos

---

# codebase_search Tool Analysis

## Test Case 1: Abstract Concept Search (COMPLETED)

**Input Parameters:**

```json
{
  "query": "error handling patterns"
}
```

**Actual Cursor Output:**

```
[Extensive semantic search results showing error handling code with context]
```

**Key Findings:**

- **SEMANTIC UNDERSTANDING**: Understands abstract concepts like "error handling patterns"
- Returns code snippets with line numbers and context
- Shows surrounding code context for better understanding
- Groups related code sections together
- **CRITICAL**: Much more sophisticated than simple text search

## Test Case 2: Technical Function Search (COMPLETED)

**Input Parameters:**

```json
{
  "query": "function that validates parameters"
}
```

**Actual Cursor Output:**

```
[Multiple code snippets showing parameter validation functions]
```

**Key Findings:**

- Understands functional requirements ("function that validates")
- Returns relevant code implementations
- Shows actual validation logic and patterns
- **INTELLIGENCE**: Matches intent rather than just keywords

---

# Critical Implementation Requirements

## grep_search Implementation

**Interface Requirements:**

- **Result Limit**: 50 matches maximum with "More results available" message
- **Format**: `File: file://[absolute-path]\nLine X: [content]`
- **Duplicate Results**: Handle potential duplicate file headers
- **Regex Support**: Full regex patterns with proper escaping
- **Case Sensitivity**: Optional parameter (default: case-insensitive)
- **Include/Exclude**: Glob pattern support for file filtering
- **OR Operator**: Pipe (|) syntax support

**Session Boundary Requirements:**

- Filter results to session workspace only
- Resolve relative paths to session context
- Respect session isolation boundaries

## file_search Implementation

**Interface Requirements:**

- **Result Limit**: Exactly 10 results maximum
- **Format**: Absolute file paths only
- **Total Count**: Show total results available ("X total results")
- **Fuzzy Matching**: Tolerant string matching algorithm
- **Ranking**: Relevance-based result ordering

**Session Boundary Requirements:**

- Search only within session workspace
- Return session-relative paths when possible
- Maintain session isolation

## codebase_search Implementation

**Interface Requirements:**

- **Semantic Search**: Understand abstract concepts and intent
- **Context Snippets**: Return code with surrounding context
- **Line Numbers**: Show exact line references
- **Grouped Results**: Organize related code sections
- **Multiple Results**: Can return multiple code sections per file

**Session Boundary Requirements:**

- Search only session workspace content
- Provide session-relative file paths
- Maintain isolation from other sessions

## Performance Characteristics

**grep_search:**

- Fast text-based regex search
- Efficient file filtering
- Suitable for large codebases

**file_search:**

- Very fast path-based search
- Minimal processing overhead
- Instant fuzzy matching

**codebase_search:**

- More computationally intensive
- Requires semantic understanding
- Higher latency but more intelligent results
