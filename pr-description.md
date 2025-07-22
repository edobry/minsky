## Summary

Implements comprehensive semantic error handling for file operations to improve AI agent UX by replacing cryptic filesystem errors with actionable guidance.

## Key Changes

- **NEW**: Semantic error schema with actionable error codes and solutions
- **NEW**: Error classification utility for intelligent error detection  
- **UPDATED**: All session file tools now return semantic errors instead of raw filesystem errors
- **NEW**: Comprehensive test suite validating all functionality

## Before vs After

**Before:** `{"success":false,"error":"ENOENT: no such file or directory"}`

**After:** `{"success":false,"errorCode":"DIRECTORY_NOT_FOUND","error":"Cannot create file - parent directory does not exist","solutions":["Set createDirs: true to auto-create directories","Create parent directory first"],"retryable":true,"relatedTools":["session_create_directory"]}`

## Testing

✅ All unit tests passing
✅ Integration tests validated  
✅ Session file operations verified
✅ Backward compatibility maintained

Addresses core UX issue from Task #308 where AI agents struggled with cryptic filesystem errors.
