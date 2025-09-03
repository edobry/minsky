/**
 * Development Workflow Maturity Assessment System
 *
 * Evaluates projects across 7 key categories to provide a maturity score
 * and actionable recommendations for improvement.
 */

import fs from "fs/promises";
import path from "path";
import { ParsedWorkflowConfig } from "./configuration";
import { getAllCategories } from "./builtin-tools";

/**
 * Maturity assessment categories with weights
 */
export const MATURITY_CATEGORIES = {
  "Code Quality": 0.2, // Linting, formatting, type checking
  Testing: 0.2, // Unit, integration, coverage
  "Dependency Management": 0.15, // Lock files, security audits, updates
  Security: 0.15, // Secret scanning, vulnerability checks
  "Task Management": 0.1, // Issue tracking (via Minsky backends)
  "Development Workflow": 0.1, // Git hooks, commit standards
  Documentation: 0.1, // README, contributing, architecture
} as const;

/**
 * Individual assessment item
 */
export interface AssessmentItem {
  name: string;
  configured: boolean;
  tool?: string;
  description?: string;
}

/**
 * Category assessment result
 */
export interface CategoryAssessment {
  score: number; // 0.0 to 1.0
  items: Record<string, AssessmentItem>;
  recommendations?: string[];
}

/**
 * Overall maturity assessment result
 */
export interface MaturityAssessment {
  score: number; // 0.0 to 1.0
  grade: "A" | "B" | "C" | "D" | "F";
  categories: Record<string, CategoryAssessment>;
  recommendations: Array<{
    category: string;
    action: string;
    command?: string;
  }>;
}

/**
 * Project detection result
 */
export interface ProjectInfo {
  type?: "typescript" | "javascript" | "python";
  hasPackageJson: boolean;
  hasRequirementsTxt: boolean;
  hasTsConfig: boolean;
  hasEslintConfig: boolean;
  hasPrettierConfig: boolean;
  hasJestConfig: boolean;
  hasGitHooks: boolean;
  hasReadme: boolean;
  hasContributing: boolean;
  hasLockFile: boolean;
}

/**
 * Detect project information from file system
 */
export async function detectProjectInfo(workspaceDir: string): Promise<ProjectInfo> {
  const info: ProjectInfo = {
    hasPackageJson: false,
    hasRequirementsTxt: false,
    hasTsConfig: false,
    hasEslintConfig: false,
    hasPrettierConfig: false,
    hasJestConfig: false,
    hasGitHooks: false,
    hasReadme: false,
    hasContributing: false,
    hasLockFile: false,
  };

  try {
    const files = await fs.readdir(workspaceDir);

    info.hasPackageJson = files.includes("package.json");
    info.hasRequirementsTxt = files.includes("requirements.txt");
    info.hasTsConfig = files.includes("tsconfig.json");
    info.hasEslintConfig = files.some((f) => f.startsWith(".eslintrc") || f === "eslint.config.js");
    info.hasPrettierConfig = files.some((f) => f.startsWith(".prettier"));
    info.hasJestConfig = files.some((f) => f.includes("jest.config"));
    info.hasReadme = files.some((f) => f.toLowerCase().startsWith("readme"));
    info.hasContributing = files.some((f) => f.toLowerCase().includes("contributing"));
    info.hasLockFile = files.some((f) =>
      ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"].includes(f)
    );

    // Check for git hooks
    try {
      const gitHooksPath = path.join(workspaceDir, ".git", "hooks");
      const hooks = await fs.readdir(gitHooksPath);
      info.hasGitHooks = hooks.some((h) => !h.endsWith(".sample"));
    } catch {
      // No git hooks directory or not accessible
    }

    // Also check .husky directory for git hooks
    if (!info.hasGitHooks) {
      try {
        const huskyPath = path.join(workspaceDir, ".husky");
        await fs.access(huskyPath);
        info.hasGitHooks = true;
      } catch {
        // No .husky directory
      }
    }

    // Determine project type
    if (info.hasTsConfig) {
      info.type = "typescript";
    } else if (info.hasPackageJson) {
      info.type = "javascript";
    } else if (info.hasRequirementsTxt) {
      info.type = "python";
    }
  } catch (error) {
    // Directory not accessible, return default info
  }

  return info;
}

/**
 * Assess code quality category
 */
function assessCodeQuality(
  workflows: ParsedWorkflowConfig[],
  projectInfo: ProjectInfo
): CategoryAssessment {
  const items: Record<string, AssessmentItem> = {};

  // Check for linting
  const lintWorkflow = workflows.find(
    (w) => w.profile?.categories.includes("linting") || w.name === "lint"
  );
  items.lint = {
    name: "Linting configured",
    configured: !!lintWorkflow || projectInfo.hasEslintConfig,
    tool: lintWorkflow?.tool,
  };

  // Check for formatting
  const formatWorkflow = workflows.find(
    (w) => w.profile?.categories.includes("formatting") || w.name === "format"
  );
  items.format = {
    name: "Formatting configured",
    configured: !!formatWorkflow || projectInfo.hasPrettierConfig,
    tool: formatWorkflow?.tool,
  };

  // Check for type checking
  const typeCheckWorkflow = workflows.find(
    (w) => w.profile?.categories.includes("type-checking") || w.name === "typecheck"
  );
  items.typecheck = {
    name: "Type checking configured",
    configured:
      !!typeCheckWorkflow || (projectInfo.type === "typescript" && projectInfo.hasTsConfig),
    tool: typeCheckWorkflow?.tool,
  };

  const configuredItems = Object.values(items).filter((item) => item.configured).length;
  const score = configuredItems / Object.keys(items).length;

  return { score, items };
}

/**
 * Assess testing category
 */
function assessTesting(
  workflows: ParsedWorkflowConfig[],
  projectInfo: ProjectInfo
): CategoryAssessment {
  const items: Record<string, AssessmentItem> = {};

  // Check for test framework
  const testWorkflow = workflows.find(
    (w) => w.profile?.categories.includes("testing") || w.name === "test"
  );
  items.unit = {
    name: "Unit tests configured",
    configured: !!testWorkflow || projectInfo.hasJestConfig,
    tool: testWorkflow?.tool,
  };

  // Check for coverage (assume available if test framework is configured)
  items.coverage = {
    name: "Coverage reporting available",
    configured: !!testWorkflow && !!testWorkflow.commands.coverage,
    tool: testWorkflow?.tool,
  };

  // Check for integration tests (hard to detect automatically)
  items.integration = {
    name: "Integration tests configured",
    configured: false,
    description: "Cannot automatically detect integration test setup",
  };

  const configuredItems = Object.values(items).filter((item) => item.configured).length;
  const score = configuredItems / Object.keys(items).length;

  return { score, items };
}

/**
 * Assess dependency management category
 */
function assessDependencyManagement(
  workflows: ParsedWorkflowConfig[],
  projectInfo: ProjectInfo
): CategoryAssessment {
  const items: Record<string, AssessmentItem> = {};

  items.lockfile = {
    name: "Lock file present",
    configured: projectInfo.hasLockFile,
  };

  // Check for security audits
  const auditWorkflow = workflows.find(
    (w) => w.commands.audit || w.profile?.categories.includes("dependency-management")
  );
  items.audit = {
    name: "Security audits configured",
    configured: !!auditWorkflow,
    tool: auditWorkflow?.tool,
  };

  // Check for update checks
  const updateWorkflow = workflows.find((w) => w.commands.outdated || w.commands.update);
  items.updates = {
    name: "Update checks configured",
    configured: !!updateWorkflow,
    tool: updateWorkflow?.tool,
  };

  const configuredItems = Object.values(items).filter((item) => item.configured).length;
  const score = configuredItems / Object.keys(items).length;

  return { score, items };
}

/**
 * Assess security category
 */
function assessSecurity(
  workflows: ParsedWorkflowConfig[],
  projectInfo: ProjectInfo
): CategoryAssessment {
  const items: Record<string, AssessmentItem> = {};

  // Check for secret scanning
  const secretWorkflow = workflows.find(
    (w) => w.profile?.categories.includes("security") || w.name === "security"
  );
  items.secrets = {
    name: "Secret scanning configured",
    configured: !!secretWorkflow,
    tool: secretWorkflow?.tool,
  };

  // Check for dependency vulnerabilities (covered by audit in dependency management)
  const auditWorkflow = workflows.find((w) => w.commands.audit);
  items.vulnerabilities = {
    name: "Dependency vulnerabilities checked",
    configured: !!auditWorkflow,
    tool: auditWorkflow?.tool,
  };

  const configuredItems = Object.values(items).filter((item) => item.configured).length;
  const score = configuredItems / Object.keys(items).length;

  return { score, items };
}

/**
 * Assess task management category
 */
function assessTaskManagement(
  workflows: ParsedWorkflowConfig[],
  projectInfo: ProjectInfo
): CategoryAssessment {
  const items: Record<string, AssessmentItem> = {};

  // Check if minsky.json exists (indicates task backend is configured)
  items.taskBackend = {
    name: "Task backend configured",
    configured: true, // If we're running this, minsky is configured
    tool: "minsky",
  };

  const configuredItems = Object.values(items).filter((item) => item.configured).length;
  const score = configuredItems / Object.keys(items).length;

  return { score, items };
}

/**
 * Assess development workflow category
 */
function assessDevelopmentWorkflow(
  workflows: ParsedWorkflowConfig[],
  projectInfo: ProjectInfo
): CategoryAssessment {
  const items: Record<string, AssessmentItem> = {};

  items.hooks = {
    name: "Git hooks configured",
    configured: projectInfo.hasGitHooks,
  };

  // Check for commit message validation (hard to detect)
  items.commits = {
    name: "Commit message validation",
    configured: projectInfo.hasGitHooks, // Assume if hooks exist, they include commit validation
    description: "Inferred from git hooks presence",
  };

  const configuredItems = Object.values(items).filter((item) => item.configured).length;
  const score = configuredItems / Object.keys(items).length;

  return { score, items };
}

/**
 * Assess documentation category
 */
function assessDocumentation(
  workflows: ParsedWorkflowConfig[],
  projectInfo: ProjectInfo
): CategoryAssessment {
  const items: Record<string, AssessmentItem> = {};

  items.readme = {
    name: "README.md present",
    configured: projectInfo.hasReadme,
  };

  items.contributing = {
    name: "CONTRIBUTING.md present",
    configured: projectInfo.hasContributing,
  };

  // Check for architecture docs (hard to detect automatically)
  items.architecture = {
    name: "Architecture docs",
    configured: false,
    description: "Cannot automatically detect architecture documentation",
  };

  const configuredItems = Object.values(items).filter((item) => item.configured).length;
  const score = configuredItems / Object.keys(items).length;

  return { score, items };
}

/**
 * Calculate letter grade from score
 */
function calculateGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 0.9) return "A";
  if (score >= 0.8) return "B";
  if (score >= 0.7) return "C";
  if (score >= 0.6) return "D";
  return "F";
}

/**
 * Generate recommendations based on assessment
 */
function generateRecommendations(categories: Record<string, CategoryAssessment>): Array<{
  category: string;
  action: string;
  command?: string;
}> {
  const recommendations: Array<{
    category: string;
    action: string;
    command?: string;
  }> = [];

  // Code quality recommendations
  const codeQuality = categories["Code Quality"];
  if (!codeQuality.items.lint?.configured) {
    recommendations.push({
      category: "Code Quality",
      action: "Add linting",
      command: "minsky workflow add lint",
    });
  }
  if (!codeQuality.items.format?.configured) {
    recommendations.push({
      category: "Code Quality",
      action: "Add code formatting",
      command: "minsky workflow add format",
    });
  }
  if (!codeQuality.items.typecheck?.configured) {
    recommendations.push({
      category: "Code Quality",
      action: "Add type checking",
      command: "minsky workflow add typecheck",
    });
  }

  // Testing recommendations
  const testing = categories["Testing"];
  if (!testing.items.unit?.configured) {
    recommendations.push({
      category: "Testing",
      action: "Configure unit tests",
      command: "minsky workflow add test",
    });
  }

  // Security recommendations
  const security = categories["Security"];
  if (!security.items.secrets?.configured) {
    recommendations.push({
      category: "Security",
      action: "Add secret scanning",
      command: "minsky workflow add security",
    });
  }

  // Dependency management recommendations
  const deps = categories["Dependency Management"];
  if (!deps.items.audit?.configured) {
    recommendations.push({
      category: "Dependency Management",
      action: "Configure dependency audits",
      command: "minsky workflow add deps:audit",
    });
  }

  return recommendations.slice(0, 5); // Limit to top 5 recommendations
}

/**
 * Perform complete maturity assessment
 */
export async function performMaturityAssessment(
  workflows: ParsedWorkflowConfig[],
  workspaceDir: string
): Promise<MaturityAssessment> {
  const projectInfo = await detectProjectInfo(workspaceDir);

  const categories: Record<string, CategoryAssessment> = {
    "Code Quality": assessCodeQuality(workflows, projectInfo),
    Testing: assessTesting(workflows, projectInfo),
    "Dependency Management": assessDependencyManagement(workflows, projectInfo),
    Security: assessSecurity(workflows, projectInfo),
    "Task Management": assessTaskManagement(workflows, projectInfo),
    "Development Workflow": assessDevelopmentWorkflow(workflows, projectInfo),
    Documentation: assessDocumentation(workflows, projectInfo),
  };

  // Calculate weighted overall score
  let overallScore = 0;
  for (const [categoryName, weight] of Object.entries(MATURITY_CATEGORIES)) {
    const categoryScore = categories[categoryName]?.score || 0;
    overallScore += categoryScore * weight;
  }

  const grade = calculateGrade(overallScore);
  const recommendations = generateRecommendations(categories);

  return {
    score: overallScore,
    grade,
    categories,
    recommendations,
  };
}
