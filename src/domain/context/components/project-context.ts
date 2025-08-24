import {
  type ContextComponent,
  type ComponentInput,
  type ComponentOutput,
  type ComponentInputs,
} from "./types";
// Reuse existing Minsky git service
import { GitService } from "../../git";

interface ProjectContextInputs {
  workspacePath: string;
  hasGitRepo: boolean;
  gitStatus?: {
    modified: string[];
    untracked: string[];
    deleted: string[];
  };
  branch?: string;
  repositoryType: "git" | "none";
  error?: string;
}

export const ProjectContextComponent: ContextComponent = {
  id: "project-context",
  name: "Project Context",
  description: "Current project state, git status, and repository information",

  // Phase 1: Async input gathering (reuses existing GitService)
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const workspacePath = context.workspacePath || process.cwd();
    let gitStatus;
    let branch;
    let hasGitRepo = false;
    let repositoryType: "git" | "none" = "none";
    let error;

    try {
      const gitService = new GitService();

      // Check if we're in a git repository
      try {
        gitStatus = await gitService.getStatus(workspacePath);
        hasGitRepo = true;
        repositoryType = "git";

        // Get branch information separately
        try {
          branch = await gitService.getCurrentBranch(workspacePath);
        } catch (branchError) {
          // Fallback: try to get branch via execInRepository
          try {
            branch = await gitService.execInRepository(
              workspacePath,
              "rev-parse --abbrev-ref HEAD"
            );
            branch = branch.trim();
          } catch {
            branch = "unknown";
          }
        }
      } catch (gitError) {
        // Not a git repository or git not available
        hasGitRepo = false;
        repositoryType = "none";
        if (gitError instanceof Error) {
          error = `Git not available: ${gitError.message}`;
        }
      }
    } catch (serviceError) {
      error = `Failed to initialize git service: ${
        serviceError instanceof Error ? serviceError.message : String(serviceError)
      }`;
    }

    return {
      workspacePath,
      hasGitRepo,
      gitStatus,
      branch,
      repositoryType,
      error,
    } as ProjectContextInputs;
  },

  // Phase 2: Pure rendering with project information
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const projectInputs = inputs as ProjectContextInputs;

    let content = `## Project Context\n\n`;

    // Workspace information
    content += `### Workspace\n`;
    content += `- Path: ${projectInputs.workspacePath}\n`;
    content += `- Type: ${
      projectInputs.repositoryType === "git" ? "Git Repository" : "Non-Git Directory"
    }\n\n`;

    // Git repository information
    if (projectInputs.hasGitRepo && projectInputs.gitStatus) {
      content += `### Git Status\n`;
      if (projectInputs.branch) {
        content += `- Branch: ${projectInputs.branch}\n`;
      }

      // Calculate total changed files
      const modifiedFiles = projectInputs.gitStatus.modified || [];
      const untrackedFiles = projectInputs.gitStatus.untracked || [];
      const deletedFiles = projectInputs.gitStatus.deleted || [];
      const totalChanges = modifiedFiles.length + untrackedFiles.length + deletedFiles.length;

      content += `- Status: ${totalChanges === 0 ? "Clean" : "Modified"}\n`;

      if (totalChanges > 0) {
        content += `- Changes:\n`;
        if (modifiedFiles.length > 0) {
          content += `  - ${modifiedFiles.length} modified file(s)\n`;
        }
        if (untrackedFiles.length > 0) {
          content += `  - ${untrackedFiles.length} untracked file(s)\n`;
        }
        if (deletedFiles.length > 0) {
          content += `  - ${deletedFiles.length} deleted file(s)\n`;
        }

        // Show first few changed files for context
        const allChanges = [...modifiedFiles, ...untrackedFiles, ...deletedFiles];
        const displayChanges = allChanges.slice(0, 5);
        if (displayChanges.length > 0) {
          content += `- Recent changes:\n`;
          displayChanges.forEach((change) => {
            content += `  - ${change}\n`;
          });

          if (allChanges.length > 5) {
            content += `  - ... and ${allChanges.length - 5} more\n`;
          }
        }
      }

      content += `\n`;
    } else if (projectInputs.repositoryType === "none") {
      content += `### Repository Status\n`;
      content += `- Not a git repository\n`;
      if (projectInputs.error) {
        content += `- Note: ${projectInputs.error}\n`;
      }
      content += `\n`;
    }

    // Project structure hints
    content += `### Project Structure\n`;
    content += `- Working directory: ${projectInputs.workspacePath}\n`;
    if (projectInputs.hasGitRepo) {
      content += `- Version control: Git (active)\n`;
      if (projectInputs.branch) {
        content += `- Current branch: ${projectInputs.branch}\n`;
      }
    } else {
      content += `- Version control: None detected\n`;
    }

    return {
      content,
      metadata: {
        componentId: this.id,
        generatedAt: new Date().toISOString(),
        tokenCount: Math.floor(content.length / 4), // rough token estimate
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const gatheredInputs = await this.gatherInputs(input);
    return this.render(gatheredInputs, input);
  },
};

export function createProjectContextComponent(): ContextComponent {
  return ProjectContextComponent;
}
