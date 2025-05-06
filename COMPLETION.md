# Task 022 Completion

Fixed the syntax error in startSession.test.ts by removing extra closing parentheses from trackCalls function calls.

The issue was that lines with trackCalls<Promise<{ workdir: string }>>() had an extra closing parenthesis and should have been trackCalls<Promise<{ workdir: string }>>().

All tests in the file now pass successfully.
