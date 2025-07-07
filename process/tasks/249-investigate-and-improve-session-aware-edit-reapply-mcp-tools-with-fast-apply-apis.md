# Investigate and Improve Session-Aware Edit/Reapply MCP Tools with Fast-Apply APIs

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Investigate and Improve Session-Aware Edit/Reapply MCP Tools with Fast-Apply APIs

## Problem Statement

Our current session-aware edit tools (`session_edit_file`, `session_search_replace`) use a custom `applyEditPattern` function that attempts to merge edit patterns with `// ... existing code ...` markers into original content. This approach has several limitations:

1. **Performance Issues**: Custom pattern matching is slow compared to specialized fast-apply models
2. **Accuracy Problems**: Complex edge cases in pattern matching lead to incorrect merges
3. **No Reapply Functionality**: Missing the critical `reapply` tool for recovering from failed edits
4. **Maintenance Burden**: Custom logic requires ongoing maintenance and bug fixes

## Context

Recent developments in fast-apply model providers (Morph, Relace) offer specialized APIs for code editing that could significantly improve our MCP tools. These providers are optimized for applying partial code changes and could offer:

- **Performance**: 5-10x faster edit processing
- **Accuracy**: Better handling of complex edit scenarios
- **Reliability**: Reduced edge case failures
- **Features**: Built-in reapply functionality

## Goals

1. **Investigate Current Implementation**: Analyze how current approach works and whether it functions properly
2. **Evaluate Fast-Apply APIs**: Compare Morph, Relace, and other providers using standardized evaluation framework
3. **Design Improved Architecture**: Create integration plan for fast-apply APIs with evaluation infrastructure
4. **Implement Reapply Functionality**: Add missing `session_reapply` tool
5. **Upgrade Existing Tools**: Enhance `session_edit_file` and `session_search_replace` with evaluation-backed improvements
6. **Optimize Performance**: Achieve measurable speed and accuracy improvements validated by comprehensive evaluation

## Dependencies

- **Task #162**: AI Evals Framework for Rules, Context Construction, and Agent Operations
- **Task #202**: Rule Suggestion Evaluation and Optimization
- **Task #041**: Test Suite for Cursor Rules (eval-like model)
- **Task #158**: Implement Session-Aware Versions of Cursor Built-in Tools

## Requirements

### 1. Current Implementation Analysis

**1.1 Functional Verification**

- **Investigate HOW current approach works**: Deep dive into `applyEditPattern` algorithm and logic
- **Verify if it functions properly**: Test against various edit scenarios including edge cases
- Document actual vs intended behavior patterns
- Identify fundamental design flaws or implementation bugs

**1.2 Performance Profiling**

- Measure current `applyEditPattern` performance across different file sizes
- Analyze accuracy on complex edit scenarios with multiple markers
- Document current edge cases and failure modes
- Assess token usage and computational overhead

**1.3 Integration with Evaluation Framework**

- Establish baseline performance metrics using Task #162 evaluation infrastructure
- Create standardized test scenarios for measuring edit quality and speed
- Design evaluation criteria for comparing different approaches
- Set up automated testing pipeline for continuous assessment

### 2. Fast-Apply API Research

**2.1 Provider Evaluation**

- **Morph API**: Test integration capabilities and performance characteristics
- **Relace API**: Evaluate features and API design
- **Alternative Providers**: Research other fast-apply services
- **Cost Analysis**: Compare pricing models and usage patterns

**2.2 Integration Assessment**

- Document API structures and authentication requirements
- Analyze rate limiting and error handling approaches
- Evaluate fallback strategies for provider unavailability
- Test cross-provider compatibility and migration paths

### 3. Architecture Design

**3.1 Provider Abstraction Layer**

- Design provider-agnostic interface for fast-apply operations
- Create strategy pattern for provider selection and switching
- Implement fallback mechanisms for provider failures
- Add configuration system for provider preferences

**3.2 Session Integration**

- Enhance session-aware functionality with fast-apply providers
- Design edit history tracking and conflict detection
- Create session-specific provider configuration
- Implement context-aware edit optimization

### 4. Core Implementation

**4.1 Fast-Apply Service**

- Implement provider abstraction layer with pluggable backends
- Create Morph and Relace integration modules
- Add comprehensive error handling and retry logic
- Implement performance monitoring and metrics collection

**4.2 Session Reapply Tool**

- Create `session_reapply` MCP tool with enhanced model selection
- Implement intelligent reapply strategies based on edit history
- Add session-aware context management
- Integrate with existing error handling infrastructure

**4.3 Enhanced Edit Tools**

- Upgrade `session_edit_file` with fast-apply provider support
- Improve `session_search_replace` performance and accuracy
- Add provider selection options to tool parameters
- Maintain backward compatibility with existing workflows

### 5. Evaluation and Testing

**5.1 Performance Benchmarking**

- Use Task #162 evaluation framework for standardized comparison
- Measure speed improvements across different edit scenarios
- Assess accuracy improvements in complex merge situations
- Document quality metrics and performance gains

**5.2 Integration Testing**

- Test provider switching and fallback mechanisms
- Verify session-aware functionality across different contexts
- Validate error handling and recovery procedures
- Ensure compatibility with existing MCP tool ecosystem

## Implementation Phases

### Phase 1: Investigation and Analysis

1. **Current State Analysis**:

   - **Investigate HOW current approach works**: Deep dive into `applyEditPattern` algorithm and logic
   - **Verify if it functions properly**: Test against various edit scenarios including edge cases
   - Profile existing performance characteristics
   - Document limitations and failure modes using evaluation framework

2. **Fast-Apply API Research**:

   - Test Morph API integration and capabilities
   - Evaluate Relace API features and performance
   - Research alternative fast-apply providers
   - Document API requirements and integration complexity

3. **Evaluation Framework Integration**:
   - Set up standardized benchmarking using Task #162 infrastructure
   - Create comprehensive test scenarios for edit quality measurement
   - Establish baseline metrics for current implementation
   - Design evaluation criteria for provider comparison

### Phase 2: Architecture Design

1. **Design Fast-Apply Integration Layer**:

   - Create provider abstraction interfaces
   - Design strategy pattern for provider selection
   - Plan error handling and fallback strategies
   - Define performance monitoring approach

2. **Session Integration Design**:

   - Plan session-aware improvements
   - Design edit history tracking
   - Create conflict detection strategy
   - Define reapply functionality requirements

3. **Evaluation Integration**:
   - Design continuous evaluation pipeline
   - Plan A/B testing framework for provider comparison
   - Create quality metrics tracking system
   - Integrate with existing evaluation infrastructure

### Phase 3: Core Implementation

1. **Fast-Apply Service Implementation**:

   - Create provider abstraction layer
   - Implement Morph and Relace integrations
   - Add error handling and retry logic
   - Implement performance monitoring

2. **Session Reapply Tool**:

   - Create `session_reapply` MCP tool
   - Implement enhanced model selection
   - Add session-aware edit history
   - Integrate with existing error handling

3. **Evaluation Infrastructure**:
   - Implement automated testing pipeline
   - Create performance monitoring dashboard
   - Set up continuous evaluation processes
   - Integrate quality metrics collection

### Phase 4: Enhanced Edit Tools

1. **Upgrade Existing Tools**:

   - Enhance `session_edit_file` with fast-apply
   - Improve `session_search_replace` performance
   - Add provider selection options
   - Maintain backward compatibility

2. **XML Tool Calls Investigation**:
   - Research XML vs JSON performance
   - Implement proof-of-concept
   - Measure performance improvements using evaluation framework
   - Plan migration strategy if beneficial

### Phase 5: Testing and Validation

1. **Comprehensive Evaluation**:

   - Performance benchmarking using standardized eval framework
   - Quality assessment across various edit scenarios
   - Integration testing with existing systems
   - Regression testing to ensure compatibility

2. **Documentation and Rollout**:
   - Document evaluation results and performance improvements
   - Create migration guide with data-driven recommendations
   - Update MCP tool documentation
   - Plan phased rollout strategy with monitoring

## Expected Outcomes

1. **Performance Improvements**:

   - 5-10x speed improvement in edit processing
   - Reduced error rates in complex edit scenarios
   - Better handling of edge cases and large files

2. **Enhanced Functionality**:

   - New `session_reapply` tool for edit recovery
   - Provider selection options for different use cases
   - Improved session-aware edit tracking

3. **Architectural Benefits**:
   - Provider-agnostic design for future extensibility
   - Comprehensive error handling and fallback strategies
   - Integration with standardized evaluation framework

## Integration Points

### 1. Session Management

- **Integrates with**: Existing session-aware MCP tools
- **Extends**: Session context tracking and edit history
- **Enables**: Provider-specific session configuration

### 2. Error Handling

- **Builds on**: Current error handling infrastructure
- **Adds**: Provider-specific error recovery
- **Improves**: Edit failure recovery workflows

### 3. MCP Tool Ecosystem

- **Integrates with**: Existing MCP tool architecture
- **Maintains**: Backward compatibility
- **Extends**: Tool parameter options and capabilities

### 4. Performance Monitoring

- **Integrates with**: Existing logging infrastructure
- **Adds**: Provider performance metrics
- **Enables**: Cost tracking and optimization

### 5. Evaluation Framework Integration

- **Depends on**: Task #162 - AI Evals Framework for Rules, Context Construction, and Agent Operations
- **Coordinates with**: Task #202 - Rule Suggestion Evaluation and Optimization
- **Leverages**: Task #041 - Test Suite for Cursor Rules (eval-like model)
- **Enables**: Standardized performance and quality measurement across edit approaches

## Success Metrics

1. **Performance**: 5-10x improvement in edit processing speed
2. **Accuracy**: 90%+ reduction in edit merge failures
3. **Reliability**: 99.9% uptime with provider fallbacks
4. **Coverage**: Support for all current edit scenarios plus edge cases
5. **Adoption**: Seamless migration for existing workflows

## Risk Mitigation

1. **Provider Dependency**: Multiple provider support with fallback mechanisms
2. **API Changes**: Abstraction layer to isolate provider-specific changes
3. **Performance Regression**: Comprehensive benchmarking and rollback capability
4. **Compatibility**: Maintain existing API contracts and behavior
5. **Cost**: Monitor usage and implement cost controls

## Future Considerations

1. **Additional Providers**: Framework designed for easy provider addition
2. **Advanced Features**: Context-aware edit optimization
3. **Performance Optimization**: Caching and request batching
4. **Integration**: Potential integration with other AI-powered tools
5. **Evaluation Evolution**: Continuous improvement of evaluation criteria and processes


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
