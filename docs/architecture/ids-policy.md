# Task ID Policy (Strict In/Strict Out)

This document defines the canonical policy for task identifiers across Minsky.

- Strict inputs: Only qualified IDs are accepted anywhere (e.g., `md#123`, `gh#456`).
- Strict storage and display: IDs are stored and displayed in the same qualified format.
- No legacy or numeric-only acceptance: Inputs like `#123` or `123` are not valid.
- No numeric-equivalence matching: We do not coerce or map IDs by numeric portions.

Rationale:
- Multi-backend safety: Different backends (markdown, GitHub issues, etc.) may not use numeric IDs, or they
  may reuse numeric values with different namespaces. Numeric-equivalence creates a risk of accidental cross-
  backend matches and data corruption.
- Determinism: Exact, qualified IDs ensure unambiguous resolution and better traceability.
- Security: Prevents unintended operations across backends when numeric IDs collide.

Implications:
- All APIs must validate IDs as qualified. Tests and fixtures must use `md#<n>`, `gh#<n>`, etc.
- No fallback matching by numeric portions in pure functions or services.
- Parsing utilities and formatters should preserve qualified IDs; any legacy content must be migrated before
  use.

Migration Guidance:
- If legacy IDs exist in content, they should be proactively migrated to qualified format as a separate step
  using content codemods or migration scripts, not at runtime.
