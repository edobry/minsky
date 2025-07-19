# Explore Exposing Rules and Documentation as MCP Resources with Template Integration

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Context

Currently, Minsky's documentation, rules, and help content exist as static files and CLI output. With the planned template-based rules generation system (Task #289), there's an opportunity to explore exposing this content as MCP resources to help AI agents better understand Minsky's purpose, functionality, and workflows.

The goal is to investigate how to:
1. Expose documentation and rules as MCP resources (not just tools)
2. Integrate with the templating system to avoid content redundancy
3. Create agent-optimized documentation that helps AI understand Minsky's purpose and workflows
4. Template CLI help text and other documentation to maintain consistency

## Research Areas

### 1. MCP Resource System Investigation
- **MCP Resource Capabilities**: Research what types of content can be exposed as MCP resources
- **Resource Discovery**: How agents discover and access available resources
- **Content Formatting**: What formats work best for AI consumption vs human consumption
- **Dynamic Resources**: Can resources be generated on-demand or must they be static?

### 2. Content Analysis and Mapping
- **Current Documentation Audit**: Catalog all existing documentation (README, CLI help, rules, etc.)
- **Content Overlap Analysis**: Identify redundant content across CLI help, rules, and documentation
- **Agent Information Needs**: Determine what information agents need to effectively use Minsky
- **Content Hierarchy**: Map relationships between different types of documentation

### 3. Template Integration Opportunities
- **Shared Content Templates**: Identify content that appears in multiple places (CLI help, rules, README)
- **Template-Driven Resources**: How templated content from #289 could generate MCP resources
- **Configuration-Driven Content**: Resources that adapt based on project configuration (CLI vs MCP setup)
- **Dynamic Generation**: Real-time resource generation based on current project state

### 4. Agent-Optimized Documentation Design
- **README Alternative**: Create agent-focused introduction to Minsky that's more structured than current README
- **Workflow Documentation**: Expose workflow patterns as consumable resources
- **Command Reference**: Structured command documentation that complements tool calls
- **Context-Aware Help**: Resources that provide relevant help based on current project state

## Specific Investigation Areas

### Documentation as Resources
```typescript
// Example resource types to explore
interface MinskyDocumentationResource {
  // Agent introduction to Minsky
  "minsky/introduction": AgentIntroDocument;
  
  // Workflow patterns and best practices  
  "minsky/workflows": WorkflowPatternsDocument;
  
  // Command reference with examples
  "minsky/commands": CommandReferenceDocument;
  
  // Current project context
  "minsky/project-status": ProjectStatusDocument;
}
```

### Template-Driven Resource Generation
- How resources could be generated from the same templates as rules and CLI help
- Configuration-driven resource content (different content for CLI vs MCP projects)
- Real-time resource updates based on project state
- Resource versioning and caching strategies

### CLI Help Integration
- Extract structured information from CLI command help
- Template CLI help text to share content with other documentation
- Expose command help as structured resources rather than plain text
- Maintain single source of truth for command documentation

## Research Questions

1. **MCP Resource Architecture**
   - What are the capabilities and limitations of MCP resources?
   - How do resources differ from tools in terms of AI agent interaction?
   - Can resources be dynamically generated or must they be pre-computed?

2. **Content Strategy**
   - What's the optimal structure for agent-consumable documentation?
   - How can we avoid duplication between CLI help, rules, and documentation?
   - What information do agents need that isn't currently well-exposed?

3. **Template Integration**
   - How can the template system from #289 drive resource generation?
   - What content should be templated vs static?
   - How do we handle configuration-dependent content in resources?

4. **Implementation Approach**
   - Should resources be generated at build time, runtime, or on-demand?
   - How do we handle resource discovery and indexing?
   - What's the relationship between templated rules and templated resources?

## Deliverables

### Research Output
- **MCP Resource Capabilities Report**: Detailed analysis of what's possible with MCP resources
- **Content Mapping Document**: Comprehensive audit of current documentation and overlap analysis
- **Template Integration Strategy**: How templating system can drive resource generation
- **Agent Documentation Requirements**: What agents need to effectively work with Minsky

### Proof of Concept
- **Basic Resource Exposure**: Simple implementation exposing key documentation as resources
- **Template-Driven Resource**: Example of resource generated from template system
- **Agent Interaction Demo**: Show how agents can discover and use exposed resources
- **Performance Analysis**: Resource generation and access performance characteristics

### Implementation Plan
- **Architecture Design**: Detailed design for production resource system
- **Integration Points**: How resources integrate with templating system and existing CLI
- **Migration Strategy**: How to transition from current documentation to resource-based approach
- **Testing Strategy**: How to validate resource content and agent interaction

## Dependencies

- **Task #289**: Template-based rules generation system (prerequisite for template integration)
- **MCP Server Infrastructure**: Current MCP implementation for extending with resources
- **CLI Architecture**: Understanding of current CLI help and documentation structure
- **Rules System**: Current rule content and generation logic

## Success Criteria

- [ ] Clear understanding of MCP resource capabilities and limitations
- [ ] Comprehensive mapping of content overlap and templating opportunities  
- [ ] Working proof of concept for exposing documentation as MCP resources
- [ ] Integration strategy with template system from Task #289
- [ ] Implementation plan for production resource system
- [ ] Demonstration of improved agent understanding of Minsky through resources

## Notes

This is an exploratory task that will likely evolve as we learn more about MCP resource capabilities and as prerequisite tasks (especially #289) are implemented. The scope may expand or contract based on findings during the research phase.

The goal is to establish a foundation for making Minsky more AI-agent-friendly by exposing its documentation and knowledge in structured, discoverable ways that complement the tool-based MCP interface.

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
