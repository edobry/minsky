# Task 233: Setup semantic-release with conventional commits for automated GitHub releases and binary builds

## Status

TODO

## Priority

HIGH

## Description

Configure semantic-release to automatically create GitHub releases with binary artifacts based on conventional commits. Integrate with existing justfile build system and GitHub Actions workflow for cross-platform binaries.

## Objectives

1. **Install and Configure semantic-release**

   - Install semantic-release and necessary plugins
   - Configure for GitHub releases only (no npm publishing)
   - Set up conventional commits integration
   - Configure release branches (main only)

2. **Binary Build Integration**

   - Integrate semantic-release with existing justfile build system
   - Ensure all 5 platform binaries are built and attached to releases
   - Maintain existing cross-platform build matrix

3. **GitHub Actions Workflow**

   - Update existing CI/CD workflow to use semantic-release
   - Configure proper authentication and permissions
   - Set up automated release creation on version tags

4. **Release Automation**
   - Automate version bumping based on conventional commits
   - Generate release notes from commit history
   - Upload binary artifacts to GitHub releases

## Requirements

### Package Dependencies

Install semantic-release and required plugins:

```bash
bun add -D semantic-release \
  @semantic-release/changelog \
  @semantic-release/git \
  @semantic-release/github \
  @semantic-release/exec
```

### Configuration Files

1. **Create `.releaserc.json`** for semantic-release configuration:

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/exec",
      {
        "prepareCmd": "just build-all"
      }
    ],
    [
      "@semantic-release/github",
      {
        "assets": [
          {
            "path": "minsky-linux-x64",
            "label": "Linux x64 Binary"
          },
          {
            "path": "minsky-linux-arm64",
            "label": "Linux ARM64 Binary"
          },
          {
            "path": "minsky-macos-x64",
            "label": "macOS x64 Binary"
          },
          {
            "path": "minsky-macos-arm64",
            "label": "macOS ARM64 Binary"
          },
          {
            "path": "minsky-windows-x64.exe",
            "label": "Windows x64 Binary"
          }
        ]
      }
    ]
  ]
}
```

### GitHub Actions Workflow

Update or create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - name: Setup Just
        uses: extractions/setup-just@v2
      - name: Install dependencies
        run: bun install
      - name: Run tests
        run: bun test
      - name: Run linting
        run: bun run lint

  release:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - name: Setup Just
        uses: extractions/setup-just@v2
      - name: Install dependencies
        run: bun install
      - name: Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: bun exec semantic-release
```

### Justfile Integration

Ensure justfile recipes are compatible with semantic-release:

```justfile
# Ensure build-all recipe exists and works
build-all:
  just build-linux
  just build-linux-arm64
  just build-macos
  just build-macos-arm64
  just build-windows
```

### Version Management

1. **Remove manual version management**:

   - Remove version from package.json (semantic-release will manage it)
   - Ensure CLI version is read from package.json

2. **Update CLI version display**:
   - Ensure `src/cli.ts` reads version from package.json
   - Test that `minsky --version` works correctly

## Implementation Steps

### Phase 1: Setup and Configuration

1. **Install Dependencies**

   ```bash
   bun add -D semantic-release @semantic-release/changelog @semantic-release/git @semantic-release/github @semantic-release/exec
   ```

2. **Create Configuration Files**

   - Create `.releaserc.json` with GitHub-only configuration
   - Ensure no npm publishing is configured

3. **Update Package.json**
   - Remove or set version to "0.0.0-development"
   - Add semantic-release script if needed

### Phase 2: GitHub Actions Integration

1. **Update CI Workflow**

   - Modify existing workflow to include semantic-release
   - Ensure proper authentication with GITHUB_TOKEN
   - Add just setup for binary builds

2. **Test Workflow**
   - Test on a feature branch first
   - Verify binary builds work in CI environment
   - Ensure release artifacts are created correctly

### Phase 3: Release Process

1. **Initial Release**

   - Create first semantic release
   - Verify binary artifacts are attached
   - Test release notes generation

2. **Validation**
   - Test different commit types (fix, feat, BREAKING CHANGE)
   - Verify version bumping works correctly
   - Ensure binary downloads work

## Testing Requirements

1. **Local Testing**

   - Test semantic-release with `--dry-run` flag
   - Verify binary builds work locally
   - Check configuration validity

2. **CI Testing**

   - Test workflow on feature branch
   - Verify GitHub token permissions
   - Test binary upload process

3. **Release Testing**
   - Create test release with actual commit
   - Verify binary artifacts are downloadable
   - Test release notes formatting

## Success Criteria

- [ ] semantic-release successfully creates GitHub releases based on conventional commits
- [ ] All 5 platform binaries are automatically built and attached to releases
- [ ] Release notes are generated from commit history
- [ ] Version bumping follows semantic versioning rules
- [ ] No manual intervention required for releases
- [ ] Existing justfile build system integrated seamlessly
- [ ] CLI version command reflects released version
- [ ] GitHub Actions workflow runs successfully
- [ ] Binary artifacts are downloadable from releases

## Future Enhancements

1. **Homebrew Integration**

   - Consider adding homebrew formula automation
   - Potentially use `@semantic-release/exec` for brew formula updates

2. **Changelog Generation**

   - Optionally integrate with existing CHANGELOG.md
   - Consider automated changelog updates

3. **Pre-release Branches**
   - Add beta/alpha branch support if needed
   - Configure distribution channels

## Dependencies

- Existing justfile build system
- GitHub Actions workflow setup
- Conventional commits already in use
- Binary build configuration (Task #164)

## Notes

This setup focuses on GitHub releases only, avoiding npm publishing complexity. The integration with the existing justfile build system ensures the current cross-platform binary generation continues to work seamlessly.

The semantic-release will:

- Analyze conventional commits to determine version bumps
- Generate release notes from commit history
- Build all platform binaries using justfile
- Create GitHub releases with attached binary artifacts
- Tag releases appropriately for future reference

This automation will streamline the release process while maintaining the high-quality binary distribution already established.
