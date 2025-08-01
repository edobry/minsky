# Configuration Validation Guide

This guide explains how Minsky handles configuration validation, including the new flexible validation system that gracefully handles unknown configuration fields.

## Overview

Minsky's configuration system now supports **flexible validation** that allows unknown configuration fields while still validating known fields strictly. This enables forward compatibility and graceful handling of experimental or provider-specific configuration options.

## Validation Modes

### Default Mode (Permissive)

- **Unknown fields**: Allowed with warnings
- **Known fields**: Strictly validated
- **Behavior**: Configuration loads successfully even with unknown fields

### Strict Mode

- **Unknown fields**: Rejected with errors
- **Known fields**: Strictly validated
- **Behavior**: Configuration fails to load if unknown fields are present

## Configuration Options

Control validation behavior through the `validation` section in your configuration:

```yaml
# Configuration validation settings
validation:
  # Whether to use strict validation (reject unknown fields)
  strictMode: false

  # Whether to show warnings for unknown configuration fields
  warnOnUnknown: true

  # Whether to show path information in unknown field warnings
  includePathInWarnings: true

  # Whether to include the validation error code in warnings
  includeCodeInWarnings: false
```

### Environment Variables

You can also control validation via environment variables:

```bash
# Enable strict mode
export MINSKY_VALIDATION_STRICT_MODE=true

# Disable warnings for unknown fields
export MINSKY_VALIDATION_WARN_ON_UNKNOWN=false

# Include detailed path information in warnings
export MINSKY_VALIDATION_INCLUDE_PATH_IN_WARNINGS=true

# Include validation error codes in warnings
export MINSKY_VALIDATION_INCLUDE_CODE_IN_WARNINGS=true
```

## Example Scenarios

### Scenario 1: Unknown AI Provider (Default Mode)

**Configuration:**

```yaml
ai:
  providers:
    openai:
      enabled: true
      apiKey: sk-...
    morph: # Unknown provider
      enabled: true
      apiKey: sk-...
```

**Result:**

- ✅ Configuration loads successfully
- ⚠️ Warning logged: "Unknown configuration field detected"
- 🚀 Application continues normally

**Log Output:**

```
Warning: Unknown configuration field detected { path: "ai.providers", message: "Unrecognized key(s) in object: 'morph'" }
```

### Scenario 2: Unknown AI Provider (Strict Mode)

**Configuration:**

```yaml
validation:
  strictMode: true

ai:
  providers:
    openai:
      enabled: true
      apiKey: sk-...
    morph: # Unknown provider
      enabled: true
      apiKey: sk-...
```

**Result:**

- ❌ Configuration fails to load
- 🛑 Application startup blocked
- 📝 Clear error message provided

### Scenario 3: Silent Unknown Fields

**Configuration:**

```yaml
validation:
  warnOnUnknown: false

ai:
  providers:
    morph: # Unknown provider
      enabled: true
      apiKey: sk-...
```

**Result:**

- ✅ Configuration loads successfully
- 🔇 No warnings logged
- 🚀 Application continues normally

## Migration Guide

### From Previous Versions

If you were relying on strict validation behavior (configurations failing on unknown fields), you need to explicitly enable strict mode:

**Before (automatic strict validation):**

```yaml
# Unknown fields would cause startup failure
ai:
  providers:
    custom_provider: { ... } # This would fail
```

**After (explicit strict mode):**

```yaml
validation:
  strictMode: true # Restore previous behavior

ai:
  providers:
    custom_provider: { ... } # This will still fail as expected
```

### Adding New Providers

The new system makes it easier to experiment with new AI providers:

```yaml
ai:
  providers:
    # Standard providers
    openai:
      enabled: true
      apiKey: sk-...

    # Experimental providers (will generate warnings but won't break startup)
    experimental_provider:
      enabled: true
      apiKey: sk-...
      custom_option: value
```

## Best Practices

### 1. Development Environment

```yaml
validation:
  strictMode: false # Allow experimentation
  warnOnUnknown: true # Show warnings for debugging
  includePathInWarnings: true # Detailed path information
  includeCodeInWarnings: true # Include error codes for debugging
```

### 2. Production Environment

```yaml
validation:
  strictMode: true # Strict validation for stability
  warnOnUnknown: true # Log any unexpected fields
  includePathInWarnings: true # Helpful for troubleshooting
  includeCodeInWarnings: false # Cleaner logs
```

### 3. CI/CD Environment

```yaml
validation:
  strictMode: true # Catch configuration issues early
  warnOnUnknown: true # Log warnings for analysis
  includePathInWarnings: true # Full diagnostic information
  includeCodeInWarnings: true # Complete error details
```

## Troubleshooting

### Unknown Field Warnings

**Symptom:**

```
Warning: Unknown configuration field detected { path: "ai.providers", message: "Unrecognized key(s) in object: 'morph'" }
```

**Solutions:**

1. **If expected**: Continue using the configuration (warnings are informational)
2. **If typo**: Fix the field name to match a supported provider
3. **If unwanted**: Remove the unknown field
4. **If disruptive**: Set `warnOnUnknown: false` to silence warnings

### Configuration Load Failures

**Symptom:**

```
Configuration validation failed: ai.providers: Unrecognized key(s) in object: 'morph'
```

**Solutions:**

1. **Disable strict mode**: Set `validation.strictMode: false`
2. **Fix configuration**: Remove or correct the unknown fields
3. **Update Minsky**: Check if the field is supported in a newer version

### Performance Considerations

- **Validation overhead**: Minimal impact on startup time
- **Logging overhead**: Warnings logged only during startup
- **Memory usage**: No significant increase

## Technical Details

### Validation Process

1. **Parse configuration** from all sources (files, environment, defaults)
2. **Merge configurations** with proper precedence
3. **Apply validation rules** based on validation configuration
4. **Filter errors** into critical vs. unknown field issues
5. **Log warnings** for unknown fields (if enabled)
6. **Return result** with appropriate success/failure status

### Error Classification

- **Critical errors**: Type mismatches, required fields missing, invalid values
- **Unknown field errors**: Fields not recognized by current schema
- **Warning-level issues**: Unknown fields when not in strict mode

### Backward Compatibility

- **Default behavior**: Permissive (allows unknown fields)
- **Explicit opt-in**: Strict mode available via configuration
- **Graceful degradation**: Unknown fields preserved in configuration object
- **API compatibility**: Existing code continues to work unchanged

## Support

For questions about configuration validation:

1. **Check logs**: Look for validation warnings and error details
2. **Review configuration**: Verify field names and structure
3. **Consult documentation**: Check provider-specific configuration guides
4. **Test validation**: Use different validation modes to diagnose issues
