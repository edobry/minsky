# Task #341: Implement Pre-Commit Secret Scanning with Husky

## Context

**CRITICAL SECURITY REQUIREMENT**: We nearly committed real API keys and GitHub tokens to the repository. GitHub push protection saved us from catastrophic credential exposure, but we must implement our own preventive measures.

## Current Security Gap

- **No client-side secret detection** before commits
- **Relying only on GitHub push protection** (not sufficient)
- **High risk of credential exposure** in task files, documentation, examples
- **Need automated scanning** as part of pre-commit workflow

## Requirements

### 1. Pre-Commit Secret Scanner Integration

**Primary Tool**: Implement `detect-secrets` or `gitleaks` with husky pre-commit hooks

**Must scan for:**

- OpenAI API keys (`sk-proj-`, `sk-`)
- GitHub Personal Access Tokens (`github_pat_`, `ghp_`)
- Anthropic API keys (`sk-ant-`)
- Google API keys (`AIza`)
- Any credential-like patterns (long alphanumeric strings)
- Environment variable assignments with secrets

### 2. Integration with Existing Husky Setup

**Current husky hooks:**

- `.husky/pre-commit` (ESLint, variable naming checks)
- `.husky/commit-msg` (commit message validation)

**Add to pre-commit workflow:**

```bash
# Secret scanning (must run BEFORE any other checks)
echo "🔍 Scanning for secrets..."
detect-secrets scan --all-files --baseline .secrets.baseline || exit 1
```

### 3. Configuration Requirements

**Baseline Configuration** (`.secrets.baseline`):

- Allow known safe patterns (placeholder examples)
- Whitelist test fixtures with fake credentials
- Configure appropriate sensitivity levels

**Scanner Configuration**:

- Scan all file types (especially `.md`, `.ts`, `.yaml`, `.json`)
- Include process/tasks/ directory (high risk area)
- Exclude node_modules/, .git/, build artifacts

### 4. Emergency Response Integration

**If secrets detected:**

1. **BLOCK commit immediately** with clear error message
2. **List exact files and line numbers** containing secrets
3. **Provide remediation guidance** (sanitize with placeholders)
4. **Require manual verification** after sanitization

### 5. Developer Workflow Integration

**Setup Commands**:

```bash
# Initialize baseline (one-time setup)
detect-secrets scan --all-files --baseline .secrets.baseline

# Add to package.json scripts
"secrets:scan": "detect-secrets scan --all-files --baseline .secrets.baseline",
"secrets:audit": "detect-secrets audit .secrets.baseline"
```

**Documentation Updates**:

- Add security section to main README
- Document how to handle false positives
- Include examples of safe placeholder patterns

## Technical Implementation

### 1. Tool Selection

**Primary Choice**: `detect-secrets` (more configurable than gitleaks)

```bash
npm install --save-dev detect-secrets
# or
pip install detect-secrets
```

**Alternative**: `gitleaks` (if detect-secrets unavailable)

### 2. Husky Integration

**Update `.husky/pre-commit`**:

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# SECURITY: Secret scanning (MUST run first)
echo "🔍 Scanning for secrets..."
if command -v detect-secrets >/dev/null 2>&1; then
    detect-secrets scan --all-files --baseline .secrets.baseline
    if [ $? -ne 0 ]; then
        echo "❌ SECRETS DETECTED! Commit blocked for security."
        echo "📋 Please sanitize credentials and retry."
        exit 1
    fi
    echo "✅ No secrets detected."
else
    echo "⚠️  detect-secrets not installed. Install for security scanning."
fi

# ... existing checks (variable naming, ESLint)
```

### 3. Baseline Configuration

**Initial `.secrets.baseline`**:

- Scan current repository state
- Mark known safe examples as allowed
- Configure plugin settings for various secret types

## Success Criteria

- [ ] Pre-commit hook blocks commits containing real secrets
- [ ] Scanner detects all major credential patterns (OpenAI, GitHub, etc.)
- [ ] False positive rate is manageable (<5 warnings for typical commits)
- [ ] Clear error messages guide developers to fix issues
- [ ] Documentation explains how to use safely
- [ ] Integration doesn't significantly slow down commits (<2 seconds)

## Priority

**🔥 CRITICAL SECURITY PRIORITY**: Must be implemented immediately to prevent future credential exposure incidents.

## Testing Plan

1. **Test secret detection** with sample credentials in temporary files
2. **Test baseline configuration** allows known safe patterns
3. **Test emergency blocking** prevents commits with real secrets
4. **Test developer workflow** with typical commit scenarios
5. **Test false positive handling** with legitimate code patterns

## Risk Mitigation

- **Monitor performance impact** on commit workflow
- **Provide clear bypass documentation** for emergencies (rare cases)
- **Regular baseline updates** as repository evolves
- **Training documentation** for team adoption

## Notes

This task is a **direct response to a critical security near-miss**. Implementation should prioritize security over convenience. Any reduction in security effectiveness is unacceptable.
