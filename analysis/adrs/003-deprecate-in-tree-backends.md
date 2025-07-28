# ADR-003: Deprecate In-Tree Task Backends

## Status

Approved

## Context

The current Minsky implementation supports in-tree task backends (markdown and JSON files stored in git repositories) through a complex "special workspace" mechanism. After comprehensive analysis, we've determined that:

1. **Special workspace complexity** (445+ lines) provides limited value for the complexity cost
2. **AI-first architecture** requires capabilities incompatible with in-tree storage
3. **GitHub Issues** provide better user experience for task specifications
4. **Cross-repository workflows** are fundamentally incompatible with in-tree approaches

However, we want to preserve the existing implementation temporarily to:

- Learn from the migration process
- Understand any edge cases or requirements we missed
- Provide fallback if GitHub Issues approach encounters unexpected issues

## Decision

**Deprecate in-tree task backends and migrate users to GitHub Issues, while preserving the existing code temporarily for learning and safety.**

### Specific Actions:

1. **Mark as Deprecated**: Add deprecation warnings to in-tree backend usage
2. **Provide Migration Tools**: Create automated migration from in-tree to GitHub Issues
3. **Preserve Code**: Keep existing implementation for reference and learning
4. **Update Documentation**: Clear guidance on migration path
5. **Set Removal Timeline**: Plan code removal after successful migration period

## Rationale

### 1. Architectural Clarity

The comprehensive analysis revealed that in-tree backends:

- **Block AI features**: No vector storage, real-time collaboration, or complex queries
- **Add complexity**: Special workspace coordination for marginal benefits
- **Limit scalability**: Poor performance and cross-repository issues
- **Confuse users**: Complex mental model vs familiar GitHub Issues

### 2. GitHub Issues Superiority

For task specifications and management:

- **Rich content**: Full markdown with images, code blocks, discussions
- **Familiar workflow**: Developers already understand GitHub Issues
- **Native integration**: Works with PRs, code review, project management
- **Proven infrastructure**: Reliable, scalable, feature-complete

### 3. AI Architecture Requirements

Future AI features require:

- **Vector storage**: For semantic search and embeddings
- **Real-time updates**: For collaborative AI workflows
- **Complex queries**: For task relationship analysis
- **Performance**: Sub-second operations for AI interactions

In-tree backends cannot provide these capabilities efficiently.

## Implementation Plan

### Phase 1: Deprecation Warnings

```typescript
// Add deprecation warnings
if (config.backend.type === "markdown" || config.backend.type === "json") {
  console.warn(`
⚠️  DEPRECATION WARNING: In-tree task backends are deprecated
    
    Migration recommended: 'minsky migrate to-github-issues'
    
    Benefits of GitHub Issues:
    • Rich task specifications with markdown
    • Native GitHub workflow integration  
    • Better collaboration and discussion
    • Foundation for future AI features
    
    Support ends: [DATE]
  `);
}
```

### Phase 2: Migration Tools

```bash
# Automated migration command
minsky migrate to-github-issues --from-backend markdown --repo owner/repo

# Migration process:
# 1. Analyze existing in-tree tasks
# 2. Create corresponding GitHub Issues
# 3. Preserve task content and relationships
# 4. Update local configuration
# 5. Provide rollback instructions
```

### Phase 3: Code Preservation Strategy

```
// Keep existing code in deprecated/ directory
src/
  deprecated/
    tasks/
      markdownTaskBackend.ts
      jsonFileTaskBackend.ts
      special-workspace-manager.ts
  current/
    tasks/
      githubIssuesBackend.ts
```

### Phase 4: Documentation Updates

- Update README to recommend GitHub Issues backend
- Create migration guide with step-by-step instructions
- Document benefits of GitHub Issues approach
- Provide troubleshooting for common migration issues

## Timeline

### Immediate (Week 1-2)

- [ ] Add deprecation warnings to in-tree backends
- [ ] Create migration tools and documentation
- [ ] Test migration process with sample repositories

### Short Term (Month 1-3)

- [ ] Encourage user migration through warnings and docs
- [ ] Gather feedback on migration process
- [ ] Refine migration tools based on user experience
- [ ] Monitor GitHub Issues backend stability

### Medium Term (Month 3-6)

- [ ] Assess migration completion rates
- [ ] Evaluate any remaining in-tree use cases
- [ ] Plan final removal timeline
- [ ] Prepare for code deletion

### Long Term (Month 6-12)

- [ ] Remove in-tree backend code if migration successful
- [ ] Clean up special workspace implementation
- [ ] Simplify codebase architecture
- [ ] Focus on advanced GitHub Issues features

## Preservation Strategy

### Why Keep the Code Initially

1. **Learning Opportunity**: Understand edge cases during migration
2. **Safety Net**: Rollback option if GitHub Issues approach fails
3. **Reference Implementation**: Inform future backend design decisions
4. **Migration Validation**: Compare functionality to ensure nothing lost

### What to Preserve

- **Core Implementations**: Markdown and JSON backends
- **Special Workspace**: Complete implementation for reference
- **Test Suites**: Understanding of expected behavior
- **Documentation**: Architectural decisions and lessons learned

### Removal Criteria

Code will be removed when:

- [ ] 95%+ of users successfully migrated to GitHub Issues
- [ ] No critical edge cases discovered that require in-tree approach
- [ ] GitHub Issues backend proven stable and feature-complete
- [ ] 6+ months of successful GitHub Issues operation

## Migration Support

### User Communication

```
Subject: Minsky In-Tree Backends Deprecation

We're migrating from in-tree task storage to GitHub Issues for better:
• Rich task specifications with full markdown support
• Native GitHub workflow integration
• Foundation for upcoming AI-powered features

Migration is simple: `minsky migrate to-github-issues`

Timeline: Support ends [DATE]
Help: [MIGRATION_GUIDE_URL]
```

### Migration Assistance

- Automated migration tools with validation
- Step-by-step migration guide with screenshots
- Community support channels for migration questions
- Direct assistance for complex migration scenarios

## Success Criteria

### Migration Success

- [ ] 95%+ user migration rate from in-tree to GitHub Issues
- [ ] Zero data loss during migration process
- [ ] User satisfaction with GitHub Issues approach
- [ ] Successful deprecation without major issues

### Code Cleanup Success

- [ ] In-tree backend code successfully removed
- [ ] Codebase complexity reduced significantly
- [ ] Architecture simplified and more maintainable
- [ ] Team development velocity improved

## Risks and Mitigation

### Risks

- **User resistance**: Some users may prefer in-tree approach
- **Migration issues**: Data loss or corruption during migration
- **GitHub dependency**: Increased reliance on external service
- **Feature gaps**: GitHub Issues may lack some in-tree capabilities

### Mitigation

- **Clear communication**: Explain benefits and provide migration support
- **Robust migration tools**: Thorough testing and validation
- **Fallback preservation**: Keep code temporarily for safety
- **Feature parity**: Ensure GitHub Issues backend matches in-tree capabilities

## References

- ADR-001: GitHub Issues Interim Strategy
- Task #325: Task Backend Architecture Analysis
- Special Workspace Implementation Analysis
- GitHub Issues Backend Requirements
