# Add --body-path Option and Required Title/Body to Session PR Command

## Context

The current `session pr` command accepts optional `--title` and `--body` parameters for creating pull requests. However, it lacks the ability to read the body from a file (like the `--body-path` option pattern used elsewhere in the codebase) and doesn't enforce that title and body are provided, which can result in PRs with auto-generated content that may not be descriptive enough.

This enhancement will:

1. Add a `--body-path` option to read PR body content from a file
2. Make title and body required parameters (either via direct options or file path)
3. Follow existing patterns in the codebase for file path options
4. Maintain backward compatibility where possible

## Background

Currently, the `session pr` command has these parameters:

- `title`: Optional string for PR title
- `body`: Optional string for PR body text
- Other standard session/repo parameters

When title/body are not provided, the system auto-generates them, but this may not always produce the most descriptive or useful PR descriptions.

## Requirements

### 1. Add --body-path Parameter

- Add a new `bodyPath` parameter to the `sessionPrCommandParams`
- The parameter should accept a file path (relative or absolute)
- Read file content and use as PR body text
- Validate that the file exists and is readable
- Handle file read errors gracefully with informative messages

### 2. Make Title and Body Required

- Require that EITHER:
  - Both `--title` and `--body` are provided, OR
  - Both `--title` and `--body-path` are provided
- Update parameter schemas to reflect required nature
- Add validation to ensure at least one title/body combination is provided
- Provide clear error messages when requirements aren't met

### 3. Update Domain Layer

- Update `SessionPrParams` interface in `src/schemas/session.ts` to include `bodyPath`
- Update `sessionPrFromParams` function in `src/domain/session.ts` to:
  - Handle body path parameter
  - Read file content when bodyPath is provided
  - Validate required parameters
  - Prioritize direct body over bodyPath if both provided

### 4. Update Command Registration

- Update `sessionPrCommandParams` in `src/adapters/shared/commands/session.ts`
- Add bodyPath parameter with appropriate schema and description
- Update title/body parameters to be required (or conditionally required)

### 5. Error Handling

- Add specific error handling for file operations
- Provide clear validation errors for missing required parameters
- Handle edge cases like empty files, binary files, etc.

### 6. Testing

- Add unit tests for the new bodyPath functionality
- Test error cases (file not found, permission errors, etc.)
- Test validation of required parameters
- Update existing tests that may be affected by required parameters

## Implementation Details

### Schema Updates

```typescript
// In src/schemas/session.ts
export const sessionPrParamsSchema = z
  .object({
    session: sessionNameSchema.optional().describe("Name of the session"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    title: z.string().min(1).describe("PR title (required)"),
    body: z.string().optional().describe("PR body text"),
    bodyPath: z.string().optional().describe("Path to file containing PR body text"),
    baseBranch: z.string().optional().describe("Base branch for PR (defaults to main)"),
    debug: flagSchema("Enable debug output"),
    noStatusUpdate: flagSchema("Skip updating task status"),
  })
  .refine((data) => data.body || data.bodyPath, {
    message: "Either 'body' or 'bodyPath' must be provided",
    path: ["body"],
  })
  .merge(commonCommandOptionsSchema);
```

### Parameter Registration

```typescript
// In src/adapters/shared/commands/session.ts
const sessionPrCommandParams: CommandParameterMap = {
  title: {
    schema: z.string().min(1),
    description: "Title for the PR",
    required: true,
  },
  body: {
    schema: z.string(),
    description: "Body text for the PR",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body text",
    required: false,
  },
  // ... other existing parameters
};
```

## Implementation Steps

1. [ ] Update `SessionPrParams` interface in `src/schemas/session.ts` to include `bodyPath`
2. [ ] Add validation logic to ensure title is required and either body or bodyPath is provided
3. [ ] Update `sessionPrCommandParams` in `src/adapters/shared/commands/session.ts`
4. [ ] Modify `sessionPrFromParams` function in `src/domain/session.ts` to handle bodyPath
5. [ ] Add file reading logic with proper error handling
6. [ ] Write unit tests for new functionality
7. [ ] Update integration tests
8. [ ] Update CLI help documentation

## Acceptance Criteria

- [ ] `--body-path` option is added to `session pr` command
- [ ] Command reads file content when `--body-path` is provided
- [ ] Title parameter is required
- [ ] Either `--body` or `--body-path` is required
- [ ] Clear validation errors for missing required parameters
- [ ] File read errors are handled gracefully
- [ ] Both relative and absolute file paths work correctly
- [ ] Unit tests cover new functionality and edge cases
- [ ] Integration tests verify end-to-end behavior
- [ ] Documentation is updated to reflect new requirements
- [ ] Backward compatibility is maintained where possible

## Testing Strategy

1. **Unit Tests**:

   - Test file reading with valid paths
   - Test error handling for invalid/missing files
   - Test parameter validation logic
   - Test schema validation with various input combinations

2. **Integration Tests**:

   - Test complete session pr workflow with body-path
   - Test error scenarios end-to-end
   - Verify PR creation with file-based body content

3. **Edge Cases**:
   - Empty files
   - Large files
   - Files with special characters
   - Permission denied scenarios
   - Network files (if supported)

## Verification

- [ ] Manual testing of `session pr` command with various parameter combinations
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] CLI help text shows updated parameters
- [ ] Error messages are clear and helpful
- [ ] File operations work with different file types and locations

## Documentation Updates

- Update CLI help text for `session pr` command
- Update any existing documentation mentioning optional title/body
- Add examples of using `--body-path` option
- Document error messages and troubleshooting

## Breaking Changes

This enhancement introduces breaking changes:

- Title parameter becomes required (was optional)
- Body parameter becomes conditionally required (body OR bodyPath must be provided)

Consider adding a deprecation warning period or providing migration guidance for existing users.
