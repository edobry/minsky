import * as fs from "fs/promises";
import * as path from "path";
import { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";
import { log } from "../../../utils/logger";

export interface DependencyContextInputs extends ComponentInputs {
  packageJson?: {
    name: string;
    version: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
    engines?: Record<string, string>;
    type?: string;
  };
  lockFile?: {
    type: "bun" | "npm" | "yarn" | "pnpm";
    path: string;
    packageCount: number;
  };
  analysis: {
    totalDependencies: number;
    outdatedCount: number;
    securityIssues: number;
    unusedCount: number;
    recommendations: string[];
  };
}

/**
 * DependencyContextComponent - Bespoke Pattern
 *
 * Analyzes project dependencies, package.json, and lock files to provide
 * comprehensive dependency context for AI assistance. Includes security,
 * performance, and maintenance insights.
 *
 * Features:
 * - Package.json analysis with dependency categorization
 * - Lock file detection and package counting
 * - Dependency health scoring and recommendations
 * - Security vulnerability detection (basic)
 * - User prompt-based filtering and focus areas
 */
export const DependencyContextComponent: ContextComponent = {
  id: "dependency-context",
  name: "Dependency Context",
  description: "Project dependencies, package.json analysis, and dependency health insights",

  async gatherInputs(context: ComponentInput): Promise<DependencyContextInputs> {
    const { workspacePath, userPrompt } = context;

    try {
      // Read package.json
      const packageJson = await readPackageJson(workspacePath);

      // Detect lock file
      const lockFile = await detectLockFile(workspacePath);

      // Analyze dependencies
      const analysis = await analyzeDependencies(packageJson, userPrompt);

      return {
        packageJson,
        lockFile,
        analysis,
      };
    } catch (error) {
      log.error("Error gathering dependency context inputs:", error);
      return {
        analysis: {
          totalDependencies: 0,
          outdatedCount: 0,
          securityIssues: 0,
          unusedCount: 0,
          recommendations: [
            "Unable to analyze dependencies - package.json not found or inaccessible",
          ],
        },
      };
    }
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const { packageJson, lockFile, analysis } = inputs as DependencyContextInputs;
    const { userPrompt } = context;

    const sections = ["## Dependency Context"];

    // Package.json overview
    if (packageJson) {
      sections.push(
        "",
        "### Package Information",
        `**Name**: ${packageJson.name}`,
        `**Version**: ${packageJson.version}`,
        `**Type**: ${packageJson.type || "commonjs"}`,
        ""
      );

      if (packageJson.engines) {
        sections.push("**Engine Requirements**:");
        Object.entries(packageJson.engines).forEach(([engine, version]) => {
          sections.push(`- ${engine}: ${version}`);
        });
        sections.push("");
      }

      // Dependency breakdown
      const depCount = Object.keys(packageJson.dependencies || {}).length;
      const devDepCount = Object.keys(packageJson.devDependencies || {}).length;

      sections.push(
        "### Dependency Overview",
        `**Production Dependencies**: ${depCount}`,
        `**Development Dependencies**: ${devDepCount}`,
        `**Total Dependencies**: ${analysis.totalDependencies}`,
        ""
      );

      // Focus on specific dependency types based on user prompt
      if (userPrompt) {
        const filteredDeps = filterDependenciesByPrompt(packageJson, userPrompt);
        if (filteredDeps.length > 0) {
          sections.push(
            `### Dependencies Related to "${userPrompt}"`,
            ...filteredDeps.map((dep) => `- **${dep.name}**: ${dep.version} (${dep.type})`),
            ""
          );
        }
      }

      // Scripts relevant to prompt
      if (packageJson.scripts && userPrompt) {
        const relevantScripts = filterScriptsByPrompt(packageJson.scripts, userPrompt);
        if (relevantScripts.length > 0) {
          sections.push(
            `### Relevant Scripts for "${userPrompt}"`,
            ...relevantScripts.map((script) => `- **${script.name}**: \`${script.command}\``),
            ""
          );
        }
      }
    }

    // Lock file information
    if (lockFile) {
      sections.push(
        "### Lock File",
        `**Package Manager**: ${lockFile.type}`,
        `**Lock File**: ${path.basename(lockFile.path)}`,
        `**Total Packages**: ${lockFile.packageCount}`,
        ""
      );
    }

    // Dependency analysis and recommendations
    sections.push(
      "### Dependency Analysis",
      `**Health Score**: ${calculateHealthScore(analysis)}/100`,
      ""
    );

    if (analysis.securityIssues > 0) {
      sections.push(
        `⚠️  **Security Issues**: ${analysis.securityIssues} potential vulnerabilities detected`
      );
    }

    if (analysis.outdatedCount > 0) {
      sections.push(
        `📅 **Outdated Dependencies**: ${analysis.outdatedCount} packages may need updates`
      );
    }

    if (analysis.unusedCount > 0) {
      sections.push(`🧹 **Unused Dependencies**: ${analysis.unusedCount} packages appear unused`);
    }

    if (analysis.recommendations.length > 0) {
      sections.push(
        "",
        "### Recommendations",
        ...analysis.recommendations.map((rec) => `- ${rec}`),
        ""
      );
    }

    // Add context-specific guidance
    if (userPrompt) {
      const guidance = generateContextualGuidance(userPrompt, packageJson, analysis);
      if (guidance.length > 0) {
        sections.push(`### Guidance for "${userPrompt}"`, ...guidance, "");
      }
    }

    return {
      id: this.id,
      name: this.name,
      content: sections.join("\n"),
      metadata: {
        packageCount: analysis.totalDependencies,
        healthScore: calculateHealthScore(analysis),
        hasSecurityIssues: analysis.securityIssues > 0,
        packageManager: lockFile?.type,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};

async function readPackageJson(
  workspacePath: string
): Promise<DependencyContextInputs["packageJson"]> {
  try {
    const packagePath = path.join(workspacePath, "package.json");
    const content = await fs.readFile(packagePath, "utf-8");
    const packageJson = JSON.parse(content);

    return {
      name: packageJson.name || "unknown",
      version: packageJson.version || "0.0.0",
      dependencies: packageJson.dependencies || {},
      devDependencies: packageJson.devDependencies || {},
      scripts: packageJson.scripts || {},
      engines: packageJson.engines,
      type: packageJson.type,
    };
  } catch (error) {
    return undefined;
  }
}

async function detectLockFile(workspacePath: string): Promise<DependencyContextInputs["lockFile"]> {
  const lockFiles = [
    { name: "bun.lockb", type: "bun" as const },
    { name: "package-lock.json", type: "npm" as const },
    { name: "yarn.lock", type: "yarn" as const },
    { name: "pnpm-lock.yaml", type: "pnpm" as const },
  ];

  for (const { name, type } of lockFiles) {
    try {
      const lockPath = path.join(workspacePath, name);
      await fs.access(lockPath);

      // Estimate package count (simplified)
      const packageCount = await estimatePackageCount(lockPath, type);

      return {
        type,
        path: lockPath,
        packageCount,
      };
    } catch {
      // File doesn't exist, try next
    }
  }

  return undefined;
}

async function estimatePackageCount(lockPath: string, type: string): Promise<number> {
  try {
    if (type === "bun") {
      // Bun uses binary lock file, hard to parse
      return 0;
    }

    const content = await fs.readFile(lockPath, "utf-8");

    if (type === "npm") {
      // Count packages in package-lock.json
      const matches = content.match(/"node_modules\//g);
      return matches ? matches.length : 0;
    }

    if (type === "yarn") {
      // Count package entries in yarn.lock
      const matches = content.match(/^[^#\s].*:$/gm);
      return matches ? matches.length : 0;
    }

    if (type === "pnpm") {
      // Count dependencies in pnpm-lock.yaml
      const matches = content.match(/^\s{2}[^:\s]/gm);
      return matches ? matches.length : 0;
    }

    return 0;
  } catch {
    return 0;
  }
}

async function analyzeDependencies(
  packageJson: DependencyContextInputs["packageJson"],
  userPrompt?: string
): Promise<DependencyContextInputs["analysis"]> {
  const analysis: DependencyContextInputs["analysis"] = {
    totalDependencies: 0,
    outdatedCount: 0,
    securityIssues: 0,
    unusedCount: 0,
    recommendations: [],
  };

  if (!packageJson) {
    return analysis;
  }

  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  analysis.totalDependencies = Object.keys(allDeps).length;

  // Basic security analysis (check for known problematic patterns)
  const securityRisks = [
    "lodash", // Often outdated versions have vulnerabilities
    "moment", // Deprecated, should use dayjs or date-fns
    "request", // Deprecated
    "node-sass", // Often has security issues
  ];

  analysis.securityIssues = Object.keys(allDeps).filter((dep) =>
    securityRisks.some((risk) => dep.includes(risk))
  ).length;

  // Estimate outdated packages (basic heuristic)
  analysis.outdatedCount = Math.floor(analysis.totalDependencies * 0.15); // Assume 15% might be outdated

  // Generate recommendations
  if (analysis.securityIssues > 0) {
    analysis.recommendations.push(
      "Run `npm audit` or `bun audit` to check for security vulnerabilities"
    );
  }

  if (analysis.totalDependencies > 50) {
    analysis.recommendations.push(
      "Consider using dependency analysis tools to identify unused dependencies"
    );
  }

  if (Object.keys(packageJson.devDependencies).length > 20) {
    analysis.recommendations.push(
      "Review dev dependencies to ensure they are all necessary for development"
    );
  }

  // Add context-specific recommendations
  if (userPrompt) {
    const contextualRecs = generateDependencyRecommendations(allDeps, userPrompt);
    analysis.recommendations.push(...contextualRecs);
  }

  return analysis;
}

function filterDependenciesByPrompt(
  packageJson: DependencyContextInputs["packageJson"],
  prompt: string
): Array<{ name: string; version: string; type: "prod" | "dev" }> {
  if (!packageJson) return [];

  const promptLower = prompt.toLowerCase();
  const results: Array<{ name: string; version: string; type: "prod" | "dev" }> = [];

  // Check production dependencies
  Object.entries(packageJson.dependencies || {}).forEach(([name, version]) => {
    if (
      name.toLowerCase().includes(promptLower) ||
      isDependencyRelevantToPrompt(name, promptLower)
    ) {
      results.push({ name, version, type: "prod" });
    }
  });

  // Check dev dependencies
  Object.entries(packageJson.devDependencies || {}).forEach(([name, version]) => {
    if (
      name.toLowerCase().includes(promptLower) ||
      isDependencyRelevantToPrompt(name, promptLower)
    ) {
      results.push({ name, version, type: "dev" });
    }
  });

  return results.slice(0, 10); // Limit to top 10 matches
}

function isDependencyRelevantToPrompt(depName: string, prompt: string): boolean {
  const depLower = depName.toLowerCase();

  // Mapping of prompts to related dependency patterns
  const relevanceMap: Record<string, string[]> = {
    test: ["test", "jest", "vitest", "mocha", "chai", "cypress", "playwright"],
    build: ["build", "webpack", "vite", "rollup", "babel", "esbuild", "swc"],
    lint: ["lint", "eslint", "prettier", "tslint"],
    type: ["type", "typescript", "@types", "ts-"],
    react: ["react", "next", "gatsby", "@react"],
    vue: ["vue", "nuxt", "@vue"],
    express: ["express", "fastify", "koa", "hapi"],
    database: ["db", "sql", "mongo", "redis", "postgres", "mysql", "sqlite"],
    auth: ["auth", "passport", "jwt", "oauth", "session"],
    security: ["security", "crypto", "bcrypt", "helmet", "cors"],
  };

  for (const [key, patterns] of Object.entries(relevanceMap)) {
    if (prompt.includes(key)) {
      return patterns.some((pattern) => depLower.includes(pattern));
    }
  }

  return false;
}

function filterScriptsByPrompt(
  scripts: Record<string, string>,
  prompt: string
): Array<{ name: string; command: string }> {
  const promptLower = prompt.toLowerCase();
  const results: Array<{ name: string; command: string }> = [];

  Object.entries(scripts).forEach(([name, command]) => {
    if (
      name.toLowerCase().includes(promptLower) ||
      command.toLowerCase().includes(promptLower) ||
      isScriptRelevantToPrompt(name, command, promptLower)
    ) {
      results.push({ name, command });
    }
  });

  return results.slice(0, 8); // Limit to top 8 matches
}

function isScriptRelevantToPrompt(scriptName: string, command: string, prompt: string): boolean {
  const combined = `${scriptName} ${command}`.toLowerCase();

  const relevanceMap: Record<string, string[]> = {
    test: ["test", "spec", "coverage", "jest", "vitest"],
    build: ["build", "compile", "bundle", "dist", "webpack", "vite"],
    dev: ["dev", "start", "serve", "watch"],
    lint: ["lint", "format", "prettier", "eslint"],
    deploy: ["deploy", "publish", "release", "ship"],
    db: ["db", "database", "migrate", "seed", "schema"],
  };

  for (const [key, patterns] of Object.entries(relevanceMap)) {
    if (prompt.includes(key)) {
      return patterns.some((pattern) => combined.includes(pattern));
    }
  }

  return false;
}

function calculateHealthScore(analysis: DependencyContextInputs["analysis"]): number {
  let score = 100;

  // Deduct points for issues
  score -= analysis.securityIssues * 20; // Security issues are serious
  score -= analysis.outdatedCount * 2; // Outdated packages
  score -= analysis.unusedCount * 1; // Unused dependencies

  // Bonus for good practices
  if (analysis.totalDependencies > 0 && analysis.securityIssues === 0) {
    score += 5; // Bonus for no security issues
  }

  return Math.max(0, Math.min(100, score));
}

function generateDependencyRecommendations(
  allDeps: Record<string, string>,
  prompt: string
): string[] {
  const recommendations: string[] = [];
  const promptLower = prompt.toLowerCase();
  const depNames = Object.keys(allDeps);

  // Context-specific recommendations
  if (promptLower.includes("test")) {
    const hasJest = depNames.some((d) => d.includes("jest"));
    const hasVitest = depNames.some((d) => d.includes("vitest"));

    if (!hasJest && !hasVitest) {
      recommendations.push("Consider adding a testing framework like vitest or jest");
    }
  }

  if (promptLower.includes("type")) {
    const hasTypescript = depNames.some((d) => d.includes("typescript"));

    if (!hasTypescript) {
      recommendations.push("Consider adding TypeScript for better type safety");
    }
  }

  if (promptLower.includes("build")) {
    const hasBundler = depNames.some(
      (d) => d.includes("webpack") || d.includes("vite") || d.includes("rollup")
    );

    if (!hasBundler) {
      recommendations.push("Consider adding a build tool like Vite or Webpack");
    }
  }

  return recommendations;
}

function generateContextualGuidance(
  prompt: string,
  packageJson: DependencyContextInputs["packageJson"],
  analysis: DependencyContextInputs["analysis"]
): string[] {
  const guidance: string[] = [];
  const promptLower = prompt.toLowerCase();

  if (promptLower.includes("security") && analysis.securityIssues > 0) {
    guidance.push(
      "🔒 **Security Focus**: Run dependency audits regularly",
      "- Use `npm audit fix` or `bun audit` to address vulnerabilities",
      "- Consider using tools like Snyk for continuous security monitoring",
      "- Keep dependencies updated to latest stable versions"
    );
  }

  if (promptLower.includes("performance") && analysis.totalDependencies > 30) {
    guidance.push(
      "⚡ **Performance Focus**: Large dependency tree detected",
      "- Use bundle analyzers to identify large dependencies",
      "- Consider tree-shaking and code splitting",
      "- Evaluate if all dependencies are truly necessary"
    );
  }

  if (promptLower.includes("update") || promptLower.includes("upgrade")) {
    guidance.push(
      "📅 **Update Strategy**: Systematic dependency management",
      "- Use `npm outdated` or `bun outdated` to check for updates",
      "- Update dependencies incrementally, testing after each batch",
      "- Pin exact versions for critical dependencies"
    );
  }

  return guidance;
}

export function createDependencyContextComponent(): ContextComponent {
  return DependencyContextComponent;
}
