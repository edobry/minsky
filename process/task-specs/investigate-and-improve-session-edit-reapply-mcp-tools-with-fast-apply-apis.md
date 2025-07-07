# Investigate and Improve Session-Aware Edit/Reapply MCP Tools with Fast-Apply APIs

## Problem Statement

Our current session-aware edit tools (`session_edit_file`, `session_search_replace`) use a custom `applyEditPattern` function that attempts to merge edit patterns with `// ... existing code ...` markers into original content. This approach has several limitations:

1. **Performance Issues**: Custom pattern matching is slow compared to specialized fast-apply models
2. **Accuracy Problems**: Complex edge cases in pattern matching lead to incorrect merges
3. **No Reapply Functionality**: Missing the critical `reapply` tool for recovering from failed edits
4. **Maintenance Burden**: Custom merge logic is complex and error-prone

Meanwhile, specialized fast-apply model providers like [Morph](https://docs.morphllm.com/guides/oneshot) and [Relace](https://docs.relace.ai/docs/instant-apply/quickstart) offer significant advantages:

- **Speed**: 1000+ tokens/sec vs 100-200 for full rewrites
- **Accuracy**: ~98% accuracy with specialized training on edit patterns
- **Reliability**: Handle edge cases better than deterministic algorithms
- **Cost-Effectiveness**: Pay only for actual changes, not unchanged code

## Context

**Current State:**

- ✅ **Session Edit Tools**: `session_edit_file` and `session_search_replace` implemented
- ✅ **Session Workspace**: Proper isolation and path resolution
- ✅ **MCP Integration**: Tools registered with FastMCP server
- ✅ **Error Handling**: Comprehensive error handling and logging
- ❌ **Reapply Functionality**: No `session_reapply` tool implemented
- ❌ **Fast-Apply Integration**: No integration with specialized apply models
- ❌ **Performance Optimization**: Using custom pattern matching instead of specialized models

**Architecture Foundation:**

- Existing `SessionPathResolver` for workspace isolation
- `CommandMapper` for MCP tool registration
- Session-aware file operations with proper error handling
- Test infrastructure for validating edit operations

**Research Context:**

Based on industry research and implementations:

- **Cursor AI**: Achieved 9x speedup with speculative edits and fast-apply models
- **Morph**: Provides OpenAI-compatible API with `morph-v3-large` model
- **Relace**: Offers instant apply with 2000+ tokens/sec performance
- **XML Tool Calls**: Research shows 30% fewer malformed calls vs JSON

## Goals

1. **Investigate Current Implementation**: Analyze how current approach works and whether it functions properly
2. **Evaluate Fast-Apply APIs**: Compare Morph, Relace, and other providers using standardized evaluation framework
3. **Design Improved Architecture**: Create integration plan for fast-apply APIs with evaluation infrastructure
4. **Implement Reapply Functionality**: Add missing `session_reapply` tool
5. **Upgrade Existing Tools**: Enhance `session_edit_file` and `session_search_replace`
6. **Optimize Performance**: Achieve significant speed and accuracy improvements with measurable results

## Detailed Requirements

### 1. Current Implementation Analysis

**1.1 Functional Verification**

- **Investigate HOW current approach works**: Deep dive into `applyEditPattern` algorithm and logic
- **Verify if it functions properly**: Test current implementation against various edit scenarios
- Document actual behavior vs intended behavior
- Identify fundamental design flaws or implementation bugs
- Test edge cases and complex merge scenarios

**1.2 Performance Profiling**

- Profile existing `applyEditPattern` function performance
- Measure accuracy on complex edit scenarios
- Document current edge cases and failure modes
- Analyze token usage and computational overhead

**1.3 Code Quality Assessment**

- Review `applyEditPattern` complexity and maintainability
- Identify brittle pattern matching logic
- Document test coverage gaps
- Assess error handling completeness

**1.4 User Experience Evaluation**

- Analyze current tool reliability from user perspective
- Document common failure scenarios
- Assess recovery options when edits fail
- Measure typical response times

### 2. Fast-Apply API Research

**2.1 Morph API Analysis**

Research and document:

- API structure and authentication
- Model capabilities (`morph-v3-large`)
- Performance characteristics
- Pricing and rate limits
- Error handling and recovery
- Integration complexity

**2.2 Relace API Analysis**

Research and document:

- Instant Apply API structure
- Performance specs (2000+ tokens/sec)
- Accuracy metrics (~98%)
- Cost structure
- Integration requirements
- Availability and reliability

**2.3 Alternative Providers**

Investigate other fast-apply providers:

- OpenAI potential capabilities
- Anthropic speculative decoding
- Open-source alternatives
- Self-hosted options

### 3. Comparative Analysis

**3.1 Performance Comparison**

Create benchmarks comparing:

- **Speed**: Current vs fast-apply APIs
- **Accuracy**: Success rate on complex edits
- **Reliability**: Failure modes and recovery
- **Cost**: Computational vs API costs

**3.2 Integration Complexity**

Evaluate:

- API integration effort
- Error handling requirements
- Fallback strategy complexity
- Testing and validation needs

**3.3 Strategic Recommendations**

Document recommendations for:

- Primary fast-apply provider choice
- Fallback provider strategy
- Migration approach
- Cost-benefit analysis

### 4. Architecture Design

**4.1 Fast-Apply Integration Layer**

Design abstraction layer:

```typescript
interface FastApplyProvider {
  name: string;
  applyEdit(originalCode: string, editSnippet: string): Promise<FastApplyResult>;
  supportsLanguage(language: string): boolean;
  getEstimatedCost(originalCode: string, editSnippet: string): number;
}

interface FastApplyResult {
  success: boolean;
  mergedCode?: string;
  error?: string;
  confidence?: number;
  tokensUsed?: number;
  processingTime?: number;
}
```

**4.2 Provider Strategy Pattern**

Implement strategy pattern:

- Primary provider (e.g., Morph)
- Secondary provider (e.g., Relace)
- Fallback to current implementation
- Provider selection based on file size/complexity

**4.3 Session Integration**

Design session-aware improvements:

- Track edit history for better reapply
- Session-scoped provider configuration
- Edit conflict detection and resolution
- Performance metrics per session

### 5. Implementation Requirements

**5.1 Core Fast-Apply Service**

Create `src/adapters/mcp/fast-apply-service.ts`:

- Provider abstraction layer
- Multi-provider support with fallback
- Error handling and retry logic
- Performance monitoring and logging
- Cost tracking and optimization

**5.2 Enhanced Session Edit Tools**

Upgrade existing tools:

- `session_edit_file`: Use fast-apply for `// ... existing code ...` patterns
- `session_search_replace`: Leverage fast-apply for complex replacements
- Maintain backward compatibility
- Add performance mode selection

**5.3 New Session Reapply Tool**

Implement `session_reapply` tool:

```typescript
interface SessionReapplyArgs {
  session: string;
  path: string;
  provider?: string; // Optional provider override
  useEnhancedModel?: boolean; // Use more sophisticated model
}
```

**5.4 XML Tool Calls Investigation**

Research XML vs JSON tool calls:

- Performance comparison
- Error rate analysis
- Integration complexity
- Migration strategy

### 6. Testing Strategy

**6.1 Performance Testing**

Create comprehensive benchmarks:

- Speed comparison across providers
- Accuracy testing on complex edits
- Cost analysis per operation
- Scalability testing

**6.2 Integration Testing**

Test session-aware functionality:

- Edit operations across session boundaries
- Reapply functionality with various failure modes
- Provider failover scenarios
- Error recovery workflows

**6.3 Regression Testing**

Ensure backward compatibility:

- Existing edit patterns continue working
- Session isolation maintained
- Error handling preserved
- Performance doesn't regress for simple cases

## Technical Implementation Plan

### Phase 1: Investigation and Analysis

1. **Current State Analysis**:

   - **Investigate HOW current approach works**: Deep dive into `applyEditPattern` algorithm and logic
   - **Verify if it functions properly**: Test current implementation against various edit scenarios
   - Document actual behavior vs intended behavior
   - Identify fundamental design flaws or implementation bugs
   - Profile existing performance characteristics
   - Document edge cases and failure modes
   - Analyze test coverage and identify gaps
   - Create baseline performance metrics

2. **Fast-Apply API Research**:

   - Test Morph API integration
   - Evaluate Relace API capabilities
   - Research alternative providers
   - Document API structures and requirements

3. **Comparative Analysis with Eval Framework Integration**:
   - Create performance benchmarks using Task #162 evaluation framework
   - Analyze cost-benefit of each approach
   - Document integration complexity
   - Provide strategic recommendations
   - Establish evaluation criteria for quality and performance comparison

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

3. **Evaluation Integration Design**:
   - Define evaluation metrics for edit quality and performance
   - Design integration with Task #162 AI evals framework
   - Plan automated comparison testing between approaches
   - Create evaluation datasets for reliable performance measurement

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
   - Implement evaluation harness for comparing approaches
   - Create test suites for quality and performance measurement
   - Integrate with Task #162 evaluation framework
   - Establish baseline measurements for current implementation

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
   - Plan phased rollout strategy based on evaluation outcomes

## Architecture Integration Points

### 1. MCP Tool Registration

- **Extends**: Existing `CommandMapper` and tool registration
- **Integrates with**: `SessionPathResolver` for workspace isolation
- **Maintains**: Current MCP tool interface patterns

### 2. Session Management

- **Builds on**: Existing session workspace functionality
- **Integrates with**: Session-aware file operations
- **Enhances**: Edit history and conflict detection

### 3. Error Handling

- **Leverages**: Existing error handling infrastructure
- **Extends**: Provider-specific error recovery
- **Maintains**: Session isolation and security

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

### 1. Performance Improvements

- **Speed**: 5-10x improvement in edit application time
- **Accuracy**: >95% success rate on complex edits
- **Reliability**: <2% failure rate with proper fallback

### 2. User Experience

- **Responsiveness**: Sub-second response for typical edits
- **Reliability**: Consistent behavior across edit patterns
- **Recovery**: Effective reapply functionality for failed edits

### 3. Technical Quality

- **Maintainability**: Simplified codebase with provider abstractions
- **Testability**: Comprehensive test coverage for all scenarios
- **Extensibility**: Easy addition of new fast-apply providers

## Risk Mitigation

### 1. API Dependencies

- **Risk**: Fast-apply API availability and reliability
- **Mitigation**: Multiple provider support with fallback to current implementation

### 2. Cost Management

- **Risk**: Unexpected API costs
- **Mitigation**: Cost tracking, rate limiting, and provider selection optimization

### 3. Compatibility

- **Risk**: Breaking existing functionality
- **Mitigation**: Comprehensive regression testing and backward compatibility

### 4. Performance Regression

- **Risk**: Slower performance for simple edits
- **Mitigation**: Smart provider selection based on edit complexity

## Future Considerations

### 1. Model Training

- Potential for training custom fast-apply models
- Integration with local model deployment
- Cost optimization through specialized models

### 2. Advanced Features

- Multi-file edit coordination
- Conflict resolution across sessions
- AI-powered edit suggestions
- Integration with code analysis tools

### 3. Ecosystem Integration

- Integration with other MCP tools
- Support for additional programming languages
- Advanced session management features
- Performance analytics and optimization

## Conclusion

This investigation and improvement effort will significantly enhance our session-aware edit tools by leveraging specialized fast-apply models. The expected outcomes include:

1. **Major Performance Improvements**: 5-10x faster edit application
2. **Enhanced Reliability**: >95% success rate with proper fallback
3. **New Capabilities**: Reapply functionality for error recovery
4. **Better Architecture**: Clean provider abstraction for future extensions
5. **Improved User Experience**: Faster, more reliable editing workflow

The implementation plan provides a structured approach to evaluate, design, and implement these improvements while maintaining backward compatibility and system reliability.
