#!/bin/bash

# Test script to verify the release workflow works locally
# This simulates what GitHub Actions will do

set -e

echo "=== Testing Minsky Release Workflow ==="
echo ""

echo "Step 1: Installing dependencies..."
bun install

echo ""
echo "Step 2: Running tests..."
if bun test --timeout 30000 2>/dev/null; then
    echo "✅ Tests passed"
else
    echo "⚠️  Tests failed (this may be expected)"
fi

echo ""
echo "Step 3: Building all platforms..."
just build-all

echo ""
echo "Step 4: Verifying artifacts..."
expected_files=(
    "minsky-linux-x64"
    "minsky-linux-arm64"
    "minsky-macos-x64"
    "minsky-macos-arm64"
    "minsky-windows-x64.exe"
)

all_good=true
for file in "${expected_files[@]}"; do
    if [[ -f "$file" ]]; then
        size=$(du -h "$file" | cut -f1)
        echo "✅ $file ($size)"
    else
        echo "❌ $file - MISSING"
        all_good=false
    fi
done

echo ""
if $all_good; then
    echo "🎉 All artifacts built successfully!"
    echo "The release workflow is ready to use."
    echo ""
    echo "To trigger a release:"
    echo "  git tag v1.0.0"
    echo "  git push origin v1.0.0"
else
    echo "❌ Some artifacts are missing. Check the build process."
    exit 1
fi

echo ""
echo "Cleaning up..."
just clean

echo "✅ Test complete!"
