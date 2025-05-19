# Minsky Rules Relationship Matrix

This document provides a comprehensive overview of rule relationships in the Minsky project. Use it to understand how rules are organized into systems and how they relate to each other.

## Rule Systems Overview

| Rule System       | Router Rule                                                                        | Related Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testing           | [testing-router](mdc:.cursor/rules/testing-router.mdc)                             | [testing-boundaries](mdc:.cursor/rules/testing-boundaries.mdc), [bun-test-patterns](mdc:.cursor/rules/bun-test-patterns.mdc), [test-expectations](mdc:.cursor/rules/test-expectations.mdc), [framework-specific-tests](mdc:.cursor/rules/framework-specific-tests.mdc), [tests](mdc:.cursor/rules/tests.mdc), [test-debugging](mdc:.cursor/rules/test-debugging.mdc), [test-driven-bugfix](mdc:.cursor/rules/test-driven-bugfix.mdc), [test-infrastructure-patterns](mdc:.cursor/rules/test-infrastructure-patterns.mdc), [testable-design](mdc:.cursor/rules/testable-design.mdc), [testing-session-repo-changes](mdc:.cursor/rules/testing-session-repo-changes.mdc) |
| Error Handling    | [error-handling-router](mdc:.cursor/rules/error-handling-router.mdc)               | [robust-error-handling](mdc:.cursor/rules/robust-error-handling.mdc), [dont-ignore-errors](mdc:.cursor/rules/dont-ignore-errors.mdc)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Code Organization | [code-organization-router](mdc:.cursor/rules/code-organization-router.mdc)         | [domain-oriented-modules](mdc:.cursor/rules/domain-oriented-modules.mdc), [file-size](mdc:.cursor/rules/file-size.mdc), [constants-management](mdc:.cursor/rules/constants-management.mdc), [command-organization](mdc:.cursor/rules/command-organization.mdc), [no-dynamic-imports](mdc:.cursor/rules/no-dynamic-imports.mdc), [template-literals](mdc:.cursor/rules/template-literals.mdc)                                                                                                                                                                                                                                                                           |
| Workflow          | [minsky-workflow-orchestrator](mdc:.cursor/rules/minsky-workflow-orchestrator.mdc) | [session-first-workflow](mdc:.cursor/rules/session-first-workflow.mdc), [task-implementation-workflow](mdc:.cursor/rules/task-implementation-workflow.mdc), [task-status-protocol](mdc:.cursor/rules/task-status-protocol.mdc), [pr-preparation-workflow](mdc:.cursor/rules/pr-preparation-workflow.mdc), [minsky-session-management](mdc:.cursor/rules/minsky-session-management.mdc), [minsky-cli-usage](mdc:.cursor/rules/minsky-cli-usage.mdc)                                                                                                                                                                                                                     |
| Meta-Rules        | [self-improvement](mdc:.cursor/rules/self-improvement.mdc)                         | [rule-creation-guidelines](mdc:.cursor/rules/rule-creation-guidelines.mdc), [rules-management](mdc:.cursor/rules/rules-management.mdc), [user-preferences](mdc:.cursor/rules/user-preferences.mdc)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Rule Application Scenarios

| Scenario                | Primary Rule                 | Supporting Rules                                     |
| ----------------------- | ---------------------------- | ---------------------------------------------------- |
| Writing tests           | testing-router               | testing-boundaries, bun-test-patterns                |
| Handling errors         | error-handling-router        | robust-error-handling, dont-ignore-errors            |
| Organizing code         | code-organization-router     | domain-oriented-modules, file-size                   |
| Working with workflows  | minsky-workflow-orchestrator | session-first-workflow, task-implementation-workflow |
| Creating/updating rules | rule-creation-guidelines     | rules-management                                     |
| Addressing feedback     | self-improvement             | rule-creation-guidelines, user-preferences           |

## Rule Relationships Diagram

```
Testing System:
testing-router
├── testing-boundaries (Foundation)
├── bun-test-patterns (Foundation)
├── framework-specific-tests (Implementation)
├── test-infrastructure-patterns (Implementation)
├── designing-tests (Implementation)
├── test-debugging (Specialized)
├── test-expectations (Specialized)
└── test-driven-bugfix (Specialized)

Error Handling System:
error-handling-router
├── robust-error-handling
└── dont-ignore-errors

Code Organization System:
code-organization-router
├── domain-oriented-modules
├── file-size
├── constants-management
├── command-organization
├── no-dynamic-imports
└── template-literals

Workflow System:
minsky-workflow-orchestrator
├── session-first-workflow
├── task-implementation-workflow
├── task-status-protocol
├── pr-preparation-workflow
├── minsky-session-management
└── minsky-cli-usage

Meta-Rules System:
self-improvement
├── rule-creation-guidelines
├── rules-management
└── user-preferences
```

This matrix helps visualize how rules relate to each other and which rules to consult for specific scenarios.
