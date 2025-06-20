# Standardize Repository URI Handling

## Context

The codebase currently has inconsistent handling of repository references, mixing URLs, paths, and repository names. Task #080 identified issues with repository reference handling, including confusion between file paths and URLs. Task #086 has now formalized repository URI handling specifications in `src/domain/concepts.md` section 4. This task aims to implement those specifications and create a consistent approach to repository URI handling that works across all supported repository types.

## Requirements

1. **URI Format Standardization**

   - Implement the standard formats for repository URIs as defined in `src/domain/concepts.md`:
     - HTTPS URLs: `https://github.com/org/repo.git`
     - SSH URLs: `git@github.com:org/repo.git`
     - Local file URIs: `file:///path/to/repo`
     - Shorthand GitHub notation: `org/repo`
   - Create utility functions to normalize all inputs to the standard format as specified in section 4.2 of the concepts document
   - Support automatic conversion of plain filesystem paths to `file://` URIs

2. **URI Parsing and Validation**

   - Create functions to parse and validate repository URIs according to the validation rules in section 4.3 of the concepts document
   - Extract components (scheme, host, path, etc.)
   - Validate URIs against supported formats
   - Provide helpful error messages for invalid URIs

3. **Convenience Functions**

   - Create utility functions for common URI operations as described in the migration guide:
     - Convert between URI formats
     - Extract repository name from URI
     - Check if URI is local or remote
     - Convert shorthand notation to full URIs

4. **Backward Compatibility**

   - Follow the migration strategy in `src/domain/migration-guide.md` section 4.2
   - Maintain support for existing code that uses repository paths
   - Create adapter functions to convert between old and new formats
   - Document migration strategy for code that uses old formats

5. **Forward Compatibility**
   - Ensure compatibility with Task #014 (Repository Backend Support)
   - Design URI handling to support future repository backends

## Implementation Steps

1. [ ] Create repository URI utilities:

   - [ ] Create functions for URI normalization following the rules in concepts.md
   - [ ] Implement parsing and validation
   - [ ] Create conversion functions between formats
   - [ ] Add comprehensive JSDoc comments using the terminology from concepts.md

2. [ ] Update repository-related code:

   - [ ] Update `src/domain/repository.ts` to use standardized URIs
   - [ ] Add URI handling to session creation and management
   - [ ] Update repository name derivation logic

3. [ ] Create backward compatibility layer:

   - [ ] Add adapter functions for existing code as described in the migration guide
   - [ ] Update affected functions to handle both formats

4. [ ] Update tests:

   - [ ] Add tests for URI normalization with all supported formats
   - [ ] Add tests for parsing and validation
   - [ ] Add tests for conversion functions
   - [ ] Test backward compatibility

5. [ ] Update documentation:
   - [ ] Document URI formats and handling
   - [ ] Update API documentation
   - [ ] Provide migration examples

## Verification

- [ ] All URI formats are correctly normalized
- [ ] Parsing and validation work correctly for all supported formats
- [ ] Conversion functions handle all format transitions
- [ ] Backward compatibility is maintained
- [ ] Tests pass for all URI operations
- [ ] Documentation clearly explains URI handling
