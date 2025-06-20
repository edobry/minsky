# Task #086: Formalize Core Minsky Concepts and Relationships

## Context

The current codebase has inconsistent terminology and concepts related to workspaces, repositories, and sessions. This inconsistency creates challenges in understanding, maintaining, and extending code that deals with these core abstractions. Task #080 identified several issues with the current model and recommended establishing clear definitions.

## Requirements

1. **Define Clear Terminology**

   - Create precise definitions for:
     - Repository: A Git repository identified by an upstream URI (with https/git/file schemes)
     - Session: A persistent workstream with metadata and an associated workspace
     - Workspace: The filesystem location where a session's working copy exists
   - Document that upstream repositories are considered read-only from Minsky's perspective

2. **Document Relationships Between Concepts**

   - Create relationship diagrams showing how concepts relate
   - Clarify the one-to-one relationship between sessions and workspaces
   - Document how tasks relate to sessions

3. **Create Migration Guide**

   - Document how terminology is changing (e.g., "main workspace" → "upstream repository")
   - Provide guidance for updating code comments and documentation

4. **URI Handling Specification**

   - Define how repository URIs will be handled
   - Specify support for:
     - HTTPS URLs (https://github.com/org/repo.git)
     - SSH URLs (git@github.com:org/repo.git)
     - Local paths with file:// schema
     - Shorthand paths (org/repo for GitHub repositories)
     - Plain filesystem paths for convenience
   - Document URI normalization and validation rules

5. **Auto-detection Rules**
   - Document how repository auto-detection will work
   - Specify how local repositories will be auto-detected
   - Define fallback mechanisms when auto-detection fails

## Implementation Steps

1. [ ] Create comprehensive concepts document in `src/domain/concepts.md`:

   - [ ] Define each core concept with precise terminology
   - [ ] Create relationship diagrams
   - [ ] Document URI handling specifications
   - [ ] Document auto-detection rules
   - [ ] Include examples of valid/invalid usage

2. [ ] Update JSDoc comments in core files:

   - [ ] `src/domain/repository.ts`
   - [ ] `src/domain/session.ts`
   - [ ] `src/domain/workspace.ts` (create if needed)

3. [ ] Create Migration Guide:

   - [ ] Document old vs. new terminology
   - [ ] Provide examples of correct concept usage
   - [ ] Include guidance for updating code comments

4. [ ] Update README.md with core concept definitions

## Verification

- [ ] A comprehensive concepts document exists in `src/domain/concepts.md`
- [ ] All core concepts have precise, consistent definitions
- [ ] Relationship diagrams clearly show how concepts relate
- [ ] JSDoc comments in core files reflect the formalized concepts
- [ ] Migration guide provides clear direction for terminology changes
- [ ] URI handling specifications are complete and address all requirements
- [ ] Auto-detection rules are clearly documented
