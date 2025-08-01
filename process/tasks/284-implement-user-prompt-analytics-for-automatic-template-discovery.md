# Implement user prompt analytics for automatic template discovery

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Overview

Implement an analytics system that analyzes user prompts and interactions to automatically discover commonly-used prompt structures and offer candidates for the prompt templates feature from task #260. This system should use embeddings and similarity search to identify patterns in user interactions and suggest reusable prompt templates.

## Problem Statement

Users often repeat similar prompt patterns without realizing it, making it difficult to identify which prompts would benefit most from templating. Manual identification of common prompt structures is time-consuming and may miss subtle patterns. An automated system could analyze user interactions to:

- Identify frequently used prompt patterns
- Discover similar prompts that could be consolidated into templates
- Suggest variable substitution opportunities
- Provide data-driven recommendations for template creation

## Requirements

### Core Features

1. **Prompt Collection System**: Capture and store user prompts/interactions for analysis
2. **Embeddings-Based Similarity Search**: Use vector embeddings to identify similar prompts
3. **Pattern Recognition**: Automatically discover common prompt structures and templates
4. **Template Candidate Generation**: Generate suggested templates with variable placeholders
5. **Analytics Dashboard**: Provide insights into prompt usage patterns
6. **Integration with Task #260**: Feed discovered patterns into the prompt templates system

### Technical Requirements

1. **Data Collection**

   - Capture user prompts from CLI interactions
   - Store interaction context (task IDs, session info, timestamps)
   - Configurable data retention policies

2. **Embeddings and Similarity**

   - Generate embeddings for prompt text using appropriate models
   - Implement similarity search and clustering algorithms
   - Support for semantic similarity detection
   - Configurable similarity thresholds

3. **Pattern Discovery**

   - Identify recurring prompt structures
   - Detect variable substitution opportunities (task IDs, paths, etc.)
   - Recognize common prompt prefixes/suffixes
   - Cluster similar prompts for template consolidation

4. **Template Generation**
   - Automatically generate template candidates from clusters
   - Suggest variable placeholders based on detected patterns
   - Provide confidence scores for template suggestions
   - Generate human-readable template descriptions

### Analytics Features

1. **Usage Metrics**

   - Most frequently used prompt patterns
   - Prompt complexity analysis
   - Time-based usage trends
   - User-specific pattern analysis

2. **Template Opportunity Identification**

   - Prompts with high similarity but manual repetition
   - Common variable substitution patterns
   - Frequently modified prompt structures
   - Cross-user pattern commonalities

3. **Recommendation Engine**
   - Suggest new templates based on usage patterns
   - Recommend improvements to existing templates
   - Identify underutilized template opportunities
   - Provide template adoption insights

## Implementation Approach

### Phase 1: Data Collection Infrastructure

1. **Prompt Capture System**

   - Add hooks to capture user prompts from CLI interactions
   - Implement storage backend for prompt data
   - Add privacy controls and user consent mechanisms
   - Create data retention and cleanup policies

2. **Storage Schema Design**
   ```typescript
   interface PromptRecord {
     id: string;
     prompt: string;
     context: {
       taskId?: string;
       sessionId?: string;
       command?: string;
       timestamp: Date;
     };
     metadata: {
       promptLength: number;
       hasVariables: boolean;
       category?: string;
     };
   }
   ```

### Phase 2: Embeddings and Similarity

1. **Embedding Generation**

   - Integrate with embedding models (OpenAI, local models, etc.)
   - Implement batch processing for efficient embedding generation
   - Cache embeddings to avoid recomputation
   - Handle embedding model versioning

2. **Similarity Search**

   - Implement vector similarity search (cosine similarity, etc.)
   - Create clustering algorithms for grouping similar prompts
   - Add configurable similarity thresholds
   - Support for different distance metrics

3. **Pattern Recognition**
   - Develop algorithms to identify common structures
   - Implement variable detection (task IDs, paths, names)
   - Create pattern scoring and ranking systems
   - Add support for hierarchical pattern discovery

### Phase 3: Template Discovery and Generation

1. **Template Candidate Generation**

   - Analyze prompt clusters to extract templates
   - Automatically identify variable placeholders
   - Generate template metadata and descriptions
   - Score templates by potential utility

2. **Integration with Task #260**
   - Export discovered templates to prompt templates system
   - Provide APIs for template management integration
   - Support template validation and testing
   - Enable feedback loops for template improvement

### Phase 4: Analytics and Insights

1. **Analytics Dashboard**

   - Create CLI commands for viewing analytics
   - Implement usage metrics and reporting
   - Add template opportunity identification
   - Provide recommendation engine

2. **Continuous Improvement**
   - Monitor template adoption rates
   - Collect feedback on generated templates
   - Refine algorithms based on usage data
   - Implement A/B testing for template suggestions

## Technical Specifications

### CLI Commands (Proposed)

```bash
# Enable/disable prompt analytics
minsky analytics enable
minsky analytics disable

# View analytics insights
minsky analytics dashboard
minsky analytics patterns
minsky analytics opportunities

# Generate template candidates
minsky analytics generate-templates
minsky analytics suggest --threshold 0.8

# Export to templates system
minsky analytics export-templates --approved-only
```

### Configuration Options

```yaml
analytics:
  enabled: true
  retention_days: 90
  embeddings:
    provider: "openai" # or "local", "huggingface"
    model: "text-embedding-ada-002"
  similarity:
    threshold: 0.75
    clustering_method: "hierarchical"
  template_generation:
    min_cluster_size: 3
    confidence_threshold: 0.8
```

### Integration Points

1. **CLI Interaction Hooks**: Capture prompts from user interactions
2. **Task #260 Templates System**: Export discovered templates
3. **Task #258 CoT Monitoring**: Provide pattern data for AI supervision system
4. **Configuration System**: Use existing config for analytics settings
5. **Storage Backends**: Leverage existing storage infrastructure
6. **Logging System**: Integrate with structured logging

## Success Criteria

1. **Pattern Discovery**: Successfully identifies 80%+ of manually recognizable patterns
2. **Template Quality**: Generated templates achieve 70%+ user approval rate
3. **Performance**: Embedding generation and similarity search complete within acceptable time limits
4. **Integration**: Seamless integration with prompt templates system from task #260
5. **Usability**: Clear and actionable analytics insights for users
6. **CoT Integration**: Pattern data can feed into Chain-of-Thought monitoring system for improved AI supervision

## Potential Challenges

1. **Embedding Costs**: Managing API costs for embedding generation
2. **Pattern Complexity**: Handling edge cases and complex prompt structures
3. **False Positives**: Avoiding over-aggressive template suggestions
4. **Performance**: Scaling similarity search for large prompt datasets
5. **Model Dependencies**: Managing dependencies on external embedding services
6. **CoT Integration**: Ensuring pattern data can be effectively used by Chain-of-Thought monitoring system

## Future Enhancements

1. **Real-time Analysis**: Live pattern detection during user interactions
2. **Cross-User Patterns**: Identify common patterns across multiple users
3. **Context-Aware Templates**: Templates that adapt based on current context
4. **AI-Powered Improvements**: Use LLMs to enhance template generation
5. **Template Evolution**: Automatically update templates based on usage patterns
6. **Integration with Other Tools**: Connect with external prompt management tools

## Research Questions

1. **Which embedding models work best for prompt similarity detection?**
2. **What similarity thresholds provide optimal pattern discovery without noise?**
3. **How can we balance template generality with specificity?**
4. **How should template quality be measured and validated?**
5. **What clustering algorithms work best for prompt pattern discovery?**
6. **How can prompt pattern data best integrate with Chain-of-Thought monitoring for AI supervision?**

## Dependencies

- Task #260: Implement prompt templates for AI interaction
- Task #258: Design multi-agent cybernetic supervision system for AI-to-AI task oversight (CoT monitoring)
- Existing Minsky CLI architecture
- Configuration system
- Storage backends
- Logging infrastructure
- Embedding service providers (OpenAI, local models, etc.)

## Estimated Complexity

**High** - Requires sophisticated analytics infrastructure, embeddings integration, pattern recognition algorithms, and seamless integration with both the prompt templates system and Chain-of-Thought monitoring system.

## Integration with Chain-of-Thought Monitoring (Task #258)

### Complementary Systems

This prompt analytics system complements the Chain-of-Thought monitoring work in **Task #258** by providing data foundation for improved AI supervision:

**Prompt Analytics → CoT Monitoring Flow:**

1. **Pattern Discovery**: Identify frequently used prompt structures and problematic patterns
2. **Embedding Reuse**: Share embedding models and similarity search infrastructure
3. **Rule Enhancement**: Feed discovered patterns into `.cursor/rules` enhancement for real-time enforcement
4. **Intervention Patterns**: Discover common user correction patterns that can inform automated interventions

**Shared Technical Infrastructure:**

- **Embeddings Pipeline**: Both systems use embeddings for semantic pattern matching
- **Pattern Recognition**: Similar algorithms for detecting problematic vs. beneficial patterns
- **Real-time Processing**: Analytics can inform real-time CoT monitoring decisions
- **Rule Integration**: Both systems enhance existing `.cursor/rules` enforcement

**Example Integration Scenarios:**

- **Prohibited Pattern Detection**: Prompt analytics discovers user frequently corrects "linter error limit" mentions → feeds into CoT monitoring for real-time intervention
- **Template Quality**: CoT monitoring tracks template usage success → feeds back into analytics for template ranking
- **Correction Patterns**: Analytics discovers common user corrections → CoT system learns intervention patterns

## Technical Architecture

### Data Flow

1. **Collection**: User prompts captured during CLI interactions
2. **Processing**: Embeddings generated and stored with metadata
3. **Analysis**: Similarity search and clustering to identify patterns
4. **Generation**: Template candidates created from identified patterns
5. **Integration**: Templates exported to prompt templates system from task #260
6. **CoT Feed**: Pattern data provided to Chain-of-Thought monitoring system from task #258
7. **Feedback**: Usage data fed back to improve pattern recognition

### Storage Requirements

- Prompt records with embeddings
- Pattern analysis cache
- Template candidate storage
- Analytics metrics and aggregations
- User preferences and feedback

### Performance Considerations

- Asynchronous embedding generation
- Efficient vector similarity search
- Caching strategies for frequently accessed data
- Batch processing for large datasets
- Progressive analysis for real-time insights
