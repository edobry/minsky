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

# ---------------------------------------------------------------------------
# Supabase operations
# ---------------------------------------------------------------------------
# `supabase-usage` resolves a Supabase Management API token in this precedence:
#   1. $SUPABASE_ACCESS_TOKEN env var (highest)
#   2. minsky config: supabase.accessToken (e.g. via ~/.config/minsky/config.yaml)
#   3. ERROR (none set)
# `supabase-health` only needs the local Supabase CLI to be linked — no PAT.
#
# Token sources (any of these, set whichever is most convenient):
#   - macOS: SUPABASE_ACCESS_TOKEN="$(cat "$HOME/Library/Application Support/supabase/access-token")"
#   - Linux: SUPABASE_ACCESS_TOKEN="$(cat "$HOME/.config/supabase/access-token")"
#   - Windows: see Supabase CLI docs (path varies)
#   - Generate a scoped PAT at https://supabase.com/dashboard/account/tokens
#   - Persist it in ~/.config/minsky/config.yaml under `supabase.accessToken`
#     (or set MINSKY_SUPABASE_ACCESS_TOKEN env var)
#
# `:= "..."` is just's string-literal syntax; the value substituted via
# {{PROJECT_REF}} is the unquoted string `yvkkrpyjhoiilmizlnac`.
# See docs/supabase-alerts.md for the full alert-rule runbook.

PROJECT_REF := "yvkkrpyjhoiilmizlnac"  # minsky (dev 2)

# List the project's daily/usage stats — useful for setting threshold values
supabase-usage:
    #!/usr/bin/env bash
    set -euo pipefail
    token="${SUPABASE_ACCESS_TOKEN:-}"
    if [ -z "$token" ]; then
        token="$(minsky config get supabase.accessToken 2>/dev/null || true)"
    fi
    if [ -z "$token" ]; then
        echo "Supabase access token not found; see justfile header for sources" >&2
        exit 1
    fi
    curl -fsS -H "Authorization: Bearer $token" \
        "https://api.supabase.com/v1/projects/{{PROJECT_REF}}/usage" | jq

# Probe DB health via the local supabase CLI's auth (no PAT required if linked)
supabase-health:
    @command -v supabase >/dev/null || { echo "supabase CLI not installed; install from https://supabase.com/docs/guides/cli"; exit 1; }
    supabase projects list
    @echo "---"
    @echo "DB ping via execute_sql is in the Minsky MCP supabase tool; no CLI equivalent."

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
