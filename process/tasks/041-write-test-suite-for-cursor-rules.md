# Task #041: Write Test Suite for Cursor Rules

## Context

Currently, cursor rules are manually verified or tested ad-hoc. A systematic testing approach is needed to ensure rules are consistently applied and to catch regressions when rules are updated or new rules are added. An "eval-like" model would involve feeding test scenarios (mock user queries, codebase states) to the AI along with a specific rule, and then evaluating the AI's response/actions against expected outcomes.

## Objective

Develop a test suite and a testing harness for validating the behavior of cursor rules.

## Requirements

1.  **Test Harness Development:**

    - Create a mechanism to simulate AI interactions with cursor rules.
    - The harness should be able to:
      - Load a specific cursor rule.
      - Mock user queries and relevant context (e.g., open files, project structure, existing code).
      - Capture the AI's proposed actions (tool calls, messages).
      - Compare actual actions against expected actions defined in test cases.

2.  **Test Case Design:**

    - Develop a schema/format for defining test cases.
    - Each test case should include:
      - The rule being tested.
      - Input conditions (mock query, context).
      - Expected AI response/actions (e.g., specific tool call with certain parameters, a particular message content).
      - Criteria for passing/failing.

3.  **Rule Coverage:**

    - Initially, implement test cases for a subset of critical rules (e.g., `changelog`, `bun_over_node`, `constants-management`).
    - The framework should be extensible to easily add tests for new and existing rules.
    - Add special focus on testing the refactored Minsky workflow rules from task #067, including:
      - Testing individual rules (e.g., `minsky-cli-usage`, `task-implementation-workflow`)
      - Testing cross-rule scenarios that span multiple workflow rules
      - Verifying the orchestrator rule correctly directs to specific rules
      - Testing rule transitions (moving from one workflow phase to another)

4.  **Multi-Rule Interaction Testing:**

    - Test how rules interact when multiple rules are applicable
    - Verify cross-references between rules work correctly
    - Ensure the orchestrator rule (from task #067) properly coordinates other rules
    - Test common workflow scenarios that involve multiple rules:
      - Creating and managing sessions
      - Implementing tasks from start to completion
      - Preparing and submitting PRs

5.  **Evaluation Mechanism:**

    - Implement a way to "evaluate" the AI's response within the test harness. This might involve:
      - Checking for the presence/absence of specific tool calls.
      - Validating parameters of tool calls.
      - Pattern matching on AI-generated messages.
      - Checking for adherence to negative constraints (e.g., a rule that _shouldn't_ be triggered).
      - Verifying cross-references to other rules are followed correctly.

6.  **Reporting:**
    - The test suite should output a clear summary of test results, indicating passed and failed tests, and reasons for failures.

## Implementation Steps

1.  [ ] Design the architecture for the test harness.
2.  [ ] Define the data structures/schema for test cases.
3.  [ ] Implement the core test harness logic for loading rules and mocking inputs.
4.  [ ] Implement the evaluation engine for comparing actual vs. expected outputs.
5.  [ ] Develop initial test cases for 2-3 selected cursor rules.
6.  [ ] Add specific test cases for the refactored Minsky workflow rules (after task #067 is completed).
7.  [ ] Implement cross-rule testing capabilities to verify rule interaction.
8.  [ ] Implement the test runner and reporting mechanism.
9.  [ ] Document how to write and run tests for cursor rules.

## Verification

- [ ] The test suite can successfully run and report results for the implemented test cases.
- [ ] Test failures clearly indicate the discrepancy between actual and expected behavior.
- [ ] New test cases can be added to the suite with relative ease.
- [ ] The testing framework accurately reflects whether a rule is being followed correctly based on the test scenario.
- [ ] The test suite can verify proper cross-rule interaction, particularly for the refactored workflow rules.
- [ ] Test cases verify that the orchestrator rule from task #067 correctly guides users to the appropriate specific rules.

## Test Scenarios for Refactored Workflow Rules

1. **Basic Navigation Tests:**
   - User asks about available tasks → verify minsky-cli-usage is triggered
   - User requests to start a task → verify transition from cli-usage to session-management
   - User requests to implement a feature → verify task-implementation-workflow is triggered

2. **Cross-Reference Tests:**
   - Test that following a cross-reference in one rule leads to the correct application of the referenced rule
   - Verify that the orchestrator rule correctly guides users to the most relevant specific rule

3. **Workflow Sequence Tests:**
   - Create test cases that simulate a full workflow from task selection to PR submission
   - Verify that the appropriate rules are triggered at each step and in the correct sequence

4. **Error Handling Tests:**
   - Test scenarios where users attempt incorrect workflows to verify proper guidance
   - Verify that the rules provide appropriate error correction guidance
