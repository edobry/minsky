# feat(#316): Enable max-lines ESLint rule with two-phase approach

## Summary

This PR adds the ESLint `max-lines` rule with a two-phase approach for better code maintainability. It introduces:

1. A warning threshold at 400 lines (matches cursor rule guidance)
2. An error threshold at 1500 lines (prevents extremely large files)

Both thresholds skip blank lines and comments to focus on actual code content.

Additionally, this PR improves the backward compatibility of session commands by introducing a new `sessionname` parameter for MCP interaction while preserving CLI compatibility with `name` and `task` parameters.

## Changes

### Added

- ESLint `max-lines` rule with:
  - Warning at 400 lines (non-blocking for existing files)
  - Error at 1500 lines (prevents extremely large files) 
  - Configuration to skip blank lines and comments
- Backward compatibility for session command parameters:
  - Added `sessionname` parameter for MCP
  - Preserved backward compatibility with `name` and `task` parameters
  - Implemented parameter mapping logic in command handlers

### Modified

- Updated `eslint.config.js` to enable the max-lines rule
- Updated session command parameters and implementation
- Updated schema definitions and domain functions for session commands

## Testing

- Verified ESLint rule enforcement by running:
  - `bun eslint ./src/domain/git.ts --no-ignore` (confirms rule is applied)
  - Tested with `--max-warnings 0` flag to ensure correct counting
- Manually tested session commands to ensure backward compatibility

## Checklist

- [x] All requirements implemented
- [x] ESLint configuration updated
- [x] Session command backward compatibility ensured
- [x] Code quality maintained
- [x] Documentation updated
- [x] Changelog updated 
