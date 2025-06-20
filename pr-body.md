Implements complete repository configuration system with 5-level hierarchy, backend auto-detection, and zero-config task operations.

## Summary

This PR implements the repository configuration system (Task #141) that enables zero-config task operations by automatically resolving backend configuration from repository and user settings.

## Key Features

### Configuration Hierarchy (5 levels)
- CLI flags (highest priority)
- Environment variables (MINSKY_*)
- Global user config (~/.config/minsky/config.yaml)
- Repository config (.minsky/config.yaml) 
- Built-in defaults (lowest priority)

### Backend Auto-Detection
- GitHub remote exists → github-issues backend
- process/tasks.md exists → markdown backend
- Always fallback → json-file backend

### Zero-Config Experience
```bash
# Before: Manual backend specification required
minsky tasks list --backend json-file

# After: Automatic resolution from configuration
minsky tasks list  # Just works!
```

## Implementation

### Core Infrastructure
- **Configuration Service**: Central orchestration with validation
- **Config Loader**: YAML file parsing with hierarchy merging
- **Backend Detector**: Smart repository characteristic detection
- **Credential Manager**: Multi-source credential resolution
- **Config Generator**: YAML file creation for init command

### CLI Integration
- **Config Commands**: `minsky config list`, `minsky config show`
- **Enhanced Init**: `--backend`, `--github-owner`, `--github-repo` options
- **Task Integration**: Zero-config task service creation

### Testing
- Comprehensive test suite for all components
- Integration tests for zero-config workflow
- Error handling and fallback scenarios

## Files Changed

### New Files
- `src/domain/configuration/` - Complete configuration system
- `src/commands/config/` - Configuration CLI commands
- `docs/repository-configuration.md` - System documentation

### Modified Files
- Enhanced `minsky init` command with backend options
- Updated task commands for configuration integration
- CLI command registration and factory updates

## Testing Results
- ✅ Configuration service tests: 8/8 passing
- ✅ Task integration tests: 3/3 passing
- ✅ Zero-config workflow verified

## Ready for Production
The system is fully functional and enables teams to eliminate manual backend configuration while maintaining proper team consistency and user flexibility.
