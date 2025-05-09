# Task #042: Update Minsky Rule Descriptions for Improved AI Triggering

## Context
The `description` field in the YAML frontmatter of Cursor rules (`.mdc` files) is critical for accurately triggering AI assistance. Currently, key Minsky workflow rules (`@minsky-workflow.mdc` and `@session-first-workflow.mdc`) lack proper frontmatter or have suboptimal descriptions. This can lead to these rules being applied inconsistently or in irrelevant contexts. Adherence to `@rule-creation-guidelines.mdc` is necessary to ensure descriptions are precise, concise, and trigger-focused.

## Objective
Update the YAML frontmatter and descriptions for specified Minsky rules to ensure they are correctly formatted and effectively guide AI rule application, improving the precision and relevance of AI assistance.

## Requirements

1.  **Standardize YAML Frontmatter:**
    *   Ensure `@minsky-workflow.mdc` and `@session-first-workflow.mdc` have a correctly formatted YAML frontmatter block at the very beginning of the file.
    *   The frontmatter should include `description`, `alwaysApply: true`, and `globs: ["**/*"]`.
    *   Remove any existing non-standard description sections from the body of the rules (e.g., the trailing description in `@session-first-workflow.mdc`).

2.  **Refine Rule Descriptions:**
    *   The `description` field must clearly and concisely state **when** the rule applies, adhering to `@rule-creation-guidelines.mdc`.
    *   Descriptions should be trigger-focused (e.g., starting with "REQUIRED when..." or "Use for...").

3.  **File Formatting:**
    *   Ensure there are no leading \`\`\` (code block markers) or extra blank lines before the YAML frontmatter or between the frontmatter and the main Markdown content.

## Specific Rule Updates

### 1. `.cursor/rules/minsky-workflow.mdc`
    *   **Issue:** Currently lacks YAML frontmatter. Content might start directly with a \`\`\` code block.
    *   **Action:**
        *   Add the following YAML frontmatter at the very beginning of the file:
            ```yaml
            ---
            description: REQUIRED for Minsky task/session lifecycle - CLI usage, task selection, session start/management, PRs.
            alwaysApply: true
            globs: ["**/*"]
            ---
            ```
        *   Ensure the Markdown content (`# Minsky Workflow...`) follows immediately after the closing `---`.

### 2. `.cursor/rules/session-first-workflow.mdc`
    *   **Issue:** Currently lacks YAML frontmatter. Content might start directly with a \`\`\` code block. Contains a "Rule Description (for discoverability and relevance)" section at the end of the file.
    *   **Action:**
        *   Add the following YAML frontmatter at the very beginning of the file:
            ```yaml
            ---
            description: REQUIRED when making any code, test, config, or doc change for a task IN A MINSKY SESSION WORKSPACE.
            alwaysApply: true
            globs: ["**/*"]
            ---
            ```
        *   Remove the entire "### Rule Description (for discoverability and relevance)" section from the end of the file.
        *   Ensure the Markdown content (`# Session-First Workflow...`) follows immediately after the closing `---`.

### 3. `.cursor/rules/task-status-verification.mdc` (Review only)
    *   **Current Description (assumed from fetch):** `REQUIRED when checking or reporting on task status to verify both tracking system status and actual implementation state`
    *   **Assessment:** This is mostly good but could be slightly more concise while retaining its specificity.
    *   **Proposed Change (for consideration by engineer):** `REQUIRED for in-depth task status checks - verifying tracking system against actual implementation.`
    *   **Action:** Engineer to review and apply if deemed an improvement for conciseness and AI trigger precision.

## Implementation Steps

1.  [ ] **Backup Existing Rules:** Before making changes, create backups of:
    *   `.cursor/rules/minsky-workflow.mdc`
    *   `.cursor/rules/session-first-workflow.mdc`
    *   `.cursor/rules/task-status-verification.mdc`
2.  [ ] **Edit `.cursor/rules/minsky-workflow.mdc`:**
    *   [ ] Prepend the specified YAML frontmatter.
    *   [ ] Remove any leading \`\`\` from the original content if present.
    *   [ ] Ensure correct formatting between frontmatter and content.
3.  [ ] **Edit `.cursor/rules/session-first-workflow.mdc`:**
    *   [ ] Prepend the specified YAML frontmatter.
    *   [ ] Remove the trailing "### Rule Description (for discoverability and relevance)" section.
    *   [ ] Remove any leading \`\`\` from the original content if present.
    *   [ ] Ensure correct formatting between frontmatter and content.
4.  [ ] **Review and Optionally Edit `.cursor/rules/task-status-verification.mdc`:**
    *   [ ] Evaluate the current description against the proposed change.
    *   [ ] If the proposed change is adopted, update the description in the YAML frontmatter.
5.  [ ] **Validate Changes:**
    *   [ ] Confirm all files are saved and correctly formatted.
    *   [ ] (If possible) Test with Cursor AI to observe if rule triggering behavior improves for relevant queries.

## Verification
- [ ] YAML frontmatter is correctly added/updated for `@minsky-workflow.mdc`.
- [ ] YAML frontmatter is correctly added/updated for `@session-first-workflow.mdc`.
- [ ] Redundant description section is removed from `@session-first-workflow.mdc`.
- [ ] Description for `@task-status-verification.mdc` is reviewed and updated if deemed an improvement.
- [ ] All edited rule files are correctly formatted according to MDC standards (frontmatter first, no leading \`\`\` before main content).
- [ ] The principles for rule descriptions (trigger-focused, concise, specific, action-oriented) have been applied.

## Additional Notes
* When fixing these files, be aware they might have unusual formatting. Some appear to start with code block markers (\`\`\`) which should be removed.
* The frontmatter and content need to be properly connected - no extra blank lines or code markers between the frontmatter's closing `---` and the start of the rule content.
* The YAML frontmatter must be the very first thing in each file, with no preceding whitespace or characters.
* The current rule files may resist simple edits due to this unusual structure. It might be necessary to completely replace the file content to ensure proper formatting. 
