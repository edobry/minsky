# Minsky Build Justfile
# Cross-platform binary builds using Bun

# Default recipe lists available commands
default:
    @just --list

# Build for current platform
build:
    bun build --compile --outfile=minsky ./src/cli.ts

# Build for specific platforms
build-linux:
    bun build --compile --target=bun-linux-x64 --outfile=minsky-linux-x64 ./src/cli.ts

build-linux-arm64:
    bun build --compile --target=bun-linux-arm64 --outfile=minsky-linux-arm64 ./src/cli.ts

build-macos:
    bun build --compile --target=bun-darwin-x64 --outfile=minsky-macos-x64 ./src/cli.ts

build-macos-arm64:
    bun build --compile --target=bun-darwin-arm64 --outfile=minsky-macos-arm64 ./src/cli.ts

build-windows:
    bun build --compile --target=bun-windows-x64 --outfile=minsky-windows-x64.exe ./src/cli.ts

# Build all platforms
build-all: build-linux build-linux-arm64 build-macos build-macos-arm64 build-windows

# Clean build artifacts
clean:
    rm -f minsky minsky-linux-x64 minsky-linux-arm64 minsky-macos-x64 minsky-macos-arm64 minsky-windows-x64.exe

# Test the built binary
test-binary: build
    ./minsky --version
    ./minsky --help

# Test macOS binaries specifically (runs on macOS)
test-macos-binaries: build-macos build-macos-arm64
    @echo "Testing macOS x64 binary:"
    ./minsky-macos-x64 --version
    ./minsky-macos-x64 tasks --help > /dev/null
    @echo "✅ macOS x64 binary working"
    @echo "Testing macOS ARM64 binary:"
    ./minsky-macos-arm64 --version
    ./minsky-macos-arm64 tasks --help > /dev/null
    @echo "✅ macOS ARM64 binary working"
    @echo "Binary sizes:"
    @ls -lah minsky-macos-* | awk '{print $9 ": " $5}' 
