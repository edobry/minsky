# Task 162: Implement AI Evals Framework Using Fast-Apply Infrastructure

## Status

BACKLOG

## Priority

HIGH

## Description

Implement a comprehensive evaluation framework for testing rules, context construction, and agent operations by **leveraging the proven fast-apply infrastructure from Task #249**. This approach reuses our successful Morph integration patterns, type-safe provider registry, and XML prompt structure for rapid, reliable evaluations.

## Foundation: Task #249 Success Patterns

This task directly builds on the successful infrastructure from Task #249:

- **✅ Fast-Apply Integration**: Proven Morph API integration with XML format compliance
- **✅ Type-Safe Provider Registry**: Compile-time validation for provider implementations  
- **✅ AI Provider System**: Working completion service and configuration management
- **✅ CLI Command Framework**: Established patterns for `minsky ai fast-apply` commands
- **✅ Session Integration**: MCP tools with session path resolution and workspace management
- **✅ XML Prompt Structure**: Validated `<instruction>`, `<code>`, `<update>` format

## Objectives

### Leverage Fast-Apply Infrastructure (Task #249 Foundation)

Build evaluation framework using proven patterns and infrastructure:

1. **Fast-Apply Evaluation Engine**

   - Extend existing AI provider system to support "evaluation" capability
   - Use Morph and other fast-apply providers for rapid rule compliance checking
   - Leverage XML prompt structure: `<instruction>`, `<code>`, `<evaluation>`
   - Reuse completion service and provider registry architecture

2. **Type-Safe Evaluation Provider Registry**

   - Extend `PROVIDER_FETCHER_REGISTRY` to include evaluation capabilities
   - Create `EvaluationProvider` interface similar to `TypedModelFetcher`
   - Enforce compile-time validation for evaluation provider implementations
   - Support multiple evaluation backends (Morph, OpenAI, Anthropic)

3. **CLI Evaluation Commands**

   - Implement `minsky eval rule` for rule compliance testing
   - Create `minsky eval context` for context construction evaluation
   - Add `minsky eval agent` for end-to-end agent task assessment
   - Follow same pattern as `minsky ai fast-apply` command structure

4. **Session-Aware Evaluation Tools**

   - Create `session.eval_rule` MCP tool for session-scoped evaluations
   - Implement `session.eval_context` for context quality assessment
   - Build `session.eval_output` for validating agent outputs
   - Reuse session path resolution and workspace management

5. **XML-Structured Evaluation Prompts**

   - Design evaluation-specific XML schemas for different eval types
   - Create structured prompts for rule compliance, context quality, output validation
   - Ensure consistent evaluation criteria across different providers
   - Support both automated scoring and detailed feedback generation

## Example Evaluation Types to Support

Using fast-apply infrastructure for rapid, reliable evaluations:

1. **Rule Compliance Testing** (`minsky eval rule`)

   ```xml
   <instruction>Evaluate if this code change follows the variable-naming-protocol rule</instruction>
   <code>Original code here</code>
   <evaluation>
   Rule: Variable Naming Protocol
   Change: [description of change made]
   Criteria: No underscores added to working variables
   Score: [0-10] with reasoning
   </evaluation>
   ```

2. **Context Construction Efficacy** (`minsky eval context`)

   ```xml
   <instruction>Assess context gathering quality for this agent interaction</instruction>
   <code>Agent session transcript</code>
   <evaluation>
   Context Quality Metrics:
   - Information completeness: [score/reasoning]
   - Relevance filtering: [score/reasoning]  
   - Efficiency: [score/reasoning]
   Overall: [score] with improvement suggestions
   </evaluation>
   ```

3. **Agent Task Performance** (`minsky eval agent`)

   ```xml
   <instruction>Evaluate agent task completion quality</instruction>
   <code>Task spec + Agent output</code>
   <evaluation>
   Task Completion Assessment:
   - Requirements met: [checklist]
   - Code quality: [score/feedback]
   - Protocol adherence: [score/feedback]
   - Overall success: [PASS/FAIL] with reasoning
   </evaluation>
   ```

4. **Fast-Apply Edit Quality** (`minsky eval edit`)

   ```xml
   <instruction>Assess quality of this fast-apply edit result</instruction>
   <code>Original + Edit Pattern + Result</code>
   <evaluation>
   Edit Quality Metrics:
   - Accuracy: Did changes match intent?
   - Completeness: Were all markers handled?
   - Code quality: Is result syntactically correct?
   - Score: [0-10] with specific feedback
   </evaluation>
   ```

## Implementation Deliverables

Building on proven Task #249 patterns and infrastructure:

1. **Extended AI Provider System**

   - Add `evaluation` capability to existing AI provider types
   - Extend `PROVIDER_FETCHER_REGISTRY` with evaluation provider support
   - Create `EvaluationCapability` interface for provider validation
   - Update `MorphModelFetcher` to support evaluation workflows

2. **CLI Evaluation Commands**

   - `minsky eval rule --rule-name <rule> --code-file <file> --change-description <desc>`
   - `minsky eval context --session <session> --interaction-id <id>`
   - `minsky eval agent --task-spec <file> --agent-output <file>`
   - `minsky eval edit --original <file> --edit-pattern <file> --result <file>`

3. **Session-Aware Evaluation MCP Tools**

   - `session.eval_rule` - Evaluate rule compliance in session context
   - `session.eval_context` - Assess context construction quality
   - `session.eval_output` - Validate agent outputs against specifications
   - Integration with existing session path resolution and workspace management

4. **XML Evaluation Prompt Templates**

   - Standardized XML schemas for each evaluation type
   - Template system for consistent evaluation criteria
   - Provider-agnostic prompt generation using existing completion service
   - Support for both scoring and detailed feedback modes

## Constraints

- **Leverage existing Task #249 infrastructure** - reuse proven patterns and code
- Use fast-apply providers (Morph, etc.) for rapid evaluation execution
- Must integrate seamlessly with existing Minsky architecture and tooling
- Leverage TypeScript/Bun ecosystem and existing AI provider system
- Support reproducible, versioned evaluations using XML structured prompts
- Maintain type safety with compile-time validation for evaluation providers

## Implementation Approach

Building on successful Task #249 patterns:

1. **Reuse AI Provider Infrastructure**: Extend existing provider registry and completion service
2. **XML Prompt Structure**: Use proven `<instruction>`, `<code>`, `<evaluation>` format
3. **CLI Command Pattern**: Follow `minsky ai fast-apply` command structure and design
4. **Session Integration**: Leverage existing session path resolution and MCP tool patterns
5. **Type Safety**: Extend type-safe provider registry to include evaluation capabilities
6. **Configuration Reuse**: Use existing AI provider configuration system

## Success Criteria

- **✅ Working CLI Commands**: `minsky eval rule/context/agent/edit` commands functional
- **✅ Session Integration**: Evaluation MCP tools working in session workflows  
- **✅ Fast-Apply Integration**: Morph and other providers executing evaluations rapidly
- **✅ Type Safety**: Compile-time validation for evaluation provider implementations
- **✅ XML Compliance**: Structured evaluation prompts following proven format
- **✅ Provider Extensibility**: Easy to add new evaluation providers and capabilities

## Dependencies

- **Task #249**: Fast-apply infrastructure must be completed and stable
- Access to Morph and other fast-apply providers for evaluation execution
- Understanding of current Minsky rule system and agent architecture  
- Existing AI provider configuration and completion service infrastructure
- Session management and MCP tool framework

## Implementation Plan

### Phase 1: Core Infrastructure Extension
1. Extend AI provider types to include `evaluation` capability
2. Update `PROVIDER_FETCHER_REGISTRY` with evaluation provider support
3. Create `EvaluationCapability` interface and validation logic

### Phase 2: CLI Evaluation Commands  
1. Implement `minsky eval rule` command using existing CLI patterns
2. Add `minsky eval context`, `minsky eval agent`, `minsky eval edit` commands
3. Create XML prompt templates for each evaluation type

### Phase 3: Session Integration
1. Implement `session.eval_rule` MCP tool
2. Add `session.eval_context` and `session.eval_output` tools
3. Integrate with existing session path resolution and workspace management

### Phase 4: Provider Integration & Testing
1. Update `MorphModelFetcher` to support evaluation workflows
2. Test evaluation commands with real Morph API integration
3. Add support for other evaluation-capable providers

## Notes

This task leverages the **proven success patterns from Task #249** to rapidly implement a comprehensive evaluation framework. By reusing existing infrastructure (AI providers, XML prompts, CLI patterns, session tools), we avoid the research overhead and architectural risk of building from scratch.

The evaluation framework will immediately benefit from fast-apply provider speeds and reliability, while maintaining type safety and extensibility for future enhancements.
