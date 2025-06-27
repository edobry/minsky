# Task #150: Design Containerized Session Workspace Architecture

## Context

This task extracts the containerization analysis from Task #049 to maintain focus on the immediate implementation of session-aware tools. The session-aware tools designed in Task #049 provide the foundation, but we need a comprehensive architecture for deploying session workspaces in Docker and Kubernetes environments.

## Background

Plans are underway to run session workspaces in Docker containers (initially local, then remote/K8s). This requires:

1. **Deployment Model**: Sessions will run in isolated Docker containers
2. **Network Boundaries**: File operations must cross container boundaries
3. **Resource Constraints**: Solutions must minimize per-container overhead  
4. **Remote Future**: Architecture must work with distributed containers

## Requirements

1. **Container Deployment Architecture**
   - Design how session containers are created, managed, and destroyed
   - Define container lifecycle integration with session management
   - Plan for local Docker and remote Kubernetes deployment scenarios
   - Consider container resource allocation and scaling strategies

2. **Session-to-Container Mapping**
   - Design service registry for mapping session IDs to container endpoints
   - Handle container health checks and recovery mechanisms
   - Support container migration and failover scenarios
   - Plan for multiple deployment models (local Docker, K8s, mixed)

3. **Container Communication Layer**
   - Determine how session-aware tools communicate with containers
   - Evaluate: Container APIs vs. Per-Container MCP Servers vs. Hybrid approaches
   - Design authentication and authorization for container access
   - Plan for network topology across deployment scenarios

4. **Deployment Scenarios Support**
   - **Local Docker**: Multiple containers on same machine
   - **Kubernetes**: Multiple pods across nodes with service discovery
   - **Mixed**: Some sessions containerized, some local
   - **Remote**: Full distributed deployment with networking considerations

## Analysis From Task #049

### Approach Comparison for Docker

#### **A. Session MCP Server Per Container**
```
AI Agent → Session 1 MCP (port 3001) → Container 1 Files
AI Agent → Session 2 MCP (port 3002) → Container 2 Files
```
**Pros**: Zero new code, perfect isolation, full MCP features
**Cons**: Memory overhead, connection management complexity

#### **B. Custom Container API**
```
AI Agent → Central MCP → Container API → Container Files
```
**Pros**: Lightweight, consistent interface, single connection
**Cons**: New component to build, limited to file operations

#### **C. Session-Specific Tools** (From Task #049)
```
AI Agent → Central MCP → session_edit_file(session_id) → Container
```
**Pros**: Unified interface, deployment agnostic, explicit context
**Cons**: Requires session routing infrastructure

### Service Discovery Analysis

**Port Management**: 
- Per-Container MCP requires port registry
- Container API requires service registry
- Session Tools need single MCP + session routing

**K8s Integration**: Session Tools approach scales best with K8s service discovery

**Resource Usage**: Session Tools most efficient (single MCP server)

## Implementation Considerations

1. **Container Image Design**
   - Base image with Minsky tooling
   - Session workspace volume mounting strategy
   - Container API or MCP server implementation
   - Health check and monitoring setup

2. **Orchestration Integration**
   - Docker Compose for local development
   - Kubernetes manifests for production
   - Service mesh considerations
   - Load balancing and ingress setup

3. **Migration Strategy**
   - Backward compatibility with local sessions
   - Gradual migration path from local to containerized
   - Rollback capabilities and hybrid deployment support

## Success Criteria

- [ ] Clear architecture for local Docker deployment
- [ ] Comprehensive Kubernetes deployment strategy
- [ ] Service discovery and container lifecycle management
- [ ] Performance benchmarks and resource usage analysis
- [ ] Migration path from local sessions to containerized
- [ ] Support for mixed deployment scenarios
- [ ] Documentation for deployment and operations

## Relationship to Task #049

This task builds on the session-aware tools interface designed in Task #049. The tools (`session_edit_file`, etc.) will remain the same - only the backend implementation changes to route to containers instead of local filesystem.

## Work Log

- 2025-06-17: Extracted from Task #049 to maintain implementation focus
- 2025-06-17: Documented analysis findings and requirements 
