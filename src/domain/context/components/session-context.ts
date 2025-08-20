import {
  type ContextComponent,
  type ComponentInput,
  type ComponentOutput,
  type ComponentInputs,
} from "./types";
// Reuse existing Minsky session utilities
import { getCurrentSessionContext, isSessionWorkspace } from "../../workspace";
import { createSessionProvider } from "../../session";

interface SessionContextInputs {
  workspacePath: string;
  isInSession: boolean;
  sessionId?: string;
  taskId?: string;
  sessionRecord?: {
    id: string;
    name: string;
    taskId?: string;
    repoUrl: string;
    branch: string;
    createdAt: string;
    updatedAt: string;
    status?: string;
  };
  error?: string;
}

export const SessionContextComponent: ContextComponent = {
  id: "session-context",
  name: "Session Context",
  description: "Current Minsky session state and active workspace information",

  // Phase 1: Async input gathering (reuses existing session utilities)
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const workspacePath = context.workspacePath || process.cwd();
    let isInSession = false;
    let sessionId: string | undefined;
    let taskId: string | undefined;
    let sessionRecord: any;
    let error: string | undefined;

    try {
      // Check if we're in a session workspace
      isInSession = isSessionWorkspace(workspacePath);

      if (isInSession) {
        // Get current session context
        const sessionContext = await getCurrentSessionContext(workspacePath);

        if (sessionContext) {
          sessionId = sessionContext.sessionId;
          taskId = sessionContext.taskId;

          // Get full session record with additional metadata
          try {
            const sessionProvider = createSessionProvider();
            const fullSessionRecord = await sessionProvider.getSession(sessionId);

            if (fullSessionRecord) {
              sessionRecord = {
                id: fullSessionRecord.id || sessionId,
                name: fullSessionRecord.name || sessionId || "unknown",
                taskId: fullSessionRecord.taskId || taskId,
                repoUrl: fullSessionRecord.repoUrl || "unknown",
                branch: fullSessionRecord.branch || "main",
                createdAt: fullSessionRecord.createdAt || new Date().toISOString(),
                updatedAt: fullSessionRecord.updatedAt || new Date().toISOString(),
                status: fullSessionRecord.status,
              };
            }
          } catch (sessionError) {
            error = `Failed to get session details: ${sessionError instanceof Error ? sessionError.message : String(sessionError)}`;
            // Create minimal session record from what we know
            if (sessionId) {
              sessionRecord = {
                id: sessionId,
                name: sessionId,
                taskId: taskId,
                repoUrl: "unknown",
                branch: "main",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
            }
          }
        } else {
          error = "In session workspace but no session context found";
        }
      }
    } catch (sessionError) {
      error = `Failed to analyze session context: ${sessionError instanceof Error ? sessionError.message : String(sessionError)}`;
    }

    return {
      workspacePath,
      isInSession,
      sessionId,
      taskId,
      sessionRecord,
      error,
    } as SessionContextInputs;
  },

  // Phase 2: Pure rendering with session information
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const sessionInputs = inputs as SessionContextInputs;

    let content = `## Session Context\n\n`;

    // Workspace session status
    content += `### Workspace Status\n`;
    content += `- Path: ${sessionInputs.workspacePath}\n`;
    content += `- Session Mode: ${sessionInputs.isInSession ? "Active Session" : "Main Workspace"}\n\n`;

    if (sessionInputs.isInSession && sessionInputs.sessionRecord) {
      // Active session information
      content += `### Active Session\n`;
      content += `- Session ID: ${sessionInputs.sessionRecord.id}\n`;
      content += `- Session Name: ${sessionInputs.sessionRecord.name}\n`;

      if (sessionInputs.sessionRecord.taskId) {
        content += `- Associated Task: ${sessionInputs.sessionRecord.taskId}\n`;
      }

      content += `- Repository: ${sessionInputs.sessionRecord.repoUrl}\n`;
      content += `- Branch: ${sessionInputs.sessionRecord.branch}\n`;

      if (sessionInputs.sessionRecord.status) {
        content += `- Status: ${sessionInputs.sessionRecord.status}\n`;
      }

      // Only show dates if they're valid
      try {
        const createdDate = new Date(sessionInputs.sessionRecord.createdAt);
        const updatedDate = new Date(sessionInputs.sessionRecord.updatedAt);

        if (!isNaN(createdDate.getTime())) {
          content += `- Created: ${createdDate.toLocaleString()}\n`;
        }
        if (!isNaN(updatedDate.getTime())) {
          content += `- Updated: ${updatedDate.toLocaleString()}\n`;
        }
      } catch {
        // Skip invalid dates
      }

      if (sessionInputs.error) {
        content += `- Note: ${sessionInputs.error}\n`;
      }

      content += `\n`;

      // Session workflow context
      content += `### Session Workflow\n`;
      content += `- Isolated Environment: Files and changes are isolated from main workspace\n`;
      content += `- Automatic Sync: Changes will be synced back when session is complete\n`;

      if (sessionInputs.sessionRecord.taskId) {
        content += `- Task Integration: Session linked to task ${sessionInputs.sessionRecord.taskId}\n`;
      }

      content += `- Version Control: Working on branch '${sessionInputs.sessionRecord.branch}'\n\n`;
    } else if (sessionInputs.isInSession) {
      // In session but missing details
      content += `### Session Information\n`;
      if (sessionInputs.sessionId) {
        content += `- Session ID: ${sessionInputs.sessionId}\n`;
      }
      if (sessionInputs.taskId) {
        content += `- Task ID: ${sessionInputs.taskId}\n`;
      }
      if (sessionInputs.error) {
        content += `- Warning: ${sessionInputs.error}\n`;
      }
      content += `\n`;
    } else {
      // Not in a session
      content += `### Main Workspace\n`;
      content += `- Working in main project workspace\n`;
      content += `- No active session isolation\n`;
      content += `- Direct access to main repository and files\n`;
      content += `- Note: Use \`minsky session start\` to create isolated work environment\n\n`;
    }

    // Session state implications for AI context
    content += `### Context Implications\n`;
    if (sessionInputs.isInSession) {
      content += `- **Isolated Context**: Working within session-specific file space\n`;
      content += `- **Task Focus**: Context should prioritize session task objectives\n`;
      content += `- **Temporary Changes**: Modifications are isolated until session completion\n`;
      if (sessionInputs.sessionRecord?.taskId) {
        content += `- **Task Integration**: AI assistance should align with task ${sessionInputs.sessionRecord.taskId}\n`;
      }
    } else {
      content += `- **Main Workspace**: Direct access to full project context\n`;
      content += `- **Persistent Changes**: Modifications directly affect main repository\n`;
      content += `- **Broad Context**: Full project scope available for AI assistance\n`;
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

export function createSessionContextComponent(): ContextComponent {
  return SessionContextComponent;
}
