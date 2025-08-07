# AI Guideline: Do Not Over-Optimize Indentation

## Context

The project utilizes a linter with autofix capabilities for code formatting, including indentation. Significant AI effort spent on perfecting indentation during code generation or modification is redundant and inefficient. This time could be better spent on more complex aspects of the coding task.

## Objective

Establish a guideline for AI behavior to not spend excessive time or effort on perfecting code indentation, relying instead on the project's linter and autofix capabilities to handle final formatting.

## Requirements

1.  **AI Behavior Modification**:
    - The AI should prioritize correct logic, structure, and adherence to other coding standards over pixel-perfect indentation.
    - The AI should not make multiple attempts to fix minor indentation issues if the code is otherwise functional and syntactically correct.
    - The AI should acknowledge that linting tools will handle final indentation.
2.  **Documentation (Optional, if this becomes a formal rule)**:
    - If this guideline is formalized into a project rule (e.g., a `.mdc` file), it should clearly state the rationale (linter autofix).

## Implementation Steps

1.  [ ] Discuss and confirm this guideline with the development team.
2.  [ ] If approved, consider adding this as a new rule or an addendum to an existing AI guidance document (e.g., within `.ai/rules/` or a relevant section of `user-preferences` or `self-improvement` rules).
3.  [ ] Communicate this guideline to any AI assistants working on the project.

## Verification

- [ ] AI demonstrates an understanding of this guideline by not repeatedly attempting to perfect indentation when linter autofix is available.
- [ ] Development workflow shows reduced time spent by AI on trivial formatting issues.
