# Implement Session Reapply Tool with Fast-Apply Recovery

## Status

NEW

## Priority

HIGH

## Description

Implement the missing `session_reapply` MCP tool for intelligent edit recovery and enhancement using fast-apply providers. This task extracts the deferred reapply functionality from Task #249 and leverages extensive reverse engineering analysis already completed in Task #158.

**Context**: Task #249 successfully restored session edit functionality with fast-apply providers, but deferred reapply implementation to ensure focused development. The comprehensive reverse engineering analysis provides complete behavioral specifications for the reapply tool.

## Dependencies

- **Task #249**: ✅ COMPLETED - Fast-apply provider infrastructure and session edit tools
- **Task #158**: Comprehensive reverse engineering analysis of Cursor's reapply tool
- **Task #162**: AI Evals Framework for performance measurement
- **Task #202**: Rule Suggestion Evaluation and Optimization

## Problem Statement

**Current Gap**: Session-aware edit tools lack the critical `reapply` functionality that Cursor provides for:

1. **Edit Recovery**: When initial edits fail or are incomplete
2. **Enhancement Operations**: Improving existing edits with better models
3. **Error Correction**: Fixing malformed or incorrect edit attempts
4. **Context Completion**: Adding missing context or completing partial implementations

**Impact**: Without reapply functionality, users cannot recover from failed edits within session context, forcing manual intervention or session restarts.

## Goals

1. **Implement Session Reapply Tool**: Create `session_reapply` MCP tool matching Cursor's behavior
2. **Fast-Apply Integration**: Leverage existing fast-apply provider infrastructure from Task #249
3. **Enhanced Model Selection**: Use superior models for error recovery and enhancement
4. **Session Context Awareness**: Maintain session boundaries and edit history tracking
5. **Error Recovery Workflows**: Provide intelligent recovery from common edit failures

## Requirements

### 1. Behavioral Compatibility

**Reference**: `/test-verification/comprehensive-reverse-engineering-summary.md` Phase 1 Analysis

- **Smart Recovery**: Enhanced model selection for error recovery and completion
- **Context Awareness**: Understanding of edit history and session state
- **Enhancement Capabilities**: Ability to improve existing edits beyond simple recovery
- **Pattern Recognition**: Understanding of edit patterns and intentions

### 2. Technical Implementation

**2.1 Core Functionality**

- Create `session_reapply` MCP tool with session path resolution
- Implement fast-apply provider selection with fallback mechanisms
- Add edit history tracking and context management
- Integrate with existing error handling infrastructure

**2.2 Provider Integration**

- **Primary**: Use fast-apply providers (Morph) for optimal performance
- **Fallback**: Graceful degradation to standard AI providers (Claude, GPT-4)
- **Model Selection**: Enhanced models for complex recovery scenarios
- **Error Handling**: Robust recovery from provider failures

**2.3 Session Integration**

- **Path Resolution**: Use SessionPathResolver for workspace boundaries
- **Edit History**: Track previous edit attempts and outcomes
- **Context Management**: Maintain session-specific state and preferences
- **Security**: Enforce session isolation and access controls

### 3. Interface Specifications

**3.1 Tool Parameters**

```typescript
interface SessionReapplyArgs {
  sessionName: string;           // Target session identifier
  path: string;                  // File path within session workspace
  previousAttempt?: string;      // Previous edit attempt content (optional)
  targetOutcome?: string;        // Desired outcome description (optional)
  enhancementMode?: boolean;     // Enhancement vs recovery mode
  modelPreference?: string;      // Specific model for complex cases
}
```

**3.2 Response Format**

```typescript
interface SessionReapplyResponse {
  success: boolean;
  reapplied: boolean;
  enhanced: boolean;
  originalLength: number;
  resultLength: number;
  provider: string;
  model: string;
  editSummary: string;
  improvements?: string[];
  warnings?: string[];
}
```

### 4. Advanced Features

**4.1 Edit History Analysis**

- Track edit attempt patterns and failure modes
- Learn from successful recovery strategies
- Identify common error types and solutions
- Provide edit suggestion improvements

**4.2 Enhancement Modes**

- **Recovery Mode**: Fix failed or incomplete edits
- **Enhancement Mode**: Improve working but suboptimal edits
- **Completion Mode**: Complete partial implementations
- **Optimization Mode**: Optimize for performance or readability

**4.3 Context Integration**

- Integration with session edit history from Task #249
- Provider performance tracking and optimization
- Edit quality metrics and improvement suggestions
- Integration with evaluation framework from Task #162

## Implementation Plan

### Phase 1: Core Tool Implementation

**1.1 Basic Reapply Functionality**

- Create `session_reapply` MCP tool skeleton
- Implement session path resolution and validation
- Add basic file reading and writing operations
- Integrate with existing SessionPathResolver

**1.2 Provider Integration**

- Leverage fast-apply provider infrastructure from Task #249
- Implement enhanced model selection for recovery scenarios
- Add fallback mechanisms for provider unavailability
- Integrate with existing AI completion service

**1.3 Error Handling**

- Implement comprehensive error recovery patterns
- Add helpful error messages and suggestions
- Create fallback strategies for various failure modes
- Integrate with existing error handling infrastructure

### Phase 2: Enhanced Features

**2.1 Edit History Tracking**

- Design edit history storage and retrieval
- Implement session-aware context management
- Add edit attempt analysis and pattern recognition
- Create recovery strategy recommendations

**2.2 Enhancement Modes**

- Implement different reapply modes (recovery, enhancement, completion)
- Add intelligent mode selection based on context
- Create enhancement suggestion generation
- Implement quality improvement algorithms

**2.3 Performance Optimization**

- Add performance monitoring and metrics collection
- Implement caching for common recovery patterns
- Optimize provider selection for different scenarios
- Add cost tracking and optimization features

### Phase 3: Integration and Testing

**3.1 Tool Ecosystem Integration**

- Integrate with existing session edit tools
- Add reapply support to session edit workflows
- Create tool interoperability features
- Implement cross-tool context sharing

**3.2 Comprehensive Testing**

- Leverage existing test cases from reverse engineering analysis
- Create session-specific reapply test scenarios
- Implement performance and quality benchmarks
- Add integration tests with session edit tools

**3.3 Documentation and Validation**

- Document reapply tool behavior and capabilities
- Create usage examples and best practices
- Validate against Cursor's reapply behavior
- Implement continuous evaluation pipeline

## Expected Outcomes

### 1. Functional Capabilities

- **Session Reapply Tool**: Working `session_reapply` implementation with full session awareness
- **Edit Recovery**: Intelligent recovery from failed or incomplete edits
- **Enhancement Operations**: Ability to improve existing edits with better models
- **Context Awareness**: Session-specific edit history and preference management

### 2. Performance Benefits

- **Fast Recovery**: Rapid edit recovery using fast-apply providers
- **Quality Improvement**: Enhanced edit quality through superior model selection
- **Failure Reduction**: Reduced edit failures through intelligent recovery
- **Workflow Efficiency**: Streamlined edit recovery workflows

### 3. Integration Benefits

- **Seamless Integration**: Natural integration with existing session edit tools
- **Provider Leverage**: Full utilization of fast-apply provider infrastructure
- **Error Resilience**: Robust error handling and recovery mechanisms
- **Performance Monitoring**: Comprehensive metrics and optimization insights

## Success Metrics

1. **Functionality**: Working reapply tool with >95% success rate on recovery scenarios
2. **Compatibility**: 100% behavioral compatibility with Cursor's reapply tool
3. **Performance**: <3s recovery time for typical edit failures
4. **Integration**: Seamless workflow with existing session edit tools
5. **Quality**: Measurable improvement in edit success rates after reapply operations

## Implementation Strategy

### Leverage Existing Analysis

**Primary Resource**: `test-verification/comprehensive-reverse-engineering-summary.md`

- **Phase 1 Analysis**: Complete behavioral documentation for reapply tool
- **Test Cases**: Ready-to-implement test scenarios and validation cases
- **Interface Specifications**: Detailed parameter and response format documentation
- **Performance Benchmarks**: Established performance standards and expectations

### Build on Task #249 Infrastructure

- **Fast-Apply Providers**: Leverage Morph integration and fallback mechanisms
- **AI Completion Service**: Use existing provider abstraction and model selection
- **Session Management**: Build on established session path resolution and security
- **Error Handling**: Extend existing error handling patterns and recovery strategies

### Validation Framework

- **Behavioral Testing**: Use existing Phase 1 validation tests from reverse engineering
- **Performance Testing**: Integrate with Task #162 evaluation framework
- **Integration Testing**: Validate seamless operation with session edit tools
- **Quality Assurance**: Continuous evaluation and improvement pipeline

## Risk Mitigation

1. **Behavioral Compatibility**: Extensive test suite from reverse engineering analysis
2. **Provider Dependency**: Leverage existing fallback mechanisms from Task #249
3. **Performance Regression**: Comprehensive benchmarking and monitoring
4. **Integration Complexity**: Incremental implementation with existing infrastructure
5. **Quality Assurance**: Continuous evaluation and validation framework

## Future Enhancements

1. **Advanced Recovery**: Machine learning-based recovery pattern recognition
2. **Collaborative Features**: Multi-user edit recovery and conflict resolution
3. **Intelligent Suggestions**: Proactive edit improvement recommendations
4. **Performance Optimization**: Advanced caching and request optimization
5. **Provider Expansion**: Support for additional fast-apply providers as they become available

## Conclusion

This task implements the critical missing reapply functionality for session-aware edit tools, leveraging comprehensive reverse engineering analysis and fast-apply provider infrastructure. The implementation will provide intelligent edit recovery, enhancement capabilities, and seamless integration with existing session tools, completing the session-aware editing ecosystem. 
