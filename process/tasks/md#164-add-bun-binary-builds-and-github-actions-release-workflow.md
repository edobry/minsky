# Task 164: Add Bun Binary Builds and GitHub Actions Release Workflow

## Status

BACKLOG

## Priority

MEDIUM

## Description

Set up build scripts in package.json that leverage Bun's ability to produce binaries, and create GitHub Actions workflows to build and publish multi-platform artifacts as releases. This includes configuring cross-platform builds (Linux, macOS, Windows) and automating the release process with proper versioning and artifact management.

## Objectives

1. **Add Bun Binary Build Scripts**

   - Configure package.json with build scripts using `bun build --compile`
   - Set up scripts for different target platforms (Linux, macOS, Windows)
   - Optimize binary size and performance settings
   - Include proper entry point configuration

2. **Create GitHub Actions Release Workflow**

   - Build binaries for multiple platforms in CI/CD
   - Automatically create releases on version tags
   - Upload platform-specific artifacts to GitHub Releases
   - Include proper naming conventions and metadata

3. **Multi-Platform Support**
   - Linux (x64, arm64)
   - macOS (x64, arm64/Apple Silicon)
   - Windows (x64)
   - Proper cross-compilation configuration

## Requirements

### Package.json Build Scripts

Add scripts for building binaries:

```json
{
  "scripts": {
    "build": "bun build --compile --outfile=minsky ./src/cli.ts",
    "build:linux": "bun build --compile --target=bun-linux-x64 --outfile=minsky-linux-x64 ./src/cli.ts",
    "build:linux-arm64": "bun build --compile --target=bun-linux-arm64 --outfile=minsky-linux-arm64 ./src/cli.ts",
    "build:macos": "bun build --compile --target=bun-darwin-x64 --outfile=minsky-macos-x64 ./src/cli.ts",
    "build:macos-arm64": "bun build --compile --target=bun-darwin-arm64 --outfile=minsky-macos-arm64 ./src/cli.ts",
    "build:windows": "bun build --compile --target=bun-windows-x64 --outfile=minsky-windows-x64.exe ./src/cli.ts",
    "build:all": "npm run build:linux && npm run build:linux-arm64 && npm run build:macos && npm run build:macos-arm64 && npm run build:windows"
  }
}
```

### GitHub Actions Workflow

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  build:
    name: Build and Release
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - target: bun-linux-x64
            output: minsky-linux-x64
          - target: bun-linux-arm64
            output: minsky-linux-arm64
          - target: bun-darwin-x64
            output: minsky-macos-x64
          - target: bun-darwin-arm64
            output: minsky-macos-arm64
          - target: bun-windows-x64
            output: minsky-windows-x64.exe

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Run tests
        run: bun test

      - name: Build binary
        run: bun build --compile --target=${{ matrix.target }} --outfile=${{ matrix.output }} ./src/cli.ts

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.output }}
          path: ${{ matrix.output }}

  release:
    name: Create Release
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Download all artifacts
        uses: actions/download-artifact@v4

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            minsky-linux-x64/minsky-linux-x64
            minsky-linux-arm64/minsky-linux-arm64
            minsky-macos-x64/minsky-macos-x64
            minsky-macos-arm64/minsky-macos-arm64
            minsky-windows-x64.exe/minsky-windows-x64.exe
          generate_release_notes: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Build Configuration

1. **Entry Point Setup**

   - Ensure `src/cli.ts` is properly configured as the main entry point
   - Include proper CLI argument parsing and error handling
   - Verify all dependencies are bundled correctly

2. **Binary Optimization**

   - Configure tree-shaking for smaller binary sizes
   - Include only necessary dependencies
   - Test binaries on target platforms

3. **Version Management**
   - Use semantic versioning for releases
   - Ensure package.json version matches git tags
   - Include version information in built binaries

## Implementation Details

### Prerequisites

- Verify Bun version supports `--compile` flag with cross-compilation
- Ensure all dependencies are compatible with binary compilation
- Test build process locally before implementing CI/CD

### Build Process

1. **Local Development**

   - Add build scripts to package.json
   - Test local binary builds for current platform
   - Verify binary functionality and performance

2. **CI/CD Integration**

   - Create GitHub Actions workflow
   - Configure matrix builds for all target platforms
   - Set up artifact collection and release automation

3. **Release Process**
   - Tag releases using semantic versioning (v1.0.0, v1.1.0, etc.)
   - Automatically trigger builds on tag push
   - Generate release notes from commits and PRs

### Testing Requirements

- Test each binary on its target platform
- Verify binary size and startup performance
- Ensure all CLI commands work in compiled binaries
- Test cross-platform compatibility

## Success Criteria

- Package.json includes all necessary build scripts
- GitHub Actions workflow successfully builds binaries for all target platforms
- Releases are automatically created when version tags are pushed
- Binaries are properly named and uploaded as release artifacts
- All binaries function correctly on their target platforms
- Build process is documented and reproducible
- Release process is automated and reliable

## Dependencies

- Bun runtime with compilation support
- GitHub repository with Actions enabled
- Proper entry point configuration in src/cli.ts
- All project dependencies compatible with binary compilation

## Notes

This enhancement will significantly improve distribution and deployment of the Minsky CLI by providing pre-built binaries for major platforms. Users won't need to have Bun or Node.js installed to use Minsky, making adoption much easier.

The automated release process will streamline deployment and ensure consistent, tested binaries are available for each version.
