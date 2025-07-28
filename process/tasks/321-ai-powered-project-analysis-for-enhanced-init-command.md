# AI-Powered Project Analysis for Enhanced Init Command

## Context

**Status:** TODO
**Priority:** HIGH
**Category:** FEATURE
**Tags:** ai, init, project-analysis, configuration, automation
**Dependencies:** #160 (AI Completion Backend)

## Overview

Enhance the `minsky init` command with AI-powered analysis of project documentation (README, package.json, Dockerfile, etc.) to automatically generate a structured "how to work with this project" configuration. This configuration will capture essential project metadata, development workflows, and deployment information, integrating seamlessly with existing init prompts to fill knowledge gaps through user interaction.

## Background

**Initial Implementation Status:** A basic version of the project configuration system has been implemented in task #307 for the session lint command. This includes:

- Basic `ProjectConfiguration` interface with workflow commands
- `ProjectConfigReader` that loads from `minsky.json` or `package.json` scripts
- Configuration priority: `minsky.json` > `package.json` > defaults
- Working implementation for the `lint` workflow command

The current init command requires users to manually configure project settings. By leveraging AI analysis of project documentation, we can:

1. **Automatically detect** project language, platform, and tooling
2. **Extract workflow information** from READMEs and documentation
3. **Identify containerization** and deployment patterns
4. **Generate structured configuration** for consistent project handling
5. **Prompt users** only for missing or ambiguous information

This creates a more intelligent, context-aware initialization process that adapts to each project's unique characteristics.

## Requirements

### 1. AI-Powered Documentation Analysis

**Document Discovery & Parsing**:

- Scan for common documentation files: `README.md`, `README.rst`, `CONTRIBUTING.md`, `DEVELOPMENT.md`, `docs/`
- Parse project configuration files: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, etc.
- Analyze containerization files: `Dockerfile`, `docker-compose.yml`, `kubernetes/`, `.devcontainer/`
- Extract deployment configurations: CI/CD files, deployment scripts, infrastructure configs

**AI Analysis Capabilities**:

- **Language/Platform Detection**: Primary and secondary languages, frameworks, platforms
- **Dependency Management**: Package managers, dependency files, installation commands
- **Development Workflow**: Build commands, test commands, development server setup
- **Containerization Status**: Docker support, container orchestration, dev containers
- **Deployment Patterns**: Deployment targets, CI/CD pipelines, infrastructure requirements
- **Development Environment**: IDE configurations, environment variables, prerequisites

### 2. Structured Project Configuration Schema

**Note:** A basic version of this schema has been implemented in `src/domain/project/types.ts` (task #307). The full schema below extends this initial implementation.

Design a comprehensive schema to capture project characteristics:

```typescript
interface ProjectConfiguration {
  // Basic Project Information
  project: {
    name: string;
    description?: string;
    version?: string;
    repository?: string;
    homepage?: string;
    license?: string;
  };

  // Language and Platform
  technology: {
    primaryLanguage: string;
    secondaryLanguages: string[];
    frameworks: string[];
    platforms: string[];
    runtimeVersion?: string;
  };

  // Development Environment
  development: {
    packageManager: string; // npm, yarn, pip, cargo, etc.
    installCommand: string;
    devDependencies?: string[];
    environmentVariables?: Record<string, string>;
    prerequisites?: string[];
    ideConfiguration?: {
      vscode?: any;
      extensions?: string[];
    };
  };

  // Workflow Commands
  workflows: {
    install: string;
    build?: string;
    start: string;
    dev?: string;
    test?: string;
    lint?: string;
    format?: string;
    clean?: string;
    custom?: Record<string, string>;
  };

  // Containerization
  containerization: {
    hasDockerfile: boolean;
    hasDockerCompose: boolean;
    hasDevContainer: boolean;
    baseImage?: string;
    exposedPorts?: number[];
    volumes?: string[];
    healthCheck?: string;
    buildContext?: string;
  };

  // Deployment
  deployment: {
    targets: ("local" | "docker" | "kubernetes" | "cloud" | "serverless")[];
    cicd?: {
      provider: string; // github-actions, gitlab-ci, etc.
      configFiles: string[];
    };
    infrastructure?: {
      provider?: string; // aws, gcp, azure, etc.
      configFiles?: string[];
    };
    buildArtifacts?: string[];
    deploymentCommands?: string[];
  };

  // Quality Assurance
  qa: {
    testing: {
      framework?: string;
      testCommand: string;
      testDirectories?: string[];
      coverageCommand?: string;
    };
    linting: {
      enabled: boolean;
      linters?: string[];
      configFiles?: string[];
    };
    formatting: {
      enabled: boolean;
      formatters?: string[];
      configFiles?: string[];
    };
  };

  // Documentation
  documentation: {
    readme: boolean;
    apiDocs?: string;
    deploymentDocs?: string;
    contributingGuide?: boolean;
    changelog?: boolean;
    examples?: string[];
  };

  // Minsky-Specific Configuration
  minsky: {
    analysisTimestamp: string;
    analysisVersion: string;
    confidence: number; // 0-1, how confident the AI is about the analysis
    userValidated: boolean;
    customOverrides?: Record<string, any>;
  };
}
```

### 3. Enhanced Init Command Integration

**AI Analysis Phase**:

1. **Document Discovery**: Scan project for relevant files
2. **Content Analysis**: Use AI backend to extract project information
3. **Configuration Generation**: Create initial project configuration
4. **Confidence Assessment**: Determine confidence levels for each detected feature

**Interactive Validation Phase**:

1. **Present Findings**: Show AI-generated configuration to user
2. **Highlight Uncertainties**: Mark low-confidence items for user review
3. **Smart Prompting**: Ask targeted questions for missing information
4. **User Overrides**: Allow manual corrections and additions

**Configuration Persistence**:

1. **Schema Integration**: Store in existing Minsky configuration system
2. **Version Tracking**: Track analysis version and confidence levels
3. **Update Mechanism**: Support re-analysis and configuration updates

### 4. Integration with Existing Systems

**AI Completion Backend Integration** (Task #160):

- Leverage multi-provider AI backend for document analysis
- Use appropriate models for different analysis types (code understanding, documentation parsing)
- Implement prompt engineering for consistent project analysis
- Handle rate limiting and error scenarios gracefully

**Future Containerized Session Architecture Integration**:

- Design configuration to support containerized sessions when available
- Plan for automatic container configuration based on project requirements
- Support dev container and multi-stage build analysis
- Prepare for Docker/Kubernetes deployment detection

**Existing Init Command Enhancement**:

- Extend current init prompts with AI-generated suggestions
- Maintain backward compatibility with manual configuration
- Integrate with existing configuration file generation
- Support batch initialization for multiple projects

## Implementation Phases

### Phase 1: Foundation

**Core Analysis Engine**:

- [ ] Document discovery and parsing utilities
- [ ] Basic AI integration for README analysis
- [ ] Initial project configuration schema
- [ ] Simple language/platform detection

**Integration Points**:

- [ ] Extend existing init command with analysis flag
- [ ] Integrate with AI completion service
- [ ] Basic configuration storage and retrieval

### Phase 2: Enhanced Analysis

**Advanced Detection**:

- [ ] Container configuration analysis (Dockerfile, docker-compose)
- [ ] CI/CD pipeline detection and parsing
- [ ] Development workflow extraction
- [ ] Dependency management analysis

**User Experience**:

- [ ] Interactive validation and correction interface
- [ ] Confidence scoring and uncertainty highlighting
- [ ] Smart prompting for missing information
- [ ] Configuration diff and update capabilities

### Phase 3: Integration & Polish

**System Integration**:

- [ ] Advanced AI prompting for complex project structures
- [ ] Support for monorepos and complex project layouts
- [ ] Performance optimization and caching
- [ ] Integration with containerized session architecture (when available)

**Documentation & Testing**:

- [ ] Comprehensive test suite with diverse project types
- [ ] Documentation for configuration schema and usage
- [ ] Migration guide for existing projects
- [ ] Performance benchmarks and optimization

## Technical Implementation

### AI Analysis Pipeline

```typescript
interface ProjectAnalyzer {
  // Discovery phase
  discoverDocuments(projectPath: string): DocumentInventory;

  // Analysis phase
  analyzeProject(inventory: DocumentInventory): Promise<ProjectAnalysis>;

  // Configuration generation
  generateConfiguration(analysis: ProjectAnalysis): ProjectConfiguration;

  // Validation and interaction
  validateWithUser(config: ProjectConfiguration): Promise<ProjectConfiguration>;
}

interface DocumentInventory {
  readme: string[];
  packageFiles: string[];
  containerFiles: string[];
  cicdFiles: string[];
  documentationFiles: string[];
  configFiles: string[];
}

interface ProjectAnalysis {
  language: LanguageAnalysis;
  dependencies: DependencyAnalysis;
  workflows: WorkflowAnalysis;
  containerization: ContainerAnalysis;
  deployment: DeploymentAnalysis;
  confidence: Record<string, number>;
}
```

### AI Prompt Engineering

Design specialized prompts for different analysis types:

1. **Language Detection**: Analyze file extensions, imports, and configuration files
2. **Workflow Extraction**: Parse README sections, package.json scripts, Makefiles
3. **Container Analysis**: Understand Dockerfile patterns, docker-compose services
4. **Deployment Patterns**: Identify CI/CD pipelines, infrastructure configurations

### Configuration Storage Integration

Extend existing Minsky configuration with project-specific section:

```typescript
interface MinskyConfig {
  // ... existing config
  projects: {
    [projectPath: string]: ProjectConfiguration;
  };
}
```

## Success Criteria

### Functional Requirements

- [ ] **Accurate Analysis**: 90%+ accuracy for language/platform detection on common project types
- [ ] **Comprehensive Coverage**: Support for 10+ programming languages and major frameworks
- [ ] **Container Integration**: Automatic detection and configuration of Docker/K8s projects
- [ ] **User Experience**: Intuitive validation interface with smart prompting
- [ ] **Performance**: Analysis completes within reasonable time for typical projects

### Integration Requirements

- [ ] **AI Backend**: Seamless integration with multi-provider AI completion service
- [ ] **Init Command**: Enhanced init workflow with optional AI analysis
- [ ] **Configuration System**: Proper integration with existing Minsky config schema
- [ ] **Future Session Architecture**: Ready for containerized session workspace integration

### Quality Requirements

- [ ] **Error Handling**: Graceful degradation when AI analysis fails
- [ ] **Confidence Tracking**: Clear indication of analysis confidence levels
- [ ] **Update Mechanism**: Support for re-analysis and configuration updates
- [ ] **Documentation**: Comprehensive schema documentation and usage examples

## Testing Strategy

### Test Project Coverage

- **Web Projects**: React, Vue, Angular, Next.js, Express, Django, Rails
- **API Projects**: REST APIs, GraphQL, gRPC services
- **CLI Tools**: Go binaries, Python scripts, Rust applications
- **Mobile Projects**: React Native, Flutter, native iOS/Android
- **Infrastructure**: Terraform, Ansible, Kubernetes manifests
- **Monorepos**: Nx, Lerna, Turborepo configurations

### Validation Approach

1. **Golden Dataset**: Curated set of projects with manually verified configurations
2. **Confidence Calibration**: Ensure confidence scores correlate with accuracy
3. **User Studies**: Test interactive validation workflow with real users
4. **Performance Testing**: Analysis speed across project sizes and types

## Documentation Requirements

### User Documentation

- [ ] **Usage Guide**: How to use AI-powered init command
- [ ] **Configuration Reference**: Complete schema documentation
- [ ] **Troubleshooting**: Common issues and solutions
- [ ] **Examples**: Typical configurations for popular project types

### Developer Documentation

- [ ] **Architecture Overview**: Analysis pipeline and AI integration
- [ ] **Extension Guide**: Adding support for new languages/frameworks
- [ ] **Prompt Engineering**: Best practices for analysis prompts
- [ ] **Testing Guide**: How to test and validate new analysis capabilities

## Future Enhancements

### Advanced AI Features

- **Code Analysis**: Static analysis integration for deeper project understanding
- **Multi-Modal Analysis**: Support for diagrams, screenshots, and other media
- **Continuous Learning**: Improve analysis accuracy based on user feedback
- **Custom Prompts**: Allow users to define custom analysis prompts

### Ecosystem Integration

- **IDE Plugins**: VS Code extension for project analysis
- **CI/CD Integration**: Automated project configuration updates
- **Team Sharing**: Share and synchronize project configurations across teams
- **Template Generation**: Create project templates from analyzed configurations

---

**Estimated Effort:** Large
**Risk Level:** Medium (AI accuracy, diverse project types, integration complexity)
**Dependencies:** Task #160 (AI Completion Backend)

**Next Steps:**

1. Begin project configuration schema design
2. Implement basic document discovery and parsing
3. Develop AI analysis prompts for common project types
4. Create interactive validation interface
5. Integrate with AI completion backend once available

## Solution

## Notes
