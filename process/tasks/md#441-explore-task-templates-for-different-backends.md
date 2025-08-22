# Explore task templates for different backends

## Context

# Explore task templates for different backends

## Context

Different task backends may benefit from different task specification templates. For example:
- GitHub Issues backend could use GitHub issue templates
- Database backend could have structured templates for different task types  
- Markdown backend could have project-specific templates

## Requirements

1. Research GitHub issue template functionality and how it could be integrated with github-issues backend
2. Design a system for backend-specific task templates
3. Consider template discovery and selection mechanisms
4. Evaluate how templates would work with AI-generated specs vs user-provided specs
5. Ensure templates are optional and don't interfere with existing workflows

## Implementation

- Analyze GitHub's issue template system (.github/ISSUE_TEMPLATE/)  
- Design TaskTemplate interface and TemplateProvider system
- Consider configuration for default templates per backend
- Prototype template integration with createTaskFromTitleAndSpec
- Update backends to support optional template selection

## Notes

This should be a separate feature that enhances the current direct spec content approach without breaking it.


## Requirements

## Solution

## Notes
