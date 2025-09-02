# Task Dependency Backfill Analysis

## Objectives

Systematically find, extract, and formalize task dependency references from free-form text in task specifications.

## Patterns to Identify

Based on initial analysis, I need to look for these patterns:

### Direct Task References

- `Task #123` (legacy format)
- `mt#123` (database backend tasks)
- `md#123` (markdown backend tasks)
- `gh#123` (GitHub issues backend)
- `json#123` (JSON file backend)

### Dependency Language

- "depends on Task #123"
- "requires Task #123"
- "blocked by Task #123"
- "prerequisite: Task #123"
- "building on Task #123"
- "based on Task #123"

### Section Contexts

- "Dependencies" sections
- "Prerequisites" sections
- "Related Tasks" sections
- "External Dependencies" sections

## Strategy

1. **Comprehensive Spec Collection**: Get all TODO task specs from all backends
2. **Pattern Matching**: Use regex to find task references in different formats
3. **Context Analysis**: Determine if references indicate dependencies vs just mentions
4. **Validation**: Verify referenced tasks actually exist
5. **Formal Linking**: Create formal dependency relationships using TaskGraphService
6. **Spec Cleanup**: Remove redundant free-form text after creating formal links

## Implementation Plan

1. Create tool to extract all TODO task specs
2. Build comprehensive regex patterns for task references
3. Analyze context to determine dependency type (depends vs mentions)
4. Validate all referenced tasks exist in the system
5. Create formal dependency links
6. Clean up specs by removing redundant dependency text
7. Verify the results

## Risk Mitigation

- Backup all task specs before modification
- Create comprehensive validation before applying changes
- Provide detailed reporting of all changes made
- Support rollback if needed
