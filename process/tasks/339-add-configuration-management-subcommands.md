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

   - Update configuration values programmatically
   - Support nested keys (e.g., ai.providers.openai.model)
   - Validate values before setting
   - Show what changed after update

4. minsky config unset <key>
   - Remove configuration values
   - Support unsetting nested keys
   - Confirm before removing important settings
   - Show what was removed

BENEFITS:

- Easier configuration management without editing files
- Self-diagnosing configuration issues
- Better user experience for setup and troubleshooting

## Requirements

## Solution

## Notes
