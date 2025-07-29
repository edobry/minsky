# Implement Session Reapply Tool Using Fast-Apply Providers

## Status

BACKLOG

## Priority

MEDIUM

## Description

Implement a new `session_reapply` MCP tool that uses fast-apply providers to intelligently reapply failed edits with enhanced context and error recovery capabilities.

## Problem Statement

The original session edit tools lacked reapply functionality, which is critical for:

1. **Error Recovery**: When edit operations fail due to content changes or conflicts
2. **Context Enhancement**: Reapplying edits with additional context or refined instructions
3. **Iterative Improvement**: Refining edits based on previous attempts
4. **Conflict Resolution**: Handling merge conflicts and content drift

## Context

- **Task #249**: Completed fast-apply provider infrastructure (Morph integration)
- **Foundation Available**: Fast-apply capability detection and provider selection
- **Infrastructure Ready**: AI completion service with fast-apply support
- **Testing Framework**: Comprehensive validation suite for fast-apply operations

## Goals

1. **Implement session_reapply Tool**: Create MCP tool for intelligent edit reapplication
2. **Context-Aware Recovery**: Use edit history and failure context for better results
3. **Multi-Provider Support**: Leverage fast-apply providers with fallback mechanisms
4. **Integration Testing**: Validate reapply functionality with real scenarios

## Requirements

### Core Functionality

**1. Session Reapply Tool**
- Create `session_reapply` MCP tool with enhanced parameters
- Support for original edit context, failure reason, and additional instructions
- Integration with session edit history tracking
- Automatic provider selection based on fast-apply capabilities

**2. Context Management**
- Track edit history and previous attempts
- Store failure reasons and context
- Enhance prompts with historical context
- Support for iterative refinement

**3. Provider Integration**
- Use fast-apply providers (Morph, future providers)
- Capability-based provider selection
- Fallback mechanisms for provider unavailability
- Error handling and retry logic

### Technical Requirements

**1. MCP Tool Implementation**
- Follow existing MCP tool patterns
- Support session-aware operations
- Parameter validation and error handling
- Comprehensive logging and debugging

**2. Edit History Tracking**
- Store edit attempts and outcomes
- Track content changes and drift
- Maintain context for reapplication
- Support for edit conflict detection

**3. Smart Prompting**
- Context-aware prompt generation
- Include previous failure information
- Enhanced instructions and constraints
- Optimized for fast-apply model performance

## Implementation Plan

### Phase 1: Core Tool Development
1. **Create MCP Tool Structure**: Implement basic session_reapply tool
2. **Parameter Design**: Define comprehensive parameter set for reapplication
3. **Provider Integration**: Connect to fast-apply provider infrastructure
4. **Basic Testing**: Validate core functionality

### Phase 2: Context Enhancement
1. **Edit History System**: Implement edit tracking and storage
2. **Context Building**: Create smart context aggregation
3. **Prompt Optimization**: Enhance prompts with historical data
4. **Conflict Detection**: Identify and handle content conflicts

### Phase 3: Advanced Features
1. **Multi-Provider Support**: Implement provider selection and fallback
2. **Performance Optimization**: Optimize for speed and accuracy
3. **Error Recovery**: Advanced error handling and retry mechanisms
4. **Integration Testing**: Comprehensive real-world validation

## Success Criteria

### Immediate
- **Working Reapply Tool**: Functional session_reapply MCP tool
- **Basic Context**: Edit history tracking and reapplication
- **Provider Integration**: Fast-apply provider usage
- **Error Handling**: Robust failure recovery

### Advanced
- **Smart Context**: Intelligent context aggregation and prompt enhancement
- **Multi-Provider**: Automatic provider selection and fallback
- **High Success Rate**: >90% success rate on reapplication scenarios
- **Performance**: Fast, efficient reapplication operations

## Dependencies

- **Task #249**: Fast-apply provider infrastructure (Morph integration) - COMPLETED
- **Existing MCP Tools**: Session-aware tool patterns and infrastructure
- **AI Completion Service**: Provider abstraction and capability detection

## Integration Points

### 1. Fast-Apply Infrastructure
- **Builds on**: Task #249 Morph integration and capability framework
- **Uses**: Fast-apply provider detection and selection
- **Leverages**: AI completion service with provider abstraction

### 2. Session Management
- **Integrates with**: Existing session-aware MCP tools
- **Extends**: Session context tracking and edit history
- **Maintains**: Compatibility with current session workflows

### 3. Error Handling
- **Enhances**: Current error handling infrastructure
- **Adds**: Reapplication-specific error recovery
- **Improves**: Edit failure recovery workflows

## Expected Outcomes

1. **Enhanced Functionality**: Powerful reapply capability for failed edits
2. **Improved Reliability**: Better edit success rates through intelligent retry
3. **Better User Experience**: Seamless error recovery and edit refinement
4. **Foundation for Advanced Features**: Platform for future edit enhancements

## Risk Mitigation

1. **Provider Dependency**: Multi-provider support with fallbacks
2. **Context Complexity**: Incremental context enhancement approach
3. **Performance Impact**: Optimization and caching strategies
4. **Integration Issues**: Thorough testing with existing tools

## Future Considerations

1. **Advanced Context**: Machine learning-enhanced context selection
2. **Collaborative Editing**: Multi-user edit conflict resolution
3. **Performance Analytics**: Usage tracking and optimization insights
4. **Provider Expansion**: Integration with additional fast-apply providers 
