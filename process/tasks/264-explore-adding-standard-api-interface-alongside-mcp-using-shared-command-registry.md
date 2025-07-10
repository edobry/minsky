# Explore Adding Standard API Interface Alongside MCP Using Shared Command Registry

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Context

Minsky currently uses the Model Context Protocol (MCP) as its primary interface for AI agent interactions. While MCP is excellent for AI-to-AI communication, there is value in exploring the addition of a more standard API interface (such as REST API) to make Minsky's capabilities accessible to a broader range of clients and integrations.

The shared command registry architecture that currently supports MCP can be extended to expose the same commands through standard API endpoints, providing consistency across interfaces while maintaining the flexibility to add new interface types in the future.

## Objectives

1. **Research Standard API Options**

   - Evaluate REST API, GraphQL, and other standard API approaches
   - Analyze how these could complement MCP without duplicating functionality
   - Identify the most suitable standard API format for Minsky's use cases

2. **Design Shared Command Registry Extension**

   - Design how the existing shared command registry can be extended to support standard API endpoints
   - Ensure command definitions can be reused across MCP and standard API interfaces
   - Define how authentication, validation, and error handling should work across interfaces

3. **Proof of Concept Implementation**

   - Create a basic proof of concept that exposes a subset of Minsky commands through a standard API
   - Demonstrate that the same command definitions can serve both MCP and standard API interfaces
   - Validate the architecture with real API calls

4. **Interface Consistency Strategy**
   - Define how to maintain consistency between MCP and standard API interfaces
   - Establish patterns for command input/output translation between interfaces
   - Document the dual-interface architecture for future development

## Requirements

### Research Phase

- [ ] **API Format Analysis**

  - Research REST API best practices and conventions
  - Evaluate GraphQL as an alternative approach
  - Consider other standard API formats (OpenAPI, JSON-RPC, etc.)
  - Document pros/cons of each approach for Minsky's use cases

- [ ] **Integration Architecture Design**
  - Design how standard API endpoints can reuse existing command registry
  - Define the interface abstraction layer between command registry and API adapters
  - Plan authentication and authorization strategy for standard API access
  - Design error handling and response formatting for standard APIs

### Proof of Concept Phase

- [ ] **Core Infrastructure**

  - Extend the shared command registry to support multiple interface types
  - Create API adapter interface that can translate between standard API calls and command registry
  - Implement basic HTTP server infrastructure for standard API endpoints

- [ ] **Command Exposure**

  - Select a representative subset of Minsky commands for the proof of concept
  - Implement REST API endpoints for selected commands
  - Ensure the same command definitions work for both MCP and REST interfaces
  - Test command execution through both interfaces

- [ ] **Documentation and Examples**
  - Create API documentation for the exposed endpoints
  - Provide example API calls and responses
  - Document the dual-interface architecture and design patterns
  - Create usage examples for different client types

### Integration Strategy

- [ ] **Command Registry Enhancement**

  - Extend command metadata to include API-specific information (HTTP methods, paths, etc.)
  - Add interface-agnostic validation and transformation capabilities
  - Implement adapter pattern for different interface types

- [ ] **Interface Consistency**
  - Define how command inputs/outputs are translated between interfaces
  - Establish naming conventions and response formats for standard APIs
  - Create testing strategy to ensure consistency across interfaces

## Verification Criteria

- [ ] **Research Deliverables**

  - Comprehensive analysis document comparing different standard API approaches
  - Architecture design document for dual-interface system
  - Decision matrix for selecting the most appropriate standard API format

- [ ] **Proof of Concept Deliverables**

  - Working proof of concept with at least 3-5 commands exposed through standard API
  - Demonstration that the same command definitions work for both MCP and standard API
  - Performance benchmarks comparing MCP vs standard API response times
  - API documentation with examples

- [ ] **Architecture Validation**
  - Proof that the shared command registry can efficiently serve multiple interface types
  - Evidence that new commands can be easily added to both interfaces
  - Documentation of the patterns and best practices for dual-interface development

## Success Metrics

- Standard API endpoints successfully execute the same commands as MCP interface
- Response times for standard API are within acceptable performance parameters
- Architecture supports easy addition of new interface types in the future
- Documentation and examples enable other developers to understand and extend the system

## Future Considerations

- How additional interface types (WebSocket, gRPC, etc.) could be added to the architecture
- Integration with existing API management tools and services
- Potential for API versioning and backwards compatibility
- Considerations for rate limiting, caching, and scaling standard API endpoints


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
