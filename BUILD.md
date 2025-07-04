# Building Minsky Binaries

Minsky uses [Just](https://github.com/casey/just) for cross-platform binary builds with Bun's compilation feature.

## Prerequisites

- [Bun](https://bun.sh/) runtime (latest version)
- [Just](https://github.com/casey/just) command runner
- All project dependencies installed (`bun install`)

## Available Build Commands

View all available build commands:
```bash
just
```

### Basic Building

Build for current platform:
```bash
just build
```

### Platform-Specific Builds

Build for specific platforms:
```bash
just build-linux        # Linux x64
just build-linux-arm64  # Linux ARM64
just build-macos        # macOS x64
just build-macos-arm64  # macOS ARM64 (Apple Silicon)
just build-windows      # Windows x64
```

### Build All Platforms

Build binaries for all supported platforms:
```bash
just build-all
```

### Testing

Test the built binary:
```bash
just test-binary
```

### Cleanup

Remove all build artifacts:
```bash
just clean
```

## Output Files

Built binaries are created in the project root with the following names:
- `minsky` - Current platform binary
- `minsky-linux-x64` - Linux x64 binary
- `minsky-linux-arm64` - Linux ARM64 binary
- `minsky-macos-x64` - macOS x64 binary
- `minsky-macos-arm64` - macOS ARM64 binary
- `minsky-windows-x64.exe` - Windows x64 binary

## Automated Releases

The GitHub Actions workflow automatically builds and releases binaries for all platforms when version tags are pushed:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the release workflow which:
1. Builds binaries for all platforms using the justfile
2. Runs tests to ensure quality
3. Creates a GitHub release with all platform binaries attached
4. Generates release notes automatically

## Installing Just

If you don't have Just installed:

**macOS:**
```bash
brew install just
```

**Linux:**
```bash
# Using cargo
cargo install just

# Or download from releases
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin
```

**Windows:**
```bash
# Using cargo
cargo install just

# Or using scoop
scoop install just
```

For more installation options, see the [Just installation guide](https://github.com/casey/just#installation). 
