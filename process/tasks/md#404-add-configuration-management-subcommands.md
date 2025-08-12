# Add configuration management subcommands

## Context

# Add configuration management subcommands

## Context

Extend the config command with management capabilities to make configuration easier and more robust.

NEW SUBCOMMANDS TO IMPLEMENT:

1. minsky config validate

   - Check for configuration issues and conflicts
   - Validate API key formats and accessibility
   - Verify file paths and permissions
   - Test connectivity to configured services

2. minsky config doctor

   - Diagnose common configuration problems
   - Check for missing required settings
   - Suggest fixes for detected issues
   - Health check for all configured services

3. minsky config set <key> <value>

   - **Back up the config file before making changes**
   - Update configuration values programmatically
   - Support nested keys (e.g., ai.providers.openai.model)
   - Validate values before setting
   - Show what changed after update

4. minsky config unset <key>
   - **Back up the config file before making changes**
   - Remove configuration values
   - Support unsetting nested keys
   - Confirm before removing important settings
   - Show what was removed

BENEFITS:

- Easier configuration management without editing files
- Self-diagnosing configuration issues
- Better user experience for setup and troubleshooting

## Requirements

### Backup Requirements

- All modifying operations (`set`, `unset`) MUST create a backup of the configuration file before making changes
- Backup files should be timestamped (e.g., `.minsky.config.js.backup.2024-01-15T10-30-45Z`)
- Backup location should be same directory as original config file
- Failed operations should restore from backup automatically

### Command Requirements

## Solution

## Notes

## Requirements

## Solution

## Notes
