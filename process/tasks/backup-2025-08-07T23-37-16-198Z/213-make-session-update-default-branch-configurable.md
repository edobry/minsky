# Task #213: Make session update default branch configurable

**Status:** TODO
**Type:** Enhancement
**Priority:** Medium

## Description

Make the default branch that session update merges from discoverable and configurable based on repository backend type.

## Current Behavior

Session update currently hardcodes 'main' as the default branch to merge from:

```typescript
const branchToMerge = branch || "main";
```

The --branch parameter allows overriding this per-command, but there's no intelligent default branch discovery.

## Requirements

### 1. Intelligent Backend-Specific Discovery

- **GitHub Backend**: Use GitHub API to discover the actual repository default branch
- **Local Backend**: Use existing `fetchDefaultBranch()` method (git symbolic-ref) with 'main' fallback
- **Remote Backend**: Use git symbolic-ref detection with 'main' fallback

### 2. Two-Level Configuration System

- **Repo-Level**: Project-specific defaultBranch override (highest config priority)
- **System-Level**: User's personal defaultBranch preference (fallback after discovery fails)
- Support standard config hierarchy (global → environment → local → project)
- Repo-level skips discovery; system-level only used when discovery fails

### 3. Fallback Chain

Priority order for determining default branch:

1. **CLI --branch parameter** (highest priority)
2. **Repo-level defaultBranch configuration** (project-specific override)
3. **Backend-specific discovery** (GitHub API / git symbolic-ref)
4. **System-level defaultBranch configuration** (user's personal preference)
5. **Hardcoded 'main' fallback** (lowest priority)

### 4. Configuration Levels

**Repo-Level Configuration:**

- Configured in project's `.minskyrc`, `config/local.yaml`, or environment variables
- Overrides all discovery mechanisms
- Use case: Project mandates specific branch (e.g., 'develop' workflow)

**System-Level Configuration:**

- Configured in user's global config (`~/.config/minsky/config.yaml`)
- Personal preference when repository discovery fails
- Use case: User mostly works with repos that use 'master' instead of 'main'

**Example Configurations:**

```yaml
# ~/.config/minsky/config.yaml (system-level)
defaultBranch: master  # Personal preference for legacy repos

# project/.minskyrc (repo-level)
defaultBranch: develop  # This project uses develop workflow
```

**Example Resolution:**

- GitHub repo with 'main' default → Uses 'main' (discovery wins over system config)
- Local repo with undetectable default + system config 'master' → Uses 'master'
- Project with repo config 'develop' → Always uses 'develop' (overrides everything)

### 5. GitHub API Integration

- Add method to GitHub backend to fetch repository default branch
- Handle authentication and API errors gracefully
- Cache result to avoid repeated API calls during session

### 6. Session Update Integration

- Modify updateSessionFromParams to use intelligent branch resolution
- Detect session backend type from session record
- Log which method was used for branch discovery (debugging)

## Implementation Notes

### Backend Detection

Session records already include `backendType` field:

```typescript
backendType?: "local" | "remote" | "github"
```

### Existing Infrastructure

- `GitService.fetchDefaultBranch()` already exists for git symbolic-ref detection
- GitHub backend exists but needs default branch API method
- Configuration system supports new options

### GitHub API Endpoint

For GitHub repos, use: `GET /repos/{owner}/{repo}` → `default_branch` field

## Technical Details

### Files to Modify

- `src/domain/repository/github.ts` - Add `getDefaultBranch()` method
- `src/domain/session.ts` - Update `updateSessionFromParams` with intelligent discovery
- `config/default.yaml` - Add optional defaultBranch configuration
- `src/schemas/session.ts` - Update documentation for branch parameter
- `src/types/config.ts` - Add configuration type definitions

### New Function Flow

```typescript
async function resolveDefaultBranch(
  sessionRecord: SessionRecord,
  workdir: string
): Promise<string> {
  // 1. Check repo-level configuration override
  if (config.repo.defaultBranch) return config.repo.defaultBranch;

  // 2. Backend-specific discovery
  let discoveredBranch: string | null = null;
  try {
    switch (sessionRecord.backendType) {
      case "github":
        discoveredBranch = await githubBackend.getDefaultBranch();
        break;
      case "local":
      case "remote":
        discoveredBranch = await gitService.fetchDefaultBranch(workdir);
        break;
    }
    if (discoveredBranch) return discoveredBranch;
  } catch (error) {
    log.debug("Backend discovery failed, falling back", { error });
  }

  // 3. System-level configuration fallback
  if (config.system.defaultBranch) return config.system.defaultBranch;

  // 4. Final hardcoded fallback
  return "main";
}
```

## Acceptance Criteria

- [ ] GitHub backend can discover default branch via API
- [ ] Local/remote backends use git symbolic-ref detection
- [ ] Repo-level defaultBranch configuration overrides all discovery
- [ ] System-level defaultBranch configuration used when discovery fails
- [ ] CLI --branch parameter still has highest priority
- [ ] Graceful fallbacks handle API/git errors
- [ ] Debug logging shows which method was used for branch resolution
- [ ] Tests cover all backend types, config levels, and fallback scenarios
- [ ] Configuration hierarchy works: CLI > repo-config > discovery > system-config > 'main'

## Benefits

- ✅ Works correctly with GitHub repos using 'master' or custom defaults
- ✅ Handles local repos with any default branch convention
- ✅ Respects actual repository configuration vs assumptions
- ✅ Maintains backward compatibility and manual override capability
- ✅ No more "divergent branches" errors from wrong default assumptions

## Related Issues

- Task #181: Investigate and improve configuration system design
- Task #177: Review and improve session update command design
- Current issue: Session updates assume 'main' but repos may use 'master' or custom branches
