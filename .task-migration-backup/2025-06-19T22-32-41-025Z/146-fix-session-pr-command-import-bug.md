# Task #146: Fix Session PR Command Import Bug

## Context

During task #138 implementation, a bug was discovered in the session PR functionality where:
1. The system incorrectly creates a `pr-title.txt` file that is not needed for the `minsky git pr` command
2. There are import issues in the session PR workflow that may involve dynamic imports

## Requirements

1. Fix the session PR command to not create unnecessary `pr-title.txt` files
2. Verify the correct usage of `minsky git pr` command (it uses `--task` flag, not separate title files)
3. Fix any dynamic import issues in the session PR workflow code
4. Ensure the session PR workflow follows the proper `minsky git pr` command interface

## Implementation Steps

1. [ ] Investigate the session PR command implementation to identify where `pr-title.txt` is created
2. [ ] Review `minsky git pr --help` to understand correct command usage
3. [ ] Fix session PR code to use proper `minsky git pr --task <id>` syntax
4. [ ] Remove any code that creates or expects `pr-title.txt` files
5. [ ] Fix any dynamic imports in the session PR workflow
6. [ ] Test the session PR workflow end-to-end

## Verification

- [ ] `minsky git pr --help` shows correct usage without title file requirement
- [ ] Session PR workflow does not create `pr-title.txt` files
- [ ] Session PR workflow uses proper `--task` flag for git pr command
- [ ] No dynamic imports in session PR related code
- [ ] End-to-end session PR workflow test passes 
