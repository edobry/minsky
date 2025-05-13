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

4.  **Evaluation Mechanism:**

    - Implement a way to "evaluate" the AI's response within the test harness. This might involve:
      - Checking for the presence/absence of specific tool calls.
      - Validating parameters of tool calls.
      - Pattern matching on AI-generated messages.
      - Checking for adherence to negative constraints (e.g., a rule that _shouldn't_ be triggered).

5.  **Reporting:**
    - The test suite should output a clear summary of test results, indicating passed and failed tests, and reasons for failures.

## Implementation Steps

1.  [ ] Design the architecture for the test harness.
2.  [ ] Define the data structures/schema for test cases.
3.  [ ] Implement the core test harness logic for loading rules and mocking inputs.
4.  [ ] Implement the evaluation engine for comparing actual vs. expected outputs.
5.  [ ] Develop initial test cases for 2-3 selected cursor rules.
6.  [ ] Implement the test runner and reporting mechanism.
7.  [ ] Document how to write and run tests for cursor rules.

## Verification

- [ ] The test suite can successfully run and report results for the implemented test cases.
- [ ] Test failures clearly indicate the discrepancy between actual and expected behavior.
- [ ] New test cases can be added to the suite with relative ease.
- [ ] The testing framework accurately reflects whether a rule is being followed correctly based on the test scenario.
