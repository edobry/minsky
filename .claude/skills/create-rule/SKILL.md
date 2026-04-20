---
name: create-rule
description: >-
  Create or update Minsky rules with proper structure, frontmatter, and
  cross-references. Use when writing a new rule, modifying an existing rule,
  or reviewing rule quality.
user-invocable: true
---

# Create Rule

Create or update rules with proper structure, metadata, and cross-references.

## Arguments

Optional: rule name or description (e.g., `/create-rule no-magic-numbers`).

## Process

### 1. Define the rule's purpose

- What specific behavior does this rule govern?
- When should this rule be applied? (triggers)
- Is this a constraint (declarative) or a procedure (should be a skill instead)?

**Key distinction**: Rules are declarative constraints that are always-on or triggered by file patterns. Procedures and workflows should be skills, not rules.

### 2. Write the frontmatter

```yaml
---
description: "Use when [specific trigger]. Apply alongside [related-rule] for [context]."
globs: "**/*.ts" # Optional: file patterns that trigger this rule
alwaysApply: false # true only for universal constraints
tags: [category] # e.g., code-style, testing, architecture, safety, minsky
---
```

**Description guidelines:**

- Focus on WHEN the rule applies, not WHAT it instructs
- Begin with "Use when..." or "Guidelines for..."
- Include trigger keywords
- Use "REQUIRED" for non-negotiable rules
- Keep under 100 characters
- Test: "Would an AI correctly apply this rule based solely on this description?"

### 3. Structure the content

1. **Title** — clear, concise `# Title`
2. **Introduction** — 1-2 sentences summarizing purpose
3. **Core requirements** — bulleted list of key points
4. **Examples** — contrasting good/bad patterns:

   ```
   // AVOID
   badExample();

   // PREFER
   goodExample();
   ```

5. **Rationale** — only if not self-evident
6. **See also** — cross-references to related rules/skills

### 4. Follow quality principles

- **Concision**: Every word must count. AI assistants have limited attention.
- **Modularity**: One rule = one concern
- **No duplication**: Never repeat content from other rules
- **Hierarchy**: Most important information first
- **Clarity**: Simple language, concrete examples

### 5. Use the rules command

Create rules via `minsky rules create`, not by writing files directly:

```bash
minsky rules create my-rule --name "My Rule" --description "When to use"
```

Or via MCP: `mcp__minsky__rules_create`

## Anti-patterns

- **Verbose introductions** — don't waste words explaining the rule exists
- **Duplicate content** — cross-reference, don't copy
- **Vague descriptions** — "best practices" without specifics
- **Mixed concerns** — each rule governs exactly one area
- **Procedural content in rules** — multi-step workflows belong in skills

## Assessment checklist

- [ ] Precise description indicating when to apply
- [ ] No duplicated content from other rules
- [ ] Clear, specific language
- [ ] Concrete examples (correct and incorrect)
- [ ] Structured most-to-least important
- [ ] References to related rules/skills
- [ ] Could be correctly applied by an AI with limited attention
