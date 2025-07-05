# Bun Optimization Setup for Minsky

## Overview

Minsky session workspaces can consume significant disk space due to duplicated `node_modules` directories across sessions. By configuring Bun's package manager to use hardlinks, you can achieve **60-90% disk space savings** while maintaining full compatibility.

## The Problem

- **Default behavior**: Each session creates its own copy of `node_modules`
- **Typical usage**: 189+ sessions consuming **34GB** total
- **Duplication**: Same packages duplicated across every session workspace
- **Impact**: Slow installations, excessive disk usage, storage costs

## The Solution: Bun Hardlink Backend

Bun's hardlink backend creates hard links from a global cache to `node_modules`, meaning:

- **One physical copy** of each package version exists on disk
- **Multiple sessions** can reference the same files
- **Automatic sharing** of dependencies across projects
- **No code changes** required

## Setup Instructions

### 1. Global Configuration (Recommended)

Create a global `bunfig.toml` configuration:

```bash
cat > ~/bunfig.toml << 'EOF'
[install]
# Force hardlink backend for maximum disk space savings
backend = "hardlink"

# Optional: Configure cache directory
[install.cache]
dir = "~/.bun/install/cache"
disable = false
disableManifest = false
EOF
```

### 2. Environment Variable (Alternative)

Add to your shell profile (`.zshrc`, `.bashrc`, etc.):

```bash
export BUN_INSTALL_BACKEND=hardlink
```

### 3. Verify Configuration

Test that the configuration is working:

```bash
# Create a test project
mkdir test-hardlink && cd test-hardlink
echo '{"dependencies": {"typescript": "^5.0.0"}}' > package.json

# Install with hardlink backend
bun install

# Verify hardlinks (link count should be > 1)
ls -li node_modules/typescript/lib/typescript.js
```

## Reclaiming Existing Space

### Option 1: Automated Bulk Reclamation

Use the provided script to convert all existing sessions:

```bash
# Run from minsky project root
./reclaim_space.sh
```

### Option 2: Manual Session Conversion

Convert individual sessions:

```bash
cd /path/to/session/workspace
rm -rf node_modules
bun install  # Will use hardlink backend automatically
```

## Results and Benefits

### Space Savings Achieved

**Before Optimization:**

- Total sessions: 189
- Total disk usage: 34GB
- Per-session average: ~180MB

**After Optimization:**

- Total disk usage: 11GB
- Space saved: 23GB (67.6% reduction)
- Per-session effective: ~58MB

### Performance Benefits

- **Faster installations**: Packages copied from cache via hardlinks
- **Reduced download time**: Global cache eliminates re-downloading
- **Better disk utilization**: Physical storage matches logical usage
- **No compatibility issues**: Standard Node.js module resolution

## Verification

### Check Hardlink Status

```bash
# Find a common file across sessions
find ~/.local/state/minsky/sessions -name "typescript.js" -path "*/typescript/lib/*" | head -1 | xargs ls -li

# Look for link count > 1 (indicates hardlinking)
# Example output: 42410573 -rw-r--r--@ 15 user staff 9066411 Apr 16 11:59 typescript.js
#                                      ^^ link count
```

### Monitor Space Usage

```bash
# Check total sessions disk usage
du -sh ~/.local/state/minsky/sessions

# Compare individual session sizes
du -sh ~/.local/state/minsky/sessions/*/node_modules | head -5
```

## Troubleshooting

### If Hardlinks Aren't Working

1. **Check file system**: Hardlinks require compatible file systems (not FAT)
2. **Verify configuration**: Ensure `~/bunfig.toml` exists and is correct
3. **Clear cache**: `bun pm cache rm` and retry installation
4. **Manual backend**: Use `bun install --backend hardlink` explicitly

### Platform Differences

- **macOS**: Uses `clonefile` by default (copy-on-write), hardlink provides better savings
- **Linux**: Uses hardlink by default
- **Windows**: Uses hardlink by default

## Best Practices

### For New Sessions

```bash
# Session creation automatically benefits from hardlinks
minsky session start --task <task-id>
# Dependencies will be hardlinked automatically
```

### For Development

- **No changes needed**: Code editing, testing, and development work identically
- **Package modifications**: Avoided automatically through copy-on-write semantics
- **Git operations**: Unaffected by hardlink configuration

### Maintenance

```bash
# Periodic cache cleanup (optional)
bun pm cache rm

# Re-run bulk reclamation after adding many sessions
./reclaim_space.sh
```

## Integration with Minsky Workflow

The hardlink configuration integrates seamlessly with:

- ✅ **Session creation**: `minsky session start`
- ✅ **Task workflows**: All existing commands work unchanged
- ✅ **Testing**: `bun test` and test infrastructure
- ✅ **Building**: `bun run build` and compilation
- ✅ **CI/CD**: GitHub Actions and automated workflows

## Migration Timeline

1. **Setup** (5 minutes): Configure global `bunfig.toml`
2. **Reclamation** (15-30 minutes): Run bulk space reclamation script
3. **Verification** (5 minutes): Confirm hardlinks working and space saved
4. **Ongoing** (automatic): All future operations use optimized storage

## Conclusion

Configuring Bun's hardlink backend is a **one-time setup** that provides:

- **Immediate space savings**: 60-90% reduction in disk usage
- **Ongoing benefits**: All future sessions automatically optimized
- **Zero maintenance**: Works transparently with existing workflows
- **Full compatibility**: No changes to development practices needed

**Recommendation**: This configuration should be standard for all Minsky installations to ensure optimal disk space utilization.
